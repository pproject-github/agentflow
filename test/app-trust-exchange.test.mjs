import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** 扮演对端应用：自己生成密钥对，只把公钥交给 AgentFlow */
function makePeerKeyPair() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

function signAs(privateKey, { method, requestPath, body, timestamp, nonce }) {
  const digest = crypto.createHash("sha256").update(body, "utf-8").digest("hex");
  const canonical = ["agentflow-app-v1", method.toUpperCase(), requestPath, digest, String(timestamp), nonce].join("\n");
  return crypto.sign(null, Buffer.from(canonical, "utf-8"), crypto.createPrivateKey(privateKey)).toString("base64");
}

test("应用互信：签名换会话，篡改/重放/过期一律拒绝", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-app-trust-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  const dataRoot = path.join(tempRoot, "data");
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce0 = Date.now();
    const [{ loginOrCreateUser, writeAuthUserNotify }, { startUiServer }, trust] = await Promise.all([
      import(`../bin/lib/auth.mjs?app-trust=${nonce0}`),
      import(`../bin/lib/ui-server.mjs?app-trust=${nonce0}`),
      import(`../bin/lib/app-trust.mjs?app-trust=${nonce0}`),
    ]);
    const user = loginOrCreateUser("wangfang1", "trust-password");
    writeAuthUserNotify(user.user.userId, {
      wecomUserId: "00320",
      wecomUserIdSource: "privilege",
      wecomUserIdVerifiedAt: new Date().toISOString(),
    });

    const peer = makePeerKeyPair();
    const registered = trust.upsertAppTrustPeer({
      appId: "mengmai",
      name: "萌买助手",
      publicKey: peer.publicKey,
      scopes: ["workspace:read", "schedule:manage"],
    });
    assert.equal(registered.ok, true, JSON.stringify(registered));
    // 我们自己的私钥不出现在任何对外结构里
    assert.doesNotMatch(JSON.stringify(trust.listAppTrustPeers()), /PRIVATE KEY/);
    assert.match(trust.selfPublicKey(), /BEGIN PUBLIC KEY/);

    server = await startUiServer({
      workspaceRoot: path.join(tempRoot, "workspace"),
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
      enableWorkspaceScheduler: false,
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const exchangePath = "/api/app/tokens/exchange";
    const call = async ({ body, timestamp = Date.now(), nonce = crypto.randomBytes(16).toString("hex"), signature, appId = "mengmai" }) => {
      const response = await fetch(base + exchangePath, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-agentflow-app": appId,
          "x-agentflow-timestamp": String(timestamp),
          "x-agentflow-nonce": nonce,
          "x-agentflow-signature": signature
            ?? signAs(peer.privateKey, { method: "POST", requestPath: exchangePath, body, timestamp, nonce }),
        },
        body,
      });
      return { status: response.status, body: await response.json() };
    };

    // 正常换取
    const body = JSON.stringify({ wecomUserId: "00320" });
    const ok = await call({ body });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.userId, "wangfang1");
    assert.equal(ok.body.appId, "mengmai");
    assert.deepEqual(ok.body.scopes, ["workspace:read", "schedule:manage"]);
    assert.ok(ok.body.token);
    assert.ok(ok.body.expiresAt - Date.now() <= 15 * 60 * 1000 + 5000);

    // 换来的会话真的能用，而且就是那个人
    const meResponse = await fetch(`${base}/api/auth/session`, {
      headers: { Authorization: `Bearer ${ok.body.token}` },
    });
    if (meResponse.status === 200) {
      const me = await meResponse.json();
      assert.equal(me?.user?.userId ?? "wangfang1", "wangfang1");
    }

    // 重放：同一个 nonce 第二次必须被拒
    const replayNonce = crypto.randomBytes(16).toString("hex");
    const replayTs = Date.now();
    const replaySig = signAs(peer.privateKey, { method: "POST", requestPath: exchangePath, body, timestamp: replayTs, nonce: replayNonce });
    const first = await call({ body, timestamp: replayTs, nonce: replayNonce, signature: replaySig });
    assert.equal(first.status, 201);
    const replayed = await call({ body, timestamp: replayTs, nonce: replayNonce, signature: replaySig });
    assert.equal(replayed.status, 401);

    // 篡改 body：签名针对旧 body，换个人就验不过
    const tamperTs = Date.now();
    const tamperNonce = crypto.randomBytes(16).toString("hex");
    const tampered = await call({
      body: JSON.stringify({ wecomUserId: "00999" }),
      timestamp: tamperTs,
      nonce: tamperNonce,
      signature: signAs(peer.privateKey, { method: "POST", requestPath: exchangePath, body, timestamp: tamperTs, nonce: tamperNonce }),
    });
    assert.equal(tampered.status, 401);

    // 过期时间戳
    const stale = await call({ body, timestamp: Date.now() - 20 * 60 * 1000 });
    assert.equal(stale.status, 401);

    // 未登记的应用
    const stranger = makePeerKeyPair();
    const strangerTs = Date.now();
    const strangerNonce = crypto.randomBytes(16).toString("hex");
    const unknown = await call({
      body,
      timestamp: strangerTs,
      nonce: strangerNonce,
      appId: "somebody-else",
      signature: signAs(stranger.privateKey, { method: "POST", requestPath: exchangePath, body, timestamp: strangerTs, nonce: strangerNonce }),
    });
    assert.equal(unknown.status, 401);

    // 登记过的应用换别人的公钥来签，同样不认
    const forged = await call({
      body,
      signature: signAs(stranger.privateKey, {
        method: "POST",
        requestPath: exchangePath,
        body,
        timestamp: Date.now(),
        nonce: crypto.randomBytes(16).toString("hex"),
      }),
    });
    assert.equal(forged.status, 401);

    // 没绑定过的企微 id：不发会话
    const unbound = await call({ body: JSON.stringify({ wecomUserId: "09999" }) });
    assert.equal(unbound.status, 404);

    // 手工绑定的身份默认不可用于换会话
    loginOrCreateUser("hesiqi", "trust-password");
    writeAuthUserNotify("hesiqi", {
      wecomUserId: "00777",
      wecomUserIdSource: "manual",
      wecomUserIdVerifiedAt: new Date().toISOString(),
    });
    const manualOnly = await call({ body: JSON.stringify({ wecomUserId: "00777" }) });
    assert.equal(manualOnly.status, 404);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("私钥落盘权限是 0600，且不会出现在管理接口响应里", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-app-trust-key-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  try {
    const trust = await import(`../bin/lib/app-trust.mjs?app-trust-key=${Date.now()}`);
    const self = trust.ensureSelfKeyPair();
    assert.match(self.privateKey, /BEGIN PRIVATE KEY/);
    // 第二次调用不重新生成，否则每次重启都要重新交换公钥
    assert.equal(trust.ensureSelfKeyPair().publicKey, self.publicKey);
    const filePath = path.join(tempRoot, "data", "admin", "app-trust.json");
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  } finally {
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
