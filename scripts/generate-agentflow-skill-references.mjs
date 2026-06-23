#!/usr/bin/env node
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { fileURLToPath } from "url";

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
  const fm = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  let meta = {};
  if (fm) {
    try { meta = yaml.load(fm[1]) || {}; } catch (_) {}
  }
  const id = path.basename(filePath, ".md");
  return {
    id,
    displayName: String(meta.displayName || id).trim(),
    description: String(meta.description || "").trim().replace(/\s+/g, " "),
    input: Array.isArray(meta.input) ? meta.input : [],
    output: Array.isArray(meta.output) ? meta.output : [],
    body: stripFrontmatter(raw),
  };
}

function categoryForNode(id) {
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
    .sort((a, b) => a.id.localeCompare(b.id));
  const localOnly = new Set([
    "control_if",
    "control_delay",
    "control_wait_until",
    "control_deadline",
    "control_cancelled",
    "control_interval_loop",
    "control_cd_workspace",
    "control_load_skills",
    "control_start",
    "control_end",
    "tool_git_checkout",
    "tool_print",
    "tool_user_check",
    "tool_user_ask",
    "provide_str",
    "provide_file",
  ]);
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
    "- Edge handles are positional: `input-0`, `output-0`, etc. Match slot order exactly.",
    "",
  ];
  for (const cat of ["agent", "control", "tool", "provide", "other"]) {
    const group = nodes.filter((n) => categoryForNode(n.id) === cat);
    if (group.length === 0) continue;
    lines.push(`## ${cat}`, "");
    for (const node of group) {
      lines.push(`### ${node.id}`);
      lines.push("");
      lines.push(`- Display: ${node.displayName}`);
      if (node.description) lines.push(`- Description: ${node.description}`);
      lines.push(`- Runtime: ${localOnly.has(node.id) ? "local-only" : node.id === "tool_nodejs" ? "direct script when script exists, otherwise agent" : "agent/runner"}`);
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

function writeGenerated(relPath, content) {
  const abs = path.join(root, relPath);
  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, content.trim() + "\n", "utf-8");
}

writeGenerated("skills/agentflow-node-reference/references/builtin-nodes.md", generateNodeReference());
writeGenerated("skills/agentflow-placeholder-reference/references/placeholders.md", generatePlaceholderReference());
console.log("Generated AgentFlow skill references.");
