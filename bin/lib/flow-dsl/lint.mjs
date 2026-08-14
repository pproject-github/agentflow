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

import { slotTypeCompatibility } from "../../../shared/slot-types.js";
import { CTRL_SLOTS, RUN_DEFINITIONS, DEFINITIONS, definitionOf } from "./defs.mjs";
import { packageResolverFor, scanAvailableNodePackages } from "./packages.mjs";
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
const CUSTOM_SLOTS_ALLOWED = new Set(["agent_subAgent", "tool_nodejs", "control_subflow_call"]);

function declaredSlot(node, kind, name) {
  const slots = node?.packageDef?.[kind]
    || definitionOf(node?.definitionId)?.[kind === "input" ? "input" : "output"]
    || [];
  return slots.find((slot) => String(slot?.name || "") === String(name || "")) || null;
}

function declaredSlotType(node, kind, name) {
  const slot = declaredSlot(node, kind, name);
  if (slot?.type) return String(slot.type);
  if (kind === "input" && node?.inputTypes?.[name]) return String(node.inputTypes[name]);
  return "";
}

function parseJsonInput(node, name) {
  const raw = String(node?.inputs?.[name] || "").trim();
  if (!raw) return { value: null, error: "为空" };
  try {
    return { value: JSON.parse(raw), error: "" };
  } catch (error) {
    return { value: null, error: error.message };
  }
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node);
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) value.forEach((v) => walk(v, visit));
    else if (value && typeof value === "object" && value.type) walk(value, visit);
  }
}

/**
 * @param {string} flowDir 含 workspace.flow.js 的目录
 * @returns {{ errors: string[], warnings: string[], ir?: object }}
 */
export function lintFlowDir(flowDir, opts = {}) {
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

  // 与存储层同一份扫描。分成两份就会出现「lint 绿灯、画布是错图」——包节点在图里
  // 到底长什么样，两边必须给同一个答案。
  const packages = scanAvailableNodePackages(flowDir, opts.workspaceRoot || "");
  const lookupDef = (definitionId) => (DEFINITIONS[definitionId] ? definitionOf(definitionId) : null);

  for (const stmt of ast.body) {
    if (stmt.type !== "ImportDeclaration") continue;
    const spec = String(stmt.source.value);
    if (spec === "agentflow/flow") continue;
    if (spec.startsWith("./nodes/")) {
      if (!packages.bySpecifier[spec]) errors.push(`import ${JSON.stringify(spec)}：节点包不存在或缺 index.mjs / node.yaml`);
    } else if (spec.startsWith("marketplace:")) {
      if (!packages.bySpecifier[spec]) errors.push(`import ${JSON.stringify(spec)}：本地未安装该 marketplace 节点包`);
    } else {
      warnings.push(`import ${JSON.stringify(spec)}：来源不是 ./nodes/ 也不是 marketplace:`);
    }
  }

  let ir;
  try {
    ir = parseFlowSource(source, {
      files,
      resolvePackage: packageResolverFor(packages),
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
  const subflows = ir?.subflows && typeof ir.subflows === "object" ? ir.subflows : {};

  const ownerOf = new Map();
  for (const [subflowId, subflow] of Object.entries(subflows)) {
    if (!(subflow.roots || []).length) errors.push(`${subflowId}: 子流程没有执行入口`);
    for (const nodeId of subflow.nodeIds || []) {
      if (!N[nodeId]) errors.push(`${subflowId}: 成员 ${nodeId} 不存在`);
      if (ownerOf.has(nodeId) && ownerOf.get(nodeId) !== subflowId) {
        errors.push(`${nodeId}: 不能同时属于子流程 ${ownerOf.get(nodeId)} 和 ${subflowId}`);
      } else ownerOf.set(nodeId, subflowId);
    }
    for (const [name, binding] of Object.entries(subflow.inputs || {})) {
      if (N[binding.nodeId]?.definitionId !== "workspace_subflow_input") {
        errors.push(`${subflowId}.${name}: 输入代理 ${binding.nodeId} 不是 flow.input`);
      }
    }
    for (const [name, binding] of Object.entries(subflow.outputs || {})) {
      if (!ownerOf.has(binding.nodeId) && !(subflow.nodeIds || []).includes(binding.nodeId)) {
        errors.push(`${subflowId}.${name}: 输出来源 ${binding.nodeId} 不在子流程内`);
      }
    }
  }

  for (const [id, node] of Object.entries(N)) {
    const definitionId = node.definitionId;
    const def = lookupDef(definitionId);
    if (!def) {
      errors.push(`${id}: 未知节点类型 ${definitionId}`);
      continue;
    }
    if (definitionId === "control_subflow_call" && !subflows[node.attrs?.subflowId]) {
      errors.push(`${id}: 引用的子流程 ${node.attrs?.subflowId || "(empty)"} 不存在`);
    }
    if (definitionId === "context_knowledge") {
      const parsed = parseJsonInput(node, "workspaceIds");
      if (parsed.error) errors.push(`${id}: context.knowledge workspaceIds 必须是 JSON 数组（${parsed.error}）`);
      else if (!Array.isArray(parsed.value) || parsed.value.length === 0) errors.push(`${id}: context.knowledge 至少选择一个 Workspace ID`);
      else if (parsed.value.some((value) => typeof value !== "string" || !String(value).trim())) errors.push(`${id}: context.knowledge workspaceIds 只能包含非空字符串 ID`);
    }
    if (definitionId === "context_skills") {
      const parsed = parseJsonInput(node, "skills");
      if (parsed.error) errors.push(`${id}: context.skills skills 必须是 JSON 数组（${parsed.error}）`);
      else if (!Array.isArray(parsed.value) || parsed.value.length === 0) errors.push(`${id}: context.skills 至少声明一个 skill`);
    }
    if (definitionId === "context_workspace") {
      const workspaceId = String(node.inputs?.workspaceId || "current").trim();
      const access = String(node.inputs?.access || "read-write").trim().toLowerCase();
      if (!workspaceId) errors.push(`${id}: context.workspace workspaceId 不能为空`);
      if (!["read-only", "read-write"].includes(access)) errors.push(`${id}: context.workspace access 只能是 read-only 或 read-write`);
    }
    if (definitionId === "context_bundle") {
      const incoming = ir.edges.filter((edge) => edge.split("|")[2] === id && edge.split("|")[3] !== "prev");
      if (!incoming.length) errors.push(`${id}: context.bundle 至少连接一个 Context 资源`);
      const literal = Object.entries(node.inputs || {}).filter(([, value]) => String(value || "").trim());
      if (literal.length) errors.push(`${id}: context.bundle 只能连接资源节点，不能内嵌 Context 正文`);
    }
    if (definitionId === "control_while") {
      const conditionId = String(node.attrs?.conditionSubflowId || "");
      const bodyId = String(node.attrs?.bodySubflowId || "");
      const hasSubflowRefs = Boolean(conditionId || bodyId);
      if (hasSubflowRefs && node.script) {
        errors.push(`${id}: control.while 不能同时声明 step 脚本和 Condition/Body 子流程`);
      } else if (hasSubflowRefs) {
        if (!conditionId || !bodyId) {
          errors.push(`${id}: control.while 必须同时声明 Condition 和 Body 子流程`);
        } else if (conditionId === bodyId) {
          errors.push(`${id}: control.while 的 Condition 和 Body 必须是不同子流程`);
        }
        const condition = subflows[conditionId];
        const body = subflows[bodyId];
        if (!condition) errors.push(`${id}: Condition 子流程 ${conditionId || "(empty)"} 不存在`);
        if (!body) errors.push(`${id}: Body 子流程 ${bodyId || "(empty)"} 不存在`);
        for (const name of ["state", "iteration"]) {
          if (condition && !condition.inputs?.[name]) errors.push(`${id}: Condition 子流程 ${conditionId} 缺少输入 ${name}`);
        }
        if (condition && !condition.outputs?.decision) {
          errors.push(`${id}: Condition 子流程 ${conditionId} 缺少输出 decision`);
        }
        for (const name of ["state", "iteration", "idempotencyKey"]) {
          if (body && !body.inputs?.[name]) errors.push(`${id}: Body 子流程 ${bodyId} 缺少输入 ${name}`);
        }
        if (body && !body.outputs?.state) errors.push(`${id}: Body 子流程 ${bodyId} 缺少输出 state`);
        for (const [contract, name, expected] of [
          [condition?.inputs, "context", "context"],
          [condition?.inputs, "state", "json"],
          [condition?.inputs, "iteration", "text"],
          [condition?.outputs, "decision", "text"],
          [body?.inputs, "context", "context"],
          [body?.inputs, "state", "json"],
          [body?.inputs, "iteration", "text"],
          [body?.inputs, "idempotencyKey", "text"],
          [body?.outputs, "state", "json"],
        ]) {
          const actual = String(contract?.[name]?.type || "");
          if (actual && actual !== expected) {
            errors.push(`${id}: While 契约 ${name} 必须是 ${expected}，当前是 ${actual}`);
          }
        }
      } else if (!node.script) {
        errors.push(`${id}: control.while 需要 step 脚本，或 Condition/Body 两个子流程`);
      }
    }
    // 运行时支持程度来自各节点 .md 的 runtime: 字段，不是这里的第二份清单
    if (def.runtime === "degraded") {
      warnings.push(`${id}: ${definitionId} 无专用 handler，靠通用 agent + 输出契约工作；结果必须恰好是 true/false`);
    } else if (def.runtime === "none") {
      errors.push(`${id}: ${definitionId} 没有 Workspace 运行时实现`);
    }
    if (CUSTOM_SLOTS_ALLOWED.has(definitionId)) {
      const defOut = new Set(def.output.map((s) => s.name));
      for (const slot of node.extraOut) {
        if (defOut.has(slot) || (node.declaredOut || []).includes(slot)) continue;
        errors.push(`${id}.${slot}: 自定义输出槽要用 const { ${slot} } = ${id} 声明，并在 body 里按 ---agentflow 信封回填`);
      }
    } else {
      const defIn = new Set(def.input.map((s) => s.name));
      const defOut = new Set(def.output.map((s) => s.name));
      for (const slot of node.extraIn) if (!defIn.has(slot)) errors.push(`${id}[${definitionId}]: 不存在的输入槽 "${slot}"`);
      for (const slot of node.extraOut) if (!defOut.has(slot)) errors.push(`${id}[${definitionId}]: 不存在的输出槽 "${slot}"`);
    }
    if (definitionId === "agent_subAgent") {
      const incomingNames = new Set(ir.edges
        .map((edge) => edge.split("|"))
        .filter((parts) => parts[2] === id)
        .map((parts) => parts[3]));
      if (incomingNames.has("context") && ["knowledgeContext", "skillsContext", "workspaceContext", "mcpContext"].some((name) => incomingNames.has(name))) {
        warnings.push(`${id}: 已连接 context Bundle，不要再重复连接旧 Context 文本引脚`);
      }
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
    const srcOwner = ownerOf.get(src) || "";
    const dstOwner = ownerOf.get(dst) || "";
    if (srcOwner !== dstOwner) {
      errors.push(`子流程边界禁止直接连线: ${src}.${fromSlot} (${srcOwner || "父流程"}) -> ${dst}.${toSlot} (${dstOwner || "父流程"})；请通过 flow.call 契约传值`);
    }
    const def = lookupDef(N[src].definitionId);
    if (def && !CTRL_SLOTS.has(fromSlot)
      && !def.output.some((s) => s.name === fromSlot)
      && !(N[src].declaredOut || []).includes(fromSlot)) {
      errors.push(`${src}.${fromSlot}: 输出槽不存在（只有 ${def.output.map((s) => s.name).join("/")}）`);
    }
    // 控制槽也得真的存在。`provide.*` 这类纯数据源没有 prev/next，写进 flow(...) 链里
    // 这条边落不下去——不报的话它会在往返时无声消失，链子断了还看不出原因。
    const dstDef = lookupDef(N[dst].definitionId);
    if (CTRL_SLOTS.has(toSlot) && dstDef && !dstDef.input.some((s) => s.name === toSlot)) {
      errors.push(`${dst}[${N[dst].definitionId}] 没有 ${toSlot} 槽，接不进控制链（这类节点只能被别的节点引用值）`);
    }
    if (CTRL_SLOTS.has(fromSlot) && def && !def.output.some((s) => s.name === fromSlot)) {
      errors.push(`${src}[${N[src].definitionId}] 没有 ${fromSlot} 槽，控制流串不下去`);
    }
    const sourceType = declaredSlotType(N[src], "output", fromSlot);
    // 自定义输入槽没有独立声明时会跟随上游类型，因此只对有明确目标类型的边做校验。
    const targetType = declaredSlotType(N[dst], "input", toSlot);
    if (sourceType && targetType) {
      const compatibility = slotTypeCompatibility(sourceType, targetType);
      if (!compatibility.compatible) {
        errors.push(
          `类型不兼容: ${src}.${fromSlot}(${compatibility.source}) -> `
          + `${dst}.${toSlot}(${compatibility.target})；请改用同类型引脚或显式转换节点`,
        );
      }
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

  // 图本身仍是 DAG，但子流程调用关系也不能递归，否则会形成运行时调用环。
  const callGraph = new Map(Object.keys(subflows).map((id) => [id, []]));
  for (const [nodeId, node] of Object.entries(N)) {
    const owner = ownerOf.get(nodeId);
    if (!owner) continue;
    if (node.definitionId === "control_subflow_call") {
      const target = String(node.attrs?.subflowId || "");
      if (target) callGraph.get(owner)?.push(target);
    }
    if (node.definitionId === "control_while") {
      for (const target of [node.attrs?.conditionSubflowId, node.attrs?.bodySubflowId]) {
        if (target) callGraph.get(owner)?.push(String(target));
      }
    }
  }
  const callColor = new Map();
  const visitCall = (id) => {
    callColor.set(id, 1);
    for (const next of callGraph.get(id) || []) {
      if (callColor.get(next) === 1) errors.push(`子流程递归调用禁止: ${id} -> ${next}`);
      else if (!callColor.has(next)) visitCall(next);
    }
    callColor.set(id, 2);
  };
  for (const id of callGraph.keys()) if (!callColor.has(id)) visitCall(id);

  for (const [id, node] of Object.entries(N)) {
    if (node.definitionId !== "control_if") continue;
    const edge = ir.edges.find((e) => e.endsWith(`|${id}|prediction`));
    if (!edge) {
      errors.push(`${id}: control.if 的 prediction 未接线`);
    } else {
      const [src, slot] = edge.split("|");
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
