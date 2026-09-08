import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function withTempHome(tag, run) {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `agentflow-${tag}-`)));
  const previousHome = process.env.AGENTFLOW_HOME;
  try {
    process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
    const stamp = `${tag}-${Date.now()}-${Math.random()}`;
    const auth = await import(`../bin/lib/auth.mjs?${stamp}`);
    const paths = await import(`../bin/lib/paths.mjs?${stamp}`);
    await run({ auth, paths });
  } finally {
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test("外部账号名一律转写成可用 ID，不因为长得不像我们的用户名就拒绝", async () => {
  const { agentflowUserIdFromExternalName, sanitizeAgentflowUserId } = await import("../bin/lib/paths.mjs");

  const cases = [
    ["lixiang", "lixiang"],
    ["LiXiang", "lixiang"],
    ["li.xiang", "li-xiang"],       // 点号：注册表单不许，企业账号不归我们管
    ["lixiang@bigo.sg", "lixiang"], // 邮箱取本地部分，域名是噪音
    ["08123", "u08123"],            // 数字开头：补前缀，不是拒绝
    ["--x--", "x"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(agentflowUserIdFromExternalName(input), expected, `${input} 映射错了`);
  }

  // 派生结果必须还能过 sanitizeAgentflowUserId——全系统都拿它当归一化入口，
  // 过不了就意味着 listAgentflowUserIds 之类会静默把这个人丢掉。
  for (const [input] of cases) {
    const id = agentflowUserIdFromExternalName(input);
    assert.equal(sanitizeAgentflowUserId(id), id, `${input} 派生出的 ${id} 过不了归一化`);
  }

  // 整串都在字母数字之外时不能都塌成同一个前缀。
  const zhang = agentflowUserIdFromExternalName("张三");
  const li = agentflowUserIdFromExternalName("李四");
  assert.notEqual(zhang, li);
  assert.equal(sanitizeAgentflowUserId(zhang), zhang);
  assert.equal(agentflowUserIdFromExternalName("张三"), zhang, "同一个名字每次要算出同一个 ID");

  assert.equal(agentflowUserIdFromExternalName(""), "");
});

test("带点的 CAS 账号能登录，再次登录还是同一个人", async () => {
  await withTempHome("cas-dot", async ({ auth, paths }) => {
    const first = auth.loginCasUser({ username: "li.xiang", attributes: { displayName: "李想" } });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.user.userId, "li-xiang");
    assert.equal(first.user.casUsername, "li.xiang");
    assert.equal(paths.getUserPipelinesRoot("li-xiang").includes("li-xiang"), true);

    const again = auth.loginCasUser({ username: "li.xiang" });
    assert.equal(again.ok, true);
    assert.equal(again.user.userId, "li-xiang", "同一个 CAS 账号必须落回同一个 ID");
  });
});

test("派生撞车时往后让位，不串号", async () => {
  await withTempHome("cas-collision", async ({ auth }) => {
    const first = auth.loginCasUser({ username: "li.xiang" });
    const second = auth.loginCasUser({ username: "li-xiang" });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.user.userId, "li-xiang");
    assert.equal(second.user.userId, "li-xiang-2", "撞车的人应当让位，而不是顶掉先来的");

    // 让位之后两边都还能各自登回自己的账号。
    assert.equal(auth.loginCasUser({ username: "li.xiang" }).user.userId, "li-xiang");
    assert.equal(auth.loginCasUser({ username: "li-xiang" }).user.userId, "li-xiang-2");
  });
});

test("认人靠 casUsername，不靠现算的 ID", async () => {
  await withTempHome("cas-rebind", async ({ auth }) => {
    const created = auth.loginCasUser({ username: "lixiang@bigo.sg" });
    assert.equal(created.user.userId, "lixiang");

    // 有人后来占了 "lixiang" 这个派生结果也没关系：老账号是按 casUsername 找回来的。
    const other = auth.loginCasUser({ username: "lixiang" });
    assert.equal(other.user.userId, "lixiang-2");
    assert.equal(auth.loginCasUser({ username: "lixiang@bigo.sg" }).user.userId, "lixiang");
  });
});

test("同名的老密码账号照旧被 CAS 认领", async () => {
  await withTempHome("cas-legacy", async ({ auth }) => {
    // 第一个密码账号会被拔成管理员，管理员走的是另一扇门；先占掉这个位置。
    assert.equal(auth.loginAdminUser("root-admin", "admin-password").ok, true);
    assert.equal(auth.loginOrCreateUser("lixiang", "legacy-password").ok, true);
    const cas = auth.loginCasUser({ username: "lixiang" });
    assert.equal(cas.ok, true);
    assert.equal(cas.user.userId, "lixiang");
    assert.equal(cas.linkedLegacyAccount, true);
  });
});
