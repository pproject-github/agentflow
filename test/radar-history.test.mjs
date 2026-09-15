import assert from "node:assert/strict";
import test from "node:test";
import { stateHistory } from "../bin/lib/radar.mjs";

/**
 * 状态页右边那串小方块的原料。
 *
 * 变更流只记变化不记每次扫描，所以历史是从「现在」倒推出来的。推错一格，
 * 人看到的就是「这条昨天还好好的」——而它其实三周没动过。
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-15T12:00:00+08:00").getTime();
const ago = (d) => new Date(NOW - d * DAY).toISOString();

test("没有事件的条目：整段都是当前状态", () => {
  const h = stateHistory([{ id: "a", state: "ok" }], [], { days: 5, now: NOW });
  assert.deepEqual(h.get("a"), ["ok", "ok", "ok", "ok", "ok"]);
});

test("状态变过：变之前是 from，之后是现在", () => {
  const h = stateHistory(
    [{ id: "a", state: "ok" }],
    [{ id: "a", kind: "state", at: ago(2), from: "warn", to: "ok" }],
    { days: 5, now: NOW },
  );
  assert.deepEqual(h.get("a"), ["warn", "warn", "ok", "ok", "ok"]);
});

test("入库之前是空格，不是「无状态」", () => {
  // 带一条老条目当锚，否则前面全空的那几天会被整体砍掉（见文件末尾那条）
  const h = stateHistory(
    [{ id: "old", state: "ok" }, { id: "a", state: "warn" }],
    [{ id: "a", kind: "added", at: ago(1), state: "warn" }],
    { days: 5, now: NOW },
  );
  assert.deepEqual(h.get("a"), ["", "", "", "warn", "warn"]);
});

test("多次变化按时间倒推", () => {
  const h = stateHistory(
    [{ id: "old", state: "ok" }, { id: "a", state: "ok" }],
    [
      { id: "a", kind: "state", at: ago(1), from: "warn", to: "ok" },
      { id: "a", kind: "state", at: ago(3), from: "risk", to: "warn" },
      { id: "a", kind: "added", at: ago(4), state: "risk" },
    ],
    { days: 6, now: NOW },
  );
  //          -5    -4      -3      -2      -1    今天
  assert.deepEqual(h.get("a"), ["", "risk", "warn", "warn", "ok", "ok"]);
});

test("别的条目的事件不串行", () => {
  const h = stateHistory(
    [{ id: "a", state: "ok" }, { id: "b", state: "risk" }],
    [{ id: "b", kind: "state", at: ago(2), from: "ok", to: "risk" }],
    { days: 4, now: NOW },
  );
  assert.deepEqual(h.get("a"), ["ok", "ok", "ok", "ok"]);
  // 事件发生在 -2 那天的中午，所以**那天结束时**已经是 risk 了
  assert.deepEqual(h.get("b"), ["ok", "risk", "risk", "risk"]);
});

test("整块板都还不存在的那几天一起砍掉", () => {
  const h = stateHistory(
    [{ id: "a", state: "ok" }, { id: "b", state: "warn" }],
    [
      { id: "a", kind: "added", at: ago(1), state: "ok" },
      { id: "b", kind: "added", at: ago(1), state: "warn" },
    ],
    { days: 14, now: NOW },
  );
  // 14 天里 12 天整块板都不存在 —— 条上只剩两格有色，看起来像渲染坏了
  assert.deepEqual(h.get("a"), ["ok", "ok"]);
  assert.deepEqual(h.get("b"), ["warn", "warn"]);
});

test("只要有一行存在，那一天就留着——各行窗口必须一样宽", () => {
  const h = stateHistory(
    [{ id: "old", state: "ok" }, { id: "new", state: "warn" }],
    [{ id: "new", kind: "added", at: ago(1), state: "warn" }],
    { days: 4, now: NOW },
  );
  assert.equal(h.get("old").length, 4);
  assert.equal(h.get("new").length, 4);
  assert.deepEqual(h.get("new"), ["", "", "warn", "warn"]);
});
