import assert from "node:assert/strict";
import test from "node:test";

import { summarizeCursorStderr } from "../bin/lib/agent-runners.mjs";
import {
  normalizeCursorModelForCli,
  resolveCliAndModel,
} from "../bin/lib/model-config.mjs";

test("Cursor UI backend prefix is removed before invoking Cursor CLI", () => {
  assert.equal(normalizeCursorModelForCli("cursor:gpt-5.4-medium"), "gpt-5.4-medium");
  assert.equal(
    normalizeCursorModelForCli("cursor:gpt-5.4-medium - GPT 5.4 Medium"),
    "gpt-5.4-medium",
  );
  assert.equal(normalizeCursorModelForCli("cursor:auto"), "Auto");

  assert.deepEqual(
    resolveCliAndModel(process.cwd(), "cursor:gpt-5.4-medium", null),
    {
      cli: "cursor",
      model: "gpt-5.4-medium",
      label: "cursor: gpt-5.4-medium",
    },
  );
});

test("Cursor invalid-model errors retain the rejected model instead of the model-list tail", () => {
  const availableModels = Array.from({ length: 200 }, (_, index) => `model-${index}`).join(", ");
  const stderr = `Cannot use this model: cursor:gpt-5.4-medium. Available models:\n${availableModels}`;

  assert.equal(
    summarizeCursorStderr(stderr),
    "Cannot use this model: cursor:gpt-5.4-medium. Available models omitted; inspect the run log for the full list.",
  );
});
