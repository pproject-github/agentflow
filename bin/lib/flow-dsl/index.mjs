/**
 * Workspace 图的代码化表示。
 *
 * 一张图落成四个文件：
 *
 * ```
 * workspace.flow.js       图结构——节点、连线、作者写的内容（受限 ESM）
 * workspace.layout.json   画布状态——坐标、尺寸、引脚显隐与顺序
 * workspace.nodes.json    代码里说不清的节点级数据——粘贴的图片、机器管理属性
 * workspace.state.json    运行态——由 workspace-state.mjs 负责，这里只是路过
 * prompts/ docs/ scripts/ 超过 3 KB 的长文本
 * ```
 *
 * 为什么是代码而不是 JSON：流程编排本质上就是「main 调用一串 func、连线传数据」。
 * 写成代码，AI 的编码能力可以直接用上，lint 能做语法校验，diff 能看懂。而 JSON 里
 * 一条 `output-1 -> input-2` 的边，人和模型都读不出它连的是什么。
 *
 * 全流程**不执行**流程文件：acorn 静态解析。
 */
import { splitWorkspaceGraph } from "../workspace-state.mjs";
import { generateFlowSource } from "./codegen.mjs";
import { extractLayout } from "./layout.mjs";
import { graphToIr, irToGraph } from "./ir.mjs";
import { parseFlowSource } from "./parser.mjs";

export const FLOW_SOURCE_FILENAME = "workspace.flow.js";
export const FLOW_LAYOUT_FILENAME = "workspace.layout.json";
export const FLOW_NODES_FILENAME = "workspace.nodes.json";

export { EXTERNALIZE_MIN } from "./codegen.mjs";
export { DEFINITIONS, apiName, definitionIdFromApi } from "./defs.mjs";
export { graphToIr, irToGraph } from "./ir.mjs";
export { generateFlowSource } from "./codegen.mjs";
export { parseFlowSource } from "./parser.mjs";

/**
 * 完整图 -> 代码化的一组文件。
 *
 * 运行态先由 `splitWorkspaceGraph` 摘出去，DSL 只面对设计态；这样代码里不会混进
 * 上次运行的产出。
 *
 * @param {object} graph 完整图（design + state 合并后的形态）
 * @param {{ packages?: Record<string, {binding?: string, specifier: string}> }} [opts]
 * @returns {{ source: string, layout: object, nodeMeta: object, state: object, files: Array<{path: string, text: string}> }}
 */
export function graphToFlowFiles(graph, opts = {}) {
  const { design, state } = splitWorkspaceGraph(graph);
  const ir = graphToIr(design);
  const { source, files } = generateFlowSource(ir, opts);
  const { layout, nodeMeta } = extractLayout(design, ir);
  return { source, layout, nodeMeta, state, files };
}

/**
 * 代码化的一组文件 -> 设计态图。
 *
 * 返回的是设计态；要拿到完整图，再用 `mergeWorkspaceState(design, state)` 合上运行态。
 *
 * 默认是**严格模式**：解析器认不出的语句会抛错，而不是当它不存在。这是作为存储格式的
 * 底线——静默丢一条语句，等于用户下一次保存时那部分图就没了。只想「尽力读出能读的部分」
 * 时（lint 要把问题一次列全）传 `strict: false`。
 *
 * @param {{ source: string, layout?: object, nodeMeta?: object, files?: Array<{path:string,text:string}>|Record<string,string>, resolvePackage?: Function, strict?: boolean }} input
 * @returns {object} 设计态图
 */
export function flowFilesToGraph(input) {
  const files = Array.isArray(input.files)
    ? Object.fromEntries(input.files.map((f) => [f.path, f.text]))
    : (input.files || {});
  const ir = parseFlowSource(input.source, { files, resolvePackage: input.resolvePackage });
  if (input.strict !== false && ir.unresolved.length) {
    const shown = ir.unresolved.slice(0, 5).map((u) => `第 ${u.line} 行：${u.message}`);
    const more = ir.unresolved.length > shown.length ? `（还有 ${ir.unresolved.length - shown.length} 处）` : "";
    throw new Error(`有 ${ir.unresolved.length} 处内容解析不出图结构${more}\n  ${shown.join("\n  ")}`);
  }
  return irToGraph(ir, input.layout || { nodes: {} }, input.nodeMeta || { nodes: {} });
}
