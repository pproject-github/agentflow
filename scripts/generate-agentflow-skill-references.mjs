#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseNodeFrontmatter } from "../bin/lib/catalog-flows.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function stripFrontmatter(raw) {
  const m = String(raw || "").match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  return m ? String(raw || "").slice(m[0].length).trim() : String(raw || "").trim();
}

function parseNodeDefinition(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const id = path.basename(filePath, ".md");
  const meta = parseNodeFrontmatter(raw);
  return {
    id,
    displayName: String(meta.displayName || id).trim(),
    description: String(meta.description || "").trim().replace(/\s+/g, " "),
    input: meta.input,
    output: meta.output,
    runtime: meta.runtime,
    category: meta.type,
    body: stripFrontmatter(raw),
  };
}

/** 分组用；display_ 单独成组，其余优先看 frontmatter 的 type:，再回落到 id 前缀。 */
function categoryForNode(node) {
  const id = node.id;
  if (id.startsWith("display_")) return "display";
  if (node.category === "agent") return "agent";
  if (node.category === "control") return "control";
  if (node.category === "provide") return "provide";
  if (id.startsWith("control_")) return "control";
  if (id.startsWith("tool_")) return "tool";
  if (id.startsWith("provide_")) return "provide";
  if (id.startsWith("agent_")) return "agent";
  return "other";
}

function slotsTable(slots) {
  if (!Array.isArray(slots) || slots.length === 0) return "无";
  return slots
    .map((slot, index) => {
      const name = String(slot?.name || "").trim() || `#${index}`;
      const type = String(slot?.type || "").trim() || "-";
      const def = slot?.default != null && String(slot.default) !== "" ? ` = ${String(slot.default)}` : "";
      return `${index}. \`${name}\`:${type}${def}`;
    })
    .join("; ");
}

function generateNodeReference() {
  const dir = path.join(root, "builtin", "nodes");
  const nodes = fs.readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => parseNodeDefinition(path.join(dir, name)))
    // 只收 Workspace 运行时有专用 handler 的类型：Composer 读到 none/degraded 就会照着
    // 生成拿不到文档承诺语义的图。分级来自各节点 .md 的 `runtime:` 字段。
    .filter((node) => node.runtime === "native")
    .sort((a, b) => a.id.localeCompare(b.id));
  // native 里唯一会真正调 agent 的三个；其余都由 runtime 本地执行完。
  const agentBacked = new Set(["agent_subAgent", "tool_nodejs", "workspace_one_click_task"]);
  const lines = [
    "# AgentFlow Builtin Nodes Reference",
    "",
    "> Generated from `builtin/nodes/*.md` by `scripts/generate-agentflow-skill-references.mjs`.",
    "",
    "## Rules Of Thumb",
    "",
    "- `tool_nodejs` needs an executable `script`; `body` is documentation when `script` exists.",
    "- `agent_subAgent` is for semantic/code/text reasoning tasks.",
    "- Local-only nodes are executed by AgentFlow runtime and do not call an agent.",
    "- The Workspace runtime executes a DAG; cyclic graphs are rejected. Express check-then-fix as forward steps.",
    "- Edge handles are positional: `input-0`, `output-0`, etc. Match slot order exactly.",
    "",
  ];
  for (const cat of ["agent", "control", "tool", "display", "provide", "other"]) {
    const group = nodes.filter((n) => categoryForNode(n) === cat);
    if (group.length === 0) continue;
    lines.push(`## ${cat}`, "");
    for (const node of group) {
      lines.push(`### ${node.id}`);
      lines.push("");
      lines.push(`- Display: ${node.displayName}`);
      if (node.description) lines.push(`- Description: ${node.description}`);
      lines.push(`- Runtime: ${node.id === "tool_nodejs"
        ? "direct script when script exists, otherwise agent"
        : agentBacked.has(node.id) ? "agent/runner" : "local-only"}`);
      lines.push(`- Inputs: ${slotsTable(node.input)}`);
      lines.push(`- Outputs: ${slotsTable(node.output)}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function generatePlaceholderReference() {
  const bodyPath = path.join(root, "builtin", "web-ui", "src", "bodyPlaceholders.js");
  const raw = fs.readFileSync(bodyPath, "utf-8");
  const orderMatch = raw.match(/RUNTIME_PLACEHOLDER_KEYS_ORDER\s*=\s*\[([^\]]+)\]/);
  const keys = orderMatch
    ? [...orderMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    : ["workspaceRoot", "pipelineWorkspace", "cwd", "flowName", "runDir", "flowDir"];
  const descriptions = {
    workspaceRoot: "Current execution workspace. After CD Workspace, this is the target project workspace.",
    pipelineWorkspace: "Original AgentFlow pipeline workspace. Use this to access pipeline-owned files after CD Workspace.",
    cwd: "Alias-like current working directory for the runtime workspace context.",
    flowName: "Current pipeline id/name.",
    runDir: "Current run directory, relative to pipeline workspace.",
    flowDir: "Absolute directory containing the current flow.yaml.",
  };
  return [
    "# AgentFlow Placeholder Reference",
    "",
    "> Generated from `builtin/web-ui/src/bodyPlaceholders.js` by `scripts/generate-agentflow-skill-references.mjs`.",
    "",
    "## Runtime Placeholders",
    "",
    ...keys.map((key) => `- \`\${${key}}\`: ${descriptions[key] || "Runtime value."}`),
    "",
    "## Slot Placeholders",
    "",
    "- `${input.<slotName>}`: input slot value by name.",
    "- `${output.<slotName>}`: output slot path by name.",
    "- `${<slotName>}`: shorthand for input or output slot when unambiguous.",
    "",
    "Do not wrap placeholders in extra quotes inside `script`; AgentFlow shell-quotes substituted values.",
  ].join("\n");
}

/**
 * DSL 的节点调用表。手写会漂——上一版表里还留着运行时早就不读的 mergeMode / previous
 * 这些槽，所以从定义表直接生成。
 */
async function generateDslNodeTable() {
  const { DEFINITIONS, apiName } = await import("../bin/lib/flow-dsl/defs.mjs");
  const CTRL = new Set(["prev", "next", "next1", "next2"]);
  const rows = Object.entries(DEFINITIONS)
    .filter(([, def]) => def.runtime === "native")
    .map(([id, def]) => {
      const fmt = (slots) => slots
        .filter((s) => !CTRL.has(s.name))
        .map((s) => `${s.name}:${s.type}`)
        .join(", ") || "—";
      return { call: apiName(id), input: fmt(def.input), output: fmt(def.output) };
    })
    .sort((a, b) => a.call.localeCompare(b.call));
  return [
    "# AgentFlow Flow DSL — 内置节点调用表",
    "",
    "> Generated from `builtin/nodes/*.md` by `scripts/generate-agentflow-skill-references.mjs`.",
    "> 只列 `runtime: native` 的节点——其余类型 lint 会直接报错。",
    "",
    "`prev` / `next` / `next1` / `next2` 是控制引脚，由 `flow()` 自动接，**不要手写**。",
    "",
    "| 调用 | 输入引脚 | 输出引脚 |",
    "|------|----------|----------|",
    ...rows.map((r) => `| \`${r.call}\` | ${r.input} | ${r.output} |`),
    "",
  ].join("\n");
}

function writeGenerated(relPath, content) {
  const abs = path.join(root, relPath);
  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, content.trim() + "\n", "utf-8");
}

writeGenerated("skills/agentflow-node-reference/references/builtin-nodes.md", generateNodeReference());
writeGenerated("skills/agentflow-placeholder-reference/references/placeholders.md", generatePlaceholderReference());
writeGenerated("skills/agentflow-flow-dsl/references/node-calls.md", await generateDslNodeTable());
console.log("Generated AgentFlow skill references.");
