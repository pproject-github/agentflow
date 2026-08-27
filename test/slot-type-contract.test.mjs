import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { lintFlowDir } from "../bin/lib/flow-dsl/lint.mjs";
import { FLOW_SOURCE_FILENAME, flowFilesToGraph } from "../bin/lib/flow-dsl/index.mjs";
import { getSlotTypeColor, slotTypeCompatibility } from "../shared/slot-types.js";

const parse = (source) => flowFilesToGraph({ source, layout: {}, nodeMeta: {}, files: {} });
const slot = (graph, nodeId, kind, name) => (
  (graph.instances[nodeId]?.[kind] || []).find((item) => item.name === name)
);

function lintSource(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-slot-types-"));
  fs.writeFileSync(path.join(root, FLOW_SOURCE_FILENAME), source, "utf-8");
  try {
    return lintFlowDir(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("shared slot compatibility keeps UI and DSL on the same rules", () => {
  assert.equal(slotTypeCompatibility("json", "json").kind, "exact");
  assert.equal(slotTypeCompatibility("json", "text").kind, "lossless");
  assert.equal(slotTypeCompatibility("text", "json").compatible, false);
  assert.equal(getSlotTypeColor("json"), "#00bcd4");
});

test("provide.json creates a native json output that connects to While.state", () => {
  const source = `import { control, flow, provide } from "agentflow/flow";

const initial = provide.json("Initial state", { value: '{"cursor":0}' });
const loop = control.while("Advance", { state: initial.value }, \`node step.mjs\`);
export const run = flow("Run", loop);
`;
  const graph = parse(source);
  assert.equal(slot(graph, "initial", "output", "value")?.type, "json");
  assert.equal(slot(graph, "loop", "input", "state")?.type, "json");
  assert.deepEqual(lintSource(source).errors, []);
});

test("DSL lint rejects the same text to json edge that the canvas rejects", () => {
  const result = lintSource(`import { control, flow, provide } from "agentflow/flow";

const initial = provide.str("Initial state", { value: '{"cursor":0}' });
const loop = control.while("Advance", { state: initial.value }, \`node step.mjs\`);
export const run = flow("Run", loop);
`);
  assert.ok(result.errors.some((error) => /initial\.value\(text\).*loop\.state\(json\)/.test(error)), result.errors.join("\n"));
});

test("control.parseJson is the explicit text to json adapter", () => {
  const source = `import { control, flow, provide } from "agentflow/flow";

const text = provide.str("JSON text", { value: '{"cursor":0}' });
const parsed = control.parseJson("Parse state", { value: text.value });
const loop = control.while("Advance", { state: parsed.result }, \`node step.mjs\`);
export const run = flow("Run", parsed, loop);
`;
  assert.deepEqual(lintSource(source).errors, []);
});
