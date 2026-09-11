import assert from "node:assert/strict";
import test from "node:test";

import {
  OVERRIDE_CONFLICT_GRACE_MS,
  decideRadarAlert,
  nextRadarAlertState,
  radarAlertText,
} from "../bin/lib/radar-alerts.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-11T09:00:00+08:00");

function row(overrides = {}) {
  return {
    id: "play-target-36",
    title: "Play 目标 API 36",
    state: "warn",
    owner: "xingqiwei",
    daysLeft: 120,
    overdue: false,
    settled: false,
    current: "targetSdk 35",
    required: "targetSdk 36",
    ...overrides,
  };
}

// 用户要求的那条线：只有未完成的才告警。催一件已经做完的事，是让人静音这个应用最快的方式
test("已完成的不告警，不管离截止日多近、过期多久", () => {
  for (const extra of [{ daysLeft: 1 }, { daysLeft: -300, overdue: false }]) {
    assert.equal(decideRadarAlert(row({ state: "ok", ...extra }), {}, NOW).kind, null);
  }
});

test("人工封存的不告警", () => {
  assert.equal(decideRadarAlert(row({ settled: true, overdue: true, daysLeft: -5 }), {}, NOW).reason, "settled");
});

test("从未完成变成完成时补一条「好了」，然后闭嘴", () => {
  const cleared = decideRadarAlert(row({ state: "ok" }), { lastAlertState: "warn", lastKind: "threshold" }, NOW);
  assert.equal(cleared.kind, "cleared");
  // 再跑一次不该重复发
  const after = nextRadarAlertState(cleared, row({ state: "ok" }), { lastAlertState: "warn" }, NOW);
  assert.equal(decideRadarAlert(row({ state: "ok" }), after, NOW).kind, null);
  // 清空档位：日期被推后、重新变回未完成时，要能从头提醒一轮
  assert.deepEqual(after.sentThresholds, []);
});

test("跨过 T-90 / T-30 / T-7 各提醒一次，其余时间闭嘴", () => {
  let alert = {};
  assert.equal(decideRadarAlert(row({ daysLeft: 120 }), alert, NOW).kind, null);

  const first = decideRadarAlert(row({ daysLeft: 88 }), alert, NOW);
  assert.equal(first.kind, "threshold");
  assert.equal(first.threshold, 90);
  alert = nextRadarAlertState(first, row({ daysLeft: 88 }), alert, NOW);

  // 同一档内不再响
  assert.equal(decideRadarAlert(row({ daysLeft: 61 }), alert, NOW).kind, null);

  const second = decideRadarAlert(row({ daysLeft: 22 }), alert, NOW);
  assert.equal(second.threshold, 30);
  alert = nextRadarAlertState(second, row({ daysLeft: 22 }), alert, NOW);

  const third = decideRadarAlert(row({ daysLeft: 3 }), alert, NOW);
  assert.equal(third.threshold, 7);
  alert = nextRadarAlertState(third, row({ daysLeft: 3 }), alert, NOW);
  assert.equal(decideRadarAlert(row({ daysLeft: 1 }), alert, NOW).kind, null);
});

// 半路接手的条目：不该先补一条 T-90 再补 T-30，人只会觉得这系统在刷屏
test("一次跨过好几档时只发最紧的那档，更大的档位一并记掉", () => {
  const decision = decideRadarAlert(row({ daysLeft: 5 }), {}, NOW);
  assert.equal(decision.threshold, 7);
  const after = nextRadarAlertState(decision, row({ daysLeft: 5 }), {}, NOW);
  assert.deepEqual(after.sentThresholds, [90, 30, 7]);
  assert.equal(decideRadarAlert(row({ daysLeft: 2 }), after, NOW).kind, null);
});

// 过期之前降噪是为了别让人静音；过期之后升噪是因为它真的在烧
test("过期当天发一条并扩大收件人，之后每天一条", () => {
  const overdue = row({ overdue: true, daysLeft: -1 });
  const first = decideRadarAlert(overdue, { lastKind: "threshold", sentThresholds: [90, 30, 7] }, NOW);
  assert.equal(first.kind, "overdue");
  assert.deepEqual(first.recipients, ["owner", "fallback", "group"]);

  let alert = nextRadarAlertState(first, overdue, {}, NOW);
  // 同一天内不重复
  assert.equal(decideRadarAlert(overdue, alert, NOW + 3 * 60 * 60 * 1000).kind, null);
  // 隔天再来一条
  const daily = decideRadarAlert(overdue, alert, NOW + DAY);
  assert.equal(daily.kind, "overdue_daily");
  assert.deepEqual(daily.recipients, ["owner", "fallback", "group"]);

  alert = nextRadarAlertState(daily, overdue, alert, NOW + DAY);
  assert.equal(decideRadarAlert(overdue, alert, NOW + DAY + 60_000).kind, null);
  assert.equal(decideRadarAlert(overdue, alert, NOW + 2 * DAY).kind, "overdue_daily");
});

test("截止日之前只发给负责人，不扩散", () => {
  assert.deepEqual(decideRadarAlert(row({ daysLeft: 5 }), {}, NOW).recipients, ["owner"]);
});

// 人的判断优先，但不能让一次点击永久掩盖一次真实退化
test("人标了已完成、脚本说没有：先不打扰，挂太久才提醒本人复核", () => {
  const conflicted = row({
    state: "ok",
    observedState: "risk",
    overrideConflict: true,
    override: { state: "ok", by: "xingqiwei", at: new Date(NOW - DAY).toISOString() },
  });
  // 刚标完，尊重人
  assert.equal(decideRadarAlert(conflicted, {}, NOW).reason, "override_ok");

  const stale = {
    ...conflicted,
    override: { ...conflicted.override, at: new Date(NOW - OVERRIDE_CONFLICT_GRACE_MS - DAY).toISOString() },
  };
  const nudge = decideRadarAlert(stale, {}, NOW);
  assert.equal(nudge.kind, "override_conflict");
  assert.deepEqual(nudge.recipients, ["owner"]);
  // 只提醒一次，不反复烦
  assert.equal(decideRadarAlert(stale, { lastKind: "override_conflict" }, NOW).kind, null);
});

test("人把状态改成未完成时，照常按未完成告警", () => {
  const reopened = row({
    state: "risk",
    observedState: "ok",
    overrideConflict: true,
    override: { state: "risk", by: "wangfang1", at: new Date(NOW).toISOString() },
    daysLeft: 3,
  });
  assert.equal(decideRadarAlert(reopened, {}, NOW).kind, "threshold");
});

test("没有截止日期的条目不按天数告警", () => {
  assert.equal(decideRadarAlert(row({ daysLeft: null }), {}, NOW).reason, "no_due");
});

test("正文说清楚为什么现在收到这条", () => {
  const decision = decideRadarAlert(row({ daysLeft: 5, effectiveTrain: "v43.0" }), {}, NOW);
  const text = radarAlertText(decision, row({ daysLeft: 5, effectiveTrain: "v43.0" }), { title: "发版合规" });
  assert.match(text, /还剩 5 天：Play 目标 API 36/);
  assert.match(text, /负责人：xingqiwei/);
  assert.match(text, /targetSdk 35/);
  assert.match(text, /v43\.0 封包/);

  const overdueText = radarAlertText({ kind: "overdue" }, row({ overdue: true, daysLeft: -9 }), {});
  assert.match(overdueText, /已经过期 9 天/);

  const conflictText = radarAlertText(
    { kind: "override_conflict" },
    row({ observedState: "risk", override: { at: "2026-08-01T00:00:00Z" } }),
    {},
  );
  assert.match(conflictText, /标记与扫描结果不符/);
  assert.match(conflictText, /2026-08-01/);
  assert.match(conflictText, /是扫描规则该改，还是这一条其实退回去了/);

  assert.match(radarAlertText({ kind: "cleared" }, row({ state: "ok" }), {}), /不用再管了/);
});
