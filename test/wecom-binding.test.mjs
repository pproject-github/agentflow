import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** 一个假的 Privilege 用户中心：按 user_name 返回 openid，就像内网那个。 */
async function startFakePrivilege(users) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({
      path: url.pathname,
      userName: url.searchParams.get("user_name"),
      disabled: url.searchParams.get("disabled"),
      auth: req.headers.authorization || "",
    });
    const hit = users[url.searchParams.get("user_name") || ""];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ errcode: 0, data: hit ? [hit] : [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test("登录名换企微 ID：查一次落盘，运行时自动注入 WECOM_TO_USER", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-wecom-binding-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  const dataRoot = path.join(tempRoot, "data");
  process.env.AGENTFLOW_HOME = dataRoot;
  let privilege;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser, readAuthUsers }, directory, userEnv] = await Promise.all([
      import(`../bin/lib/auth.mjs?wecom-binding=${nonce}`),
      import(`../bin/lib/wecom-directory.mjs?wecom-binding=${nonce}`),
      import(`../bin/lib/user-env.mjs?wecom-binding=${nonce}`),
    ]);
    const user = loginOrCreateUser("wangfang1", "binding-password");
    // CAS 用户查的是 casUsername；这里模拟 CAS 登录后的样子
    const usersPath = path.join(dataRoot, "auth", "users.json");
    const users = JSON.parse(fs.readFileSync(usersPath, "utf-8"));
    users[user.user.userId].casUsername = "wangfang1";
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2), "utf-8");

    privilege = await startFakePrivilege({
      wangfang1: { user_name: "wangfang1", name: "王芳", openid: "00320" },
    });
    const env = {
      PRIVILEGE_URL: privilege.baseUrl,
      PRIVILEGE_ACCOUNT: "svc-agentflow",
      PRIVILEGE_PASSWORD: "secret",
    };

    // 绑定前：注入里没有 WECOM_TO_USER
    assert.equal(userEnv.runtimeEnvForUser({ userId: "wangfang1" }).WECOM_TO_USER, undefined);

    const resolved = await directory.resolveWecomUserId("wangfang1", { env });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    assert.equal(resolved.wecomUserId, "00320");
    assert.equal(resolved.source, "privilege");
    assert.equal(resolved.cached, false);
    assert.equal(privilege.requests.at(-1).userName, "wangfang1");
    assert.equal(privilege.requests.at(-1).disabled, "0");
    assert.equal(
      privilege.requests.at(-1).auth,
      `Basic ${Buffer.from("svc-agentflow:secret", "utf8").toString("base64")}`,
    );

    // 落盘在用户记录上，不是临时的
    assert.equal(readAuthUsers().wangfang1.notify.wecomUserId, "00320");

    // 再要一次走缓存，不再打 Privilege
    const callsBefore = privilege.requests.length;
    const again = await directory.resolveWecomUserId("wangfang1", { env });
    assert.equal(again.cached, true);
    assert.equal(again.wecomUserId, "00320");
    assert.equal(privilege.requests.length, callsBefore);

    // 绑定后：流程运行时直接拿得到
    const runtimeEnv = userEnv.runtimeEnvForUser({ userId: "wangfang1" });
    assert.equal(runtimeEnv.WECOM_TO_USER, "00320");
    assert.equal(runtimeEnv.AGENTFLOW_WECOM_USER_ID, "00320");
    assert.equal(runtimeEnv.AGENTFLOW_USER_ID, "wangfang1");

    // 用户自己配的仍然盖得住平台默认值——要发给别人时用
    userEnv.writeUserEnvRows("wangfang1", [{ key: "WECOM_TO_USER", value: "00999" }]);
    assert.equal(userEnv.runtimeEnvForUser({ userId: "wangfang1" }).WECOM_TO_USER, "00999");
  } finally {
    if (privilege) await new Promise((resolve) => privilege.server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Privilege 查不到就不写绑定，手工指定可以兜底", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-wecom-manual-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let privilege;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, directory] = await Promise.all([
      import(`../bin/lib/auth.mjs?wecom-manual=${nonce}`),
      import(`../bin/lib/wecom-directory.mjs?wecom-manual=${nonce}`),
    ]);
    loginOrCreateUser("hesiqi", "binding-password");
    privilege = await startFakePrivilege({});
    const env = { PRIVILEGE_URL: privilege.baseUrl, PRIVILEGE_ACCOUNT: "svc", PRIVILEGE_PASSWORD: "secret" };

    const missed = await directory.resolveWecomUserId("hesiqi", { env });
    assert.equal(missed.ok, false);
    assert.match(missed.error, /没有 user_name=hesiqi/);
    assert.equal(directory.readWecomBinding("hesiqi"), null);

    const manual = directory.writeManualWecomBinding("hesiqi", "00777");
    assert.equal(manual.ok, true);
    assert.deepEqual(
      { id: directory.readWecomBinding("hesiqi").wecomUserId, source: directory.readWecomBinding("hesiqi").source },
      { id: "00777", source: "manual" },
    );

    // 没配密码时报得明确，而不是发一个空 Basic 出去
    const noPassword = await directory.resolveWecomUserId("hesiqi", { env: { PRIVILEGE_URL: privilege.baseUrl }, force: true });
    assert.equal(noPassword.ok, false);
    assert.match(noPassword.error, /PRIVILEGE_PASSWORD/);
  } finally {
    if (privilege) await new Promise((resolve) => privilege.server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("批量补齐：跳过历史链接账号，逐条报结果", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-wecom-backfill-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  const dataRoot = path.join(tempRoot, "data");
  process.env.AGENTFLOW_HOME = dataRoot;
  let privilege;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, directory] = await Promise.all([
      import(`../bin/lib/auth.mjs?wecom-backfill=${nonce}`),
      import(`../bin/lib/wecom-directory.mjs?wecom-backfill=${nonce}`),
    ]);
    loginOrCreateUser("wangqi", "backfill-password");
    loginOrCreateUser("xingqiwei", "backfill-password");
    loginOrCreateUser("wangfang", "backfill-password");
    const usersPath = path.join(dataRoot, "auth", "users.json");
    const users = JSON.parse(fs.readFileSync(usersPath, "utf-8"));
    users.wangfang.linkedToUserId = "wangfang1"; // 历史账号，不该白查一遍
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2), "utf-8");

    privilege = await startFakePrivilege({
      wangqi: { user_name: "wangqi", openid: "00101" },
      xingqiwei: { user_name: "xingqiwei", openid: "00102" },
    });
    const result = await directory.backfillWecomBindings({
      env: { PRIVILEGE_URL: privilege.baseUrl, PRIVILEGE_ACCOUNT: "svc", PRIVILEGE_PASSWORD: "secret" },
    });
    assert.equal(result.bound, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.rows.find((row) => row.userId === "wangfang").skipped, "linked");
    assert.equal(privilege.requests.some((item) => item.userName === "wangfang"), false);
    assert.equal(directory.readWecomBinding("wangqi").wecomUserId, "00101");
    assert.equal(directory.readWecomBinding("xingqiwei").wecomUserId, "00102");
  } finally {
    if (privilege) await new Promise((resolve) => privilege.server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
