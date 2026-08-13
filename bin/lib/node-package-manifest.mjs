/**
 * 代码节点包的清单提取。
 *
 * 一个节点包 = 一个目录，`index.mjs` 同时是「声明」和「实现」：
 *
 * ```js
 * export default {
 *   id: "collect_metrics",
 *   version: "1.0.0",
 *   name: "统计流程语料",
 *   inputs:  { date: { type: "text", description: "查询日期" } },
 *   outputs: { result: { type: "text" } },
 * };
 *
 * export async function run(inputs, outputs, dirs) { ... }
 * ```
 *
 * 声明部分由 acorn **静态解析**得到——列节点面板、校验槽位、渲染画布都不会执行包里的
 * 代码。这是硬约束：目录扫描期执行第三方代码既慢又不安全。
 *
 * 代价是 `export default` 必须是纯字面量。任何变量引用、函数调用、展开运算都会被拒绝，
 * 并给出明确报错，而不是悄悄退化成空清单。
 */
import fs from "fs";
import path from "path";
import { parse as acornParse } from "acorn";
import { normalizeNodeUiForSlots } from "./node-ui-kit.mjs";

export const NODE_PACKAGE_ENTRY = "index.mjs";

/** 槽位类型；与 builtin/nodes/*.md 的 `type:` 取值一致。 */
const SLOT_TYPES = new Set(["text", "file", "bool", "node", "image", "json"]);

function staticEval(node, where) {
  if (!node) throw new Error(`${where}: 空表达式`);
  switch (node.type) {
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length) throw new Error(`${where}: 模板字符串不能有插值`);
      return node.quasis.map((q) => q.value.cooked).join("");
    case "ArrayExpression":
      return node.elements.map((el, i) => staticEval(el, `${where}[${i}]`));
    case "ObjectExpression": {
      const out = {};
      for (const prop of node.properties) {
        if (prop.type !== "Property") throw new Error(`${where}: 对象里不允许展开运算符`);
        if (prop.computed) throw new Error(`${where}: 对象里不允许计算属性名`);
        const key = prop.key.type === "Identifier" ? prop.key.name : prop.key.value;
        out[key] = staticEval(prop.value, `${where}.${key}`);
      }
      return out;
    }
    case "UnaryExpression":
      if (node.operator === "-") return -staticEval(node.argument, where);
      if (node.operator === "+") return +staticEval(node.argument, where);
      throw new Error(`${where}: 不允许的一元运算 ${node.operator}`);
    default:
      throw new Error(`${where}: 只允许字面量，不允许 ${node.type}`);
  }
}

/**
 * 从节点包入口静态提取 `export default` 声明。
 * @returns {object|null} 解析不出声明时返回 null；语法/字面量违规时抛错。
 */
export function readNodePackageDeclaration(entryPath) {
  const src = fs.readFileSync(entryPath, "utf-8");
  let ast;
  try {
    ast = acornParse(src, { ecmaVersion: 2022, sourceType: "module" });
  } catch (e) {
    throw new Error(`${path.basename(entryPath)} 解析失败：${(e && e.message) || e}`);
  }
  for (const stmt of ast.body) {
    if (stmt.type !== "ExportDefaultDeclaration") continue;
    return staticEval(stmt.declaration, "export default");
  }
  return null;
}

/** 入口是否导出了 `run`（命名导出或 `export default { run }` 之外的函数声明）。 */
export function nodePackageExportsRun(entryPath) {
  const src = fs.readFileSync(entryPath, "utf-8");
  let ast;
  try {
    ast = acornParse(src, { ecmaVersion: 2022, sourceType: "module" });
  } catch {
    return false;
  }
  for (const stmt of ast.body) {
    if (stmt.type !== "ExportNamedDeclaration") continue;
    const decl = stmt.declaration;
    if (decl?.type === "FunctionDeclaration" && decl.id?.name === "run") return true;
    if (decl?.type === "VariableDeclaration") {
      for (const d of decl.declarations) if (d.id?.type === "Identifier" && d.id.name === "run") return true;
    }
    for (const spec of stmt.specifiers || []) {
      const exported = spec.exported?.name ?? spec.exported?.value;
      if (exported === "run") return true;
    }
  }
  return false;
}

/**
 * 声明里的 `inputs` / `outputs` 是对象映射（顺序即槽位顺序）；平台要的是槽位数组，
 * 且首位固定是控制槽 prev / next。
 */
export function slotMapToList(map, kind) {
  const first = kind === "input"
    ? { type: "node", name: "prev", default: "" }
    : { type: "node", name: "next", default: "" };
  const out = [first];
  if (!map || typeof map !== "object" || Array.isArray(map)) return out;
  for (const [name, rawSpec] of Object.entries(map)) {
    const spec = typeof rawSpec === "string" ? { type: rawSpec } : (rawSpec && typeof rawSpec === "object" ? rawSpec : {});
    const type = String(spec.type || "text").trim();
    if (!SLOT_TYPES.has(type)) {
      throw new Error(`${kind} 槽位 ${name}: 未知类型 ${type}（可选 ${[...SLOT_TYPES].join(" / ")}）`);
    }
    const slot = { type, name: String(name), default: spec.default == null ? "" : String(spec.default) };
    if (spec.description != null) slot.description = String(spec.description);
    if (spec.required != null) slot.required = Boolean(spec.required);
    out.push(slot);
  }
  return out;
}

/**
 * 把节点包声明转成 marketplace manifest 的形状（`node.yaml` 解析后的等价物）。
 * @returns {object|null}
 */
export function nodePackageDeclarationToManifest(decl, packageDir) {
  if (!decl || typeof decl !== "object" || Array.isArray(decl)) return null;
  const id = decl.id != null ? String(decl.id).trim() : path.basename(packageDir);
  const version = decl.version != null ? String(decl.version).trim() : "";
  if (!id || !version) return null;
  const input = slotMapToList(decl.inputs, "input");
  const output = slotMapToList(decl.outputs, "output");
  const ui = normalizeNodeUiForSlots(decl.ui, input, output);
  return {
    id,
    version,
    displayName: decl.name != null ? String(decl.name) : id,
    description: decl.description != null ? String(decl.description) : "",
    input,
    output,
    baseDefinitionId: "tool_nodejs",
    runtime: { type: "tool_nodejs", entry: NODE_PACKAGE_ENTRY, mode: "module" },
    ...(ui ? { ui } : {}),
    ...(decl.ownerUserId != null ? { ownerUserId: String(decl.ownerUserId) } : {}),
    ...(decl.createdBy != null ? { createdBy: String(decl.createdBy) } : {}),
  };
}

/**
 * 读取一个节点包目录的清单：优先 `index.mjs` 静态声明，读不出再回退调用方给的
 * `node.yaml` 读取器。
 * @param {string} dir
 * @param {(yamlPath: string) => object|null} readYaml
 * @returns {object|null}
 */
export function readNodePackageManifest(dir, readYaml) {
  const entry = path.join(dir, NODE_PACKAGE_ENTRY);
  if (fs.existsSync(entry) && fs.statSync(entry).isFile()) {
    const manifest = nodePackageDeclarationToManifest(readNodePackageDeclaration(entry), dir);
    if (manifest) return manifest;
  }
  return typeof readYaml === "function" ? readYaml(path.join(dir, "node.yaml")) : null;
}

/** 目录是否是一个可识别的节点包。 */
export function isNodePackageDir(dir) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
  const entry = path.join(dir, NODE_PACKAGE_ENTRY);
  if (fs.existsSync(entry) && fs.statSync(entry).isFile()) return true;
  return fs.existsSync(path.join(dir, "node.yaml"));
}
