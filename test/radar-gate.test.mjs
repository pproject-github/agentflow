import assert from "node:assert/strict";
import test from "node:test";

import { applyGate, classifyChange } from "../bin/lib/radar-gate.mjs";

const ctx = (fields = []) => ({ humanFields: new Set(fields) });

/**
 * 门禁规则是从 decideRadarAlert 反推的：会让一条条目从此不再出声的改动要审批。
 * 这一组用例就是把那三条静音路径逐条钉住。
 */
test("改成 ok 要审批——它会关掉这条的告警", () => {
  const verdict = classifyChange({ kind: "state", id: "a", from: "risk", to: "ok" }, ctx());
  assert.equal(verdict.gate, "review");
  assert.match(verdict.reason, /关掉这条的告警/);
});

// 误报只花注意力，漏报会让违规的包发出去——所以不对称是有意的
test("状态变坏直接落地，收紧不需要证据", () => {
  for (const to of ["warn", "risk", "idle"]) {
    assert.equal(classifyChange({ kind: "state", id: "a", from: "ok", to }, ctx()).gate, "auto");
  }
});

test("清空截止日要审批——阈值提醒从此不触发", () => {
  const verdict = classifyChange({ kind: "due", id: "a", from: "2026-10-31", to: "" }, ctx());
  assert.equal(verdict.gate, "review");
  assert.match(verdict.reason, /阈值提醒不再触发/);
});

test("推后截止日要审批，提前或补齐不用", () => {
  assert.equal(classifyChange({ kind: "due", id: "a", from: "2026-10-01", to: "2026-12-01" }, ctx()).gate, "review");
  assert.equal(classifyChange({ kind: "due", id: "a", from: "2026-12-01", to: "2026-10-01" }, ctx()).gate, "auto");
  assert.equal(classifyChange({ kind: "due", id: "a", from: "", to: "2026-10-01" }, ctx()).gate, "auto");
});

test("封存要审批，解除封存不用", () => {
  assert.equal(classifyChange({ kind: "settled", id: "a", to: true }, ctx()).gate, "review");
  assert.equal(classifyChange({ kind: "settled", id: "a", to: false }, ctx()).gate, "auto");
});

test("条目消失要审批——那是停止追踪", () => {
  assert.equal(classifyChange({ kind: "dropped", id: "a" }, ctx()).gate, "review");
});

// 新条目没有历史可覆盖，也没有告警可关，所有拦截条件天然不成立
test("新增条目直接落地", () => {
  assert.equal(classifyChange({ kind: "added", id: "a", state: "warn" }, ctx(["a:state"])).gate, "auto");
});

test("描述性字段直接落地——没有告警吃它们", () => {
  assert.equal(classifyChange({ kind: "current", id: "a", from: "x", to: "y" }, ctx()).gate, "auto");
});

test("上次由人改的字段被改回去要审批", () => {
  const verdict = classifyChange({ kind: "current", id: "a", from: "x", to: "y" }, ctx(["a:current"]));
  assert.equal(verdict.gate, "review");
  assert.match(verdict.reason, /上次由人改的 current/);
});

// 一条待审批不该把同一条目上其它本该落地的改动一起卡住，否则板照样是旧的
test("只回退被拦的字段，同条目其它改动照常落地", () => {
  const previous = { rows: [{ id: "a", state: "risk", current: "旧", due: "2026-10-01" }] };
  const next = [{ id: "a", state: "ok", current: "新", due: "2026-10-01" }];
  const events = [
    { kind: "state", id: "a", from: "risk", to: "ok" },
    { kind: "current", id: "a", from: "旧", to: "新" },
  ];
  const { rows, applied, held } = applyGate(previous, next, events, ctx());
  assert.equal(rows[0].state, "risk", "被拦的 state 回退");
  assert.equal(rows[0].current, "新", "没被拦的 current 落地");
  assert.deepEqual(applied.map((item) => item.kind), ["current"]);
  assert.deepEqual(held.map((item) => item.kind), ["state"]);
});

// 等审批期间条目已经不见了的话，人打开板都找不到它
test("被拦下的「条目消失」要把它留在板上", () => {
  const previous = { rows: [{ id: "gone", state: "warn", title: "要消失的" }] };
  const { rows, held } = applyGate(previous, [], [{ kind: "dropped", id: "gone" }], ctx());
  assert.deepEqual(rows.map((row) => row.id), ["gone"]);
  assert.equal(held.length, 1);
});

test("不开门禁时一切照旧落地", () => {
  const events = [{ kind: "state", id: "a", from: "risk", to: "ok" }];
  const { held } = applyGate({ rows: [] }, [{ id: "a", state: "ok" }], [], ctx());
  assert.deepEqual(held, [], "没有事件就没有拦截");
  assert.equal(applyGate({ rows: [{ id: "a", state: "risk" }] }, [{ id: "a", state: "ok" }], events, ctx()).held.length, 1);
});
