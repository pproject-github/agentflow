import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRunInspectorTurns,
  normalizeRunInspectorEvents,
  runInspectorTimelineRows,
} from "../builtin/web-ui/src/lib/runInspectorModel.js";

test("Run Inspector groups real ScheduleRun events into trigger and node Turns", () => {
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
  const turns = buildRunInspectorTurns(events, run, startedAt + 7_000);
  assert.deepEqual(turns.map((turn) => turn.title), ["ScheduleRun 触发", "agent_subAgent", "tool_nodejs"]);
  assert.equal(turns[1].durationMs, 3_000);
  assert.equal(turns[2].events.some((event) => event.script === "npm test"), true);
  const timeline = runInspectorTimelineRows(turns);
  assert.equal(timeline[1].offsetPct > 0, true);
  assert.equal(timeline[2].widthPct > 1.2, true);
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
  assert.deepEqual(events.map((event) => event.label), ["Agent 新 Turn 重试", "恢复 Agent 产物"]);
  assert.deepEqual(events.map((event) => event.status), ["retrying", "success"]);
  assert.match(events[1].text, /outputs\/result\.html/);
});
