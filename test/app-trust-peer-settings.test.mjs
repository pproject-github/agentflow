import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function publicKeyPem() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).publicKey;
}

async function withTrustStore(run) {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-peer-settings-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  try {
    await run(await import(`../bin/lib/app-trust.mjs?peer-settings=${crypto.randomUUID()}`), tempRoot);
  } finally {
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

// 列表接口只回公钥指纹，管理员手上没有公钥原文。如果改一次有效期就要求重贴公钥，
// 结果就是没人敢动这些设置——真出事时也不会有人去收紧它。
test("改已登记应用的设置不用重贴公钥，省略不等于清空", async () => {
  await withTrustStore(async (trust) => {
    const publicKey = publicKeyPem();
    assert.equal(trust.upsertAppTrustPeer({ appId: "mengmai", publicKey, scopes: ["workspace:read"] }).ok, true);
    const before = trust.listAppTrustPeers().find((peer) => peer.appId === "mengmai");

    const updated = trust.upsertAppTrustPeer({ appId: "mengmai", sessionTtlMs: 24 * 60 * 60 * 1000 });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(updated.peer.sessionTtlMs, 24 * 60 * 60 * 1000);
    // 公钥没变：指纹是同一个，签名照样验得过
    assert.equal(updated.peer.publicKeyFingerprint, before.publicKeyFingerprint);
    // 省略的字段沿用旧值，不被顺手抹掉
    assert.deepEqual(updated.peer.scopes, ["workspace:read"]);
    assert.equal(updated.peer.name, before.name);
  });
});

test("没登记过的应用必须带公钥", async () => {
  await withTrustStore(async (trust) => {
    const created = trust.upsertAppTrustPeer({ appId: "stranger", sessionTtlMs: 60_000 });
    assert.equal(created.ok, false);
    assert.match(created.error, /必须提供 publicKey/);
    assert.equal(trust.listAppTrustPeers().length, 0);
  });
});

// 一张代理会话的有效期是"漏了之后还能被用多久"。上限卡死，免得手滑填成永久。
test("会话有效期收敛到 1 分钟 ~ 24 小时", async () => {
  await withTrustStore(async (trust) => {
    const publicKey = publicKeyPem();
    trust.upsertAppTrustPeer({ appId: "mengmai", publicKey });

    const tooLong = trust.upsertAppTrustPeer({ appId: "mengmai", sessionTtlMs: 365 * 24 * 60 * 60 * 1000 });
    assert.equal(tooLong.peer.sessionTtlMs, 24 * 60 * 60 * 1000);

    const tooShort = trust.upsertAppTrustPeer({ appId: "mengmai", sessionTtlMs: 5 });
    assert.equal(tooShort.peer.sessionTtlMs, 60 * 1000);
  });
});

// 填错不能变成永久会话，也不能把管理员已经配好的有效期悄悄重置成默认值
test("非法有效期不落地：新应用回落到默认，老应用保持原值", async () => {
  await withTrustStore(async (trust) => {
    const publicKey = publicKeyPem();
    for (const bad of [0, -1, Number.NaN, "abc"]) {
      const appId = `fresh-${String(bad).replace(/[^a-z0-9]/gi, "") || "zero"}`;
      assert.equal(
        trust.upsertAppTrustPeer({ appId, publicKey, sessionTtlMs: bad }).peer.sessionTtlMs,
        15 * 60 * 1000,
        `新登记 sessionTtlMs=${String(bad)} 应该回落到默认值`,
      );
    }

    trust.upsertAppTrustPeer({ appId: "mengmai", publicKey, sessionTtlMs: 6 * 60 * 60 * 1000 });
    for (const bad of [0, -1, Number.NaN, "abc"]) {
      assert.equal(
        trust.upsertAppTrustPeer({ appId: "mengmai", sessionTtlMs: bad }).peer.sessionTtlMs,
        6 * 60 * 60 * 1000,
        `更新时 sessionTtlMs=${String(bad)} 应该保持原有配置`,
      );
    }
  });
});

// 磁盘上可能留着更早版本写下的、没被收敛过的值
test("磁盘上已有的超长有效期在读取时也被拉回上限", async () => {
  await withTrustStore(async (trust, tempRoot) => {
    const publicKey = publicKeyPem();
    trust.upsertAppTrustPeer({ appId: "mengmai", publicKey });
    const filePath = path.join(tempRoot, "data", "admin", "app-trust.json");
    const file = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    file.peers.mengmai.sessionTtlMs = 10 * 365 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(filePath, JSON.stringify(file, null, 2));

    assert.equal(
      trust.listAppTrustPeers().find((peer) => peer.appId === "mengmai").sessionTtlMs,
      24 * 60 * 60 * 1000,
    );
  });
});
