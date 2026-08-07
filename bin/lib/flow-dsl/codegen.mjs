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

function displayFileExt(kind) {
  return { html: "html", chart: "json", table: "json", mermaid: "mmd", ascii: "txt", react: "json" }[kind] || "md";
}

/**
 * @param {object} ir
 * @param {{ packages?: Record<string, {binding?: string, specifier: string}> }} [opts]
 *        packages：nodeId -> 代码节点包，生成 `import x from "./nodes/x"` 并用绑定名做调用
 * @returns {{ source: string, files: Array<{path: string, text: string}> }}
 */
export function generateFlowSource(ir, opts = {}) {
  const N = ir.nodes;
  const files = [];
  const emitFile = (rel, text) => {
    files.push({ path: rel, text });
    return rel;
  };

  const externalize = (id, slot, text) => {
    if (text.length < EXTERNALIZE_MIN) return null;
    const definitionId = N[id].definitionId;
    if (isDisplayDefinition(definitionId)) {
      return emitFile(`docs/${id}.${displayFileExt(definitionId.slice("display_".length))}`, text);
    }
    return emitFile(slot === "$script" ? `scripts/${id}.sh` : `prompts/${id}.md`, text);
  };
  const textArg = (id, slot, text) => {
    const rel = externalize(id, slot, text);
    return rel ? `file(${JSON.stringify(rel)})` : literal(text);
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

  // 自定义输出槽通过解构暴露成变量：`const { storyId } = node;`
  const outVar = new Map();
  for (const [id, node] of Object.entries(N)) {
    for (const slot of node.extraOut) {
      outVar.set(`${id}|${slot}`, isIdentifier(slot) ? slot : `${id}_${slot}`);
    }
  }

  // 代码节点包的 import 绑定名；与任何 nodeId 或其它绑定冲突时加后缀
  const nodeIds = new Set(Object.keys(N));
  const bindingOf = new Map();
  for (const [id, pkg] of Object.entries(opts.packages || {})) {
    const base = pkg.binding
      || pkg.specifier.split("/").pop().replace(/[-.](\w)/g, (_, c) => c.toUpperCase());
    let name = base;
    while (nodeIds.has(name) || [...bindingOf.values()].some((v) => v.name === name && v.spec !== pkg.specifier)) {
      name += "Node";
    }
    bindingOf.set(id, { name, spec: pkg.specifier });
  }
  const callee = (id) => bindingOf.get(id)?.name || apiName(N[id].definitionId);

  function pinsObject(id) {
    const node = N[id];
    const def = definitionOf(node.definitionId);
    const lines = [];
    const wired = new Map((dataIn.get(id) || []).map((x) => [x.slot, x]));
    const order = [...def.input.map((s) => s.name).filter((n) => !CTRL_SLOTS.has(n)), ...node.extraIn];
    const seen = new Set();
    for (const name of order) {
      if (seen.has(name)) continue;
      seen.add(name);
      const key = isIdentifier(name) ? name : JSON.stringify(name);
      if (wired.has(name)) {
        const x = wired.get(name);
        lines.push(`${key}: ${outVar.get(`${x.from}|${x.fromSlot}`) || `${x.from}.${x.fromSlot}`}`);
        continue;
      }
      if (node.inputs[name] !== undefined) {
        lines.push(`${key}: ${textArg(id, name, String(node.inputs[name]))}`);
        continue;
      }
      // 声明了但没接线也没默认值的自定义槽写成 null，否则解析回来会丢掉这个槽
      if (node.extraIn.includes(name)) lines.push(`${key}: null`);
    }
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!seen.has(name)) lines.push(`${name}: ${textArg(id, name, String(value))}`);
    }
    if (isProvideDefinition(node.definitionId)) {
      for (const [name, value] of Object.entries(node.outputs)) {
        lines.push(`${name}: ${textArg(id, name, String(value))}`);
      }
    }
    return lines.length ? `{\n${lines.map((l) => `  ${l}`).join(",\n")},\n}` : "{}";
  }

  // 把控制链展开成嵌套序列；分叉处变成数组，由 printItem 打成 flow.fork(...)
  function expandChain(id) {
    const kids = (controlNext.get(id) || [])
      .filter((x) => !RUN_DEFINITIONS.has(N[x.to].definitionId))
      .map((x) => x.to);
    if (isIf(id) || !kids.length) return [id];
    if (kids.length === 1) return [id, ...expandChain(kids[0])];
    return [id, kids.map(expandChain)];
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
      ? `flow.fork(${item.map((s) => `flow(${s.map(printItem).join(", ")})`).join(", ")})`
      : item
  );

  const declared = new Set();
  const out = [];

  function chainFrom(roots) {
    const seq = roots.length === 1
      ? expandChain(roots[0])
      : (roots.length ? [roots.map(expandChain)] : []);
    for (const id of collectIds(seq)) declare(id, false);
    return seq;
  }

  function declare(id, exported) {
    if (declared.has(id)) return;
    declared.add(id);
    // 上游数据依赖必须先声明，否则引用的变量还不存在
    for (const dep of dataIn.get(id) || []) if (!declared.has(dep.from)) declare(dep.from, true);

    const node = N[id];
    const args = [];
    if (node.label) args.push(literal(node.label));
    args.push(pinsObject(id));

    if (isIf(id)) {
      const thenIds = (controlNext.get(id) || []).filter((x) => x.slot === "next1").map((x) => x.to);
      const elseIds = (controlNext.get(id) || []).filter((x) => x.slot === "next2").map((x) => x.to);
      args.push(`flow(${chainFrom(thenIds).map(printItem).join(", ")})`);
      args.push(`flow(${chainFrom(elseIds).map(printItem).join(", ")})`);
    } else {
      const usesScript = node.definitionId === "tool_nodejs" && node.script;
      const body = usesScript ? node.script : node.body;
      if (body) args.push(textArg(id, usesScript ? "$script" : "$body", String(body)));
    }

    out.push(`${exported ? "export " : ""}const ${id} = ${callee(id)}(${args.join(", ")});\n`);
    if (node.extraOut.length) {
      const bindings = node.extraOut.map((slot) => {
        const v = outVar.get(`${id}|${slot}`);
        return v === slot ? slot : `${JSON.stringify(slot)}: ${v}`;
      });
      out.push(`const { ${bindings.join(", ")} } = ${id};\n`);
    }
  }

  const ids = Object.keys(N).sort();

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
    const fn = definitionId === "workspace_scheduled_run" ? "flow.schedule" : "flow";
    out.push(`export const ${runId} = ${fn}(${[...head, ...seq].join(", ")});\n`);
  }

  // 一个 run 直接连到另一个 run：接力，不是子图
  for (const [src, list] of [...controlNext].sort()) {
    for (const x of list) {
      if (RUN_DEFINITIONS.has(N[x.to].definitionId)) out.push(`flow.resume(${src}, ${x.to});\n`);
    }
  }

  // 没有 run 入口、但自成控制链的孤儿链条——语料里真的有，丢掉就等于删图
  const controlTargets = new Set(ir.edges.map((e) => e.split("|")).filter((p) => p[3] === "prev").map((p) => p[2]));
  for (const id of ids) {
    if (declared.has(id) || RUN_DEFINITIONS.has(N[id].definitionId) || controlTargets.has(id)) continue;
    if (!(controlNext.get(id) || []).length) continue;
    out.push(`flow.detached(${chainFrom([id]).map(printItem).join(", ")});\n`);
  }
  for (const id of ids) {
    if (!declared.has(id) && !RUN_DEFINITIONS.has(N[id].definitionId)) declare(id, true);
  }

  const imports = [`import { agent, control, display, file, flow, provide, tool, workspace } from "agentflow/flow";`];
  const seenBinding = new Set();
  for (const id of ids) {
    const binding = bindingOf.get(id);
    if (!binding || seenBinding.has(binding.name)) continue;
    seenBinding.add(binding.name);
    imports.push(`import ${binding.name} from ${JSON.stringify(binding.spec)};`);
  }

  return { source: `${imports.join("\n")}\n\n${out.join("\n")}`, files };
}
