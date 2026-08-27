import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendAiTraceEvents,
  classifyAiToolSideEffect,
  createAiExplorationSession,
  listAiExplorationSessions,
  materializableAiTraceEvents,
  parseAiPlanResult,
  readAiExplorationSession,
  updateAiExplorationSession,
  writeAiExplorationMaterialization,
} from "../bin/lib/ai-exploration.mjs";

test("AI exploration stores append-only trace events and redacts secrets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-ai-exploration-"));
  try {
    const session = createAiExplorationSession(root, {
      title: "Codex exploration",
      goal: "Inspect the project",
      mode: "observed",
      status: "running",
      source: { provider: "codex", agent: "external" },
    });
    const appended = appendAiTraceEvents(root, session.id, [{
      type: "tool",
      name: "exec_command",
      summary: "Read configuration with api_key=secret-value-123456",
      inputPreview: "Authorization: Bearer secret-token-123456",
      sideEffect: "read",
      status: "success",
    }], { phase: "observed" });

    assert.equal(appended.session.eventCount, 1);
    const detail = readAiExplorationSession(root, session.id);
    assert.equal(detail.events.length, 1);
    assert.equal(detail.events[0].phase, "observed");
    assert.equal(detail.events[0].sideEffect, "read");
    assert.equal(JSON.stringify(detail).includes("secret-value-123456"), false);
    assert.equal(JSON.stringify(detail).includes("secret-token-123456"), false);
    assert.equal(listAiExplorationSessions(root)[0].id, session.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AI tool traces classify reads, external calls and unknown commands conservatively", () => {
  assert.equal(classifyAiToolSideEffect("Read", "tool_use"), "read");
  assert.equal(classifyAiToolSideEffect("web_fetch", "tool_use"), "external");
  assert.equal(classifyAiToolSideEffect("exec_command", "tool_use"), "write");
  assert.equal(classifyAiToolSideEffect("", "thinking"), "none");
});

test("AI plan JSON becomes planned spans and materialization provenance", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-ai-plan-"));
  try {
    const session = createAiExplorationSession(root, { goal: "Build a report", mode: "planned" });
    const plan = parseAiPlanResult(JSON.stringify({
      title: "Report plan",
      summary: "Read data and publish the result",
      spans: [
        { id: "read", type: "file", name: "Read input", sideEffect: "read" },
        { id: "publish", parentSpanId: "read", type: "tool", name: "Publish", sideEffect: "external" },
      ],
    }), session.id);
    assert.equal(plan.events.length, 2);
    assert.equal(plan.events[0].phase, "planned");
    assert.equal(plan.events[1].requiresApproval, true);
    appendAiTraceEvents(root, session.id, plan.events, { phase: "planned" });
    appendAiTraceEvents(root, session.id, [{ id: "dry", spanId: "dry", phase: "simulated", name: "Dry", status: "success" }], { phase: "simulated" });
    updateAiExplorationSession(root, session.id, { status: "ready", title: plan.title });
    assert.deepEqual(materializableAiTraceEvents(readAiExplorationSession(root, session.id)).map((event) => event.spanId), ["read", "publish"]);
    const mapping = writeAiExplorationMaterialization(root, session.id, {
      nodeIds: ["read_input", "publish_result"],
      designRevision: "revision-1",
    });
    assert.deepEqual(mapping.nodeIds, ["read_input", "publish_result"]);
    assert.deepEqual(mapping.spanIds, ["read", "publish"]);
    assert.equal(mapping.designRevision, "revision-1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
