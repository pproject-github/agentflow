import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRunAuditTrace,
  buildRunInspectorTurns,
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
