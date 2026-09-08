import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRunAuditTrace,
  buildRunInspectorTurns,
  buildRunStateSnapshot,
  normalizeRunInspectorEvents,
  runInspectorTimelineRows,
} from "../builtin/web-ui/src/lib/runInspectorModel.js";

test("Run Inspector keeps workflow nodes and scripts separate from Agent model Turns", () => {
  const startedAt = Date.parse("2026-08-26T10:00:00.000Z");
  const events = [
    { type: "run-start", scheduled: true, trigger: "scheduled", ts: startedAt },
    { type: "scheduler-triggered", scheduleNodeId: "schedule", runNodeId: "run", ts: startedAt + 100 },
    { type: "node-start", nodeId: "agent", definitionId: "agent_subAgent", ts: startedAt + 1_000 },
    { type: "natural", kind: "thinking", nodeId: "agent", text: "检查输入", ts: startedAt + 1_500 },
    { type: "node-done", nodeId: "agent", definitionId: "agent_subAgent", ts: startedAt + 4_000 },
    { type: "node-start", nodeId: "script", definitionId: "tool_nodejs", ts: startedAt + 4_100 },
    { type: "script-start", nodeId: "script", script: "npm test", cwd: "/tmp/run", status: "running", ts: startedAt + 4_200 },
    { type: "script-finish", nodeId: "script", stdout: "ok", exitCode: 0, durationMs: 2_000, status: "success", ts: startedAt + 6_200 },
    { type: "node-done", nodeId: "script", definitionId: "tool_nodejs", ts: startedAt + 6_300 },
    { type: "run-finish", status: "success", durationMs: 6_500, ts: startedAt + 6_500 },
  ];
  const run = { runId: "scheduled-1", scheduled: true, trigger: "scheduled", startedAt, endedAt: startedAt + 6_500, status: "success" };
  const trace = buildRunAuditTrace(events, run, startedAt + 7_000);
  assert.deepEqual(trace.nodes.map((node) => node.label), ["agent_subAgent", "tool_nodejs"]);
  assert.equal(trace.turns.length, 0);
  const script = trace.spans.find((span) => span.kind === "script");
  assert.equal(script.script, "npm test");
  assert.equal(script.stdout, "ok");
  const timeline = runInspectorTimelineRows(trace.spans, trace);
  assert.equal(timeline.find((span) => span.kind === "script").offsetPct > 0, true);
});

test("Run Inspector reconstructs Session, Model Turns and paired Tool Calls from raw Cursor events", () => {
  const startedAt = Date.parse("2026-08-27T01:45:00.000Z");
  const raw = (nodeId, ts, payload) => ({ type: "raw", nodeId, ts, text: JSON.stringify(payload) });
  const events = [
    { type: "run-start", ts: startedAt, status: "running" },
    { type: "node-start", nodeId: "agent", definitionId: "agent_subAgent", ts: startedAt + 100 },
    raw("agent", startedAt + 200, { type: "system", subtype: "init", session_id: "session-1", model: "Composer 2.5" }),
    raw("agent", startedAt + 300, { type: "thinking", subtype: "delta", session_id: "session-1", text: "先读取上下文" }),
    raw("agent", startedAt + 400, { type: "assistant", session_id: "session-1", model_call_id: "model-1", message: { content: [{ type: "text", text: "读取文件" }] } }),
    raw("agent", startedAt + 500, { type: "tool_call", subtype: "started", session_id: "session-1", model_call_id: "model-1", call_id: "tool-read", tool_call: { readToolCall: { startedAtMs: startedAt + 500, args: { path: "references/history.md" } } } }),
    raw("agent", startedAt + 800, { type: "tool_call", subtype: "completed", session_id: "session-1", model_call_id: "model-1", call_id: "tool-read", tool_call: { readToolCall: { startedAtMs: startedAt + 500, completedAtMs: startedAt + 800, args: { path: "references/history.md" }, result: { success: { totalLines: 20 } } } } }),
    raw("agent", startedAt + 900, { type: "tool_call", subtype: "started", session_id: "session-1", model_call_id: "model-1", call_id: "tool-orphan", tool_call: { readToolCall: { startedAtMs: startedAt + 900, args: { path: "SKILL.md" } } } }),
    raw("agent", startedAt + 1_000, { type: "thinking", subtype: "delta", session_id: "session-1", text: "生成结果" }),
    raw("agent", startedAt + 1_200, { type: "assistant", session_id: "session-1", model_call_id: "model-2", message: { content: [{ type: "text", text: "完成" }] } }),
    raw("agent", startedAt + 1_300, { type: "result", subtype: "success", session_id: "session-1", duration_ms: 1_100, usage: { input_tokens: 10, output_tokens: 5 } }),
    { type: "node-done", nodeId: "agent", definitionId: "agent_subAgent", ts: startedAt + 1_400, status: "success" },
    { type: "run-finish", ts: startedAt + 1_500, status: "success" },
  ];
  const run = { runId: "run-1", startedAt, endedAt: startedAt + 1_500, status: "success" };
  const trace = buildRunAuditTrace(events, run);
  assert.equal(trace.attempts.length, 1);
  assert.deepEqual(trace.sessions.map((session) => session.label), ["Composer 2.5 Session"]);
  assert.deepEqual(trace.turns.map((turn) => turn.modelCallId), ["model-1", "model-2"]);
  assert.equal(trace.turns[0].children.filter((span) => span.kind === "tool").length, 2);
  assert.equal(trace.turns[0].children.find((span) => span.callId === "tool-read").path, "references/history.md");
  assert.equal(trace.gaps.length, 1);
  assert.match(trace.gaps[0].incompleteReason, /tool-orphan/);
  assert.equal(buildRunInspectorTurns(events, run).length, 2);
});

test("Run Inspector extracts commands from raw agent events without losing the original event", () => {
  const [event] = normalizeRunInspectorEvents([{
    type: "raw",
    source: "codex",
    eventType: "item.completed:command_execution",
    text: JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm test", exit_code: 1 } }),
    ts: 100,
  }]);
  assert.equal(event.command, "npm test");
  assert.equal(event.exitCode, 1);
  assert.equal(event.status, "error");
  assert.equal(event.source.type, "raw");
});

test("Run Inspector exposes Agent looping recovery and safe retry decisions", () => {
  const events = normalizeRunInspectorEvents([
    {
      type: "agent-retry",
      nodeId: "agent",
      category: "agent_looping",
      strategy: "new-turn",
      status: "retrying",
      message: "Started one clean Turn.",
      ts: 100,
    },
    {
      type: "agent-recovery",
      nodeId: "agent",
      category: "agent_looping",
      strategy: "reuse-result-file",
      resultFile: "outputs/result.html",
      status: "success",
      message: "Recovered outputs/result.html without replaying the node.",
      ts: 200,
    },
  ]);
  assert.deepEqual(events.map((event) => event.label), ["Agent 新 Attempt", "恢复 Agent 产物"]);
  assert.deepEqual(events.map((event) => event.status), ["retrying", "success"]);
  assert.match(events[1].text, /outputs\/result\.html/);
});

test("Run State projects graph nodes, progress, waiting state and pending nodes", () => {
  const startedAt = 1_000;
  const flowNodes = [
    { id: "plan", data: { label: "Plan" } },
    { id: "review", data: { label: "用户确认" } },
    { id: "publish", data: { label: "发布" } },
  ];
  const events = [
    { type: "run-start", status: "running", ts: startedAt },
    { type: "node-start", nodeId: "plan", definitionId: "plan", ts: startedAt + 10 },
    { type: "node-done", nodeId: "plan", definitionId: "plan", status: "success", ts: startedAt + 100 },
    { type: "node-start", nodeId: "review", definitionId: "review", status: "running", ts: startedAt + 110 },
    { type: "node-waiting", nodeId: "review", definitionId: "review", status: "waiting", ts: startedAt + 120 },
  ];
  const state = buildRunStateSnapshot(events, { runId: "r-1", status: "waiting", startedAt }, flowNodes, [], startedAt + 200);
  assert.equal(state.status, "waiting");
  assert.deepEqual(state.progress, { completed: 1, total: 3, percent: 33 });
  assert.deepEqual(state.currentStage, { id: "review", label: "用户确认", status: "waiting" });
  assert.deepEqual(state.waiting, [{ id: "review", label: "用户确认" }]);
  assert.deepEqual(state.pending, [{ id: "publish", label: "发布" }]);
  assert.deepEqual(state.stages.map((stage) => stage.status), ["success", "waiting", "pending"]);
});

test("Run trigger nodes do not appear as an executing stage or inflate progress", () => {
  const flowNodes = [
    { id: "run", data: { label: "Run", definitionId: "workspace_run" } },
    { id: "plan", data: { label: "Plan", definitionId: "provide_str" } },
    { id: "finish", data: { label: "完成", definitionId: "display_markdown" } },
  ];
  const events = [
    { type: "run-start", nodeId: "run", status: "running", ts: 10 },
    { type: "node-start", nodeId: "plan", definitionId: "provide_str", ts: 20 },
    { type: "node-done", nodeId: "plan", definitionId: "provide_str", status: "success", ts: 30 },
    { type: "run-finish", nodeId: "run", status: "success", ts: 40 },
  ];
  const state = buildRunStateSnapshot(events, { runId: "trigger-1", status: "success", startedAt: 10, endedAt: 40 }, flowNodes);
  assert.equal(state.status, "success");
  // finish 一个事件都没有：它不在这次 Run 的执行计划里，不该占进度分母。
  assert.deepEqual(state.progress, { completed: 1, total: 1, percent: 100 });
  assert.equal(state.stages.find((stage) => stage.id === "finish").status, "not_run");
  assert.equal(state.currentStage.id, "plan");
  assert.equal(state.currentStage.status, "success");
  assert.equal(state.stages.some((stage) => stage.id === "run"), false);
});

test("Run State handles failed and skipped stages without exposing secret values", () => {
  const flowNodes = [{ id: "a", data: { label: "A" } }, { id: "b", data: { label: "B" } }];
  const events = [
    { type: "node-start", nodeId: "a", ts: 10 },
    { type: "node-error", nodeId: "a", status: "error", text: "token=do-not-leak", ts: 20 },
    { type: "node-skipped", nodeId: "b", status: "skipped", ts: 30 },
  ];
  const state = buildRunStateSnapshot(events, { runId: "r-2", status: "failed", startedAt: 0, endedAt: 40 }, flowNodes);
  assert.equal(state.status, "error");
  assert.deepEqual(state.stages.map((stage) => stage.status), ["error", "skipped"]);
  assert.equal(JSON.stringify(state).includes("do-not-leak"), false);
  assert.equal(state.lastEvent.type, "node-skipped");
});

test("Run State remains renderable before the first event arrives", () => {
  const state = buildRunStateSnapshot([], { runId: "queued-1", status: "queued", startedAt: 100 }, [{ id: "first", data: { label: "第一阶段" } }], [], 200);
  assert.equal(state.status, "pending");
  assert.deepEqual(state.progress, { completed: 0, total: 1, percent: 0 });
  assert.deepEqual(state.pending, [{ id: "first", label: "第一阶段" }]);
  assert.equal(state.lastEvent, null);
});

test("Run-level failure closes an active stage when node-error is missing", () => {
  const state = buildRunStateSnapshot([
    { type: "run-start", status: "running", ts: 10 },
    { type: "node-start", nodeId: "agent", definitionId: "agent_subAgent", ts: 20 },
    { type: "error", status: "error", message: "authentication required", ts: 30 },
  ], { runId: "failed-1", status: "failed", startedAt: 10, endedAt: 30 }, [
    { id: "agent", data: { label: "子 Agent" } },
  ]);
  assert.equal(state.status, "error");
  assert.equal(state.currentStage.status, "error");
  assert.equal(state.stages[0].status, "error");
});

// 用户需求点: 工作台把整张图当阶段列表，没跑到的节点一律显示"待执行"。数据提供型节点
// （文本、密码、Load Skills…）是作为输入就地解析的，从不作为阶段执行，于是一个成功的 Run
// 看上去卡在 2/33，像是执行过却显示未执行。
test("Run State separates nodes outside the plan from nodes still pending", () => {
  const flowNodes = [
    { id: "agent", data: { label: "子 Agent", definitionId: "agent_subAgent" } },
    { id: "wecom", data: { label: "企业微信应用 Markdown", definitionId: "tool_wecom_send_app_markdown" } },
    { id: "text_1", data: { label: "文本", definitionId: "provide_text" } },
    { id: "skills", data: { label: "Load Skills", definitionId: "control_load_skills" } },
  ];
  const events = [
    { type: "node-start", nodeId: "agent", ts: 10 },
    { type: "node-done", nodeId: "agent", status: "success", ts: 20 },
    { type: "node-start", nodeId: "wecom", ts: 21 },
    { type: "node-done", nodeId: "wecom", status: "success", ts: 22 },
    { type: "run-finish", status: "success", ts: 23 },
  ];
  const state = buildRunStateSnapshot(events, { runId: "r-plan", status: "success", startedAt: 10, endedAt: 23 }, flowNodes);
  assert.deepEqual(
    state.stages.map((stage) => [stage.id, stage.status]),
    [["agent", "success"], ["wecom", "success"], ["text_1", "not_run"], ["skills", "not_run"]],
  );
  assert.deepEqual(state.progress, { completed: 2, total: 2, percent: 100 });
  assert.deepEqual(state.pending, []);
});

test("Run State keeps event-less nodes pending while the Run is still going", () => {
  const flowNodes = [
    { id: "agent", data: { label: "子 Agent" } },
    { id: "later", data: { label: "后面的节点" } },
  ];
  const events = [{ type: "node-start", nodeId: "agent", ts: 10 }];
  const state = buildRunStateSnapshot(events, { runId: "r-live", status: "running", startedAt: 10 }, flowNodes, [], 20);
  assert.equal(state.stages.find((stage) => stage.id === "later").status, "pending");
  assert.deepEqual(state.pending, [{ id: "later", label: "后面的节点" }]);
});

// 用户需求点: control_if 执行完也看不出走的是 true 还是 false。
test("Run State surfaces which branch a control_if took", () => {
  const flowNodes = [
    { id: "gate", data: { label: "是否发送", definitionId: "control_if" } },
    { id: "gate2", data: { label: "第二个判断", definitionId: "control_if" } },
  ];
  const events = [
    { type: "node-start", nodeId: "gate", ts: 10 },
    { type: "status", nodeId: "gate", line: "control_if branch: true", ts: 11 },
    { type: "node-done", nodeId: "gate", definitionId: "control_if", branch: "true", status: "success", ts: 12 },
    { type: "node-start", nodeId: "gate2", ts: 13 },
    { type: "node-done", nodeId: "gate2", definitionId: "control_if", branch: "false", status: "success", ts: 14 },
  ];
  const state = buildRunStateSnapshot(events, { runId: "r-if", status: "success", startedAt: 10, endedAt: 14 }, flowNodes);
  assert.equal(state.stages.find((stage) => stage.id === "gate").branch, "true");
  assert.equal(state.stages.find((stage) => stage.id === "gate2").branch, "false");
});
