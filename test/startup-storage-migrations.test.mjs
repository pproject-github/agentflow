import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  STORAGE_SCHEMA_VERSION,
  runStartupStorageMigrations,
} from "../bin/lib/startup-storage-migrations.mjs";

const LOSSLESS_YAML = `instances:
  start:
    definitionId: control_start
    input: []
    output:
      - { type: flow, name: next }
  print:
    definitionId: tool_print
    input:
      - { type: flow, name: prev }
      - { type: text, name: content, value: hello }
    output:
      - { type: flow, name: next }
edges:
  - { source: start, sourceHandle: output-0, target: print, targetHandle: input-0 }
ui:
  nodePositions: {}
`;

const LOSSY_YAML = `instances:
  start:
    definitionId: control_start
    input: []
    output:
      - { type: flow, name: next }
  gate:
    definitionId: tool_user_check
    input:
      - { type: flow, name: prev }
    output:
      - { type: flow, name: next }
edges:
  - { source: start, sourceHandle: output-0, target: gate, targetHandle: input-0 }
ui:
  nodePositions: {}
`;

function seedFlow(dir, filename, text) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), text, "utf-8");
}

test("启动按存储版本迁移全部用户、Workspace 和归档流程，只跳过有损 YAML", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-startup-migrate-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  const personal = path.join(dataRoot, "users", "alice", "pipelines", "personal-flow");
  const workspace = path.join(workspaceRoot, ".workspace", "agentflow", "pipelines", "workspace-flow");
  const archived = path.join(dataRoot, "pipelines", "_archived", "archived-flow");
  const lossy = path.join(dataRoot, "users", "alice", "pipelines", "lossy-flow");
  const graphFlow = path.join(dataRoot, "users", "bob", "pipelines", "graph-flow");
  try {
    seedFlow(personal, "flow.yaml", LOSSLESS_YAML);
    seedFlow(workspace, "flow.yaml", LOSSLESS_YAML);
    seedFlow(archived, "flow.yaml", LOSSLESS_YAML);
    seedFlow(lossy, "flow.yaml", LOSSY_YAML);
    seedFlow(graphFlow, "workspace.graph.json", JSON.stringify({
      version: 1,
      instances: {},
      edges: [],
      ui: { nodePositions: {} },
    }));

    const first = runStartupStorageMigrations({ dataRoot, workspaceRoot });
    assert.equal(first.schemaVersion, STORAGE_SCHEMA_VERSION);
    assert.equal(first.attempted.length, 2);
    assert.ok(fs.existsSync(path.join(personal, "workspace.flow.js")));
    assert.ok(fs.existsSync(path.join(workspace, "workspace.flow.js")));
    assert.ok(fs.existsSync(path.join(archived, "workspace.flow.js")));
    assert.ok(fs.existsSync(path.join(lossy, "flow.yaml")));
    assert.ok(!fs.existsSync(path.join(lossy, "workspace.flow.js")));
    assert.ok(fs.existsSync(path.join(graphFlow, "workspace.flow.js")));
    assert.ok(fs.existsSync(path.join(
      graphFlow,
      ".agentflow-migrations",
      "workspace-flow-dsl-v1",
      "workspace.graph.json",
    )));

    const report = JSON.parse(fs.readFileSync(first.statePath, "utf-8"));
    const rows = Object.values(report.migrations["workspace-flow-dsl-v1"].targets)
      .flatMap((target) => target.rows);
    assert.equal(rows.find((row) => row.flowId === "lossy-flow").result, "needs-decision");

    const second = runStartupStorageMigrations({ dataRoot, workspaceRoot });
    assert.equal(second.attempted.length, 0);
    assert.equal(second.skipped.length, 2);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("相同数据根切换到新的 workspaceRoot 时只补迁新 Workspace", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-startup-new-workspace-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceA = path.join(tempRoot, "workspace-a");
  const workspaceB = path.join(tempRoot, "workspace-b");
  const flowB = path.join(workspaceB, ".workspace", "agentflow", "pipelines", "flow-b");
  try {
    runStartupStorageMigrations({ dataRoot, workspaceRoot: workspaceA });
    seedFlow(flowB, "flow.yaml", LOSSLESS_YAML);
    const result = runStartupStorageMigrations({ dataRoot, workspaceRoot: workspaceB });
    assert.equal(result.attempted.length, 1);
    assert.equal(result.attempted[0].kind, "workspace");
    assert.ok(fs.existsSync(path.join(flowB, "workspace.flow.js")));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
