import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// 用户需求点: 同一个人关联了旧账号后有两个 userId，运行记录分散在两边；流程仓库的使用次数
// 按流程目录归属聚合，不折算别名就只算得到 CAS 身份那一半（线上 7/10/10 vs 实际 57/69/30）。
test("linked legacy accounts count toward the same flow owner", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-user-alias-"));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = tempRoot;
  t.after(() => {
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(tempRoot, "auth"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, "auth", "users.json"),
    JSON.stringify({
      wangfang: { authProvider: "linked", legacyUserIds: [] },
      wangfang1: { authProvider: "cas", legacyUserIds: ["wangfang"] },
      other: { authProvider: "cas", legacyUserIds: [] },
    }, null, 2),
    "utf-8",
  );

  const { agentflowUserIdAliases } = await import(`../bin/lib/auth.mjs?user-alias=${Date.now()}`);
  const aliases = agentflowUserIdAliases();
  assert.equal(aliases.get("wangfang"), "wangfang1");
  assert.equal(aliases.get("wangfang1"), undefined, "CAS 账号本身不是别名");
  assert.equal(aliases.get("other"), undefined);
});

test("an account that lists itself is not treated as its own alias", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-user-alias-self-"));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = tempRoot;
  t.after(() => {
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(tempRoot, "auth"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, "auth", "users.json"),
    JSON.stringify({ loop: { authProvider: "cas", legacyUserIds: ["loop", ""] } }, null, 2),
    "utf-8",
  );

  const { agentflowUserIdAliases } = await import(`../bin/lib/auth.mjs?user-alias-self=${Date.now()}`);
  assert.equal(agentflowUserIdAliases().size, 0);
});
