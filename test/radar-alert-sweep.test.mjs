import assert from "node:assert/strict";
import test from "node:test";

import { resolveRecipients, sweepRadarBoard } from "../bin/lib/radar-alert-sweep.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-11T09:00:00+08:00");

const BINDINGS = {
  xingqiwei: { wecomUserId: "00111", source: "privilege" },
  wangfang1: { wecomUserId: "00320", source: "privilege" },
};

function harness(rows, overrides = {}) {
  const sent = [];
  let written = null;
  return {
    sent,
    get written() { return written; },
    deps: {
      readGlobalEnv: () => ({
        WECOM_CORP_ID: "x", WECOM_APP_SECRET: "y", WECOM_AGENT_ID: "1",
        AGENTFLOW_SCHEDULE_ALERT_FALLBACK_USER: "wangfang1",
        AGENTFLOW_SCHEDULE_ALERT_WEBHOOK: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x",
        ...overrides.env,
      }),
      readRadarBoard: () => (overrides.board === null ? null : { board: "compliance", title: "发版合规", rows }),
      readAlertStates: () => overrides.states || {},
      writeAlertStates: (_board, states) => { written = states; },
      readAuthUsers: () => ({ xingqiwei: { username: "xingqiwei" }, hesiqi: { username: "hesiqi" } }),
      readWecomBinding: (userId) => (overrides.bindings === undefined ? BINDINGS[userId] : overrides.bindings[userId]) || null,
      sendAppMarkdown: async (params) => { sent.push({ via: "app", ...params }); },
      sendGroupMarkdown: async (params) => { sent.push({ via: "group", ...params }); },
      ...overrides.deps,
    },
  };
}

function row(extra = {}) {
  return {
    id: "play-target-36", title: "Play 目标 API 36", state: "warn",
    owner: "xingqiwei", daysLeft: 5, overdue: false, settled: false,
    current: "targetSdk 35", required: "targetSdk 36",
    ...extra,
  };
}

test("只有未完成的会被发出去", async () => {
  const h = harness([
    row(),
    row({ id: "done-one", state: "ok", daysLeft: 2 }),
    row({ id: "settled-one", settled: true, daysLeft: 1 }),
  ]);
  const result = await sweepRadarBoard("compliance", { now: NOW, deps: h.deps });
  assert.deepEqual(result.sent.map((item) => item.id), ["play-target-36"]);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].markdown, /还剩 5 天/);
  assert.equal(h.sent[0].toUser, "00111");
});

test("截止日之前只发负责人，不进群", async () => {
  const h = harness([row({ daysLeft: 5 })]);
  await sweepRadarBoard("compliance", { now: NOW, deps: h.deps });
  assert.deepEqual(h.sent.map((item) => item.via), ["app"]);
});

// 过期之后是升级，不是重复：同一条消息同时到私聊和群里
test("过期之后收件人扩大到兜底账号和群", async () => {
  const h = harness([row({ overdue: true, daysLeft: -3 })]);
  const result = await sweepRadarBoard("compliance", { now: NOW, deps: h.deps });
  assert.equal(result.sent[0].kind, "overdue");
  assert.deepEqual(result.sent[0].to, ["owner", "fallback"]);
  assert.deepEqual(h.sent.map((item) => item.via), ["app", "app", "group"]);
  assert.deepEqual(h.sent.filter((item) => item.via === "app").map((item) => item.toUser), ["00111", "00320"]);
});

// 「没人绑定也别把通知丢了」是这条链存在的全部意义
test("负责人没绑企微时落到兜底账号，并写明转发原因", async () => {
  const h = harness([row({ owner: "hesiqi", daysLeft: 5 })]);
  await sweepRadarBoard("compliance", { now: NOW, deps: h.deps });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].toUser, "00320");
  assert.match(h.sent[0].markdown, /hesiqi 没有绑定企业微信，转发给你/);
});

test("三级都没有收件人时不算通知过，状态不推进", async () => {
  const h = harness([row({ owner: "nobody", daysLeft: 5 })], {
    bindings: {},
    env: { AGENTFLOW_SCHEDULE_ALERT_FALLBACK_USER: "", AGENTFLOW_SCHEDULE_ALERT_WEBHOOK: "" },
  });
  const result = await sweepRadarBoard("compliance", { now: NOW, deps: h.deps });
  assert.equal(result.sent[0].reason, "no_recipient");
  assert.equal(h.sent.length, 0);
  // 没写状态：等这个人绑定了企微，下一次要从头提醒
  assert.equal(h.written, null);
});

// 投递失败就重试的话，每次扫描都会再发一遍，降噪整个被绕过去
test("投递失败不抛异常，状态照样推进", async () => {
  const h = harness([row({ daysLeft: 5 })], {
    deps: { sendAppMarkdown: async () => { throw new Error("invalid webhook"); } },
  });
  const result = await sweepRadarBoard("compliance", { now: NOW, deps: h.deps });
  assert.equal(result.sent[0].ok, false);
  assert.match(result.sent[0].error, /invalid webhook/);
  assert.ok(h.written["play-target-36"]);
});

test("扫两遍只发一条：第二遍读到的是第一遍写回的状态", async () => {
  const first = harness([row({ daysLeft: 5 })]);
  await sweepRadarBoard("compliance", { now: NOW, deps: first.deps });
  assert.equal(first.sent.length, 1);

  const second = harness([row({ daysLeft: 4 })], { states: first.written });
  await sweepRadarBoard("compliance", { now: NOW + 60 * 60 * 1000, deps: second.deps });
  assert.equal(second.sent.length, 0);
});

test("板上已经没有的条目，告警状态顺手清掉", async () => {
  const h = harness([row({ daysLeft: 5 })], {
    states: { "gone-item": { lastKind: "threshold", lastAt: NOW - DAY } },
  });
  await sweepRadarBoard("compliance", { now: NOW, deps: h.deps });
  assert.equal("gone-item" in h.written, false);
  assert.ok("play-target-36" in h.written);
});

test("全局开关关掉后一条都不发", async () => {
  const h = harness([row({ overdue: true, daysLeft: -3 })], { env: { AGENTFLOW_RADAR_ALERTS: "off" } });
  const result = await sweepRadarBoard("compliance", { now: NOW, deps: h.deps });
  assert.equal(result.skipped, "disabled");
  assert.equal(h.sent.length, 0);
});

test("板不存在时安静返回，不炸", async () => {
  const h = harness([], { board: null });
  assert.equal((await sweepRadarBoard("nope", { now: NOW, deps: h.deps })).skipped, "no_board");
});

test("收件人解析：owner 绑了就不必然扩散到兜底", () => {
  const resolved = resolveRecipients(["owner"], {
    owner: "xingqiwei",
    env: { AGENTFLOW_SCHEDULE_ALERT_FALLBACK_USER: "wangfang1" },
    deps: { readWecomBinding: (id) => BINDINGS[id] || null },
  });
  assert.deepEqual(resolved.users.map((user) => user.via), ["owner"]);
  assert.equal(resolved.ownerUnbound, false);
  assert.equal(resolved.webhook, "");
});
