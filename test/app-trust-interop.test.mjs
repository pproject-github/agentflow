import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 跨仓库黄金向量。
 *
 * 萌买那侧（mengmai: src/features/agentflow/server/__tests__/signature.test.ts）有一份
 * 逐字节相同的。Ed25519 是确定性签名，同一份规范化串 + 同一把密钥必须签出同一个结果，
 * 所以任何一边改了拼接方式（多一个空格、少一个换行、字段换序），这条会先红——而不是等
 * 到联调时收到一句无从下手的「应用签名校验失败」。
 *
 * 这把密钥只用于测试，写死在两个仓库里。
 */
const GOLDEN = {
  privateKeyDer: "MC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH",
  publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\n-----END PUBLIC KEY-----\n",
  body: JSON.stringify({ wecomUserId: "00320" }),
  bodyDigest: "b18c9ac0790cf6177bfd81aa5c348cede436e376c0eac761850ec50aa55d428b",
  timestamp: "1789012345678",
  nonce: "deadbeefdeadbeefdeadbeefdeadbeef",
  requestPath: "/api/app/tokens/exchange",
  signature: "1xojtGOfSZJbaJiFttrIa8ZnkQy6DVk/RVCSJ6+QRPTfIl3CWVPwJdsqTFtrrB9nm1sr9NCGnsq8AXZnlDHaCg==",
};

function goldenPrivateKey() {
  return crypto.createPrivateKey({
    key: Buffer.from(GOLDEN.privateKeyDer, "base64"),
    format: "der",
    type: "pkcs8",
  });
}

test("规范化串与萌买侧逐字节一致", async () => {
  const { appTrustCanonicalString } = await import(`../bin/lib/app-trust.mjs?interop=${Date.now()}`);
  const canonical = appTrustCanonicalString({
    method: "POST",
    requestPath: GOLDEN.requestPath,
    body: GOLDEN.body,
    timestamp: GOLDEN.timestamp,
    nonce: GOLDEN.nonce,
  });
  assert.equal(canonical, [
    "agentflow-app-v1",
    "POST",
    GOLDEN.requestPath,
    GOLDEN.bodyDigest,
    GOLDEN.timestamp,
    GOLDEN.nonce,
  ].join("\n"));
});

test("萌买用这把密钥签出的名，我们这边验得过", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-interop-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  try {
    const trust = await import(`../bin/lib/app-trust.mjs?interop-verify=${Date.now()}`);
    const registered = trust.upsertAppTrustPeer({
      appId: "mengmai",
      publicKey: GOLDEN.publicKeyPem,
      scopes: ["workspace:read"],
    });
    assert.equal(registered.ok, true, JSON.stringify(registered));

    // 先自证：黄金签名确实是这把密钥对这段串签出来的
    const canonical = trust.appTrustCanonicalString({
      method: "POST",
      requestPath: GOLDEN.requestPath,
      body: GOLDEN.body,
      timestamp: GOLDEN.timestamp,
      nonce: GOLDEN.nonce,
    });
    assert.equal(
      crypto.sign(null, Buffer.from(canonical, "utf-8"), goldenPrivateKey()).toString("base64"),
      GOLDEN.signature,
    );

    // 再走真实校验路径。时间戳是固定的，所以把"现在"设成那一刻，验的是签名本身而不是时钟
    const verified = trust.verifyAppRequest({
      method: "POST",
      requestPath: GOLDEN.requestPath,
      body: GOLDEN.body,
      headers: {
        "x-agentflow-app": "mengmai",
        "x-agentflow-timestamp": GOLDEN.timestamp,
        "x-agentflow-nonce": GOLDEN.nonce,
        "x-agentflow-signature": GOLDEN.signature,
      },
      now: Number(GOLDEN.timestamp),
    });
    assert.equal(verified.ok, true, JSON.stringify(verified));
    assert.equal(verified.appId, "mengmai");

    // 同一条请求再来一次：nonce 已经用过
    const replay = trust.verifyAppRequest({
      method: "POST",
      requestPath: GOLDEN.requestPath,
      body: GOLDEN.body,
      headers: {
        "x-agentflow-app": "mengmai",
        "x-agentflow-timestamp": GOLDEN.timestamp,
        "x-agentflow-nonce": GOLDEN.nonce,
        "x-agentflow-signature": GOLDEN.signature,
      },
      now: Number(GOLDEN.timestamp),
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, "replayed_nonce");
  } finally {
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
