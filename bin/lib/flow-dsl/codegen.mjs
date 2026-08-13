/**
 * IR -> `workspace.flow.js`。
 *
 * 生成的是**受限 ESM**：只有 import、const 声明和调用表达式，没有控制流。这不是风格
 * 选择——画布必须能靠静态解析渲染出来，绝不能为了画一张图去执行用户的代码。
 *
 * 图结构如何映射成代码：
 *
 * - 一个节点 = 一次 `const <nodeId> = <api>(label?, pins, body?)`
 * - 控制边（连到 `prev` 的边）= `flow(a, b, c)` 里的参数顺序
 * - 数据边 = 引脚对象里引用上游变量：`{ content: agent1.result }`
 * - `control_if` 的两个分支 = 第 3、4 个参数 `flow(...)` / `flow(...)`
 * - 控制流分叉 = `flow.fork(flow(...), flow(...))`
 * - 运行入口 = `export const run = flow("Run", ...)`
 *
 * 超过 EXTERNALIZE_MIN 的长文本外置成独立文件，代码里写 `file("prompts/x.md")`：
 * 一段 8 KB 的提示词塞进模板字符串会把流程结构淹没。
 */
import { CTRL_SLOTS, RUN_DEFINITIONS, apiName, definitionOf, isDisplayDefinition, isProvideDefinition } from "./defs.mjs";

/** 长文本外置阈值（字节）。低于这个长度的直接内联，免得目录里全是碎文件。 */
export const EXTERNALIZE_MIN = 3000;

const isIdentifier = (s) => /^[A-Za-z_$][\w$]*$/.test(s);

/**
 * 短的普通文本用双引号；带引号、换行或过长的用模板字符串。
 * 含 `"` 的内容（排程 JSON、带引号的提示词）走双引号会被转义成一片 `\"`，读不动。
 */
function literal(value) {
  const text = String(value ?? "");
  const inlineable = !text.includes("\n")
    && text.length < 90
    && !text.includes('"')
    && !text.includes("`")
    && !text.includes("${");
  if (inlineable) return JSON.stringify(text);
  return "`" + text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`";
}

/**
 * 把正文写成模板字符串，`folds` 里的占位符还原成 JS 插值。
 *
 * 没被折叠的 `${...}` 一律转义成 `\${...}`——那是运行时自己要解析的占位符，不是 JS 表达式。
 */
function interpolatedLiteral(text, folds) {
  const escape = (s) => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  const parts = String(text ?? "").split(/(\$\{[A-Za-z_][A-Za-z0-9_-]*\})/);
  return `\`${parts.map((part) => {
    const m = /^\$\{([A-Za-z_][A-Za-z0-9_-]*)\}$/.exec(part);
    return m && folds.has(m[1]) ? `\${${folds.get(m[1])}}` : escape(part);
  }).join("")}\``;
}

function displayFileExt(kind) {
  return { html: "html", code: "txt", chart: "json", table: "json", mermaid: "mmd", ascii: "txt", react: "json" }[kind] || "md";
}

/**
 * @param {object} ir
 * @param {{ packages?: Record<string, {binding?: string, specifier: string}> }} [opts]
 *        packages：nodeId -> 代码节点包，生成 `import x from "./nodes/x"` 并用绑定名做调用
 * @returns {{ source: string, files: Array<{path: string, text: string}> }}
 */
export function generateFlowSource(ir, opts = {}) {
  const N = ir.nodes;
  const subflows = ir?.subflows && typeof ir.subflows === "object" ? ir.subflows : {};
  const subflowMemberIds = new Set(Object.values(subflows).flatMap((subflow) => subflow?.nodeIds || []));
  const files = [];
  const emitFile = (rel, text) => {
    files.push({ path: rel, text });
    return rel;
  };

  // 节点 id 就是顶层变量名，可能刚好叫 display / flow / file。节点 id 不能为了代码生成
  // 偷偷改掉（那会变成另一张图），所以冲突时给 DSL API import 起别名：
  // `import { display as displayApi } ...; const display = displayApi.markdown(...)`。
  // 所有顶层标识符共用 taken；先给内置 API 占位，后面的输出解构和包 import 也会避开它们。
  const taken = new Set(Object.keys(N));
  const uniqueName = (base, fallback) => {
    let name = isIdentifier(base) ? base : fallback;
    if (taken.has(name)) name = fallback;
    while (taken.has(name)) name += "_";
    taken.add(name);
    return name;
  };
  const flowApiRoots = ["agent", "control", "display", "file", "flow", "provide", "tool", "workspace"];
  const flowApiBinding = new Map(flowApiRoots.map((root) => [root, uniqueName(root, `${root}Api`)]));
  const apiCall = (name) => {
    const [root, ...tail] = String(name || "").split(".");
    return [flowApiBinding.get(root) || root, ...tail].join(".");
  };

  // 同一个节点的 body 和某个引脚值可能都超阈值，文件名必须带槽名区分：都叫
  // `prompts/<id>.md` 的话两段不同的文本会写进同一个文件，往返时后写的覆盖先写的。
  const externalize = (id, slot, text) => {
    if (text.length < EXTERNALIZE_MIN) return null;
    const definitionId = N[id].definitionId;
    const suffix = slot === "$body" || slot === "$script" ? "" : `.${slot.replace(/[^\w.-]/g, "_")}`;
    if (isDisplayDefinition(definitionId)) {
      return emitFile(`docs/${id}${suffix}.${displayFileExt(definitionId.slice("display_".length))}`, text);
    }
    return emitFile(slot === "$script" ? `scripts/${id}.sh` : `prompts/${id}${suffix}.md`, text);
  };
  const textArg = (id, slot, text) => {
    const rel = externalize(id, slot, text);
    return rel ? `${apiCall("file")}(${JSON.stringify(rel)})` : literal(text);
  };

  const controlNext = new Map();
  const dataIn = new Map();
  for (const key of ir.edges) {
    const [src, fromSlot, dst, toSlot] = key.split("|");
    if (toSlot === "prev") {
      if (!controlNext.has(src)) controlNext.set(src, []);
      controlNext.get(src).push({ to: dst, slot: fromSlot });
    } else {
      if (!dataIn.has(dst)) dataIn.set(dst, []);
      dataIn.get(dst).push({ slot: toSlot, from: src, fromSlot });
    }
  }

  const isIf = (id) => N[id]?.definitionId === "control_if";

  // 代码节点包自己声明了输出槽，import 已经把它们带进来，不必解构；引用时直接写
  // `pkgNode.total`。这个集合必须先算，`outVar` 只收真的会被解构出来的槽——否则会生成
  // 一个引用了不存在变量的文件。
  const packageOutputs = (id) => new Set(
    (opts.packages?.[id]?.output || []).map((slot) => String(slot?.name || "")),
  );
  const destructured = new Map(
    Object.entries(N).map(([id, node]) => {
      const declared = packageOutputs(id);
      return [id, node.extraOut.filter((slot) => !declared.has(slot))];
    }),
  );

  // 自定义输出槽通过解构暴露成变量：`const { storyId } = node;`
  const outVar = new Map();
  for (const [id, slots] of destructured) {
    for (const slot of slots) {
      outVar.set(`${id}|${slot}`, uniqueName(slot, `${id}_${slot}`.replace(/[^\w$]/g, "_")));
    }
  }

  // 代码节点包的 import 绑定名
  const bindingOf = new Map();
  for (const [id, pkg] of Object.entries(opts.packages || {})) {
    const base = pkg.binding
      || pkg.specifier.split("/").pop().replace(/[-.](\w)/g, (_, c) => c.toUpperCase());
    // 同一个包在多个节点上共用一个绑定名，别重复发号
    const shared = [...bindingOf.values()].find((v) => v.spec === pkg.specifier);
    bindingOf.set(id, shared || { name: uniqueName(base, `${base}Node`), spec: pkg.specifier });
  }
  const callee = (id) => bindingOf.get(id)?.name || apiCall(apiName(N[id].definitionId));

  const bodyTextOf = (id) => String(
    ((N[id].definitionId === "tool_nodejs" || N[id].definitionId === "control_while") && N[id].script)
      ? N[id].script
      : (N[id].body || ""),
  );

  /**
   * 正文里的 `${slot}` 占位符能写回成 JS 插值的那些槽。
   *
   * 条件很紧：引用表达式的**根标识符**必须和槽名一致。`{ date: date.value }` + 正文
   * `${date}` 可以折叠成 `` `${date.value}` ``；而 `{ d: date.value }` 不行——解析器只能
   * 从 `${date.value}` 推出槽名 `date`，折叠了就往返不回来。
   */
  function bodyFolds(id) {
    const text = bodyTextOf(id);
    // 正文超阈值会被外置成文件，文件里没有 JS 插值这回事
    if (!text || text.length >= EXTERNALIZE_MIN) return new Map();
    const candidates = new Map();
    for (const x of dataIn.get(id) || []) {
      if (!text.includes(`\${${x.slot}}`)) continue;
      const ref = outVar.get(`${x.from}|${x.fromSlot}`) || `${x.from}.${x.fromSlot}`;
      if (ref.split(".")[0] !== x.slot) continue;
      candidates.set(x.slot, ref);
    }
    if (!candidates.size) return candidates;

    // 定义表里的槽永远按定义顺序重建，折不折都在原位；自定义槽不一样——折进正文之后，
    // 解析回来是「按正文里出现的先后追加到末尾」。所以自定义槽只能折**末尾那一段**，
    // 而且那段的正文顺序要和槽序一致。否则往返一次槽序就变了，闸门会把整张图退回 JSON。
    const extras = N[id].extraIn;
    const folds = new Map([...candidates].filter(([slot]) => !extras.includes(slot)));
    const atBody = (slot) => text.indexOf(`\${${slot}}`);
    for (let k = extras.length; k > 0; k -= 1) {
      const tail = extras.slice(-k);
      if (!tail.every((slot) => candidates.has(slot))) continue;
      const byBody = [...tail].sort((a, b) => atBody(a) - atBody(b));
      if (JSON.stringify(byBody) !== JSON.stringify(tail)) continue;
      for (const slot of tail) folds.set(slot, candidates.get(slot));
      break;
    }
    return folds;
  }

  const pkgSlots = (id, kind) => (opts.packages?.[id]?.[kind] || []);
  const slotTypeOf = (id, name) => {
    const node = N[id];
    const fromPkg = pkgSlots(id, "input").find((s) => s?.name === name);
    if (fromPkg?.type) return String(fromPkg.type);
    const fromDef = definitionOf(node.definitionId).input.find((s) => s.name === name);
    if (fromDef?.type) return String(fromDef.type);
    return String(node.inputTypes?.[name] || "text");
  };
  /** bool 槽写回成裸 `true` / `false`；其余一律是文本。 */
  const pinValue = (id, name, value) => {
    const text = String(value);
    if (slotTypeOf(id, name) === "bool" && (text === "true" || text === "false")) return text;
    return textArg(id, name, text);
  };

  function pinsObject(id, folds = new Map()) {
    const node = N[id];
    const def = definitionOf(node.definitionId);
    const lines = [];
    const wired = new Map((dataIn.get(id) || []).filter((x) => !folds.has(x.slot)).map((x) => [x.slot, x]));
    const order = [...def.input.map((s) => s.name).filter((n) => !CTRL_SLOTS.has(n)), ...node.extraIn];
    const seen = new Set();
    for (const name of order) {
      if (seen.has(name)) continue;
      seen.add(name);
      // 已经折进正文插值里的槽不再出现在引脚对象里；写两遍等于同一条边写两次
      if (folds.has(name)) continue;
      const key = isIdentifier(name) ? name : JSON.stringify(name);
      if (wired.has(name)) {
        const x = wired.get(name);
        lines.push(`${key}: ${outVar.get(`${x.from}|${x.fromSlot}`) || `${x.from}.${x.fromSlot}`}`);
        continue;
      }
      if (node.inputs[name] !== undefined) {
        lines.push(`${key}: ${pinValue(id, name, node.inputs[name])}`);
        continue;
      }
      // 声明了但没接线也没默认值的自定义槽写成 null，否则解析回来会丢掉这个槽
      if (node.extraIn.includes(name)) lines.push(`${key}: null`);
    }
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!seen.has(name) && !folds.has(name)) lines.push(`${name}: ${pinValue(id, name, value)}`);
    }
    if (isProvideDefinition(node.definitionId)) {
      for (const [name, value] of Object.entries(node.outputs)) {
        lines.push(`${name}: ${textArg(id, name, String(value))}`);
      }
    }
    return lines.length ? `{\n${lines.map((l) => `  ${l}`).join(",\n")},\n}` : "{}";
  }

  // 把控制链展开成嵌套序列；分叉处变成数组，由 printItem 打成 flow.fork(...)
  function expandChain(id, allowed = null) {
    const kids = (controlNext.get(id) || [])
      .filter((x) => !RUN_DEFINITIONS.has(N[x.to].definitionId))
      .filter((x) => !allowed || allowed.has(x.to))
      .map((x) => x.to);
    if (isIf(id) || !kids.length) return [id];
    if (kids.length === 1) return [id, ...expandChain(kids[0], allowed)];
    return [id, kids.map((kid) => expandChain(kid, allowed))];
  }
  const collectIds = (seq, acc = []) => {
    for (const item of seq) {
      if (Array.isArray(item)) item.forEach((s) => collectIds(s, acc));
      else acc.push(item);
    }
    return acc;
  };
  const printItem = (item) => (
    Array.isArray(item)
      ? `${apiCall("flow.fork")}(${item.map((s) => `${apiCall("flow")}(${s.map(printItem).join(", ")})`).join(", ")})`
      : item
  );

  const declared = new Set();
  const declaredSubflows = new Set();
  const out = [];

  function chainFrom(roots, allowed = null) {
    const seq = roots.length === 1
      ? expandChain(roots[0], allowed)
      : (roots.length ? [roots.map((root) => expandChain(root, allowed))] : []);
    for (const id of collectIds(seq)) declare(id, false);
    return seq;
  }

  const outputRef = (nodeId, slot) => outVar.get(`${nodeId}|${slot}`) || `${nodeId}.${slot}`;

  function declareSubflow(subflowId) {
    if (declaredSubflows.has(subflowId)) return;
    const subflow = subflows[subflowId];
    if (!subflow) return;
    declaredSubflows.add(subflowId);
    const allowed = new Set(subflow.nodeIds || []);
    for (const binding of Object.values(subflow.inputs || {})) declare(binding.nodeId, false);
    const seq = chainFrom((subflow.roots || []).filter((id) => allowed.has(id)), allowed).map(printItem);
    for (const binding of Object.values(subflow.outputs || {})) declare(binding.nodeId, false);
    const inputEntries = Object.entries(subflow.inputs || {}).map(([name, binding]) => (
      `${isIdentifier(name) ? name : JSON.stringify(name)}: ${binding.nodeId}`
    ));
    const outputEntries = Object.entries(subflow.outputs || {}).map(([name, binding]) => (
      `${isIdentifier(name) ? name : JSON.stringify(name)}: ${outputRef(binding.nodeId, binding.slot)}`
    ));
    const inputObject = inputEntries.length ? `{ ${inputEntries.join(", ")} }` : "{}";
    const outputObject = outputEntries.length ? `{ ${outputEntries.join(", ")} }` : "{}";
    out.push(`export const ${subflowId} = ${apiCall("flow.subflow")}(${literal(subflow.label || subflowId)}, ${inputObject}, ${apiCall("flow")}(${seq.join(", ")}), ${outputObject});\n`);
  }

  function declare(id, exported) {
    if (declared.has(id)) return;
    declared.add(id);
    // 上游数据依赖必须先声明，否则引用的变量还不存在
    for (const dep of dataIn.get(id) || []) if (!declared.has(dep.from)) declare(dep.from, true);

    const node = N[id];
    if (node.definitionId === "workspace_subflow_input") {
      const name = String(node.attrs?.subflowInputName || node.label || id);
      const type = String(node.attrs?.subflowInputType || node.packageDef?.output?.[0]?.type || "text");
      out.push(`const ${id} = ${apiCall("flow.input")}(${literal(name)}, ${literal(type)});\n`);
      return;
    }
    if (node.definitionId === "control_subflow_call") {
      const subflowId = String(node.attrs?.subflowId || "");
      declareSubflow(subflowId);
      const args = [];
      if (node.label) args.push(literal(node.label));
      args.push(subflowId);
      args.push(pinsObject(id));
      out.push(`${exported ? "export " : ""}const ${id} = ${apiCall("flow.call")}(${args.join(", ")});\n`);
      const bindings = (destructured.get(id) || []).map((slot) => {
        const variable = outVar.get(`${id}|${slot}`);
        return variable === slot ? slot : `${isIdentifier(slot) ? slot : JSON.stringify(slot)}: ${variable}`;
      });
      if (bindings.length) out.push(`const { ${bindings.join(", ")} } = ${id};\n`);
      return;
    }
    const folds = isIf(id) ? new Map() : bodyFolds(id);
    const args = [];
    if (node.label) args.push(literal(node.label));
    args.push(pinsObject(id, folds));

    const conditionSubflowId = node.definitionId === "control_while"
      ? String(node.attrs?.conditionSubflowId || "")
      : "";
    const bodySubflowId = node.definitionId === "control_while"
      ? String(node.attrs?.bodySubflowId || "")
      : "";
    if (conditionSubflowId || bodySubflowId) {
      declareSubflow(conditionSubflowId);
      declareSubflow(bodySubflowId);
      args.push(conditionSubflowId || "undefined");
      args.push(bodySubflowId || "undefined");
    } else if (isIf(id)) {
      const thenIds = (controlNext.get(id) || []).filter((x) => x.slot === "next1").map((x) => x.to);
      const elseIds = (controlNext.get(id) || []).filter((x) => x.slot === "next2").map((x) => x.to);
      args.push(`${apiCall("flow")}(${chainFrom(thenIds).map(printItem).join(", ")})`);
      args.push(`${apiCall("flow")}(${chainFrom(elseIds).map(printItem).join(", ")})`);
    } else {
      const usesScript = (node.definitionId === "tool_nodejs" || node.definitionId === "control_while") && node.script;
      const body = usesScript ? node.script : node.body;
      if (body) {
        args.push(folds.size
          ? interpolatedLiteral(body, folds)
          : textArg(id, usesScript ? "$script" : "$body", String(body)));
      }
    }

    out.push(`${exported ? "export " : ""}const ${id} = ${callee(id)}(${args.join(", ")});\n`);
    const needsBinding = destructured.get(id) || [];
    if (needsBinding.length) {
      const bindings = needsBinding.map((slot) => {
        const v = outVar.get(`${id}|${slot}`);
        if (v === slot) return slot;
        return `${isIdentifier(slot) ? slot : JSON.stringify(slot)}: ${v}`;
      });
      out.push(`const { ${bindings.join(", ")} } = ${id};\n`);
    }
  }

  const ids = Object.keys(N).sort();

  // 子流程先于父流程调用声明；内部节点仍是普通 DSL 节点，只是拥有独立作用域。
  for (const subflowId of Object.keys(subflows).sort()) declareSubflow(subflowId);

  for (const runId of ids) {
    const definitionId = N[runId].definitionId;
    if (!RUN_DEFINITIONS.has(definitionId)) continue;
    const roots = (controlNext.get(runId) || [])
      .filter((x) => !RUN_DEFINITIONS.has(N[x.to].definitionId))
      .map((x) => x.to);
    const seq = chainFrom(roots).map(printItem);
    const head = [];
    if (N[runId].label) head.push(literal(N[runId].label));
    // 排程配置存在 run 节点的 body 里，是 JSON 字符串
    if (definitionId === "workspace_scheduled_run") head.push(N[runId].body ? literal(N[runId].body) : "null");
    const fn = apiCall(definitionId === "workspace_scheduled_run" ? "flow.schedule" : "flow");
    out.push(`export const ${runId} = ${fn}(${[...head, ...seq].join(", ")});\n`);
  }

  // 一个 run 直接连到另一个 run：接力，不是子图
  for (const [src, list] of [...controlNext].sort()) {
    for (const x of list) {
      if (RUN_DEFINITIONS.has(N[x.to].definitionId)) out.push(`${apiCall("flow.resume")}(${src}, ${x.to});\n`);
    }
  }

  // 没有 run 入口、但自成控制链的孤儿链条——语料里真的有，丢掉就等于删图
  const controlTargets = new Set(ir.edges.map((e) => e.split("|")).filter((p) => p[3] === "prev").map((p) => p[2]));
  for (const id of ids) {
    if (declared.has(id) || subflowMemberIds.has(id) || RUN_DEFINITIONS.has(N[id].definitionId) || controlTargets.has(id)) continue;
    if (!(controlNext.get(id) || []).length) continue;
    out.push(`${apiCall("flow.detached")}(${chainFrom([id]).map(printItem).join(", ")});\n`);
  }
  for (const id of ids) {
    if (!declared.has(id) && !subflowMemberIds.has(id) && !RUN_DEFINITIONS.has(N[id].definitionId)) declare(id, true);
  }

  const flowImports = flowApiRoots.map((root) => {
    const local = flowApiBinding.get(root);
    return local === root ? root : `${root} as ${local}`;
  });
  const imports = [`import { ${flowImports.join(", ")} } from "agentflow/flow";`];
  const seenBinding = new Set();
  for (const id of ids) {
    const binding = bindingOf.get(id);
    if (!binding || seenBinding.has(binding.name)) continue;
    seenBinding.add(binding.name);
    imports.push(`import ${binding.name} from ${JSON.stringify(binding.spec)};`);
  }

  return { source: `${imports.join("\n")}\n\n${out.join("\n")}`, files };
}
