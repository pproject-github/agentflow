import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(".");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("Flow DSL owns Workspace graph editing and the duplicate graph skill is removed", () => {
  const dsl = read("skills/agentflow-flow-dsl/SKILL.md");
  const skillNames = fs.readdirSync(path.join(root, "skills"));

  assert.match(dsl, /直接修改现有 Workspace/);
  assert.match(dsl, /添加或删除节点、修改字段和连线/);
  assert.equal(skillNames.some((name) => name.endsWith("workspace-graph")), false);
});

test("new-flow template loads Flow DSL as its graph authoring skill", () => {
  const template = read("builtin/pipelines/new/workspace.flow.js");
  assert.match(template, /skillKeys: "agentflow-flow-dsl,agentflow-node-reference"/);
});

test("Workspace default skill collection only uses Flow DSL for graph editing", () => {
  const server = read("bin/lib/ui-server.mjs");
  const workspaceCollection = server.slice(
    server.indexOf('id: "workspace"'),
    server.indexOf("function feedbackStorePath"),
  );
  const defaultBlock = workspaceCollection.slice(
    workspaceCollection.indexOf("defaultKeys:"),
    workspaceCollection.indexOf("legacyDefaultKeys:"),
  );

  assert.match(defaultBlock, /agentflow-flow-dsl/);
});

test("Composer routes current graph work through lifecycle and DSL skills", () => {
  const server = read("bin/lib/ui-server.mjs");
  const composerPrompt = server.slice(
    server.indexOf("function buildComposerPromptWithFlowContext"),
    server.indexOf("export function startUiServer"),
  );

  assert.match(composerPrompt, /agentflow-author-flow/);
  assert.match(composerPrompt, /agentflow-flow-dsl/);
  assert.match(composerPrompt, /agentflow-node-dsl/);
  assert.doesNotMatch(composerPrompt, /agentflow-flow-add-instances/);
  assert.doesNotMatch(composerPrompt, /agentflow-flow-edit-node-fields/);
  assert.doesNotMatch(composerPrompt, /agentflow-flow-sync-ui/);
});
