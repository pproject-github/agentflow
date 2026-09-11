import assert from "node:assert/strict";
import test from "node:test";

import { SCHEDULE_ALERT_REPEAT_MS, decideScheduleAlert, notifyScheduleOutcome } from "../bin/lib/schedule-alerts.mjs";

const HOUR = 60 * 60 * 1000;

function entryFixture(overrides = {}) {
  return {
    key: "wangfang1:user:daily_task:daily",
    userId: "wangfang1",
    flowId: "daily_task",
    flowSource: "user",
    scheduleNodeId: "daily",
    label: "每日任务",
    cron: "0 9 * * *",
    timezone: "Asia/Shanghai",
    ...overrides,
  };
}

function depsFixture(sent, overrides = {}) {
  return {
    readGlobalEnv: () => ({ WECOM_CORP_ID: "x", WECOM_APP_SECRET: "y", WECOM_AGENT_ID: "1", ...overrides.env }),
    readWecomBinding: () => (overrides.binding === undefined ? { wecomUserId: "00320", source: "privilege" } : overrides.binding),
    readAuthUsers: () => ({ wangfang1: { username: "wangfang1" } }),
    sendAppMarkdown: async (params) => { sent.push({ via: "app", ...params }); return { ok: true }; },
    sendGroupMarkdown: async (params) => { sent.push({ via: "group", ...params }); return { ok: true }; },
    ...overrides.deps,
  };
}

// 用户需求点：定时坏了没人知道。线上一条每半小时跑一次的流程连炸两天、126 次失败无人察觉。
// 但每次都发就等于没做——收件人会把这个应用静音。
test("状态从好变坏发一条，持续坏着每天最多补一条", () => {
  const now = Date.parse("2026-09-11T09:00:00+08:00");
  assert.deepEqual(
    decideScheduleAlert({}, "failed", now),
    { kind: "failed", reason: "first_failure" },
  );

  const afterFirst = { lastAlertStatus: "failed", lastFailureAlertAt: now };
  // 同一天内继续失败：闭嘴
  assert.equal(decideScheduleAlert(afterFirst, "failed", now + HOUR).kind, null);
  assert.equal(decideScheduleAlert(afterFirst, "failed", now + 23 * HOUR).reason, "muted_repeat");
  // 满一天：补一条，提醒它还没好
  assert.deepEqual(
    decideScheduleAlert(afterFirst, "failed", now + SCHEDULE_ALERT_REPEAT_MS),
    { kind: "failed", reason: "still_failing" },
  );
});

test("恢复时发一条，一直好着不打扰", () => {
  const now = Date.now();
  assert.deepEqual(
    decideScheduleAlert({ lastAlertStatus: "failed", lastFailureAlertAt: now - HOUR }, "success", now),
    { kind: "recovered", reason: "recovered" },
  );
  assert.equal(decideScheduleAlert({ lastAlertStatus: "success" }, "success", now).kind, null);
  assert.equal(decideScheduleAlert({}, "success", now).kind, null);
});

test("stopped / skipped 不是坏了，不通知", () => {
  for (const status of ["stopped", "skipped", "disabled", "interrupted"]) {
    assert.equal(decideScheduleAlert({}, status).kind, null, `${status} 不该触发通知`);
  }
});

test("失败通知私聊负责人，正文带流程、计划、错误首行和回跳链接", async () => {
  const sent = [];
  const result = await notifyScheduleOutcome({
    entry: entryFixture(),
    status: "failed",
    error: "send wecom app markdown failed: user & party & tag all invalid, hint: [178899...]\n    at run (file:///a/b.mjs:12)",
    publicBaseUrl: "http://ai.mengma.bigo.inner/",
    deps: depsFixture(sent),
  });

  assert.equal(result.sent, true);
  assert.equal(result.via, "app");
  assert.equal(result.toUser, "00320");
  assert.equal(sent.length, 1);
  const markdown = sent[0].markdown;
  assert.match(markdown, /定时任务失败：每日任务/);
  assert.match(markdown, /daily_task · daily/);
  assert.match(markdown, /0 9 \* \* \*/);
  assert.match(markdown, /user & party & tag all invalid/);
  // 堆栈不进正文，第一行就够
  assert.doesNotMatch(markdown, /at run \(file/);
  assert.match(markdown, /http:\/\/ai\.mengma\.bigo\.inner\/workspace\?flowId=daily_task&flowSource=user&focusNodeId=daily/);
  // 通知状态要回写，否则降噪无从判断
  assert.equal(result.alert.lastAlertStatus, "failed");
  assert.ok(result.alert.lastFailureAlertAt > 0);
});

test("owner 没绑定时转给管理员指定的兜底账号，正文写明转发原因", async () => {
  const sent = [];
  const result = await notifyScheduleOutcome({
    entry: entryFixture(),
    status: "failed",
    error: "boom",
    deps: {
      ...depsFixture(sent, { env: { AGENTFLOW_SCHEDULE_ALERT_FALLBACK_USER: "wangfang1" } }),
      // hesiqi 是 owner 但查不到绑定；wangfang1 是兜底账号
      readWecomBinding: (userId) => (userId === "wangfang1" ? { wecomUserId: "00320", source: "privilege" } : null),
      readAuthUsers: () => ({ hesiqi: { username: "hesiqi" }, wangfang1: { username: "wangfang1" } }),
    },
  });
  // owner 自己绑了就直接发给他，不该绕到兜底账号
  assert.equal(result.sent, true);
  assert.equal(result.via, "app");
  assert.doesNotMatch(sent[0].markdown, /转发给你/);

  const forwarded = [];
  const toFallback = await notifyScheduleOutcome({
    entry: entryFixture({ userId: "hesiqi", key: "hesiqi:user:Likee_inapp_feedback_summary:daily", flowId: "Likee_inapp_feedback_summary" }),
    status: "failed",
    error: "send wecom app markdown failed: user & party & tag all invalid",
    deps: {
      ...depsFixture(forwarded, { env: { AGENTFLOW_SCHEDULE_ALERT_FALLBACK_USER: "wangfang1" } }),
      readWecomBinding: (userId) => (userId === "wangfang1" ? { wecomUserId: "00320", source: "privilege" } : null),
      readAuthUsers: () => ({ hesiqi: { username: "hesiqi" }, wangfang1: { username: "wangfang1" } }),
    },
  });
  assert.equal(toFallback.sent, true);
  assert.equal(toFallback.via, "fallback-user");
  assert.equal(toFallback.toUser, "00320");
  // 收件人要能看出这条跟自己什么关系
  assert.match(forwarded[0].markdown, /hesiqi 没有绑定企业微信，转发给你/);
  assert.match(forwarded[0].markdown, /Likee_inapp_feedback_summary/);
});

test("没绑定企微时退回运维群；两者都没有就跳过，而且不推进状态", async () => {
  const sentGroup = [];
  const viaGroup = await notifyScheduleOutcome({
    entry: entryFixture(),
    status: "failed",
    error: "boom",
    deps: depsFixture(sentGroup, {
      binding: null,
      env: { AGENTFLOW_SCHEDULE_ALERT_WEBHOOK: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x" },
    }),
  });
  assert.equal(viaGroup.sent, true);
  assert.equal(viaGroup.via, "group");
  assert.equal(sentGroup[0].webhookUrl.includes("webhook/send"), true);

  const nobody = [];
  const skipped = await notifyScheduleOutcome({
    entry: entryFixture(),
    status: "failed",
    error: "boom",
    deps: depsFixture(nobody, { binding: null }),
  });
  assert.equal(skipped.sent, false);
  assert.equal(skipped.reason, "no_recipient");
  assert.equal(nobody.length, 0);
  // 没人收到就不算通知过：等这个人绑定了企微，下一次失败要从头提醒
  assert.equal(skipped.alert, undefined);
});

test("投递失败不抛异常，但状态照样推进，免得每次运行都重试把降噪绕过去", async () => {
  const result = await notifyScheduleOutcome({
    entry: entryFixture(),
    status: "failed",
    error: "boom",
    deps: depsFixture([], {
      deps: { sendAppMarkdown: async () => { throw new Error("invalid webhook url"); } },
    }),
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "send_failed");
  assert.match(result.error, /invalid webhook url/);
  assert.equal(result.alert.lastAlertStatus, "failed");
});

// 配置的位置和读取的位置必须一致：文档让人在管理后台填，代码却只读 process.env 的话，
// 页面上填了也不生效，而且没有任何报错——只是通知里悄悄少了链接。
test("回跳链接认管理后台里配的站点地址", async () => {
  const sent = [];
  const result = await notifyScheduleOutcome({
    entry: entryFixture(),
    status: "failed",
    error: "boom",
    deps: depsFixture(sent, { env: { AGENTFLOW_PUBLIC_BASE_URL: "http://ai.mengma.bigo.inner/" } }),
  });
  assert.equal(result.sent, true);
  assert.match(sent[0].markdown, /http:\/\/ai\.mengma\.bigo\.inner\/workspace\?flowId=daily_task/);
});

test("全局开关关掉后一条都不发", async () => {
  const sent = [];
  const result = await notifyScheduleOutcome({
    entry: entryFixture(),
    status: "failed",
    error: "boom",
    deps: depsFixture(sent, { env: { AGENTFLOW_SCHEDULE_ALERTS: "off" } }),
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "disabled");
  assert.equal(sent.length, 0);
});

// 用户需求点：一条 */30 的流程一天 48 次失败。模拟两天，确认收到的是 2 条而不是 96 条。
test("连炸两天只发两条，恢复时再发一条", async () => {
  const sent = [];
  let entry = entryFixture();
  const deps = depsFixture(sent);
  const start = Date.parse("2026-09-09T00:00:00+08:00");

  for (let i = 0; i < 96; i += 1) {
    const now = start + i * 30 * 60 * 1000;
    const result = await notifyScheduleOutcome({ entry, status: "failed", error: "boom", now, deps });
    if (result.alert) entry = { ...entry, alert: result.alert };
  }
  assert.equal(sent.length, 2, `两天 96 次失败应该只发 2 条，实际 ${sent.length}`);
  assert.match(sent[1].markdown, /持续失败中/);

  const recovered = await notifyScheduleOutcome({
    entry,
    status: "success",
    now: start + 96 * 30 * 60 * 1000,
    deps,
  });
  assert.equal(recovered.sent, true);
  assert.equal(recovered.kind, "recovered");
  assert.match(sent[2].markdown, /已恢复/);

  // 恢复之后再失败，算新的一轮，立刻通知
  const next = await notifyScheduleOutcome({
    entry: { ...entry, alert: recovered.alert },
    status: "failed",
    error: "boom",
    now: start + 97 * 30 * 60 * 1000,
    deps,
  });
  assert.equal(next.reason, "first_failure");
  assert.equal(sent.length, 4);
});
