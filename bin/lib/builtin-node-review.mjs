import fs from "node:fs";
import path from "node:path";
import { parse as acornParse } from "acorn";

import { PACKAGE_ROOT } from "./paths.mjs";

const WORKSPACE_RUNTIME_PATH = "bin/lib/workspace-server.mjs";

// Only modules explicitly listed here are exposed in full. The runtime adapter is
// extracted from workspace-server.mjs so the review always follows the code that
// actually dispatches the built-in node without exposing the whole server file.
const BUILTIN_NODE_IMPLEMENTATION_FILES = new Map([
  ["tool_wecom_send_group_markdown", ["bin/lib/wecom.mjs"]],
  ["tool_wecom_send_app_markdown", ["bin/lib/wecom.mjs"]],
]);

const sourceCache = new Map();
let runtimeAstCache = null;

function readPackageSource(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) return "";
  if (sourceCache.has(normalized)) return sourceCache.get(normalized);
  const absolutePath = path.join(PACKAGE_ROOT, normalized);
  let source = "";
  try {
    if (fs.statSync(absolutePath).isFile()) source = fs.readFileSync(absolutePath, "utf8").replace(/\r\n/g, "\n");
  } catch {}
  sourceCache.set(normalized, source);
  return source;
}

function walkAst(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (["start", "end", "loc", "type"].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit);
    } else if (value && typeof value === "object") {
      walkAst(value, visit);
    }
  }
}

function astContainsString(node, expected) {
  let found = false;
  walkAst(node, (candidate) => {
    if (candidate.type === "Literal" && candidate.value === expected) found = true;
  });
  return found;
}

function runtimeAst() {
  const source = readPackageSource(WORKSPACE_RUNTIME_PATH);
  if (!source) return { source: "", ast: null };
  if (runtimeAstCache?.source === source) return runtimeAstCache;
  let ast = null;
  try {
    ast = acornParse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  } catch {}
  runtimeAstCache = { source, ast };
  return runtimeAstCache;
}

function runtimeAdapterSource(definitionId) {
  const { source, ast } = runtimeAst();
  if (!source || !ast) return "";
  const matches = [];
  walkAst(ast, (node) => {
    if (node.type !== "IfStatement" || !astContainsString(node.test, definitionId)) return;
    matches.push(source.slice(node.start, node.end).trim());
  });
  return matches.join("\n\n");
}

export function builtinNodeReviewSources(definitionId = "") {
  const id = String(definitionId || "").trim();
  if (!id) return [];
  const sources = [];
  const adapter = runtimeAdapterSource(id);
  if (adapter) {
    sources.push({
      sourcePath: `builtin/${id}/runtime-adapter.mjs`,
      title: "内置运行适配器",
      kind: "builtin-adapter",
      content: adapter,
    });
  }
  for (const relativePath of BUILTIN_NODE_IMPLEMENTATION_FILES.get(id) || []) {
    const content = readPackageSource(relativePath);
    if (!content) continue;
    sources.push({
      sourcePath: relativePath,
      title: `内置实现 · ${path.basename(relativePath)}`,
      kind: "builtin-implementation",
      content,
    });
  }
  return sources;
}
