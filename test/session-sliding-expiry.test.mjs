import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const DAY = 24 * 60 * 60 * 1000;

/** 直接改磁盘上的 sessions.json——测试要控制「上次续期是多久以前」。 */
function sessionsFile(home) {
  return path.join(home, "auth", "sessions.json");
}
function readSessions(home) {
  return JSON.parse(fs.readFileSync(sessionsFile(home), "utf-8"));
}
function writeSessions(home, sessions) {
  fs.writeFileSync(sessionsFile(home), JSON.stringify(sessions, null, 2), "utf-8");
}
const requestWith = (token) => ({ headers: { authorization: `Bearer ${token}` } });
/** 按客户端名找会话——loginOrCreateUser 已经先建了一个 web 会话，不能按下标取。 */
function findSession(home, clientName) {
  const entry = Object.entries(readSessions(home)).find(([, r]) => String(r?.clientName || "") === clientName);
  assert.ok(entry, `找不到 clientName=${clientName} 的会话`);
  return entry;
}
function patchSession(home, clientName, patch) {
  const sessions = readSessions(home);
  const [key, record] = findSession(home, clientName);
  sessions[key] = { ...record, ...patch };
  writeSessions(home, sessions);
}

async function seed(t) {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-session-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  t.after(() => {
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  const auth = await import(`../bin/lib/auth.mjs?session-slide=${Date.now()}${Math.random()}`);
  const login = auth.loginOrCreateUser("slide-user", "slide-password");
  assert.equal(login.ok, true, login.error || "建用户应当成功");
  const user = login.user;
  /** 走真实的设备码流拿一个 cli 会话——mengmai 那边拿到的就是这种。 */
  const issueCliSession = (clientName) => {
    const started = auth.createCliAuthorization({ publicBaseUrl: "http://127.0.0.1", clientName });
    const decided = auth.decideCliAuthorization({
      requestId: started.requestId,
      approvalNonce: started.approvalNonce,
      userId: user.userId,
      approved: true,
    });
    assert.equal(decided.ok, true, decided.error || "授权应当通过");
    const exchanged = auth.exchangeCliAuthorization(started.deviceCode);
    assert.equal(exchanged.ok, true, exchanged.error || "换取 token 应当成功");
    return exchanged;
  };
  return { auth, user, home: process.env.AGENTFLOW_HOME, issueCliSession, webToken: login.token };
}

// 绑定一次是要用户开浏览器走一遍授权的。固定 30 天到期意味着每月打断一次接入方的用户；
// 单纯把期限拉长又等于一把丢了能用很久的钥匙。滑动过期两头都好。
test("cli 会话在使用中续期，闲置才过期", async (t) => {
  const { auth, user, home, issueCliSession } = await seed(t);
  const session = issueCliSession("mengmai");

  // 装成上次续期是 20 天前（还没到期，但早过了续期节流窗口）
  const before = Date.now() - 20 * DAY + 30 * DAY;
  patchSession(home, "mengmai", { expiresAt: before });

  const resolved = auth.getAuthUserFromRequest(requestWith(session.token));
  assert.equal(resolved?.userId, user.userId, "会话没过期，必须解析得出用户");

  const after = Number(findSession(home, "mengmai")[1].expiresAt);
  assert.ok(after > before, "用一次就应该把到期时间往后推");
  assert.ok(after - Date.now() > 29 * DAY, `续期后应当还有约 30 天，实际 ${((after - Date.now()) / DAY).toFixed(1)} 天`);
});

test("浏览器会话不滑动，到点就是到点", async (t) => {
  const { auth, user, home, webToken } = await seed(t);
  const session = { token: webToken };
  const sessions = readSessions(home);
  const [key, record] = Object.entries(sessions).find(([, r]) => String(r?.kind) === "web");
  const before = Date.now() + 5 * DAY;
  sessions[key] = { ...record, expiresAt: before };
  writeSessions(home, sessions);

  assert.equal(auth.getAuthUserFromRequest(requestWith(session.token))?.userId, user.userId);
  assert.equal(Number(readSessions(home)[key].expiresAt), before, "web 会话的到期时间不该被动过");
});

// 每个请求都重写整个 sessions.json 太贵——轮询接口一秒钟就好几次。
test("刚续过期的会话不重复写盘", async (t) => {
  const { auth, home, issueCliSession } = await seed(t);
  const session = issueCliSession("mengmai");
  const before = Number(findSession(home, "mengmai")[1].expiresAt);

  for (let i = 0; i < 5; i++) auth.getAuthUserFromRequest(requestWith(session.token));

  assert.equal(Number(findSession(home, "mengmai")[1].expiresAt), before, "一小时内的重复请求不该再写一次");
});

// 过期会话只在它自己的 token 再被用到时才删——线上 86 个里躺着 37 个僵尸。
test("续期时顺手清掉过期的僵尸会话", async (t) => {
  const { auth, home, issueCliSession } = await seed(t);
  const dead = issueCliSession("old");
  const live = issueCliSession("mengmai");

  patchSession(home, "old", { expiresAt: Date.now() - DAY });
  patchSession(home, "mengmai", { expiresAt: Date.now() - 20 * DAY + 30 * DAY });
  assert.equal(Object.keys(readSessions(home)).length, 3, "web + old + mengmai");

  auth.getAuthUserFromRequest(requestWith(live.token));

  const remaining = Object.values(readSessions(home));
  assert.ok(!remaining.some((r) => r.clientName === "old"), "过期的那个应该被清掉");
  assert.ok(remaining.some((r) => r.clientName === "mengmai"), "还在用的那个必须留着");
  assert.ok(dead.token, "被清掉的会话确实存在过");
});
