import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
  // 运行时已经从 ui-server 拆到 workspace-server.mjs，dispatch 分支跟着走了
  const src = fs.readFileSync(path.join(repoRoot, "bin", "lib", "workspace-server.mjs"), "utf-8");
  const dispatched = new Set();
  for (const m of src.matchAll(/\b(?:defId|id)\s*===\s*"([a-z][a-zA-Z_]*)"/g)) {
    if (defs.has(m[1])) dispatched.add(m[1]);
  }
  assert.ok(dispatched.size >= 25, `只从 workspace-server 扫出 ${dispatched.size} 个 dispatch 分支`);
  for (const id of [...dispatched].sort()) {
    assert.notEqual(
      defs.get(id).runtime,
      "none",
      `workspace-server 里有 ${id} 的 handler，但 builtin/nodes/${id}.md 写着 runtime: none`,
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

test("skills 里写到的引脚名都真的存在", async () => {
  const { DEFINITIONS } = await import("../bin/lib/flow-dsl/defs.mjs");
  // 节点自身的字段，不是引脚——`tool_nodejs.script`、`agent_subAgent.body` 这种写法合法
  const NODE_FIELDS = new Set(["body", "script", "scriptRef", "label", "role", "model", "input", "output"]);
  const ids = Object.keys(DEFINITIONS).sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`\\b(${ids.join("|")})\\.([A-Za-z][A-Za-z0-9_]*)`, "g");

  const stale = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!entry.name.endsWith(".md")) continue;
      for (const match of fs.readFileSync(abs, "utf-8").matchAll(pattern)) {
        const [, definitionId, name] = match;
        if (NODE_FIELDS.has(name)) continue;
        const def = DEFINITIONS[definitionId];
        if (![...def.input, ...def.output].some((slot) => slot.name === name)) {
          stale.push(`${path.relative(repoRoot, abs)}: ${match[0]}`);
        }
      }
    }
  };
  walk(path.join(repoRoot, "skills"));
  // 改了节点定义就得改教模型怎么用它的文档，否则 AI 会照着写出 lint 不过的图
  assert.deepEqual([...new Set(stale)], [], "skills 里引用了不存在的引脚");
});

test("skills 里的完整流程示例本身能过 lint", async () => {
  const { lintFlowDir } = await import("../bin/lib/flow-dsl/lint.mjs");
  const { FLOW_SOURCE_FILENAME } = await import("../bin/lib/flow-dsl/index.mjs");

  // 只挑带 import 的代码块——那是「照着抄就能用」的完整示例，片段不算
  const examples = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!entry.name.endsWith(".md")) continue;
      const blocks = [...fs.readFileSync(abs, "utf-8").matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
      blocks.forEach((source, index) => {
        if (/from "agentflow\/flow"/.test(source)) {
          examples.push({ label: `${path.relative(repoRoot, abs)} #${index}`, source });
        }
      });
    }
  };
  walk(path.join(repoRoot, "skills"));
  // workspace-graph 已合并进 flow-dsl，不再为了凑数量维护一份重复完整示例。
  assert.ok(examples.length >= 2, `只找到 ${examples.length} 个完整示例，扫描大概坏了`);

  const failures = [];
  for (const example of examples) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-skill-example-"));
    try {
      fs.writeFileSync(path.join(dir, FLOW_SOURCE_FILENAME), example.source, "utf-8");
      const result = lintFlowDir(dir);
      // 示例里引用只存在于读者流程目录里的代码节点包和外置文件，这两类报错不算数
      const errors = result.errors.filter(
        (e) => !/节点包不存在|找不到对应文件|未知节点类型 pkg:/.test(e),
      );
      if (errors.length) failures.push(`${example.label}: ${errors.join("; ")}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.deepEqual(failures, [], "skills 里的示例自己都过不了 lint");
});

test("面板隐藏的节点不会出现在 /api/nodes 目录里", () => {
  const catalog = listNodesJson(repoRoot, "", "", {});
  const ids = new Set((Array.isArray(catalog) ? catalog : catalog.nodes || []).map((n) => n.id));
  for (const id of [...RETIRED_NODE_IDS, "control_user_workspace"]) {
    assert.ok(!ids.has(id), `${id} 不该出现在节点面板目录里`);
  }
});

test("Workspace hydration 可读取隐藏结构节点及其 UI，但仍标记为面板隐藏", () => {
  const catalog = listNodesJson(repoRoot, "", "", { includeHidden: true });
  const nodes = Array.isArray(catalog) ? catalog : catalog.nodes || [];
  const call = nodes.find((node) => node.id === "control_subflow_call");
  assert.ok(call, "子流程调用节点应可供已有实例做 UI hydration");
  assert.equal(call.paletteHidden, true);
  assert.equal(call.ui?.card?.sections?.[0]?.type, "subflow");
});
