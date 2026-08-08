/**
 * `workspace.flow.js` 的静态校验。
 *
 * 三类检查，对应三类真实会犯的错：
 *
 * 1. **语法层** —— 结构文件里不许出现控制流。写了 `for` / `if` / `await` 说明作者
 *    把节点实现塞进了图结构文件；实现该放 `nodes/<name>/index.mjs`。这条也保证了
 *    画布永远能靠静态解析渲染出来。
 * 2. **语义层** —— 节点类型是否存在、运行时是否真的支持（读各节点 .md 的
 *    `runtime:` 分级）、槽位是否存在、fan-in、环。
 * 3. **连通性** —— `control.if` 的 prediction 是否接了 bool、有没有孤立节点、
 *    有没有 run 入口。
 *
 * 注意 lint 的对象只有图结构文件。`nodes/` 下的节点实现是普通 JS，`for`/`await`
 * 随便写，不受这套约束。
 */
import fs from "fs";
import path from "path";
import { parse as acornParse } from "acorn";

import { isNodePackageDir, readNodePackageManifest, slotMapToList } from "../node-package-manifest.mjs";
import { CTRL_SLOTS, RUN_DEFINITIONS, DEFINITIONS, definitionOf } from "./defs.mjs";
import { FLOW_SOURCE_FILENAME } from "./index.mjs";
import { parseFlowSource } from "./parser.mjs";

/** 图结构文件里禁用的语法；值是给人看的名字。 */
const BANNED_SYNTAX = {
  ForStatement: "for",
  ForOfStatement: "for-of",
  ForInStatement: "for-in",
  WhileStatement: "while",
  DoWhileStatement: "do-while",
  IfStatement: "if 语句",
  ConditionalExpression: "三元表达式",
  AwaitExpression: "await",
  SpreadElement: "展开运算符",
  FunctionDeclaration: "函数声明",
  ArrowFunctionExpression: "箭头函数",
  FunctionExpression: "函数表达式",
  SwitchStatement: "switch",
  TryStatement: "try",
  NewExpression: "new",
};

/** 这两类节点的槽位由实例自己定义，不受定义表约束。 */
const CUSTOM_SLOTS_ALLOWED = new Set(["agent_subAgent", "tool_nodejs"]);

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node);
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) value.forEach((v) => walk(v, visit));
    else if (value && typeof value === "object" && value.type) walk(value, visit);
  }
}

/** 扫 `<flowDir>/nodes/*` 下的代码节点包，返回 import specifier -> 定义。 */
function scanFlowLocalPackages(flowDir) {
  const out = {};
  const root = path.join(flowDir, "nodes");
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (!isNodePackageDir(dir)) continue;
    let manifest = null;
    try {
      manifest = readNodePackageManifest(dir, () => null);
    } catch {
      manifest = null;
    }
    if (!manifest) continue;
    const record = {
      id: manifest.id,
      input: manifest.input || slotMapToList({}, "input"),
      output: manifest.output || slotMapToList({}, "output"),
    };
    out[`./nodes/${entry.name}`] = record;
    out[`./nodes/${entry.name}/index.mjs`] = record;
  }
  return out;
}

/**
 * @param {string} flowDir 含 workspace.flow.js 的目录
 * @returns {{ errors: string[], warnings: string[], ir?: object }}
 */
export function lintFlowDir(flowDir) {
  const errors = [];
  const warnings = [];
  const sourcePath = path.join(flowDir, FLOW_SOURCE_FILENAME);
  if (!fs.existsSync(sourcePath)) return { errors: [`缺少 ${sourcePath}`], warnings };

  const source = fs.readFileSync(sourcePath, "utf-8");
  let ast;
  try {
    ast = acornParse(source, { ecmaVersion: 2022, sourceType: "module", locations: true });
  } catch (e) {
    return { errors: [`语法错误: ${(e && e.message) || e}`], warnings };
  }

  walk(ast, (node) => {
    if (BANNED_SYNTAX[node.type]) {
      errors.push(`结构文件禁用 ${BANNED_SYNTAX[node.type]} @L${node.loc?.start.line}（节点实现请放 nodes/<name>/index.mjs）`);
    }
    if (node.type === "MemberExpression" && node.computed) {
      errors.push(`禁止动态属性访问 @L${node.loc?.start.line}`);
    }
  });

  // file() 引用的外置文本
  const files = {};
  walk(ast, (node) => {
    if (node.type !== "CallExpression" || node.callee?.name !== "file") return;
    const rel = node.arguments[0]?.value;
    if (typeof rel !== "string") {
      errors.push(`file() 参数必须是字符串字面量 @L${node.loc?.start.line}`);
      return;
    }
    const abs = path.join(flowDir, rel);
    if (!fs.existsSync(abs)) errors.push(`file(${JSON.stringify(rel)}) 指向的文件不存在`);
    else files[rel] = fs.readFileSync(abs, "utf-8");
  });

  const packages = scanFlowLocalPackages(flowDir);
  const localDefs = {};
  for (const pkg of Object.values(packages)) {
    localDefs[`local:${pkg.id}`] = { input: pkg.input, output: pkg.output, runtime: "native" };
  }
  const lookupDef = (definitionId) => (
    localDefs[definitionId] || (DEFINITIONS[definitionId] ? definitionOf(definitionId) : null)
  );

  for (const stmt of ast.body) {
    if (stmt.type !== "ImportDeclaration") continue;
    const spec = String(stmt.source.value);
    if (spec === "agentflow/flow") continue;
    if (spec.startsWith("./nodes/")) {
      if (!packages[spec]) errors.push(`import ${JSON.stringify(spec)}：节点包不存在或缺 index.mjs / node.yaml`);
    } else if (!spec.startsWith("marketplace:")) {
      warnings.push(`import ${JSON.stringify(spec)}：来源不是 ./nodes/ 也不是 marketplace:`);
    }
  }

  let ir;
  try {
    ir = parseFlowSource(source, {
      files,
      resolvePackage: (spec) => (packages[spec] ? { definitionId: `local:${packages[spec].id}` } : {}),
    });
  } catch (e) {
    errors.push(`解析成图失败: ${(e && e.message) || e}`);
    return { errors, warnings };
  }

  // 解析器读不出图结构的地方。lint 是列全问题的地方，所以这里不抛，逐条报出来
  for (const item of ir.unresolved) {
    errors.push(`${FLOW_SOURCE_FILENAME}:${item.line} ${item.message}`);
  }

  const N = ir.nodes;

  for (const [id, node] of Object.entries(N)) {
    const definitionId = node.definitionId;
    const def = lookupDef(definitionId);
    if (!def) {
      errors.push(`${id}: 未知节点类型 ${definitionId}`);
      continue;
    }
    // 运行时支持程度来自各节点 .md 的 runtime: 字段，不是这里的第二份清单
    if (!definitionId.startsWith("local:")) {
      if (def.runtime === "degraded") {
        warnings.push(`${id}: ${definitionId} 无专用 handler，靠通用 agent + 输出契约工作；结果必须恰好是 true/false`);
      } else if (def.runtime === "none") {
        errors.push(`${id}: ${definitionId} 没有 Workspace 运行时实现`);
      }
    }
    if (CUSTOM_SLOTS_ALLOWED.has(definitionId)) {
      const defOut = new Set(def.output.map((s) => s.name));
      for (const slot of node.extraOut) {
        if (defOut.has(slot) || (node.declaredOut || []).includes(slot)) continue;
        errors.push(`${id}.${slot}: 自定义输出槽要用 const { ${slot} } = ${id} 声明，并在 body 里按 ---agentflow 信封回填`);
      }
    } else if (!definitionId.startsWith("local:")) {
      const defIn = new Set(def.input.map((s) => s.name));
      const defOut = new Set(def.output.map((s) => s.name));
      for (const slot of node.extraIn) if (!defIn.has(slot)) errors.push(`${id}[${definitionId}]: 不存在的输入槽 "${slot}"`);
      for (const slot of node.extraOut) if (!defOut.has(slot)) errors.push(`${id}[${definitionId}]: 不存在的输出槽 "${slot}"`);
    }
  }

  const inputSeen = new Map();
  const adjacency = new Map();
  for (const key of ir.edges) {
    const [src, fromSlot, dst, toSlot] = key.split("|");
    if (!N[src]) {
      errors.push(`边引用了未声明的节点 ${src}`);
      continue;
    }
    if (!N[dst]) {
      errors.push(`边引用了未声明的节点 ${dst}`);
      continue;
    }
    const def = lookupDef(N[src].definitionId);
    if (def && !CTRL_SLOTS.has(fromSlot)
      && !def.output.some((s) => s.name === fromSlot)
      && !(N[src].declaredOut || []).includes(fromSlot)) {
      errors.push(`${src}.${fromSlot}: 输出槽不存在（只有 ${def.output.map((s) => s.name).join("/")}）`);
    }
    const target = `${dst}|${toSlot}`;
    if (inputSeen.has(target)) {
      errors.push(`fan-in 禁止: ${dst}.${toSlot} 被 ${inputSeen.get(target)} 和 ${src} 同时连入`);
    } else {
      inputSeen.set(target, src);
    }
    if (!adjacency.has(src)) adjacency.set(src, []);
    adjacency.get(src).push(dst);
  }

  // Workspace 运行计划是 DAG，有环会被运行时直接拒绝——在这里就报出来
  const color = new Map();
  const visit = (u) => {
    color.set(u, 1);
    for (const v of adjacency.get(u) || []) {
      if (color.get(v) === 1) {
        errors.push(`存在环: ${u} -> ${v}`);
        return;
      }
      if (!color.has(v)) visit(v);
    }
    color.set(u, 2);
  };
  for (const id of Object.keys(N)) if (!color.has(id)) visit(id);

  for (const [id, node] of Object.entries(N)) {
    if (node.definitionId !== "control_if") continue;
    const edge = ir.edges.find((e) => e.endsWith(`|${id}|prediction`));
    if (!edge) {
      errors.push(`${id}: control.if 的 prediction 未接线`);
    } else {
      const [src, slot] = edge.split("|");
      const type = lookupDef(N[src]?.definitionId)?.output.find((s) => s.name === slot)?.type;
      if (type && type !== "bool") errors.push(`${id}: prediction 只能接 bool，${src}.${slot} 是 ${type}`);
    }
    for (const [slot, label] of [["next1", "then"], ["next2", "else"]]) {
      if (!ir.edges.some((e) => e.startsWith(`${id}|${slot}|`))) warnings.push(`${id}: control.if 缺 ${label} 分支`);
    }
  }

  const touched = new Set(ir.edges.flatMap((e) => {
    const p = e.split("|");
    return [p[0], p[2]];
  }));
  for (const id of Object.keys(N)) {
    if (!touched.has(id) && !RUN_DEFINITIONS.has(N[id].definitionId)) warnings.push(`${id}: 未接任何线`);
  }
  if (!Object.values(N).some((n) => RUN_DEFINITIONS.has(n.definitionId))) {
    warnings.push("没有任何 run 入口，这张图不会被执行");
  }

  return { errors, warnings, ir };
}
