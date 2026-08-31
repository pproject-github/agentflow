import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { isCursorAgentLoopingError, runCursorAgentWithPrompt } from "../bin/lib/agent-runners.mjs";
import {
  classifyCursorApiKeyLimitError,
  clearCursorApiKeyCooldown,
  createCursorApiKeyAttempts,
  cursorApiKeyCooldownMinutes,
  getCursorApiKeyModelSelection,
  getCursorApiKeyPoolStatuses,
  isCursorAutoFallbackEligible,
  markCursorApiKeyLaneBlocked,
  recordCursorApiKeyFallbackModel,
  resetCursorApiKeyPoolForTests,
} from "../bin/lib/cursor-api-key-pool.mjs";
import {
  clearCursorModelCatalogCache,
  parseCursorModelsOutput,
  selectComposerFallbackModel,
} from "../bin/lib/cursor-model-catalog.mjs";

test("Cursor model catalog discovers the first Composer model without pinning a version", () => {
  const models = parseCursorModelsOutput(`
\u001b[1mAvailable models\u001b[0m
auto - Auto (default)
Composer 2.5 - Fast
composer-legacy - Composer Legacy (current)
Tip: use --model to select one
`);

  assert.deepEqual(models, [
    { id: "auto", displayName: "Auto", isDefault: true, isCurrent: false },
    { id: "Composer 2.5", displayName: "Fast", isDefault: false, isCurrent: false },
    { id: "composer-legacy", displayName: "Composer Legacy", isDefault: false, isCurrent: true },
  ]);
  assert.equal(selectComposerFallbackModel(models)?.id, "Composer 2.5");
});

test("only explicit Auto usage exhaustion enables the Composer lane", () => {
  resetCursorApiKeyPoolForTests();
  const [selection] = createCursorApiKeyAttempts({
    CURSOR_API_KEYS: JSON.stringify([{ id: "key-1", name: "Primary", key: "secret-1" }]),
  });
  const now = Date.now();

  assert.equal(classifyCursorApiKeyLimitError("resource_exhausted"), "resource_exhausted");
  assert.equal(isCursorAutoFallbackEligible("resource_exhausted"), false);
  markCursorApiKeyLaneBlocked(selection, "auto", 30, "resource_exhausted", now);
  recordCursorApiKeyFallbackModel(selection, {
    id: "Composer Next",
    displayName: "Composer Next",
    discoveredAt: new Date(now).toISOString(),
  });
  assert.equal(getCursorApiKeyModelSelection(selection, now + 1), undefined);

  resetCursorApiKeyPoolForTests();
  const [eligibleSelection] = createCursorApiKeyAttempts({
    CURSOR_API_KEYS: JSON.stringify([{ id: "key-1", name: "Primary", key: "secret-1" }]),
  });
  markCursorApiKeyLaneBlocked(eligibleSelection, "auto", 30, "You're out of usage", now);
  recordCursorApiKeyFallbackModel(eligibleSelection, {
    id: "Composer Next",
    displayName: "Composer Next",
    discoveredAt: new Date(now).toISOString(),
  });
  assert.deepEqual(getCursorApiKeyModelSelection(eligibleSelection, now + 1), {
    lane: "fallback",
    modelId: "Composer Next",
    modelName: "Composer Next",
  });
});

test("Cursor key statuses expose Auto, degraded and cooling lanes without secrets", () => {
  resetCursorApiKeyPoolForTests();
  const records = [{ id: "status-key", name: "Status Key", key: "secret-status-key" }];
  const now = Date.now();

  assert.deepEqual(getCursorApiKeyPoolStatuses(records, now), [{
    id: "status-key",
    status: "available",
    activeLane: "auto",
    activeModelId: "auto",
    activeModelName: "Auto",
    degraded: false,
    laneCooldowns: [],
  }]);

  markCursorApiKeyLaneBlocked(records[0], "auto", 30, "You're out of usage", now);
  recordCursorApiKeyFallbackModel(records[0], {
    id: "Composer 2.5",
    displayName: "Composer 2.5",
    discoveredAt: new Date(now).toISOString(),
  });
  const degraded = getCursorApiKeyPoolStatuses(records, now + 1)[0];
  assert.equal(degraded.status, "available");
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.activeLane, "fallback");
  assert.equal(degraded.laneCooldowns[0].modelName, "Auto");
  assert.equal(JSON.stringify(degraded).includes("secret-status-key"), false);

  markCursorApiKeyLaneBlocked(records[0], "fallback", 3, "resource_exhausted", now + 2);
  const cooling = getCursorApiKeyPoolStatuses(records, now + 3)[0];
  assert.equal(cooling.status, "cooling_down");
  assert.equal(cooling.laneCooldowns.length, 2);
  assert.equal(clearCursorApiKeyCooldown(records[0]), true);
  assert.equal(getCursorApiKeyPoolStatuses(records, now + 4)[0].status, "available");
});

test("resource_exhausted uses the short Cursor key cooldown", () => {
  assert.equal(cursorApiKeyCooldownMinutes({}, "resource_exhausted"), 3);
  assert.equal(cursorApiKeyCooldownMinutes({ AGENTFLOW_CURSOR_API_KEY_RESOURCE_EXHAUSTED_COOLDOWN_MINUTES: "7" }, "resource_exhausted"), 7);
  assert.equal(cursorApiKeyCooldownMinutes({ AGENTFLOW_CURSOR_API_KEY_COOLDOWN_MINUTES: "60" }, "429 Too Many Requests"), 60);
});

test("Cursor Auto retries the same key with the dynamically discovered Composer model", async () => {
  resetCursorApiKeyPoolForTests();
  clearCursorModelCatalogCache();
  const fixture = createMockCursorAgent();
  const previousCommand = process.env.CURSOR_AGENT_CMD;
  process.env.CURSOR_AGENT_CMD = fixture.command;
  const events = [];
  try {
    const handle = runCursorAgentWithPrompt(fixture.directory, "hello", {
      env: {
        CURSOR_API_KEYS: JSON.stringify([{ id: "fallback-key", name: "Fallback Key", key: "key-a" }]),
        MOCK_CURSOR_LOG: fixture.logPath,
        MOCK_CURSOR_MODE: "usage-fallback",
      },
      onStreamEvent: (event) => events.push(event),
    });
    await handle.finished;
  } finally {
    restoreEnv("CURSOR_AGENT_CMD", previousCommand);
  }

  const calls = readJsonLines(fixture.logPath);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].key, "key-a");
  assert.deepEqual(calls[1].args, ["models"]);
  assert.equal(calls[1].key, "key-a");
  assert.equal(calls[2].key, "key-a");
  assert.deepEqual(calls[2].args.slice(calls[2].args.indexOf("--model"), -1), ["--model", "Composer 2.5"]);
  assert.ok(events.some((event) => event.eventType === "model_fallback" && event.text === "auto -> Composer 2.5"));
});

test("Cursor login session retries the same Agent Turn with the discovered Composer model", async () => {
  resetCursorApiKeyPoolForTests();
  clearCursorModelCatalogCache();
  const fixture = createMockCursorAgent();
  const previousCommand = process.env.CURSOR_AGENT_CMD;
  process.env.CURSOR_AGENT_CMD = fixture.command;
  const events = [];
  try {
    const handle = runCursorAgentWithPrompt(fixture.directory, "hello", {
      env: {
        AGENTFLOW_USER_ID: "login-fallback-user",
        CURSOR_API_KEYS: "",
        MOCK_CURSOR_LOG: fixture.logPath,
        MOCK_CURSOR_MODE: "usage-fallback",
      },
      onStreamEvent: (event) => events.push(event),
    });
    await handle.finished;
  } finally {
    restoreEnv("CURSOR_AGENT_CMD", previousCommand);
  }

  const calls = readJsonLines(fixture.logPath);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args.includes("--model"), false);
  assert.deepEqual(calls[1].args, ["models"]);
  assert.deepEqual(calls[2].args.slice(calls[2].args.indexOf("--model"), -1), ["--model", "Composer 2.5"]);
  assert.deepEqual(calls.map((call) => call.key), ["", "", ""]);
  assert.ok(events.some((event) => event.type === "status" && event.line.includes("login session")));
  assert.ok(events.some((event) => event.eventType === "model_fallback" && event.text === "auto -> Composer 2.5"));
});

test("Cursor login session does not replay the Agent after tool activity", async () => {
  resetCursorApiKeyPoolForTests();
  clearCursorModelCatalogCache();
  const fixture = createMockCursorAgent();
  const previousCommand = process.env.CURSOR_AGENT_CMD;
  process.env.CURSOR_AGENT_CMD = fixture.command;
  try {
    const handle = runCursorAgentWithPrompt(fixture.directory, "hello", {
      env: {
        AGENTFLOW_USER_ID: "login-side-effect-user",
        CURSOR_API_KEYS: "",
        MOCK_CURSOR_LOG: fixture.logPath,
        MOCK_CURSOR_MODE: "usage-after-tool",
      },
    });
    await assert.rejects(handle.finished, /out of usage/);
  } finally {
    restoreEnv("CURSOR_AGENT_CMD", previousCommand);
  }

  const calls = readJsonLines(fixture.logPath);
  assert.equal(calls.length, 1);
  assert.equal(calls.some((call) => call.args[0] === "models"), false);
  assert.equal(calls.some((call) => call.args.includes("--model")), false);
});

test("Cursor Auto switches to Composer after looping with read-only tools", async () => {
  resetCursorApiKeyPoolForTests();
  clearCursorModelCatalogCache();
  const fixture = createMockCursorAgent();
  const previousCommand = process.env.CURSOR_AGENT_CMD;
  process.env.CURSOR_AGENT_CMD = fixture.command;
  const events = [];
  try {
    const handle = runCursorAgentWithPrompt(fixture.directory, "hello", {
      env: {
        AGENTFLOW_USER_ID: "looping-read-user",
        CURSOR_API_KEYS: "",
        MOCK_CURSOR_LOG: fixture.logPath,
        MOCK_CURSOR_MODE: "looping-read",
      },
      onStreamEvent: (event) => events.push(event),
    });
    await handle.finished;
  } finally {
    restoreEnv("CURSOR_AGENT_CMD", previousCommand);
  }

  const calls = readJsonLines(fixture.logPath);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].args, ["models"]);
  assert.ok(calls[2].args.includes("Composer 2.5"));
  assert.ok(events.some((event) => event.eventType === "model_fallback" && event.reason === "agent_looping"));
});

test("Cursor does not replay a looping Agent after a mutating tool", async () => {
  resetCursorApiKeyPoolForTests();
  clearCursorModelCatalogCache();
  const fixture = createMockCursorAgent();
  const previousCommand = process.env.CURSOR_AGENT_CMD;
  process.env.CURSOR_AGENT_CMD = fixture.command;
  let failure;
  try {
    const handle = runCursorAgentWithPrompt(fixture.directory, "hello", {
      env: {
        AGENTFLOW_USER_ID: "looping-edit-user",
        CURSOR_API_KEYS: "",
        MOCK_CURSOR_LOG: fixture.logPath,
        MOCK_CURSOR_MODE: "looping-edit",
      },
    });
    await handle.finished.catch((error) => { failure = error; });
  } finally {
    restoreEnv("CURSOR_AGENT_CMD", previousCommand);
  }

  assert.equal(isCursorAgentLoopingError(failure), true);
  assert.equal(failure?.code, "CURSOR_AGENT_LOOPING");
  assert.equal(failure?.cursorHadMutatingToolActivity, true);
  const calls = readJsonLines(fixture.logPath);
  assert.equal(calls.length, 1);
  assert.equal(calls.some((call) => call.args[0] === "models"), false);
});

test("generic 429 rotates to the next key without switching models", async () => {
  resetCursorApiKeyPoolForTests();
  clearCursorModelCatalogCache();
  const fixture = createMockCursorAgent();
  const previousCommand = process.env.CURSOR_AGENT_CMD;
  process.env.CURSOR_AGENT_CMD = fixture.command;
  try {
    const handle = runCursorAgentWithPrompt(fixture.directory, "hello", {
      env: {
        CURSOR_API_KEYS: JSON.stringify([
          { id: "rate-key-a", name: "Rate A", key: "key-a" },
          { id: "rate-key-b", name: "Rate B", key: "key-b" },
        ]),
        MOCK_CURSOR_LOG: fixture.logPath,
        MOCK_CURSOR_MODE: "rate-limit",
      },
    });
    await handle.finished;
  } finally {
    restoreEnv("CURSOR_AGENT_CMD", previousCommand);
  }

  const calls = readJsonLines(fixture.logPath);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.key), ["key-a", "key-b"]);
  assert.equal(calls.some((call) => call.args[0] === "models"), false);
  assert.equal(calls.some((call) => call.args.includes("--model")), false);
});

test("Cursor adds --force only for trusted unattended execution", async () => {
  resetCursorApiKeyPoolForTests();
  clearCursorModelCatalogCache();
  const fixture = createMockCursorAgent();
  const previousCommand = process.env.CURSOR_AGENT_CMD;
  process.env.CURSOR_AGENT_CMD = fixture.command;
  try {
    const interactive = runCursorAgentWithPrompt(fixture.directory, "interactive", {
      force: true,
      env: { MOCK_CURSOR_LOG: fixture.logPath },
    });
    await interactive.finished;
    const scheduled = runCursorAgentWithPrompt(fixture.directory, "scheduled", {
      execution: { unattended: true },
      env: {
        MOCK_CURSOR_LOG: fixture.logPath,
        MOCK_CURSOR_MODE: "approved-tools",
      },
    });
    await scheduled.finished;
  } finally {
    restoreEnv("CURSOR_AGENT_CMD", previousCommand);
  }

  const calls = readJsonLines(fixture.logPath);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.includes("--force"), false, "legacy force must not bypass interactive permissions");
  assert.equal(calls[1].args.includes("--force"), true, "trusted unattended execution must approve tools");
});

test("Cursor rejects a final success after a required tool was rejected or errored", async () => {
  const modes = ["tool-rejected", "tool-error", "interaction-rejected"];
  const previousCommand = process.env.CURSOR_AGENT_CMD;
  try {
    for (const mode of modes) {
      resetCursorApiKeyPoolForTests();
      clearCursorModelCatalogCache();
      const fixture = createMockCursorAgent();
      process.env.CURSOR_AGENT_CMD = fixture.command;
      const handle = runCursorAgentWithPrompt(fixture.directory, mode, {
        env: {
          MOCK_CURSOR_LOG: fixture.logPath,
          MOCK_CURSOR_MODE: mode,
        },
      });
      await assert.rejects(handle.finished, /Required tool .* (?:rejected|denied|error)/i, mode);
    }
  } finally {
    restoreEnv("CURSOR_AGENT_CMD", previousCommand);
  }
});

function createMockCursorAgent() {
  const directory = mkdtempSync(path.join(tmpdir(), "agentflow-cursor-fallback-"));
  const command = path.join(directory, "mock-cursor-agent.mjs");
  const logPath = path.join(directory, "calls.jsonl");
  writeFileSync(command, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.MOCK_CURSOR_LOG, JSON.stringify({ args, key: process.env.CURSOR_API_KEY || "" }) + "\\n");
if (args[0] === "models") {
  console.log("Available models\\nauto - Auto (default)\\nComposer 2.5 - Fast\\nTip: use --model");
  process.exit(0);
}
const mode = process.env.MOCK_CURSOR_MODE;
if (mode === "usage-fallback" && !args.includes("--model")) {
  console.log(JSON.stringify({ type: "result", subtype: "error", is_error: true, error: { message: "ActionRequiredError: You're out of usage" } }));
  process.exit(0);
}
if (mode === "usage-after-tool") {
  console.log(JSON.stringify({ type: "tool_call", subtype: "started", tool_call: { shell: { command: "echo changed" } } }));
  console.log(JSON.stringify({ type: "result", subtype: "error", is_error: true, error: { message: "ActionRequiredError: You're out of usage" } }));
  process.exit(0);
}
if (mode === "looping-read" && !args.includes("--model")) {
  console.log(JSON.stringify({ type: "tool_call", subtype: "started", tool_call: { readToolCall: { args: { path: "README.md" } } } }));
  console.log(JSON.stringify({ type: "result", subtype: "error", is_error: true, error: { message: "NonRetriableError: Agent Looping Detected The model got stuck in a repeating response pattern" } }));
  process.exit(0);
}
if (mode === "looping-edit") {
  console.log(JSON.stringify({ type: "tool_call", subtype: "started", tool_call: { editToolCall: { args: { path: "result.html" } } } }));
  console.log(JSON.stringify({ type: "result", subtype: "error", is_error: true, error: { message: "NonRetriableError: Agent Looping Detected The model got stuck in a repeating response pattern" } }));
  process.exit(0);
}
if (mode === "rate-limit" && process.env.CURSOR_API_KEY === "key-a") {
  console.log(JSON.stringify({ type: "result", subtype: "error", is_error: true, error: { message: "429 Too Many Requests" } }));
  process.exit(0);
}
if (mode === "approved-tools") {
  console.log(JSON.stringify({ type: "tool_call", subtype: "completed", tool_call: { shellToolCall: { result: { success: true } } } }));
  console.log(JSON.stringify({ type: "tool_call", subtype: "completed", tool_call: { WebSearch: { result: { success: true } } } }));
  console.log(JSON.stringify({ type: "tool_call", subtype: "completed", tool_call: { mcpToolCall: { result: { success: true } } } }));
}
if (mode === "tool-rejected") {
  console.log(JSON.stringify({ type: "tool_call", subtype: "completed", tool_call: { shellToolCall: { result: { rejected: true } } } }));
}
if (mode === "tool-error") {
  console.log(JSON.stringify({ type: "tool_call", subtype: "completed", tool_call: { mcpToolCall: { result: { error: { message: "denied" } } } } }));
}
if (mode === "interaction-rejected") {
  console.log(JSON.stringify({ type: "tool_call", subtype: "completed", tool_call: { interaction_query: { result: "rejected" } } }));
}
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }));
`, "utf8");
  chmodSync(command, 0o755);
  return { directory, command, logPath };
}

function readJsonLines(filePath) {
  return readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function restoreEnv(name, value) {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}
