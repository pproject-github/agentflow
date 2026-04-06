/**
 * 从 flow.yaml 解析实例的 role / model，供 Composer 多步规划与路由使用。
 */
import yaml from "js-yaml";

const VALID_ROLES = ["需求拆解", "技术规划", "代码执行", "测试回归", "普通"];

/**
 * @param {string} [flowYaml]
 * @returns {Record<string, { role: string, model?: string, label: string, definitionId?: string, hasScript?: boolean }>}
 */
export function parseInstanceRoleModelMap(flowYaml) {
  const map = {};
  if (!flowYaml || typeof flowYaml !== "string" || !flowYaml.trim()) return map;
  try {
    const raw = yaml.load(flowYaml);
    const instances = raw?.instances && typeof raw.instances === "object" ? raw.instances : {};
    for (const [id, inst] of Object.entries(instances)) {
      if (!inst || typeof inst !== "object") continue;
      const rawRole = inst.role != null ? String(inst.role).trim() : "";
      const role = VALID_ROLES.includes(rawRole) ? rawRole : "普通";
      let model = inst.model != null ? String(inst.model).trim() : "";
      if (model === "default") model = "";
      const label = inst.label != null ? String(inst.label) : id;
      const definitionId = inst.definitionId != null ? String(inst.definitionId).trim() : undefined;
      const hasScript = definitionId === "tool_nodejs" && inst.script != null && String(inst.script).trim() !== "";
      map[id] = { role, model: model || undefined, label, definitionId, hasScript };
    }
  } catch {
    /* ignore */
  }
  return map;
}

/**
 * 供规划器 user 消息附加：明确实例上的角色、模型与节点类型，便于输出带 instanceId / nodeRole 的步骤。
 * @param {string} [flowYaml]
 * @returns {string}
 */
export function formatInstancePlannerHint(flowYaml) {
  const map = parseInstanceRoleModelMap(flowYaml);
  const entries = Object.entries(map);
  if (entries.length === 0) return "";

  const nodejsMissing = [];
  const lines = entries.map(([id, v]) => {
    const m = v.model ? ` · 模型 \`${v.model}\`` : "";
    const defHint = v.definitionId ? ` · \`${v.definitionId}\`` : "";
    const scriptHint = v.definitionId === "tool_nodejs" && !v.hasScript ? " ⚠️ **缺 script**" : "";
    if (v.definitionId === "tool_nodejs" && !v.hasScript) nodejsMissing.push(id);
    return `- \`${id}\`（${v.label}）：角色 **${v.role}**${defHint}${m}${scriptHint}`;
  });

  let warn = "";
  if (nodejsMissing.length > 0) {
    warn = `\n\n⚠️ **以下 tool_nodejs 节点缺少 script 字段**（无 script 则节点无法执行）：${nodejsMissing.map(id => `\`${id}\``).join("、")}。` +
      "必须为它们写入可执行的 `script`（shell/node 命令），或改用 `agent_subAgent`。`body` 不会被执行。";
  }

  return (
    "\n## 画布实例（类型 / 角色 / 模型）\n" +
    "agent 步骤请尽量填写 `instanceId`（本步主要操作的实例），`nodeRole` 应与该实例的 role 一致；可选用 `executorModel` 覆盖执行模型（否则使用该实例在 YAML 中的 model，再否则用用户全局模型）。\n" +
    lines.join("\n") +
    warn
  );
}
