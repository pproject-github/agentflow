/**
 * DSL 用的节点定义表与 API 名映射。
 *
 * 定义表来自 `builtin/nodes/*.md`——与节点面板同一个来源（见
 * docs/wiki/node-definitions.zh-CN.md），因此 DSL 认识的节点集合与用户能拖出来的
 * 节点集合天然一致，不存在第二份清单。
 */
import fs from "fs";
import path from "path";

import { PACKAGE_BUILTIN_NODES_DIR } from "../paths.mjs";
import { parseNodeFrontmatter } from "../catalog-flows.mjs";

/** 控制槽：连这些槽的边表示执行顺序，不是数据流。 */
export const CTRL_SLOTS = new Set(["prev", "next", "next1", "next2"]);

/**
 * 标准槽：控制槽 + 运行时统一注入的上下文槽。
 * 这些名字不算「自定义槽」，代码里不必声明。
 */
export const STD_SLOTS = new Set([
  ...CTRL_SLOTS,
  "workspaceContext",
  "skillsContext",
  "mcpContext",
  "knowledgeContext",
  "gitContext",
]);

/** 运行入口节点——DSL 里对应 `flow()` / `flow.schedule()`，不是普通节点调用。 */
export const RUN_DEFINITIONS = new Set(["workspace_run", "workspace_scheduled_run"]);

export const isDisplayDefinition = (id) => String(id || "").startsWith("display_");
export const isProvideDefinition = (id) => String(id || "").startsWith("provide_");

/** 槽是否是控制槽（按类型或按名字，两者都要认——语料里两种写法都有）。 */
export const isControlSlot = (slot) =>
  String(slot?.type) === "node" || CTRL_SLOTS.has(String(slot?.name));

function loadDefinitions(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const meta = parseNodeFrontmatter(fs.readFileSync(path.join(dir, file), "utf-8"));
    out[file.slice(0, -3)] = { input: meta.input, output: meta.output, runtime: meta.runtime };
  }
  return out;
}

export const DEFINITIONS = loadDefinitions(PACKAGE_BUILTIN_NODES_DIR);

/**
 * definitionId -> DSL 调用名。多数是 `前缀_驼峰` 的机械转换，少数缩写要显式列出，
 * 否则 `control_cd_workspace` 会变成 `control.cdWorkspace` 的错拼。
 */
const API_OVERRIDES = {
  control_agent_toBool: "control.agentToBool",
  control_cd_workspace: "control.cdWorkspace",
  control_user_workspace: "control.userWorkspace",
  control_load_skills: "control.loadSkills",
  control_load_mcp: "control.loadMcp",
  control_toBool: "control.toBool",
  control_anyOne: "control.anyOne",
  tool_nodejs: "tool.nodejs",
  workspace_one_click_task: "workspace.oneClickTask",
};

function deriveApiName(definitionId) {
  if (API_OVERRIDES[definitionId]) return API_OVERRIDES[definitionId];
  const at = definitionId.indexOf("_");
  if (at < 0) return definitionId;
  const tail = definitionId.slice(at + 1).replace(/_([a-zA-Z])/g, (_, c) => c.toUpperCase());
  return `${definitionId.slice(0, at)}.${tail}`;
}

const API_BY_DEFINITION = {};
const DEFINITION_BY_API = {};
const collisions = [];
for (const definitionId of Object.keys(DEFINITIONS)) {
  const name = deriveApiName(definitionId);
  if (DEFINITION_BY_API[name] && DEFINITION_BY_API[name] !== definitionId) {
    collisions.push(`${name}: ${DEFINITION_BY_API[name]} vs ${definitionId}`);
  }
  API_BY_DEFINITION[definitionId] = name;
  DEFINITION_BY_API[name] = definitionId;
}

/**
 * definitionId <-> DSL 名必须是双射，否则解析回来会指向错误的节点类型。
 * 新增节点定义撞名时在这里直接炸掉，而不是等到某张图被静默解析错。
 */
export const API_NAME_COLLISIONS = collisions;
if (collisions.length) {
  throw new Error(`DSL 节点调用名冲突：${collisions.join("; ")}`);
}

export const apiName = (definitionId) => API_BY_DEFINITION[definitionId] || deriveApiName(definitionId);
export const definitionIdFromApi = (name) => DEFINITION_BY_API[name] || String(name).replace(".", "_");

export function definitionOf(definitionId) {
  return DEFINITIONS[definitionId] || { input: [], output: [], runtime: "native" };
}
