/**
 * `workspace.flow.js` -> IR。
 *
 * **绝不执行代码**——用 acorn 取 AST 后静态读出来。画布渲染、lint、导入都走这条路径，
 * 执行第三方流程文件去画一张图既慢又不安全。
 *
 * 代价是能识别的写法有限：import、`const x = call(...)`、解构声明、以及
 * `flow.resume` / `flow.detached` 这两个表达式语句。
 *
 * 认不出来的东西**一律记进 `unresolved`**，绝不静默跳过。这个文件是流程的权威表示，
 * 「解析器看不懂就当它不存在」等于：画布少画一个节点，用户随手一保存，那个节点就从
 * 磁盘上消失了。调用方（`flowFilesToGraph` 默认、以及 lint）据此决定是报错还是列出来。
 */
import { parse as acornParse } from "acorn";

import { STD_SLOTS, definitionOf, definitionIdFromApi } from "./defs.mjs";

const calleePath = (n) => (
  n.type === "Identifier"
    ? n.name
    : (n.type === "MemberExpression" && !n.computed ? `${calleePath(n.object)}.${n.property.name}` : null)
);

const memberPath = (n) => (
  n.type === "MemberExpression" && !n.computed
    && n.object.type === "Identifier" && n.property.type === "Identifier"
    ? [n.object.name, n.property.name]
    : null
);

/**
 * @param {string} source workspace.flow.js
 * @param {{ files?: Record<string,string>, resolvePackage?: (specifier: string) => {definitionId?: string} }} [opts]
 *        files：`file("...")` 引用的外置文本，键是相对路径
 * @returns {{ nodes: object, edges: string[] }}
 */
export function parseFlowSource(source, opts = {}) {
  const files = opts.files || {};
  const ast = acornParse(source, { ecmaVersion: 2022, sourceType: "module", locations: true });

  /** 解析器认不出、因此没有进入图的东西。 */
  const unresolved = [];
  const unresolvedAt = (node, message) => {
    unresolved.push({ line: node?.loc?.start?.line || 0, message });
  };

  function stringOf(node) {
    if (!node) return null;
    if (node.type === "Literal" && typeof node.value === "string") return node.value;
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
    if (node.type === "CallExpression" && calleePath(node.callee) === "file") {
      const rel = stringOf(node.arguments[0]);
      if (rel == null) return null;
      if (!(rel in files)) throw new Error(`file(${JSON.stringify(rel)}) 找不到对应文件`);
      return files[rel];
    }
    return null;
  }

  // import 绑定 -> 代码节点包
  const packageOf = new Map();
  for (const stmt of ast.body) {
    if (stmt.type !== "ImportDeclaration") continue;
    const specifier = String(stmt.source.value);
    if (specifier === "agentflow/flow") continue;
    const def = stmt.specifiers.find((s) => s.type === "ImportDefaultSpecifier");
    if (def) {
      packageOf.set(def.local.name, {
        specifier,
        ...(opts.resolvePackage ? opts.resolvePackage(specifier) || {} : {}),
      });
    }
  }

  const nodes = {};
  const edges = [];
  const varOf = new Map();
  const pendingIf = [];
  const runDecls = [];
  const destructures = [];

  // 先扫一遍解构声明：`const { storyId } = node;` 让后面引用 storyId 时能还原成边
  for (const stmt of ast.body) {
    const decl = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (decl?.type !== "VariableDeclaration") continue;
    const d = decl.declarations[0];
    if (d?.id.type === "ObjectPattern" && d.init?.type === "Identifier") {
      for (const prop of d.id.properties) {
        const slot = prop.key.name ?? prop.key.value;
        varOf.set(prop.value.type === "Identifier" ? prop.value.name : slot, [d.init.name, slot]);
      }
      destructures.push({ node: d.init.name, slots: d.id.properties.map((p) => p.key.name ?? p.key.value) });
    }
  }

  function readPins(id, definitionId, obj) {
    const def = definitionOf(definitionId);
    const defInputs = new Set(def.input.map((s) => s.name));
    const defOutputs = new Set(def.output.map((s) => s.name));
    const node = nodes[id];
    if (!obj || obj.type !== "ObjectExpression") return;
    for (const prop of obj.properties) {
      if (prop.type !== "Property") {
        unresolvedAt(prop, `${id}: 引脚对象里出现了展开运算，静态解析读不出引脚`);
        continue;
      }
      if (prop.computed) {
        unresolvedAt(prop, `${id}: 引脚名不能是动态表达式`);
        continue;
      }
      const key = prop.key.name ?? prop.key.value;
      const isCustom = !STD_SLOTS.has(key) && !defInputs.has(key);

      const member = memberPath(prop.value);
      if (member) {
        edges.push(`${member[0]}|${member[1]}|${id}|${key}`);
        if (isCustom) node.extraIn.push(key);
        continue;
      }
      if (prop.value.type === "Identifier" && varOf.has(prop.value.name)) {
        const [src, slot] = varOf.get(prop.value.name);
        edges.push(`${src}|${slot}|${id}|${key}`);
        if (isCustom) node.extraIn.push(key);
        continue;
      }
      // `{ url: null }` = 声明了槽但没接线，槽要存在、值为空
      if (prop.value.type === "Literal" && prop.value.value === null) {
        if (isCustom) node.extraIn.push(key);
        continue;
      }
      const text = stringOf(prop.value);
      if (text === null) {
        unresolvedAt(prop, `${id}.${key}: 引脚值既不是上游引用也不是字面量`);
        continue;
      }
      // provide_* 的值写在引脚对象里，但它其实是输出槽
      if (defOutputs.has(key) && !defInputs.has(key)) {
        node.outputs[key] = text;
        continue;
      }
      node.inputs[key] = text;
      if (isCustom) node.extraIn.push(key);
    }
  }

  const itemsOf = (call) => {
    const out = [];
    for (const arg of call.arguments) {
      if (arg.type === "Identifier") out.push(arg.name);
      else if (arg.type === "CallExpression" && calleePath(arg.callee) === "flow.fork") {
        out.push({ fork: arg.arguments.map(itemsOf) });
      } else {
        unresolvedAt(arg, "控制流参数只能是节点变量名或 flow.fork(...)");
      }
    }
    return out;
  };

  function linkChain(head, items) {
    let prev = head;
    let slot = "next";
    for (const item of items) {
      if (typeof item === "object" && item.fork) {
        for (const seq of item.fork) linkChain(prev, seq);
        continue;
      }
      if (prev) edges.push(`${prev}|${slot}|${item}|prev`);
      prev = item;
      slot = "next";
    }
  }

  for (const stmt of ast.body) {
    if (stmt.type === "ImportDeclaration") continue;
    const decl = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;

    if (decl?.type === "VariableDeclaration") {
      if (decl.declarations.length !== 1) {
        unresolvedAt(decl, "一条 const 只能声明一个节点");
        continue;
      }
      const d = decl.declarations[0];
      if (d.id.type === "ObjectPattern") {
        // 前面那趟已经处理过；只有 `const {a} = notAnIdentifier` 会漏下来
        if (d.init?.type !== "Identifier") unresolvedAt(d, "解构只能来自一个节点变量");
        continue;
      }
      if (d.id.type !== "Identifier") {
        unresolvedAt(d, "节点声明左边必须是一个变量名");
        continue;
      }
      const id = d.id.name;
      const init = d.init;
      if (init?.type !== "CallExpression") {
        unresolvedAt(d, `${id}: 节点声明右边必须是一次节点调用`);
        continue;
      }
      const path = calleePath(init.callee);
      const args = [...init.arguments];

      const first = args[0];
      const hasLabel = first
        && ((first.type === "Literal" && typeof first.value === "string") || first.type === "TemplateLiteral");
      const label = hasLabel ? stringOf(args.shift()) : null;

      if (path === "flow" || path === "flow.schedule") {
        const body = path === "flow.schedule" ? stringOf(args.shift()) : null;
        runDecls.push({
          id,
          definitionId: path === "flow.schedule" ? "workspace_scheduled_run" : "workspace_run",
          items: itemsOf({ arguments: args }),
          label,
          body,
        });
        continue;
      }

      const pkg = packageOf.get(path);
      // 代码节点包在图里就是「基础类型 + marketplaceRef」，和画布从面板拖出来的一模一样。
      // 解析不出包时退回 `pkg:<specifier>`——那是一张读不出槽位的图，交给上层报错，
      // 绝不能假装它是个正常节点。
      const definitionId = pkg
        ? (pkg.baseDefinitionId || pkg.definitionId || `pkg:${pkg.specifier}`)
        : definitionIdFromApi(path);
      nodes[id] = { definitionId, inputs: {}, outputs: {}, extraIn: [], extraOut: [], declaredOut: [], attrs: {} };
      if (label) nodes[id].label = label;
      if (pkg) {
        nodes[id].package = pkg.specifier;
        nodes[id].packageBinding = path;
        // 包声明的槽位相对基础类型是「自定义槽」，得先建出来，否则 `x.total` 这条边
        // 找不到落点，句柄下标会串到别的槽上
        // 包自己就是这个节点的定义表——槽位以它为准，不能拿基础类型的
        // （`tool_nodejs` 带着 workspaceContext / skillsContext 这些上下文槽，代码节点没有）
        if (pkg.input || pkg.output) {
          nodes[id].packageDef = { input: pkg.input || [], output: pkg.output || [] };
        }
        if (pkg.marketplaceRef) nodes[id].attrs.marketplaceRef = pkg.marketplaceRef;
        if (pkg.id) nodes[id].attrs.marketplacePackageId = pkg.id;
        if (pkg.version) nodes[id].attrs.marketplaceVersion = pkg.version;
        const def = definitionOf(definitionId);
        for (const [kind, declared, defSlots] of [
          ["extraIn", pkg.input || [], def.input],
          ["extraOut", pkg.output || [], def.output],
        ]) {
          for (const slot of declared) {
            const name = String(slot?.name || "").trim();
            if (!name || STD_SLOTS.has(name) || defSlots.some((s) => s.name === name)) continue;
            if (!nodes[id][kind].includes(name)) nodes[id][kind].push(name);
            // 包已经声明过了，不必再 `const { total } = x` 解构一遍
            if (kind === "extraOut" && !nodes[id].declaredOut.includes(name)) nodes[id].declaredOut.push(name);
          }
        }
      }
      readPins(id, definitionId, args[0]);

      if (definitionId === "control_if") {
        if (args[1]) pendingIf.push({ id, slot: "next1", call: args[1] });
        if (args[2]) pendingIf.push({ id, slot: "next2", call: args[2] });
      } else {
        const body = stringOf(args[1]);
        if (body !== null) {
          if (definitionId === "tool_nodejs") nodes[id].script = body;
          else nodes[id].body = body;
        }
      }
      continue;
    }

    if (decl?.type === "ExpressionStatement" && decl.expression.type === "CallExpression") {
      const path = calleePath(decl.expression.callee);
      if (path === "flow.resume") {
        const [a, b] = decl.expression.arguments.map((x) => x.name);
        if (a && b) edges.push(`${a}|next|${b}|prev`);
        else unresolvedAt(decl, "flow.resume 的两个参数都必须是节点变量名");
        continue;
      }
      if (path === "flow.detached") {
        linkChain(null, itemsOf(decl.expression));
        continue;
      }
    }

    unresolvedAt(stmt, `顶层出现了流程图表达不了的语句（${stmt.type}）`);
  }

  for (const run of runDecls) {
    nodes[run.id] = {
      definitionId: run.definitionId,
      inputs: {},
      outputs: {},
      extraIn: [],
      extraOut: [],
      declaredOut: [],
      attrs: {},
    };
    if (run.label) nodes[run.id].label = run.label;
    if (run.body) nodes[run.id].body = run.body;
    linkChain(run.id, run.items);
  }

  for (const branch of pendingIf) {
    const items = itemsOf(branch.call);
    if (!items.length) continue;
    const first = typeof items[0] === "string" ? items[0] : null;
    if (!first) continue;
    edges.push(`${branch.id}|${branch.slot}|${first}|prev`);
    linkChain(null, items);
  }

  for (const ds of destructures) {
    const node = nodes[ds.node];
    if (!node) continue;
    for (const slot of ds.slots) {
      if (!node.extraOut.includes(slot)) node.extraOut.push(slot);
      // 记下「代码里显式解构声明过」——lint 据此区分自定义输出槽是声明的还是猜的
      if (!node.declaredOut.includes(slot)) node.declaredOut.push(slot);
    }
  }

  for (const node of Object.values(nodes)) {
    node.extraIn = [...new Set(node.extraIn)];
    node.extraOut = [...new Set(node.extraOut)];
  }

  return { nodes, edges: [...new Set(edges)].sort(), unresolved };
}
