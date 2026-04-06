/**
 * Web UI Composer：对当前 flow.yaml 调用与 CLI 一致的 validate-flow 逻辑。
 * agent 有时会把 flow.yaml 写到 workspace 路径而非 user 路径（或反之），
 * 当原路径找不到时，尝试在 workspace 下的 .workspace/agentflow/pipelines/ 和
 * agentflow/pipelines/ 中查找同名目录。
 */
import fs from "fs";
import path from "path";
import { runValidateFlow } from "../pipeline/validate-flow.mjs";

/**
 * @param {string} flowYamlAbs
 * @param {string} workspaceRoot
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateComposerFlowYaml(flowYamlAbs, workspaceRoot) {
  let flowDir = path.dirname(path.resolve(flowYamlAbs));
  const root = path.resolve(workspaceRoot);

  if (!fs.existsSync(path.join(flowDir, "flow.yaml"))) {
    const flowId = path.basename(flowDir);
    const candidates = [
      path.join(root, ".workspace", "agentflow", "pipelines", flowId),
      path.join(root, "agentflow", "pipelines", flowId),
      path.join(root, ".cursor", "agentflow", "pipelines", flowId),
    ];
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, "flow.yaml"))) {
        flowDir = c;
        break;
      }
    }
  }

  return runValidateFlow(flowDir, root);
}

/**
 * @param {{ ok?: boolean, errors?: string[] }} result
 * @returns {string}
 */
export function formatValidationErrorsBlock(result) {
  if (!result) return "（校验无返回）";
  const errs = Array.isArray(result.errors) ? result.errors : [];
  if (errs.length === 0) return "（无 errors 字段，请检查 flow.yaml 结构）";
  return errs.map((e, i) => `${i + 1}. ${e}`).join("\n");
}
