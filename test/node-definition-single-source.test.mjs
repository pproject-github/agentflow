import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseNodeFrontmatter, listNodesJson } from "../bin/lib/catalog-flows.mjs";
import { RETIRED_NODE_IDS } from "../bin/lib/legacy-flow-execution.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodesDir = path.join(repoRoot, "builtin", "nodes");

function readAllNodeDefinitions() {
  const out = new Map();
  for (const file of fs.readdirSync(nodesDir).filter((f) => f.endsWith(".md"))) {
    const id = file.slice(0, -3);
    out.set(id, parseNodeFrontmatter(fs.readFileSync(path.join(nodesDir, file), "utf-8")));
  }
  return out;
}

test("每个内置节点定义都声明了 runtime 分级", () => {
  const defs = readAllNodeDefinitions();
  assert.ok(defs.size >= 42, `builtin/nodes 只解析出 ${defs.size} 个定义`);
  for (const [id, def] of defs) {
    assert.ok(
      ["native", "degraded", "none"].includes(def.runtime),
      `${id}: runtime 必须是 native / degraded / none，实际 ${def.runtime}`,
    );
  }
});

test("runtime: none 的节点与 RETIRED_NODE_IDS 一一对应", () => {
  const defs = readAllNodeDefinitions();
  const declaredNone = [...defs].filter(([, d]) => d.runtime === "none").map(([id]) => id).sort();
  // control_agent_toBool 是 degraded（靠通用 agent + 输出契约工作），但产品上仍不进面板
  const expectedNone = [...RETIRED_NODE_IDS].filter((id) => id !== "control_agent_toBool").sort();
  assert.deepEqual(declaredNone, expectedNone);
});

test("RETIRED_NODE_IDS 里的节点都带 palette: hidden", () => {
  const defs = readAllNodeDefinitions();
  for (const id of RETIRED_NODE_IDS) {
    const def = defs.get(id);
    assert.ok(def, `RETIRED_NODE_IDS 引用了不存在的节点定义 ${id}`);
    assert.equal(def.paletteHidden, true, `${id} 已退役但 .md 没写 palette: hidden`);
  }
});

test("Workspace 运行时 dispatch 到的每个 definitionId 都有 native/degraded 的定义", () => {
  const defs = readAllNodeDefinitions();
  const src = fs.readFileSync(path.join(repoRoot, "bin", "lib", "ui-server.mjs"), "utf-8");
  const dispatched = new Set();
  for (const m of src.matchAll(/\b(?:defId|id)\s*===\s*"([a-z][a-zA-Z_]*)"/g)) {
    if (defs.has(m[1])) dispatched.add(m[1]);
  }
  assert.ok(dispatched.size >= 25, `只从 ui-server 扫出 ${dispatched.size} 个 dispatch 分支`);
  for (const id of [...dispatched].sort()) {
    assert.notEqual(
      defs.get(id).runtime,
      "none",
      `ui-server 里有 ${id} 的 handler，但 builtin/nodes/${id}.md 写着 runtime: none`,
    );
  }
});

test("曾经硬编码在 WorkspacePage.jsx 的定义已迁到 builtin/nodes 且形状不变", () => {
  const catalog = listNodesJson(repoRoot, "", "", {});
  const byId = new Map((Array.isArray(catalog) ? catalog : catalog.nodes || []).map((n) => [n.id, n]));
  const shape = (node) => ({
    type: node.type,
    runtime: node.runtimeTier,
    inputs: node.inputs.map((s) => `${s.type}:${s.name}`),
    outputs: node.outputs.map((s) => `${s.type}:${s.name}`),
  });

  assert.deepEqual(shape(byId.get("workspace_run")), {
    type: "control",
    runtime: "native",
    inputs: ["node:prev"],
    outputs: ["node:next"],
  });
  assert.deepEqual(shape(byId.get("workspace_scheduled_run")), {
    type: "control",
    runtime: "native",
    inputs: ["node:prev"],
    outputs: ["node:next"],
  });
  assert.deepEqual(shape(byId.get("control_load_skills")), {
    type: "control",
    runtime: "native",
    inputs: ["node:prev", "text:skillKeys"],
    outputs: ["node:next", "text:skillsContext"],
  });
  assert.deepEqual(shape(byId.get("control_load_mcp")), {
    type: "control",
    runtime: "native",
    inputs: ["node:prev", "text:serverNames"],
    outputs: ["node:next", "text:mcpContext"],
  });
  assert.deepEqual(shape(byId.get("control_cd_workspace")), {
    type: "control",
    runtime: "native",
    inputs: ["node:prev", "text:path", "text:label", "text:knowledgeContext", "text:workspaceContext"],
    outputs: ["node:next", "text:knowledgeContext", "text:workspaceContext", "file:cwd"],
  });
  assert.deepEqual(shape(byId.get("workspace_one_click_task")), {
    type: "agent",
    runtime: "native",
    inputs: [
      "node:prev",
      "text:skillKeys",
      "bool:includeWorkspaceContext",
      "text:displayType",
      "text:knowledgeContext",
      "text:workspaceContext",
    ],
    outputs: ["node:next", "text:content", "text:displayType"],
  });
});

test("WorkspacePage.jsx 不再硬编码节点定义", () => {
  const src = fs.readFileSync(
    path.join(repoRoot, "builtin", "web-ui", "src", "pages", "WorkspacePage.jsx"),
    "utf-8",
  );
  for (const name of [
    "HIDDEN_WORKSPACE_DEFS",
    "WORKSPACE_RUN_DEFINITION",
    "WORKSPACE_SCHEDULED_RUN_DEFINITION",
    "WORKSPACE_LOAD_SKILLS_DEFINITION",
    "WORKSPACE_LOAD_MCP_DEFINITION",
    "WORKSPACE_LOAD_WORKSPACE_DEFINITION",
    "WORKSPACE_CONTEXT_RUN_DEFINITION",
  ]) {
    assert.ok(!src.includes(name), `WorkspacePage.jsx 仍引用 ${name}；节点定义应只来自 builtin/nodes/*.md`);
  }
});

test("skills 参考文档都是 builtin/nodes 的最新生成物", () => {
  const generated = [
    path.join(repoRoot, "skills", "agentflow-node-reference", "references", "builtin-nodes.md"),
    path.join(repoRoot, "skills", "agentflow-flow-dsl", "references", "node-calls.md"),
  ];
  const before = generated.map((f) => fs.readFileSync(f, "utf-8"));
  execFileSync(process.execPath, [path.join(repoRoot, "scripts", "generate-agentflow-skill-references.mjs")], {
    cwd: repoRoot,
    stdio: "pipe",
  });
  const stale = generated.filter((f, i) => fs.readFileSync(f, "utf-8") !== before[i]);
  if (stale.length) {
    generated.forEach((f, i) => fs.writeFileSync(f, before[i], "utf-8"));
    assert.fail(`builtin/nodes/*.md 改过但没重跑生成器：${stale.map((f) => path.basename(f)).join(", ")}`);
  }
});

test("面板隐藏的节点不会出现在 /api/nodes 目录里", () => {
  const catalog = listNodesJson(repoRoot, "", "", {});
  const ids = new Set((Array.isArray(catalog) ? catalog : catalog.nodes || []).map((n) => n.id));
  for (const id of [...RETIRED_NODE_IDS, "control_user_workspace"]) {
    assert.ok(!ids.has(id), `${id} 不该出现在节点面板目录里`);
  }
});
