import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runCursorAgentWithPrompt } from "../bin/lib/agent-runners.mjs";
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
if (mode === "rate-limit" && process.env.CURSOR_API_KEY === "key-a") {
  console.log(JSON.stringify({ type: "result", subtype: "error", is_error: true, error: { message: "429 Too Many Requests" } }));
  process.exit(0);
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
