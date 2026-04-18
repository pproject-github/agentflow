/**
 * Normalize flow.yaml text before writing / importing.
 *
 * Legacy / hand-written flows commonly hardcode the pipeline scripts root as
 *   `${workspaceRoot}/.workspace/agentflow/pipelines/${flowName}`
 * which only works when the flow is installed under the workspace scope. Hub
 * downloads go to `~/agentflow/pipelines/` (user scope) by default, and builtin
 * flows live inside the package — both break the hardcoded path. Runtime already
 * exposes `${flowDir}` (see bin/pipeline/get-resolved-values.mjs) that resolves
 * to the flow's actual directory regardless of scope, so we rewrite the known
 * bad prefixes to `${flowDir}` on write / import.
 */

const PIPELINE_ROOT_PATTERNS = [
  // ${workspaceRoot}/.workspace/agentflow/pipelines/${flowName}
  /\$\{workspaceRoot\}\/\.workspace\/agentflow\/pipelines\/\$\{flowName\}/g,
  // ${workspaceRoot}/.cursor/agentflow/pipelines/${flowName} (legacy)
  /\$\{workspaceRoot\}\/\.cursor\/agentflow\/pipelines\/\$\{flowName\}/g,
  // ~/agentflow/pipelines/${flowName}
  /~\/agentflow\/pipelines\/\$\{flowName\}/g,
  // $HOME/agentflow/pipelines/${flowName}
  /\$HOME\/agentflow\/pipelines\/\$\{flowName\}/g,
  // ${HOME}/agentflow/pipelines/${flowName}
  /\$\{HOME\}\/agentflow\/pipelines\/\$\{flowName\}/g,
];

/**
 * @param {string} text
 * @returns {{ text: string, changed: boolean, replacements: number }}
 */
export function normalizeFlowYamlText(text) {
  if (typeof text !== "string" || !text) {
    return { text: text ?? "", changed: false, replacements: 0 };
  }
  let out = text;
  let count = 0;
  for (const pat of PIPELINE_ROOT_PATTERNS) {
    out = out.replace(pat, () => {
      count += 1;
      return "${flowDir}";
    });
  }
  return { text: out, changed: count > 0, replacements: count };
}

/**
 * 识别「flow.yaml 中 tool_nodejs script 路径错」常见模式。
 * 典型触发：script 硬编码 workspace/cursor/user 路径 + `${flowName}`，
 * 但 flow 实际装到其他 scope 时会 `Cannot find module`。
 * @param {string} stderr
 * @returns {string} 空串或可附加到错误信息末尾的修复提示
 */
export function buildPipelineScriptPathHint(stderr) {
  const s = typeof stderr === "string" ? stderr : "";
  if (!s) return "";
  const m = s.match(/Cannot find module '([^']+)'/);
  if (!m) return "";
  const missing = m[1];
  const isPipelineScript =
    /\/agentflow\/pipelines\/[^/]+\/scripts\//.test(missing) ||
    /\/\.workspace\/agentflow\/pipelines\//.test(missing) ||
    /\/\.cursor\/agentflow\/pipelines\//.test(missing);
  if (!isPipelineScript) return "";
  return (
    ` | Hint: 脚本不存在（${missing}）。flow.yaml 的 tool_nodejs.script 可能硬编码了 ` +
    "`${workspaceRoot}/.workspace/agentflow/pipelines/${flowName}/scripts/...`；" +
    "当 flow 装到 ~/agentflow/pipelines/ 或 builtin 时会找不到。" +
    "请改用 `${flowDir}/scripts/xxx.mjs`（${flowDir} 解析到 flow 真实目录，兼容 user/workspace/builtin）。" +
    "AI 自愈无法修复此类模板路径错——必须手改 flow.yaml。"
  );
}
