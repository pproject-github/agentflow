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

/**
 * `tool_nodejs` 脚本里除槽名之外还能用的占位符常量（见运行时的 `constants` 表）。
 * 它们不是引脚，`${flowDir}` 这种写法必须原样留在脚本里，不能被当成 JS 插值。
 */
const SCRIPT_CONSTANTS = new Set([
  "workspaceRoot",
  "pipelineWorkspace",
  "flowDir",
  "cwd",
  "nodeRunDir",
  "nodeTmpDir",
  "outputsDir",
  "scriptRef",
]);

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

  // codegen 在节点 id 与 DSL API 名冲突时会生成
  // `import { display as displayApi } from "agentflow/flow"`。静态解析时先把 local 名还原成
  // canonical API 名，后面的节点类型、flow 控制语句和 file() 才仍走同一套规则。
  const flowApiOf = new Map();
  for (const stmt of ast.body) {
    if (stmt.type !== "ImportDeclaration" || String(stmt.source.value) !== "agentflow/flow") continue;
    for (const specifier of stmt.specifiers || []) {
      if (specifier.type !== "ImportSpecifier") continue;
      const imported = specifier.imported?.name ?? specifier.imported?.value;
      const local = specifier.local?.name;
      if (imported && local) flowApiOf.set(local, String(imported));
    }
  }
  const apiCalleePath = (node) => {
    const raw = calleePath(node);
    if (!raw) return raw;
    const [root, ...tail] = raw.split(".");
    return [flowApiOf.get(root) || root, ...tail].join(".");
  };

  function stringOf(node) {
    if (!node) return null;
    if (node.type === "Literal" && typeof node.value === "string") return node.value;
    // 槽值在图里统一是字符串。`true` / `42` 是 JS 里写这类值的自然写法，收下并规范化，
    // 不要逼作者写 `"true"`；写回时由槽的 type 决定加不加引号。
    if (node.type === "Literal" && (typeof node.value === "boolean" || typeof node.value === "number")) {
      return String(node.value);
    }
    if (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")
      && node.argument.type === "Literal" && typeof node.argument.value === "number") {
      return String(node.operator === "-" ? -node.argument.value : node.argument.value);
    }
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
    if (node.type === "CallExpression" && apiCalleePath(node.callee) === "file") {
      const rel = stringOf(node.arguments[0]);
      if (rel == null) return null;
      if (!(rel in files)) throw new Error(`file(${JSON.stringify(rel)}) 找不到对应文件`);
      return files[rel];
    }
    return null;
  }

  /** Read a JSON-compatible literal without evaluating user code. */
  function staticJsonOf(node) {
    if (!node) return { ok: false, value: null };
    if (node.type === "Literal") return { ok: true, value: node.value };
    if (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")
      && node.argument.type === "Literal" && typeof node.argument.value === "number") {
      return { ok: true, value: node.operator === "-" ? -node.argument.value : node.argument.value };
    }
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
      return { ok: true, value: node.quasis[0].value.cooked };
    }
    if (node.type === "ArrayExpression") {
      const value = [];
      for (const item of node.elements) {
        const parsed = staticJsonOf(item);
        if (!parsed.ok) return { ok: false, value: null };
        value.push(parsed.value);
      }
      return { ok: true, value };
    }
    if (node.type === "ObjectExpression") {
      const value = {};
      for (const prop of node.properties) {
        if (prop.type !== "Property" || prop.computed || prop.kind !== "init") return { ok: false, value: null };
        const parsed = staticJsonOf(prop.value);
        if (!parsed.ok) return { ok: false, value: null };
        value[String(prop.key.name ?? prop.key.value ?? "")] = parsed.value;
      }
      return { ok: true, value };
    }
    return { ok: false, value: null };
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
  const subflows = {};
  const subflowOf = new Map();

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

  /**
   * 带插值的模板字符串 -> 正文文本 + 数据边。
   *
   * 运行时的正文占位符只认槽名（`${slotName}`，见 `workspaceBodyPlaceholderNames` 的正则，
   * 里面没有 `.`），所以 `` `分析 ${date.value} 的数据` `` 不能原样落进正文——它编译成
   * 正文 `分析 ${date} 的数据` 加一条 `date.value -> 本节点.date` 的边。槽名取引用表达式
   * 的**根标识符**，这样写回时（codegen）能原样还原成同一段代码。
   *
   * @returns {{ text: string, refs: Array<{slot,src,srcSlot}> } | { error: string, node } | null}
   */
  function interpolatedOf(id, tpl, definitionId) {
    if (tpl?.type !== "TemplateLiteral" || !tpl.expressions.length) return null;
    // 本节点自己就有这个名字 -> `${x}` 是运行时占位符，原样留在正文里，不是 JS 插值
    const def = definitionOf(definitionId);
    const isScript = definitionId === "tool_nodejs" || definitionId === "control_while";
    const ownSlot = (name) => def.input.some((s) => s.name === name)
      || nodes[id].extraIn.includes(name)
      || nodes[id].inputs[name] !== undefined
      || edges.some((e) => e.endsWith(`|${id}|${name}`))
      // 脚本里还能引用常量和自己的输出槽（运行时会把它们填成可写文件路径）
      || (isScript && (
        SCRIPT_CONSTANTS.has(name)
        || def.output.some((s) => s.name === name)
        || destructures.some((d) => d.node === id && d.slots.includes(name))
      ));

    const refs = [];
    let text = tpl.quasis[0].value.cooked;
    for (let i = 0; i < tpl.expressions.length; i += 1) {
      const expr = tpl.expressions[i];
      if (expr.type === "Identifier" && ownSlot(expr.name)) {
        text += `\${${expr.name}}${tpl.quasis[i + 1].value.cooked}`;
        continue;
      }
      const member = memberPath(expr);
      let slot;
      let src;
      let srcSlot;
      if (member) {
        [src, srcSlot] = member;
        slot = src;
      } else if (expr.type === "Identifier" && varOf.has(expr.name)) {
        [src, srcSlot] = varOf.get(expr.name);
        slot = expr.name;
      } else {
        return { error: `${id}: 模板插值只能引用上游节点的输出（\`\${节点.槽}\` 或解构出来的变量）`, node: expr };
      }
      refs.push({ slot, src, srcSlot });
      text += `\${${slot}}${tpl.quasis[i + 1].value.cooked}`;
    }
    return { text, refs };
  }

  function readPins(id, definitionId, obj) {
    const def = definitionOf(definitionId);
    const defInputs = new Set(def.input.map((s) => s.name));
    const defOutputs = new Set(def.output.map((s) => s.name));
    const inputType = new Map(def.input.map((s) => [s.name, String(s.type || "text")]));
    const outputType = new Map(def.output.map((s) => [s.name, String(s.type || "text")]));
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
      const rawKey = prop.key.name ?? prop.key.value;
      const key = definitionId === "context_bundle"
        ? ({ knowledge: "knowledgeContext", skills: "skillsContext", workspace: "workspaceContext", mcp: "mcpContext" }[rawKey] || rawKey)
        : rawKey;
      const isCustom = !STD_SLOTS.has(key) && !defInputs.has(key);

      // Context resources are values, not control nodes. A bundle accepts the resource variable
      // directly (`{ knowledge }`), and consumers accept the bundle directly (`{ context: ctx }`).
      if (prop.value.type === "Identifier" && nodes[prop.value.name]) {
        const sourceDefinitionId = nodes[prop.value.name].definitionId;
        const contextOutput = {
          context_knowledge: "knowledgeContext",
          context_skills: "skillsContext",
          context_workspace: "workspaceContext",
          context_bundle: "context",
        }[sourceDefinitionId];
        if (contextOutput && (
          (definitionId === "context_bundle" && key === contextOutput)
          || (key === "context" && sourceDefinitionId === "context_bundle")
        )) {
          edges.push(`${prop.value.name}|${contextOutput}|${id}|${key}`);
          if (isCustom) node.extraIn.push(key);
          continue;
        }
      }

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
      if (text === null && (inputType.get(key) === "json" || outputType.get(key) === "json")) {
        const parsed = staticJsonOf(prop.value);
        if (parsed.ok) {
          if (defOutputs.has(key) && !defInputs.has(key)) node.outputs[key] = JSON.stringify(parsed.value);
          else node.inputs[key] = JSON.stringify(parsed.value);
          if (isCustom) node.extraIn.push(key);
          continue;
        }
      }
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
      // 自定义槽的类型代码里没别处写，只能从字面量的种类看出来。记下来，`irToGraph`
      // 才能把槽建成 bool，写回时也才知道该写 `true` 而不是 `"true"`。
      if (isCustom && prop.value.type === "Literal" && typeof prop.value.value === "boolean") {
        node.inputTypes[key] = "bool";
      }
      if (isCustom) node.extraIn.push(key);
    }
  }

  const itemsOf = (call) => {
    const out = [];
    for (const arg of call.arguments) {
      if (arg.type === "Identifier") out.push(arg.name);
      else if (arg.type === "CallExpression" && apiCalleePath(arg.callee) === "flow.fork") {
        out.push({ fork: arg.arguments.map(itemsOf) });
      } else {
        unresolvedAt(arg, "控制流参数只能是节点变量名或 flow.fork(...)");
      }
    }
    return out;
  };

  const flatItemIds = (items, out = []) => {
    for (const item of items || []) {
      if (typeof item === "string") out.push(item);
      else if (item?.fork) for (const branch of item.fork) flatItemIds(branch, out);
    }
    return out;
  };

  const rootItemIds = (items) => {
    const first = items?.[0];
    if (typeof first === "string") return [first];
    if (!first?.fork) return [];
    return first.fork.map((branch) => flatItemIds(branch)[0]).filter(Boolean);
  };

  const objectEntries = (node, context) => {
    if (!node || node.type !== "ObjectExpression") {
      unresolvedAt(node, `${context} 必须是对象字面量`);
      return [];
    }
    return node.properties.map((prop) => {
      if (prop.type !== "Property" || prop.computed || prop.kind !== "init") {
        unresolvedAt(prop, `${context} 只能包含静态字段`);
        return null;
      }
      return [String(prop.key.name ?? prop.key.value ?? ""), prop.value];
    }).filter(Boolean);
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
      const path = apiCalleePath(init.callee);
      const args = [...init.arguments];

      if (path === "flow.input") {
        const name = stringOf(args[0]);
        const type = stringOf(args[1]) || "text";
        if (!name) unresolvedAt(init, `${id}: flow.input 的第一个参数必须是输入名`);
        nodes[id] = {
          definitionId: "workspace_subflow_input",
          inputs: {},
          inputTypes: {},
          outputs: {},
          extraIn: [],
          extraOut: [],
          declaredOut: [],
          attrs: { subflowInputName: name || id, subflowInputType: type },
          packageDef: { input: [], output: [{ name: "value", type }] },
          label: name || id,
        };
        continue;
      }

      const first = args[0];
      const hasLabel = first
        && ((first.type === "Literal" && typeof first.value === "string") || first.type === "TemplateLiteral");
      const label = hasLabel ? stringOf(args.shift()) : null;

      if (path === "flow.subflow") {
        const inputObject = args.shift();
        const sequence = args.shift();
        const outputObject = args.shift();
        const items = sequence?.type === "CallExpression" && apiCalleePath(sequence.callee) === "flow"
          ? itemsOf(sequence)
          : [];
        // The visual editor persists an empty flow() while its START/RETURN
        // contract is still being wired. Keep that draft round-trippable;
        // lint already reports a missing execution root and runtime refuses it.
        const inputs = {};
        for (const [name, value] of objectEntries(inputObject, `${id} inputs`)) {
          if (value.type !== "Identifier" || nodes[value.name]?.definitionId !== "workspace_subflow_input") {
            unresolvedAt(value, `${id}.${name}: 子流程输入必须引用 flow.input 变量`);
            continue;
          }
          const proxy = nodes[value.name];
          inputs[name] = {
            nodeId: value.name,
            slot: "value",
            type: String(proxy.attrs?.subflowInputType || "text"),
          };
        }
        const outputs = {};
        for (const [name, value] of objectEntries(outputObject, `${id} outputs`)) {
          const member = memberPath(value);
          const ref = member || (value.type === "Identifier" ? varOf.get(value.name) : null);
          if (!ref) {
            unresolvedAt(value, `${id}.${name}: 子流程输出必须引用内部节点输出`);
            continue;
          }
          const sourceNode = nodes[ref[0]];
          const declaredSlot = sourceNode?.packageDef?.output?.find((slot) => slot.name === ref[1])
            || definitionOf(sourceNode?.definitionId).output.find((slot) => slot.name === ref[1]);
          outputs[name] = { nodeId: ref[0], slot: ref[1], type: String(declaredSlot?.type || "text") };
        }
        const roots = rootItemIds(items);
        subflows[id] = { id, label: label || id, inputs, outputs, roots, nodeIds: [] };
        subflowOf.set(id, subflows[id]);
        linkChain(null, items);
        continue;
      }

      if (path === "flow.call") {
        const ref = args.shift();
        const subflow = ref?.type === "Identifier" ? subflowOf.get(ref.name) : null;
        if (!subflow) unresolvedAt(ref, `${id}: flow.call 第二个参数必须引用前面声明的 flow.subflow`);
        const inputSlots = Object.entries(subflow?.inputs || {}).map(([name, binding]) => ({ name, type: binding.type || "text" }));
        const outputSlots = Object.entries(subflow?.outputs || {}).map(([name, binding]) => ({ name, type: binding.type || "text" }));
        nodes[id] = {
          definitionId: "control_subflow_call",
          inputs: {},
          inputTypes: {},
          outputs: {},
          extraIn: inputSlots.map((slot) => slot.name),
          extraOut: outputSlots.map((slot) => slot.name),
          declaredOut: outputSlots.map((slot) => slot.name),
          attrs: { subflowId: ref?.name || "" },
          packageDef: {
            input: [{ name: "prev", type: "node" }, ...inputSlots],
            output: [{ name: "next", type: "node" }, ...outputSlots],
          },
        };
        if (label) nodes[id].label = label;
        readPins(id, "control_subflow_call", args[0]);
        continue;
      }

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
      nodes[id] = {
        definitionId,
        inputs: {},
        inputTypes: {},
        outputs: {},
        extraIn: [],
        extraOut: [],
        declaredOut: [],
        attrs: {},
      };
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

      if (definitionId === "control_while" && args[1]?.type === "Identifier") {
        const conditionRef = args[1];
        const bodyRef = args[2];
        const conditionSubflow = subflowOf.get(conditionRef.name);
        const bodySubflow = bodyRef?.type === "Identifier" ? subflowOf.get(bodyRef.name) : null;
        if (!conditionSubflow) {
          unresolvedAt(conditionRef, `${id}: control.while 第三个参数必须引用前面声明的 Condition 子流程`);
        }
        if (!bodySubflow) {
          unresolvedAt(bodyRef || args[1], `${id}: control.while 第四个参数必须引用前面声明的 Body 子流程`);
        }
        nodes[id].attrs.conditionSubflowId = conditionRef.name || "";
        nodes[id].attrs.bodySubflowId = bodyRef?.type === "Identifier" ? bodyRef.name : "";
      } else if (definitionId === "control_while" && args[2]) {
        unresolvedAt(args[2], `${id}: control.while 只能使用一个 step 脚本，或依次传入 Condition/Body 两个子流程`);
      } else if (definitionId === "control_if") {
        if (args[1]) pendingIf.push({ id, slot: "next1", call: args[1] });
        if (args[2]) pendingIf.push({ id, slot: "next2", call: args[2] });
      } else if (args[1]) {
        let body = stringOf(args[1]);
        if (body === null) {
          const interp = interpolatedOf(id, args[1], definitionId);
          if (interp?.error) {
            unresolvedAt(interp.node, interp.error);
          } else if (interp) {
            body = interp.text;
            for (const ref of interp.refs) {
              // 插值引用的槽和显式写在引脚对象里的槽撞了：两者会争同一个槽，谁赢取决于
              // 解析顺序。不猜，报出来让作者改名。
              const clash = nodes[id].inputs[ref.slot] !== undefined
                || edges.some((e) => e.endsWith(`|${id}|${ref.slot}`) && !e.startsWith(`${ref.src}|${ref.srcSlot}|`));
              if (clash) {
                unresolvedAt(args[1], `${id}.${ref.slot}: 模板插值要占用的槽已经在引脚对象里写过了`);
                continue;
              }
              edges.push(`${ref.src}|${ref.srcSlot}|${id}|${ref.slot}`);
              if (!STD_SLOTS.has(ref.slot) && !definitionOf(definitionId).input.some((s) => s.name === ref.slot)) {
                nodes[id].extraIn.push(ref.slot);
              }
            }
          } else {
            // 以前这里是 `if (body !== null)` 静默跳过：正文读不出来就整段消失，
            // 保存一次磁盘上就真没了。读不懂必须记账。
            unresolvedAt(args[1], `${id}: 正文既不是字符串字面量、file(...) 也不是模板插值`);
          }
        }
        if (body !== null) {
          if (definitionId === "tool_nodejs" || definitionId === "control_while") nodes[id].script = body;
          else nodes[id].body = body;
        }
      }
      continue;
    }

    if (decl?.type === "ExpressionStatement" && decl.expression.type === "CallExpression") {
      const path = apiCalleePath(decl.expression.callee);
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
      inputTypes: {},
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

  // 子流程成员 = 显式控制链 + 输出来源 + 它们的数据依赖。边仍保存在统一 IR 中，
  // 但成员清单让运行时能为每次 flow.call 建立隔离的调用帧。
  const upstream = new Map();
  for (const edge of edges) {
    const [src, fromSlot, dst, toSlot] = edge.split("|");
    if (toSlot === "prev") continue;
    if (!upstream.has(dst)) upstream.set(dst, []);
    upstream.get(dst).push(src);
  }
  for (const subflow of Object.values(subflows)) {
    const members = new Set([
      ...Object.values(subflow.inputs).map((binding) => binding.nodeId),
      ...Object.values(subflow.outputs).map((binding) => binding.nodeId),
    ]);
    const queue = [...subflow.roots, ...members];
    const visited = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      members.add(current);
      for (const dep of upstream.get(current) || []) queue.push(dep);
      for (const edge of edges) {
        const [src, fromSlot, dst, toSlot] = edge.split("|");
        if (src === current && toSlot === "prev") queue.push(dst);
      }
    }
    subflow.nodeIds = [...members].filter((nodeId) => nodes[nodeId]).sort();
    for (const nodeId of subflow.nodeIds) nodes[nodeId].attrs.subflowId = subflow.id;
  }

  return { nodes, edges: [...new Set(edges)].sort(), subflows, unresolved };
}
