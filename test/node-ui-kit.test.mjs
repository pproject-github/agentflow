import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseNodeFrontmatter } from "../bin/lib/catalog-flows.mjs";
import { normalizeNodeUi } from "../bin/lib/node-ui-kit.mjs";
import { readNodePackageManifest } from "../bin/lib/node-package-manifest.mjs";
import {
  buildNodeUiInputBindings,
  mergeNodeWithPalette,
  persistedNodeUiStatus,
  sanitizeRuntimeOutputsForCanvas,
} from "../builtin/web-ui/src/mergeFlowNodes.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Node UI Kit 只保留声明式白名单组件", () => {
  const ui = normalizeNodeUi({
    card: {
      template: "state-machine",
      icon: "repeat",
      tone: "purple",
      onClick: "steal()",
      sections: [
        { type: "binding", label: "State", input: "state" },
        { type: "html", content: "<script>alert(1)</script>" },
        { type: "decision", label: "Decision", output: "decision", options: [
          { value: "done", label: "Done", tone: "green", onClick: "bad()" },
        ] },
      ],
    },
  });

  assert.deepEqual(ui, {
    version: 1,
    card: {
      template: "state-machine",
      tone: "purple",
      icon: "repeat",
      sections: [
        { type: "binding", label: "State", input: "state" },
        {
          type: "decision",
          label: "Decision",
          output: "decision",
          options: [{ value: "done", label: "Done", tone: "green" }],
        },
      ],
    },
  });
});

test("control.while 的 builtin frontmatter 提供可解释状态机卡片", () => {
  const source = fs.readFileSync(path.join(repoRoot, "builtin", "nodes", "control_while.md"), "utf-8");
  const def = parseNodeFrontmatter(source);
  assert.equal(def.ui.card.template, "state-machine");
  assert.equal(def.ui.card.icon, "repeat");
  assert.deepEqual(def.ui.card.sections.map((section) => section.type), [
    "binding",
    "loop",
    "decision",
    "metrics",
    "summary",
    "history",
  ]);
  assert.deepEqual(def.ui.card.sections[2].options.map((option) => option.value), ["continue", "wait", "done", "fail"]);
});

test("代码节点包的 ui 声明进入 Marketplace manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-node-ui-"));
  try {
    fs.writeFileSync(path.join(root, "index.mjs"), `export default {
  id: "visible_step",
  version: "1.0.0",
  name: "Visible Step",
  inputs: { state: { type: "json" } },
  outputs: { result: { type: "json" } },
  ui: {
    card: {
      template: "details",
      icon: "data_object",
      sections: [{ type: "binding", label: "State", input: "state" }]
    }
  }
};
export async function run() {}
`, "utf-8");
    const manifest = readNodePackageManifest(root, () => null);
    assert.equal(manifest.ui.version, 1);
    assert.equal(manifest.ui.card.icon, "data_object");
    assert.equal(manifest.ui.card.sections[0].input, "state");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Workspace 节点获得 UI 声明和可读输入绑定", () => {
  const ui = normalizeNodeUi({ card: { sections: [{ type: "binding", label: "State", input: "state" }] } });
  const palette = [{
    id: "control_while",
    type: "control",
    displayName: "While",
    ui,
    inputs: [{ type: "node", name: "prev" }, { type: "json", name: "state" }],
    outputs: [{ type: "node", name: "next" }, { type: "text", name: "decision" }],
  }];
  const source = {
    id: "readPrd",
    data: {
      label: "读取 PRD",
      outputs: [{ type: "node", name: "next" }, { type: "json", name: "result" }],
    },
  };
  const target = mergeNodeWithPalette({
    id: "advance",
    data: { definitionId: "control_while" },
  }, {
    advance: {
      definitionId: "control_while",
      input: [{ type: "node", name: "prev" }, { type: "json", name: "state" }],
      output: [{ type: "node", name: "next" }, { type: "text", name: "decision" }],
    },
  }, palette);
  assert.deepEqual(target.data.nodeUi, ui);
  const bindings = buildNodeUiInputBindings([source, target], [{
    source: "readPrd",
    target: "advance",
    sourceHandle: "output-1",
    targetHandle: "input-1",
  }]);
  assert.deepEqual(bindings.get("advance").state, {
    sourceNodeId: "readPrd",
    sourceLabel: "读取 PRD",
    sourceSlot: "result",
    display: "读取 PRD.result",
  });
});

test("Node UI Kit 声明的运行态在刷新后仍可见，其余输出继续清理", () => {
  const ui = normalizeNodeUi({
    card: {
      sections: [
        { type: "decision", label: "Decision", output: "decision" },
        { type: "metrics", label: "Progress", items: [{ label: "Iteration", output: "iterations" }] },
        { type: "summary", label: "Summary", output: "summary" },
        { type: "history", label: "History", output: "history" },
      ],
    },
  });
  const instances = {
    loop: {
      definitionId: "control_while",
      output: [
        { type: "json", name: "result", value: '{"large":"hidden"}' },
        { type: "json", name: "state", value: '{"n":2}' },
        { type: "text", name: "decision", value: "wait" },
        { type: "text", name: "iterations", value: "2" },
        { type: "text", name: "summary", value: "needs approval" },
        { type: "json", name: "history", value: '[{"iteration":2,"decision":"wait"}]' },
        { type: "text", name: "checkpointFingerprint", value: "secret-runtime-detail" },
      ],
    },
  };
  const palette = [{ id: "control_while", ui }];
  const sanitized = sanitizeRuntimeOutputsForCanvas(instances, palette);
  const outputs = Object.fromEntries(sanitized.loop.output.map((slot) => [slot.name, slot.value]));

  assert.equal(outputs.decision, "wait");
  assert.equal(outputs.iterations, "2");
  assert.equal(outputs.summary, "needs approval");
  assert.match(outputs.history, /wait/);
  assert.equal(outputs.result, "");
  assert.equal(outputs.state, "");
  assert.equal(outputs.checkpointFingerprint, "");
  assert.equal(persistedNodeUiStatus({ nodeUi: ui, outputs: sanitized.loop.output }), "waiting");
});
