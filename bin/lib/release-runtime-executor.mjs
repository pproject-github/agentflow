import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RELEASE_WORKFLOW_CONFIG } from "../../shared/release-workflow-config.js";
import { readReleaseDeploymentConfigWithDataRoot } from "./admin-release-projects.mjs";
import { defaultFetchIterationsSync, findTapdIterationForVersion } from "./release-tapd.mjs";

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'"'"'`)}'`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function normalizeCompositeStatus(status, aliases = {}) {
  const value = String(status || "").trim().toLowerCase();
  return String(aliases?.[value] || value);
}

const SECRET_KEY_RE = /(token|secret|password|passwd|webhook|authorization|cookie|api[-_]?key)/i;
const PREVIOUS_RESULT_MAX_CHARS = 12_000;
/** OA 拼音账号：小写字母开头，仅字母数字与 ._-（与 release-approval 操作手册一致）。 */
const OA_OPERATOR_RE = /^[a-z][a-z0-9._-]*$/;

export function isReleaseApprovalOperatorUsername(value = "") {
  const name = String(value || "").trim();
  return Boolean(name) && OA_OPERATOR_RE.test(name);
}

/** 审核单申请人：优先 AgentFlow 登录名，必须是 OA 拼音。 */
export function resolveReleaseApprovalOperator(...candidates) {
  for (const candidate of candidates) {
    const name = String(candidate || "").trim();
    if (isReleaseApprovalOperatorUsername(name)) return name;
  }
  return "";
}

function sanitizePromptValue(value, key = "") {
  if (SECRET_KEY_RE.test(String(key || ""))) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => sanitizePromptValue(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitizePromptValue(item, name)]));
  }
  return value;
}

/**
 * 用户需求点: 重试时只能带回可恢复摘要；把上次 Agent 日志/stdout/events 整包塞进 prompt 会超过 Cursor 上限并秒失败。
 */
export function compactReleasePreviousResult(previousResult, maxChars = PREVIOUS_RESULT_MAX_CHARS) {
  if (previousResult == null) return null;
  if (typeof previousResult === "string") {
    const text = previousResult.trim();
    if (!text) return null;
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…[truncated]`;
  }
  if (!previousResult || typeof previousResult !== "object" || Array.isArray(previousResult)) return null;
  // 明确丢弃 events/logs/stdout 等调试噪声，绝不 ...rest 回灌大字段。
  const steps = Array.isArray(previousResult.steps)
    ? previousResult.steps.slice(0, 20).map((step) => {
      if (!step || typeof step !== "object") return null;
      const output = step.output && typeof step.output === "object" && !Array.isArray(step.output)
        ? Object.fromEntries(Object.entries(step.output).slice(0, 12).map(([key, value]) => [
          key,
          typeof value === "string" ? value.slice(0, 200) : (typeof value === "number" || typeof value === "boolean" || value == null ? value : "[omitted]"),
        ]))
        : undefined;
      return {
        ...(step.stepId != null ? { stepId: step.stepId } : {}),
        ...(step.actionId != null ? { actionId: step.actionId } : {}),
        ...(step.title != null ? { title: String(step.title).slice(0, 120) } : {}),
        ...(step.status != null ? { status: step.status } : {}),
        ...(step.error ? { error: String(step.error).slice(0, 400) } : {}),
        ...((step.summary || step.message) ? { summary: String(step.summary || step.message).slice(0, 400) } : {}),
        ...(output && Object.keys(output).length ? { output } : {}),
      };
    }).filter(Boolean)
    : undefined;
  const compact = {
    ...(previousResult.status != null ? { status: previousResult.status } : {}),
    ...(previousResult.summary != null ? { summary: String(previousResult.summary).slice(0, 1_000) } : {}),
    ...(previousResult.error != null ? { error: String(previousResult.error).slice(0, 600) } : {}),
    ...(previousResult.next_action != null ? { next_action: previousResult.next_action } : {}),
    ...(previousResult.waiting != null ? { waiting: previousResult.waiting } : {}),
    ...(Array.isArray(previousResult.records) ? { records: previousResult.records.slice(0, 10).map((item) => (
      typeof item === "string" ? item.slice(0, 120) : (item && typeof item === "object" ? {
        ...(item.record_id || item.id ? { record_id: String(item.record_id || item.id).slice(0, 120) } : {}),
        ...(item.resume_record_id ? { resume_record_id: String(item.resume_record_id).slice(0, 120) } : {}),
        ...(item.operation ? { operation: String(item.operation).slice(0, 120) } : {}),
        ...(item.result_status ? { result_status: String(item.result_status).slice(0, 80) } : {}),
        ...(item.status ? { status: String(item.status).slice(0, 40) } : {}),
      } : undefined)
    )).filter((item) => item && Object.keys(item).length) } : {}),
    ...(Array.isArray(previousResult.artifacts) ? { artifacts: previousResult.artifacts.slice(0, 10).map((item) => (
      typeof item === "string" ? item.slice(0, 120) : undefined
    )).filter(Boolean) } : {}),
    ...(steps?.length ? { steps } : {}),
  };
  if (!Object.keys(compact).length) return null;
  const encoded = JSON.stringify(compact);
  if (encoded.length <= maxChars) return compact;
  return {
    status: compact.status || "failed",
    summary: String(compact.summary || compact.error || "上一次执行摘要过长，已省略；请按 Skill 现状继续，勿重复不可逆写操作。").slice(0, 1_000),
    ...(compact.error ? { error: String(compact.error).slice(0, 400) } : {}),
    truncated: true,
  };
}

/** 从 pending/run 卡片提取给 Agent 的恢复摘要；永远不读取 output.events / logs。 */
export function releasePreviousResultForAgent(item) {
  if (!item || typeof item !== "object") return null;
  const output = item.output && typeof item.output === "object" && !Array.isArray(item.output) ? item.output : null;
  const details = item.details && typeof item.details === "object" && !Array.isArray(item.details) ? item.details : null;
  const fromOutput = output && !Array.isArray(output.events)
    ? {
      status: output.status,
      summary: output.summary,
      error: output.error,
      records: output.records,
      artifacts: output.artifacts,
      next_action: output.next_action,
      waiting: output.waiting,
      steps: output.steps,
    }
    : {};
  const fromDetails = details
    ? {
      steps: details.steps,
      records: details.records,
      artifacts: details.artifacts,
      summary: details.summary,
      status: details.status,
    }
    : {};
  return compactReleasePreviousResult({
    status: item.status || fromOutput.status || fromDetails.status,
    summary: item.summary || item.message || fromOutput.summary || fromDetails.summary,
    error: item.error || fromOutput.error,
    next_action: fromOutput.next_action,
    waiting: fromOutput.waiting,
    records: fromOutput.records || fromDetails.records,
    artifacts: fromOutput.artifacts || fromDetails.artifacts,
    steps: fromDetails.steps || fromOutput.steps,
  });
}

/**
 * 从 skillRoot 最近执行记录提取可恢复摘要，供重试时避免重复 prepare/apply。
 */
export function discoverReleaseSkillRecovery(skillRoots = [], capabilityId = "") {
  const roots = selectReleaseAgentSkillRoots(skillRoots, capabilityId);
  const skillRoot = roots[0];
  if (!skillRoot) return null;
  const execDir = path.join(skillRoot, ".release-skill", "executions");
  if (!fs.existsSync(execDir)) return null;
  const id = String(capabilityId || "");
  const wantsLocalization = /localization-download|localization-upload/.test(id);
  if (!wantsLocalization) return null;
  let files = [];
  try {
    files = fs.readdirSync(execDir)
      .filter((name) => name.endsWith(".yaml"))
      .map((name) => {
        const filePath = path.join(execDir, name);
        return { filePath, mtime: fs.statSync(filePath).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 40);
  } catch {
    return null;
  }
  const hints = [];
  for (const { filePath } of files) {
    let text = "";
    try { text = fs.readFileSync(filePath, "utf8"); } catch { continue; }
    const recordId = text.match(/^record_id: (.+)$/m)?.[1]?.trim();
    const status = text.match(/^status: (.+)$/m)?.[1]?.trim();
    const operation = text.match(/^\s+operation: (.+)$/m)?.[1]?.trim();
    const resultStatus = text.match(/^\s+status: (.+)$/m)?.[1]?.trim();
    const resumeId = text.match(/resume_record_id: ([a-f0-9]{32})/)?.[1];
    if (!recordId || !operation) continue;
    if (wantsLocalization && /localization-download/.test(id)) {
      if (/准备翻译归档|应用翻译|提交受管理多语言|topic|MR|推送/.test(operation)) {
        hints.push({
          record_id: recordId,
          status: status || resultStatus,
          operation,
          ...(resumeId ? { resume_record_id: resumeId } : {}),
          ...(resultStatus ? { result_status: resultStatus } : {}),
        });
      }
    }
    if (hints.length >= 8) break;
  }
  if (!hints.length) return null;
  return compactReleasePreviousResult({
    status: "recovery",
    summary: "Skill 执行记录摘要；重试将整图重新执行，勿依赖断点续跑。",
    records: hints,
  });
}

/** 用户需求点: 已移除 Google Play AAB 扩展仓库，所有发版 Agent 只从主 release-skills 根读取 Skill。 */
export function selectReleaseAgentSkillRoots(skillRoots = [], capabilityId = "", skillHints = []) {
  void capabilityId;
  void skillHints;
  const normalized = (Array.isArray(skillRoots) ? skillRoots : [])
    .map((root) => String(root || "").trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .filter((root) => !/(?:^|\/)release-skills-google-play-aab$/i.test(root));
  if (!normalized.length) return [];
  const main = normalized.filter((root) => /(?:^|\/)release-skills$/i.test(root));
  return main.length ? main : [normalized[0]];
}

/** @deprecated 仅保留旧测试/外部调用兼容；AgentFlow 执行路径不使用。 */
function legacyReleaseCapabilityPlaybook(capabilityId = "", context = {}, inputs = {}) {
  const id = String(capabilityId || "");
  const productLabel = String(context?.businessLine || inputs?.product || "likee").trim() || "likee";
  const platformLabel = String(context?.platform || inputs?.platform || "android").trim() || "android";
  const product = productLabel.toLowerCase();
  const platform = platformLabel.toLowerCase();
  const version = String(context?.version || inputs?.minor_version || "").trim();
  const batch = String(context?.batch || inputs?.batch || "initial").trim().toLowerCase() || "initial";
  const releaseBranch = String(inputs?.release_branch || "").trim();
  const displayProduct = productLabel[0] ? productLabel[0].toUpperCase() + productLabel.slice(1) : productLabel;

  if (id.includes("localization-upload-notify")) {
    if (!version) {
      return [
        `上传 ${displayProduct} ${platformLabel} 的受审源多语言内容。`,
        "缺少初始化版本号（minor_version）。返回 status=waiting，waiting.reason=version_required，required_inputs=[\"minor_version\"]，不要执行。",
      ].join("\n");
    }
    return `上传 ${displayProduct} ${platformLabel} 的受审源多语言内容（版本 ${version}，批次 ${batch}），完成后发送 localization-uploaded 通知。`;
  }
  if (id.includes("localization-download-merge-notify")) {
    if (!version) {
      return [
        `为 ${displayProduct} ${platformLabel} 拉回翻译。`,
        "缺少初始化版本号（minor_version）。返回 status=waiting，waiting.reason=version_required，required_inputs=[\"minor_version\"]，不要执行。",
      ].join("\n");
    }
    const forceRerun = ["1", "true", "yes", "on"].includes(String(inputs?.force_rerun ?? "").trim().toLowerCase())
      || inputs?.force_rerun === true;
    if (forceRerun) {
      return [
        `为 ${displayProduct} ${platformLabel} 拉回翻译（版本 ${version}，批次 ${batch}）。本次为强制重新下载。`,
        "必须对 prepare-translation-archive 使用 --rerun（按 Skill 流程），再 apply；有变更时交接 release-git 完成受管理提交、推送和创建或复用 MR。",
        "MR 创建或复用成功后本节点立即完成；不要等待 MR 合入，不要发送合入通知。",
      ].join("\n");
    }
    return `为 ${displayProduct} ${platformLabel} 拉回翻译（版本 ${version}，批次 ${batch}），按 Skill 应用到工程；有变更时由 Skill 内部交接 release-git 完成受管理提交、推送和创建或复用 MR。MR 创建或复用成功后本节点立即完成；不要等待 MR 合入，不要发送合入通知。`;
  }
  if (id.includes("create-release-branch")) {
    if (!version) {
      return [
        `为 ${displayProduct} ${platformLabel} 当前首包创建标准发版分支并登记。`,
        "缺少初始化版本号（minor_version）。返回 status=waiting，waiting.reason=version_required，required_inputs=[\"minor_version\"]，不要执行。",
      ].join("\n");
    }
    return releaseBranch
      ? `为 ${displayProduct} ${platformLabel} 当前发版显式选择 ${releaseBranch} 并登记（版本 ${version}，批次 ${batch}）。`
      : `为 ${displayProduct} ${platformLabel} 当前首包创建标准发版分支并登记（版本 ${version}，批次 ${batch}）。`;
  }
  if (id.includes("merge-release-to-master")) {
    if (!version) {
      return [
        `为 ${displayProduct} ${platformLabel} 当前 release 分支创建合入主干的 MR。`,
        "缺少初始化版本号（minor_version）。返回 status=waiting，waiting.reason=version_required，required_inputs=[\"minor_version\"]，不要执行。",
      ].join("\n");
    }
    return `为 ${displayProduct} ${platformLabel} 当前 release 分支创建合入主干的 MR（版本 ${version}，批次 ${batch}）；若已合入则核对并准备通知交接。`;
  }
  if (id.includes("build-package")) {
    if (!version) {
      return [
        `准备 ${displayProduct} ${platformLabel} 发版包。`,
        "缺少初始化版本号（minor_version）。返回 status=waiting，waiting.reason=version_required，required_inputs=[\"minor_version\"]，不要执行。",
      ].join("\n");
    }
    // 用户需求点: 构建号优先从活动发版读取，读取不到时立刻停在 waiting，不得盲目触发构建。
    const buildNumber = String(inputs?.build_number || "").trim();
    return buildNumber
      ? `准备 ${displayProduct} ${platformLabel} 发版包（版本 ${version}，批次 ${batch}，构建号 ${buildNumber}）。`
      : [
        `准备 ${displayProduct} ${platformLabel} 发版包（版本 ${version}，批次 ${batch}）。`,
        "先从当前活动发版读取渠道包所需的 build_number（Android 需包含对应构建号）；无法确定时返回 status=waiting，waiting.reason=build_number_required，required_inputs=[\"build_number\"]，不要猜测或执行。",
      ].join("\n");
  }
  if (id.includes("submit-full-rollout-approval")) {
    const operator = resolveReleaseApprovalOperator(inputs?.operator, context?.operator);
    if (!version) {
      return [
        `为 ${displayProduct} ${platformLabel} 创建全量发布审核草稿。`,
        "缺少初始化版本号（minor_version）。返回 status=waiting，waiting.reason=version_required，required_inputs=[\"minor_version\"]，不要执行。",
      ].join("\n");
    }
    if (!operator) {
      return [
        `为 ${displayProduct} ${platformLabel} ${version}（${batch}）创建全量发布审核草稿。`,
        "审核申请人无效：须为 OA 拼音账号（如 yangcaimu）。返回 status=waiting，waiting.reason=approval_operator_invalid，不要执行。",
      ].join("\n");
    }
    return [
      `为 ${displayProduct} ${platformLabel} ${version}（${batch}）创建全量发布审核草稿，审核申请人为 ${operator}。`,
      "按 release-approval 操作指南：目标批次须已有构建号、发布日期与已确认指标快照；读 Skill 自行编排 create-full-rollout-approval。",
    ].join("\n");
  }
  if (id.includes("submit-approval")) {
    const operator = resolveReleaseApprovalOperator(inputs?.operator, context?.operator);
    if (!version) {
      return [
        `为 ${displayProduct} ${platformLabel} 创建首次发版审核草稿。`,
        "缺少初始化版本号（minor_version）。返回 status=waiting，waiting.reason=version_required，required_inputs=[\"minor_version\"]，不要执行。",
      ].join("\n");
    }
    if (!operator) {
      return [
        `为 ${displayProduct} ${platformLabel} ${version}（${batch}）创建首次发版审核草稿。`,
        "审核申请人无效：须为 OA 拼音账号（如 yangcaimu）。返回 status=waiting，waiting.reason=approval_operator_invalid，不要执行。",
      ].join("\n");
    }
    return `为 ${displayProduct} ${platformLabel} ${version}（${batch}）创建首次发版审核草稿，审核申请人为 ${operator}。`;
  }
  if (id.includes("initial-publish-and-notify")) {
    if (!version) {
      return [
        platform === "ios"
          ? `为 ${displayProduct} ${platformLabel} 上传首包版本更新说明并通知。`
          : `为 ${displayProduct} ${platformLabel} 执行首包商店发布并通知。`,
        "缺少初始化版本号（minor_version）。返回 status=waiting，waiting.reason=version_required，required_inputs=[\"minor_version\"]，不要执行。",
      ].join("\n");
    }
    return platform === "ios"
      ? `为 ${displayProduct} ${platformLabel} 上传首包版本更新说明并通知（版本 ${version}，批次 initial）。`
      : `为 ${displayProduct} ${platformLabel} 执行首包商店发布并通知（版本 ${version}，批次 initial）。`;
  }
  if (id.includes("supplemental-publish-and-notify")) {
    if (!version) {
      return [
        platform === "ios"
          ? `为 ${displayProduct} ${platformLabel} 上传补包版本更新说明并通知。`
          : `为 ${displayProduct} ${platformLabel} 执行补包商店发布并通知。`,
        "缺少初始化版本号（minor_version）。返回 status=waiting，waiting.reason=version_required，required_inputs=[\"minor_version\"]，不要执行。",
      ].join("\n");
    }
    return platform === "ios"
      ? `为 ${displayProduct} ${platformLabel} 上传补包版本更新说明并通知（版本 ${version}，批次 supplemental）。`
      : `为 ${displayProduct} ${platformLabel} 执行补包商店发布并通知（版本 ${version}，批次 supplemental）。`;
  }
  if (id.includes("start-supplemental-release-notify")) {
    if (!version) {
      return [
        `为 ${displayProduct} ${platformLabel} 开始补包并发送通知。`,
        "缺少初始化版本号（minor_version）。返回 status=waiting，waiting.reason=version_required，required_inputs=[\"minor_version\"]，不要执行。",
      ].join("\n");
    }
    return [
      `为 ${displayProduct} ${platformLabel} 开始补包（版本 ${version}，批次 supplemental）并发送补包开始通知。`,
      "先按 release-management Skill 执行 guide-current-release，读取当前版本的发版上下文；平台时间线没有历史记录也允许执行，不要因为页面没有历史卡片而跳过。",
      "若同一主版本已有活动发版，按 Skill 执行 append-release-batch 追加 supplemental batch；若没有任何活动发版，按 Skill 建立首包活动上下文后再继续补包准备；不要把补包误当成新的首包流程。",
      "发版上下文准备成功后，再按 release-notification Skill 发送补包开始通知。上下文或分支无法安全建立时返回 status=failed/waiting，说明原因，不要假装完成。",
    ].join("\n");
  }
  if (id === "rollout" || (id.includes("rollout") && !id.includes("full-rollout"))) {
    if (!version) {
      return [
        `为 ${displayProduct} ${platformLabel} 观察灰度并推进放量。`,
        "缺少初始化版本号（minor_version）。返回 status=waiting，waiting.reason=version_required，required_inputs=[\"minor_version\"]，不要执行。",
      ].join("\n");
    }
    // 用户需求点: Android 放量必须由操作员明确给出灰度比例，不能让 Agent 猜测目标量级。
    const grayPercent = String(inputs?.gray_percent || "").trim();
    if (!grayPercent && platform === "android") {
      return [
        `为 ${displayProduct} ${platformLabel} 观察灰度并推进放量（版本 ${version}，批次 ${batch}）。`,
        "缺少灰度百分比（gray_percent）。返回 status=waiting，waiting.reason=gray_percent_required，required_inputs=[\"gray_percent\"]，不要执行。",
      ].join("\n");
    }
    return grayPercent
      ? `为 ${displayProduct} ${platformLabel} 观察灰度并推进放量到 ${grayPercent}%（版本 ${version}，批次 ${batch}）。`
      : `为 ${displayProduct} ${platformLabel} 观察灰度并推进放量（版本 ${version}，批次 ${batch}）。`;
  }
  if (id.includes("full-rollout") && !id.includes("approval")) {
    if (!version) {
      return [
        `为 ${displayProduct} ${platformLabel} 发送全量放量通知。`,
        "缺少初始化版本号（minor_version）。返回 status=waiting，waiting.reason=version_required，required_inputs=[\"minor_version\"]，不要执行。",
      ].join("\n");
    }
    return `为 ${displayProduct} ${platformLabel} 发送全量放量通知（版本 ${version}，批次 ${batch}）。`;
  }
  if (id.includes("free-prompt")) {
    const userPrompt = String(inputs?.prompt || "").trim();
    if (!userPrompt) {
      return [
        `按操作员任务说明执行 ${displayProduct} ${platformLabel} 发版相关操作。`,
        "缺少任务说明（prompt）。返回 status=waiting，waiting.reason=prompt_required，required_inputs=[\"prompt\"]，不要执行。",
      ].join("\n");
    }
    return userPrompt;
  }
  if (id.includes("prepare-context") || id.includes("release-initialization")) {
    if (!version) {
      return [
        `查看并准备 ${displayProduct} ${platformLabel} 的当前活动发版。`,
        "缺少初始化版本号（minor_version）。返回 status=waiting，waiting.reason=version_required，required_inputs=[\"minor_version\"]，不要执行。",
      ].join("\n");
    }
    const publishDate = String(inputs?.publish_date || "").trim();
    return publishDate
      ? `为 ${displayProduct} ${platformLabel} 准备版本 ${version}（${batch}）活动发版上下文，发布日期 ${publishDate}。`
      : `查看并准备 ${displayProduct} ${platformLabel} 版本 ${version}（${batch}）的当前活动发版。`;
  }
  return `为 ${displayProduct} ${platformLabel}${version ? ` ${version}` : ""}（${batch}）执行当前发版能力。`;
}

function interpolateReleaseGoal(template, values) {
  return String(template || "").replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_match, key) => String(values?.[key] ?? "").trim());
}

/** 用户需求点: 发版平台只传递配置中的业务目标，Skill 自行决定内部步骤和 CLI 参数。 */
export function buildReleaseCapabilityPlaybook(capabilityId = "", context = {}, inputs = {}, configuredCapability = null) {
  const id = String(capabilityId || "").trim();
  // 仅兼容旧的直接调用方；AgentFlow 运行路径始终传入配置能力，使用下方配置驱动目标。
  if (!configuredCapability) return legacyReleaseCapabilityPlaybook(id, context, inputs);
  const capability = configuredCapability && typeof configuredCapability === "object"
    ? configuredCapability
    : RELEASE_WORKFLOW_CONFIG.capabilities?.find((item) => String(item?.id || "") === id);
  const product = String(context?.businessLine || inputs?.product || "").trim();
  const platform = String(context?.platform || inputs?.platform || "").trim();
  const version = String(context?.version || inputs?.minor_version || "").trim();
  const batch = String(context?.batch || inputs?.batch || "initial").trim();
  const prompt = String(inputs?.prompt || "").trim();
  const goal = String(capability?.capabilityGoal || capability?.description || "执行当前发版能力。").trim();
  if (id === "free-prompt-agent" && prompt) return prompt;
  return interpolateReleaseGoal(goal, {
    businessLine: product,
    platform,
    version,
    batch,
    batchIndex: context?.batchIndex,
    operator: inputs?.operator || context?.operator,
    prompt,
  });
}

export function buildReleaseAgentPrompt({ capability = {}, context = {}, inputs = {}, skillRoots = [], upstreamOutputs = {}, previousResult = null, requiredReleaseFields = [] } = {}) {
  const capabilityId = String(capability?.id || capability?.compositeId || "").trim();
  const promptInputs = inputs && typeof inputs === "object" && !Array.isArray(inputs) ? { ...inputs } : {};
  if (capabilityId.includes("localization-upload-notify")) delete promptInputs.source_path;
  // 续跑/历史恢复由 Skill 自行处理；AgentFlow 不再注入 previousResult / executions 摘要。
  void previousResult;
  const inputHints = String(promptInputs.skill_hints || "")
    .split(/[,;\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.startsWith("release-"));
  const hints = [...new Set([
    ...inputHints,
    ...(Array.isArray(capability.skillHints) ? capability.skillHints.filter(Boolean) : []),
  ])];
  const agentSkillRoots = selectReleaseAgentSkillRoots(skillRoots, capabilityId, hints);
  const skillRoot = agentSkillRoots[0] || "";
  const configuredCapability = capability?.capabilityGoal
    ? capability
    : (RELEASE_WORKFLOW_CONFIG.capabilities?.find((item) => String(item?.id || "") === capabilityId) || capability);
  const intent = buildReleaseCapabilityPlaybook(capabilityId, context, promptInputs, configuredCapability);
  const contextBrief = sanitizePromptValue({
    businessLine: context?.businessLine,
    platform: context?.platform,
    version: context?.version,
    batch: context?.batch,
  });
  // 只保留操作员显式输入；空对象不塞进 prompt。
  const explicitKeys = Object.keys(promptInputs).filter((key) => {
    if (key === "skill_hints" || key === "prompt") return false;
    const value = promptInputs[key];
    return value != null && String(value).trim() !== "";
  });
  const safeInputs = explicitKeys.length
    ? sanitizePromptValue(Object.fromEntries(explicitKeys.map((key) => [key, promptInputs[key]])))
    : null;
  const safeUpstream = sanitizePromptValue(upstreamOutputs);
  const requiredFields = [...new Set([
    ...(Array.isArray(requiredReleaseFields) ? requiredReleaseFields : []),
    ...(Array.isArray(capability?.inputs) ? capability.inputs.filter((input) => input?.required).map((input) => input?.key) : []),
  ]
    .map((field) => String(field || "").trim()).filter(Boolean))];
  // 用户需求点: 固定节点必须无交互执行；缺少 Skill 必填参数时立即返回可操作的 waiting/failed 结果。
  const prompt = [
    "你是发版执行 Agent。遵循 skillRoot 中相关 Skill 的当前 operator-guide，按任务实际执行，不改业务线、平台或版本。",
    `skillRoot: ${skillRoot || "（缺失：返回 failed）"}`,
    context?.repositoryRoot || context?.workspacePath ? `repositoryRoot: ${String(context.repositoryRoot || context.workspacePath)}` : "",
    hints.length ? `Skill: ${hints.join(", ")}` : "",
    `任务: ${intent}`,
    `上下文: ${JSON.stringify(contextBrief)}`,
    safeInputs ? `输入: ${JSON.stringify(safeInputs)}` : "",
    Object.keys(safeUpstream || {}).length ? `上游结果: ${JSON.stringify(safeUpstream)}` : "",
    requiredFields.length ? `必要输入: ${requiredFields.join(", ")}；无法确定时立即返回 failed，并列出 required_inputs。` : "本节点无后续对话；缺少参数或需要确认时立即返回 failed，并列出原因。真实外部异步结果才返回 waiting。",
    '只返回 JSON：{"status":"completed|waiting|failed","summary":"...","steps":[],"records":[],"artifacts":[],"waiting":null,"next_action":""}。',
  ].filter(Boolean).join("\n");
  const MAX_RELEASE_AGENT_PROMPT_CHARS = 12_000;
  if (prompt.length <= MAX_RELEASE_AGENT_PROMPT_CHARS) return prompt;
  return `${prompt.slice(0, MAX_RELEASE_AGENT_PROMPT_CHARS)}\n…[prompt truncated]`;
}

export function confirmationFingerprint(action, context = {}, inputs = {}) {
  const payload = stableJson({
    actionId: action?.id || "",
    compositeId: action?.compositeId || (action?.kind === "composite" ? String(action?.id || "").replace(/^composite:/, "") : ""),
    actionSequence: Array.isArray(action?.actions) ? action.actions.map((item, index) => ({ stepId: item?.stepId || `step-${index + 1}`, id: item?.id || "", order: index })) : [],
    context,
    inputs,
  });
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

export function wrapperScript(skillName, actionName, scriptPath, skillRoot) {
  const python = [
    "import json, os, re, subprocess, sys",
    "input_values = json.loads(os.environ.get('AGENTFLOW_INPUTS_JSON', '{}'))",
    `skill = ${JSON.stringify(String(skillName || ""))}`,
    `action = ${JSON.stringify(String(actionName || ""))}`,
    `repository_root = ${JSON.stringify(String(skillRoot || ""))}`,
    `args = ['run', 'python', ${JSON.stringify(String(scriptPath || ""))}, '--action', action]`,
    "if skill == 'release-notification' and os.environ.get('AGENTFLOW_RELEASE_TEST_MODE') == '1':\n    input_values['message_style'] = 'debug'\n    if action == 'send-custom-notification': input_values['bot'] = 'debug'\n    else: input_values['target'] = 'debug'",
    "fingerprint = input_values.pop('__release_confirmation_fingerprint', '')",
    "if fingerprint: args.extend(['--confirmation-fingerprint', str(fingerprint)])",
    "if skill == 'release-google-play':\n    if 'config' in input_values: args.extend(['--config', str(input_values['config'])])\n    if 'package_name' in input_values: args.extend(['--package-name', str(input_values['package_name'])])\n    if action == 'submit-aab-internal-testing': args.append('--live')\nelse:\n    args.extend(sum(([\"--input\", f\"{key}={value}\"] for key, value in input_values.items()), []))",
    "completed = subprocess.run(['uv', *args], cwd=repository_root or None, capture_output=True, text=True)",
    "if completed.stdout: print(completed.stdout, end='')",
    "if completed.stderr: print(completed.stderr, end='', file=sys.stderr)",
    "if completed.returncode != 0: raise SystemExit(completed.returncode)",
    "if re.search(r'(?m)^status:\\s*(?:preflight_failed|failed|error|cancelled|canceled)\\b', completed.stdout): raise SystemExit(2)",
    "raise SystemExit(0)",
  ].join("\n");
  return [
    "uv run python -c",
    shellQuote(python),
  ].join(" ");
}

function releaseManagementScriptPath(skillRoot) {
  const root = String(skillRoot || "").trim();
  if (!root) return "";
  const candidates = [
    path.join(root, "release-management", "scripts", "run.py"),
    path.join(root, "skills", "release-management", "scripts", "run.py"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

// 用户需求点: 准备活动发版上下文只需 guide → create 两步 CLI，走 Agent 会空转 skillhub/探索目录并易超时。
export function prepareContextWrapperScript(scriptPath, skillRoot) {
  const python = [
    "import json, os, re, subprocess, sys",
    "input_values = json.loads(os.environ.get('AGENTFLOW_INPUTS_JSON', '{}'))",
    "publish_date_lookup_error = str(input_values.pop('publish_date_lookup_error', '') or '').strip()",
    `script_path = ${JSON.stringify(String(scriptPath || ""))}`,
    `skill_root = ${JSON.stringify(String(skillRoot || ""))}`,
    "def action_status(stdout):",
    "    match = re.search(r'(?m)^status:\\s*(\\S+)', stdout or '')",
    "    return match.group(1).lower() if match else ''",
    "def stdout_error(stdout):",
    "    match = re.search(r'(?m)^\\s*error:\\s*(.+?)$', stdout or '')",
    "    return match.group(1).strip() if match else ''",
    "def record_id(stdout):",
    "    match = re.search(r'(?m)^record_id:\\s*(\\S+)', stdout or '')",
    "    return match.group(1).strip() if match and match.group(1).strip().lower() != 'null' else ''",
    "def guidance_reason(stdout):",
    "    match = re.search(r'(?mi)^\\s*(?:reason|guidance_reason):\\s*([a-z0-9_.-]+)', stdout or '')",
    "    return match.group(1).strip().lower() if match else ''",
    "def reported_minor_version(stdout):",
    "    matches = re.findall(r'''(?mi)^\\s*minor_version:\\s*[\\\"']?([0-9]+(?:\\.[0-9]+)+)[\\\"']?\\s*$''', stdout or '')",
    "    return matches[-1].strip() if matches else ''",
    "def required_precondition(stdout):",
    "    return bool(re.search(r'(?mis)precondition:\\s*(?:\\n\\s*)?status:\\s*required\\b', stdout or ''))",
    "def no_active_release(stdout):",
    "    reason = guidance_reason(stdout)",
    "    if reason == 'no_active_release': return True",
    "    return bool(re.search(r'(?i)(?:no active release|missing.*active release|未找到活动发版|尚未建立活动发版)', stdout or ''))",
    "def is_success(stdout):",
    "    return action_status(stdout) in ('succeeded', 'skipped', 'completed', 'already_current') and not required_precondition(stdout)",
    "def needs_create(stdout):",
    "    return no_active_release(stdout)",
    "def run_action(action, values):",
    "    args = ['uv', 'run', 'python', script_path, '--action', action]",
    "    args.extend([item for key, value in values.items() if value not in (None, '') for item in ('--input', f'{key}={value}')])",
    "    completed = subprocess.run(args, cwd=skill_root or None, capture_output=True, text=True)",
    "    return completed",
    "def emit(payload):",
    "    print(json.dumps(payload, ensure_ascii=False))",
    "    raise SystemExit(0)",
    "product = str(input_values.get('product') or 'likee').strip().lower() or 'likee'",
    "platform = str(input_values.get('platform') or 'android').strip().lower() or 'android'",
    "minor_version = str(input_values.get('minor_version') or '').strip()",
    "major_version = str(input_values.get('major_version') or '').strip()",
    "batch = str(input_values.get('batch') or 'initial').strip().lower() or 'initial'",
    "publish_date = str(input_values.get('publish_date') or '').strip()",
    "if not script_path or not os.path.exists(script_path):",
    "    emit({'status': 'failed', 'summary': '缺少 release-management 执行脚本', 'steps': [], 'records': [], 'artifacts': [], 'waiting': None, 'next_action': ''})",
    "guide_inputs = {'product': product, 'platform': platform, 'minor_version': minor_version}",
    "guide = run_action('guide-current-release', guide_inputs)",
    "guide_out = (guide.stdout or '') + ('\\n' + guide.stderr if guide.stderr else '')",
    "if guide.returncode != 0 and not guide.stdout:",
    "    emit({'status': 'failed', 'summary': stdout_error(guide_out) or 'guide-current-release 执行失败', 'steps': [{'action': 'guide-current-release', 'status': 'failed'}], 'records': [], 'artifacts': [], 'waiting': None, 'next_action': ''})",
    "if is_success(guide_out) and minor_version and reported_minor_version(guide_out) and reported_minor_version(guide_out) != minor_version:",
    "    emit({'status': 'failed', 'summary': f'活动发版版本不匹配：请求 {minor_version}，Skill 返回 {reported_minor_version(guide_out)}', 'steps': [{'action': 'guide-current-release', 'status': 'failed'}], 'records': [], 'artifacts': [], 'waiting': None, 'next_action': ''})",
    "if is_success(guide_out) and minor_version and reported_minor_version(guide_out) == minor_version:",
    "    rec = record_id(guide_out)",
    "    emit({'status': 'completed', 'summary': '活动发版上下文已就绪', 'steps': [{'action': 'guide-current-release', 'status': 'completed'}], 'records': ([{'record_id': rec}] if rec else []), 'artifacts': [], 'waiting': None, 'next_action': 'continue'})",
    "if is_success(guide_out) and not minor_version and not needs_create(guide_out):",
    "    rec = record_id(guide_out)",
    "    emit({'status': 'completed', 'summary': '活动发版上下文已就绪', 'steps': [{'action': 'guide-current-release', 'status': 'completed'}], 'records': ([{'record_id': rec}] if rec else []), 'artifacts': [], 'waiting': None, 'next_action': 'continue'})",
    "if is_success(guide_out) and minor_version and not reported_minor_version(guide_out):",
    "    rec = record_id(guide_out)",
    "    emit({'status': 'completed', 'summary': '活动发版上下文已就绪', 'steps': [{'action': 'guide-current-release', 'status': 'completed'}], 'records': ([{'record_id': rec}] if rec else []), 'artifacts': [], 'waiting': None, 'next_action': 'continue'})",
    "if needs_create(guide_out) and not publish_date:",
    "    emit({'status': 'waiting', 'summary': publish_date_lookup_error or '请填写发布日期 (publish_date) 后重试', 'steps': [{'action': 'guide-current-release', 'status': 'waiting'}], 'records': [], 'artifacts': [], 'waiting': {'reason': 'publish_date_required', 'required_inputs': ['publish_date']}, 'next_action': 'fill_publish_date'})",
    "if not needs_create(guide_out):",
    "    emit({'status': 'failed', 'summary': stdout_error(guide_out) or guidance_reason(guide_out) or 'guide-current-release 执行失败', 'steps': [{'action': 'guide-current-release', 'status': 'failed'}], 'records': [], 'artifacts': [], 'waiting': None, 'next_action': ''})",
    "create_inputs = {'product': product, 'platform': platform, 'major_version': major_version, 'publish_date': publish_date}",
    "create = run_action('create-active-release', create_inputs)",
    "create_out = (create.stdout or '') + ('\\n' + create.stderr if create.stderr else '')",
    "if create.returncode != 0 and not create.stdout:",
    "    emit({'status': 'failed', 'summary': stdout_error(create_out) or 'create-active-release 执行失败', 'steps': [{'action': 'guide-current-release', 'status': 'completed'}, {'action': 'create-active-release', 'status': 'failed'}], 'records': [], 'artifacts': [], 'waiting': None, 'next_action': ''})",
    "if is_success(create_out) and not required_precondition(create_out):",
    "    rec = record_id(create_out)",
    "    emit({'status': 'completed', 'summary': '活动发版上下文已创建', 'steps': [{'action': 'guide-current-release', 'status': 'completed'}, {'action': 'create-active-release', 'status': 'completed'}], 'records': ([{'record_id': rec}] if rec else []), 'artifacts': [], 'waiting': None, 'next_action': 'continue'})",
    "if needs_create(create_out) and not publish_date:",
    "    emit({'status': 'waiting', 'summary': publish_date_lookup_error or '请填写发布日期 (publish_date) 后重试', 'steps': [{'action': 'create-active-release', 'status': 'waiting'}], 'records': [], 'artifacts': [], 'waiting': {'reason': 'publish_date_required', 'required_inputs': ['publish_date']}, 'next_action': 'fill_publish_date'})",
    "emit({'status': 'failed', 'summary': stdout_error(create_out) or stdout_error(guide_out) or '准备活动发版上下文失败', 'steps': [{'action': 'create-active-release', 'status': 'failed'}], 'records': [], 'artifacts': [], 'waiting': None, 'next_action': ''})",
  ].join("\n");
  return [
    "uv run python -c",
    shellQuote(python),
  ].join(" ");
}

const PREPARE_CONTEXT_NODE_ID = "release-initialization:prepare-context";

function parsePrepareContextFastPathOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text.split("\n").filter(Boolean).pop() || text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 用户需求点: 初始化完成后在读取状态时自动执行 guide-current-release，避免单独的「准备活动发版上下文」冗余卡片。 */
function releaseTapdConfigForContext(context = {}) {
  const deployment = readReleaseDeploymentConfigWithDataRoot();
  const businessLine = String(context?.businessLine || "").trim().toLowerCase();
  const platform = String(context?.platform || "").trim().toLowerCase() === "iphone"
    ? "ios"
    : String(context?.platform || "").trim().toLowerCase();
  return deployment.projects.find((entry) => (
    String(entry.businessLine || "").trim().toLowerCase() === businessLine
    && String(entry.platform || "").trim().toLowerCase() === platform
  ))?.tapd || {};
}

function prepareContextFastPathRun(command, executionInputs, env) {
  const runResult = spawnSync("sh", ["-c", command], { env: { ...env, AGENTFLOW_INPUTS_JSON: JSON.stringify(executionInputs) }, encoding: "utf8", timeout: 120_000 });
  return {
    process: runResult,
    payload: parsePrepareContextFastPathOutput(runResult.stdout || runResult.stderr),
  };
}

/**
 * 用户需求点: 将业务线、平台和版本映射到 TAPD 迭代，确定性补齐首次发版日期；失败时只返回可人工补充的提示，不启动 Agent。
 */
export function resolvePrepareContextInputs(context = {}, inputs = {}, options = {}) {
  const executionInputs = releaseExecutionInputs({ id: PREPARE_CONTEXT_NODE_ID, skill: "release-management" }, context, inputs);
  if (String(executionInputs.publish_date || "").trim()) return { inputs: executionInputs, tapdError: "" };
  const tapdConfig = options.tapdConfig === undefined ? releaseTapdConfigForContext(context) : (options.tapdConfig || {});
  const workspaceId = String(tapdConfig.workspaceId || tapdConfig.workspace_id || "").trim();
  if (!workspaceId) {
    return { inputs: { ...executionInputs, publish_date_lookup_error: "未配置 TAPD workspaceId，无法自动确定首次发版日期" }, tapdError: "未配置 TAPD workspaceId，无法自动确定首次发版日期" };
  }
  try {
    const fetchIterationsSync = typeof options.fetchIterationsSync === "function"
      ? options.fetchIterationsSync
      : defaultFetchIterationsSync;
    const iterations = fetchIterationsSync({
      workspaceId,
      categoryId: tapdConfig.categoryId || tapdConfig.category_id || "",
      iterationName: tapdConfig.iterationName || tapdConfig.iteration_name || "",
      apiBaseUrl: tapdConfig.apiBaseUrl || tapdConfig.api_base_url,
      accessTokenEnv: tapdConfig.accessTokenEnv || tapdConfig.access_token_env,
      accessToken: tapdConfig.accessToken || tapdConfig.access_token,
    });
    const matched = findTapdIterationForVersion(iterations, context.version || executionInputs.minor_version);
    if (matched?.releaseDate) return { inputs: { ...executionInputs, publish_date: matched.releaseDate }, tapdError: "" };
    const tapdError = `TAPD 未找到版本 ${String(context.version || executionInputs.minor_version || "").trim()} 对应迭代，请填写 publish_date 后重试`;
    return { inputs: { ...executionInputs, publish_date_lookup_error: tapdError }, tapdError };
  } catch (error) {
    const tapdError = String(error?.message || error || "TAPD 迭代查询失败").trim();
    return { inputs: { ...executionInputs, publish_date_lookup_error: tapdError }, tapdError };
  }
}

/** 用户需求点: 准备上下文优先用 TAPD 迭代结束日期补齐首次发版日期；仅在无法自动确定时要求人工输入。 */
export function runPrepareContextFastPath(context = {}, inputs = {}, skillRoots = [], options = {}) {
  const compositeId = PREPARE_CONTEXT_NODE_ID;
  const roots = selectReleaseAgentSkillRoots(skillRoots, compositeId);
  const skillRoot = roots[0] || "";
  const scriptPath = releaseManagementScriptPath(skillRoot);
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    return { ok: false, status: "failed", summary: "缺少 release-management 执行脚本" };
  }
  const initialInputs = releaseExecutionInputs({ id: compositeId, skill: "release-management" }, context, inputs);
  const env = { ...process.env };
  const command = prepareContextWrapperScript(scriptPath, skillRoot);
  let executionInputs = initialInputs;
  let { process: result, payload } = prepareContextFastPathRun(command, executionInputs, env);
  if (!payload) {
    return { ok: false, status: "failed", summary: String(result.stderr || result.stdout || "准备活动发版上下文失败").trim().slice(0, 500) };
  }
  const waitingForPublishDate = String(payload.status || "").toLowerCase() === "waiting"
    && String(payload.waiting?.reason || "").toLowerCase() === "publish_date_required"
    && !String(executionInputs.publish_date || "").trim();
  if (waitingForPublishDate) {
    const resolved = resolvePrepareContextInputs(context, executionInputs, options);
    executionInputs = resolved.inputs;
    if (String(executionInputs.publish_date || "").trim()) {
      ({ process: result, payload } = prepareContextFastPathRun(command, executionInputs, env));
    }
    const tapdError = resolved.tapdError;
    if (tapdError && String(payload.status || "").toLowerCase() === "waiting") {
      payload = {
        ...payload,
        summary: tapdError,
        waiting: {
          ...(payload.waiting && typeof payload.waiting === "object" ? payload.waiting : {}),
          reason: "publish_date_required",
          required_inputs: ["publish_date"],
          source: "tapd",
        },
        next_action: "fill_publish_date",
      };
    }
  }
  return { ok: true, ...payload, contextInputs: { ...executionInputs } };
}

/** 用户需求点: 初始化节点一次性完成活动发版上下文，不再生成独立的 prepare-context 时间线节点。 */
export function bootstrapReleasePrepareContext(stateInput = {}, context = {}, skillRoots = []) {
  const state = stateInput && typeof stateInput === "object" ? { ...stateInput } : {};
  const timeline = Array.isArray(state.timeline) ? [...state.timeline] : [];
  const initializationIndex = timeline.findIndex((item) => item?.nodeId === "release-initialization");
  const initialization = initializationIndex >= 0 ? timeline[initializationIndex] : null;
  const initialized = Boolean(initialization);
  if (!initialized) return { state, changed: false };
  const batch = String(context?.batch || state.context?.batch || initialization.contextSnapshot?.batch || "initial").trim().toLowerCase() || "initial";
  if (batch === "supplemental") {
    // 用户需求点: 补包上下文必须由开始补包节点触发，首次读取页面时不能隐式执行或创建活动发版。
    // 统一大版本时间线已经有首包初始化时，该初始化节点继续作为整条时间线的根，不应被补包读取改写为 deferred。
    const initializationBatch = String(initialization.contextSnapshot?.batch || "").trim().toLowerCase();
    if (initializationBatch === "initial" || String(initialization.contextPreparationStatus || "").toLowerCase() === "completed") {
      return { state, changed: false };
    }
    if (String(initialization.contextPreparationStatus || "").toLowerCase() === "deferred") return { state, changed: false };
    const deferredInitialization = {
      ...initialization,
      contextPreparationStatus: "deferred",
      summary: initialization.summary || "补包上下文将在开始补包节点中准备",
      updatedAt: Date.now(),
    };
    const deferredTimeline = [...timeline];
    deferredTimeline[initializationIndex] = deferredInitialization;
    return {
      changed: true,
      state: {
        ...state,
        initialization: { ...(state.initialization || {}), status: "completed", contextPreparationStatus: "deferred" },
        timeline: deferredTimeline,
      },
    };
  }
  if (["completed", "waiting", "failed"].includes(String(initialization.contextPreparationStatus || "").toLowerCase())) return { state, changed: false };
  if (timeline.some((item) => item?.nodeId && item.nodeId !== "release-initialization" && !String(item.nodeId).startsWith("release-initialization:"))) {
    return { state, changed: false };
  }
  const result = runPrepareContextFastPath(context, {}, skillRoots);
  const now = Date.now();
  const nextTimeline = [...timeline];
  const current = { ...initialization };
  const details = {
    ...(result.steps ? { steps: result.steps } : {}),
    ...(result.records ? { records: result.records } : {}),
    ...(result.artifacts ? { artifacts: result.artifacts } : {}),
    ...(result.waiting ? { waiting: result.waiting } : {}),
    ...(result.summary ? { summary: result.summary } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
  if (result.ok && String(result.status || "").toLowerCase() === "waiting") {
    current.status = "waiting";
    current.progress = 0;
    current.contextPreparationStatus = "waiting";
    current.summary = result.summary || "请填写发布日期 (publish_date) 后重试";
    current.details = details;
    current.updatedAt = now;
    nextTimeline[initializationIndex] = current;
    return {
      changed: true,
      state: {
        ...state,
        initialization: { status: "waiting", contextPreparationStatus: "waiting" },
        timeline: nextTimeline,
        pending: (Array.isArray(state.pending) ? state.pending : []).filter((item) => item?.nodeId !== PREPARE_CONTEXT_NODE_ID),
      },
    };
  }
  if (result.ok && ["completed", "succeeded", "skipped"].includes(String(result.status || "").toLowerCase())) {
    current.status = "completed";
    current.progress = 100;
    current.contextPreparationStatus = "completed";
    current.summary = result.summary || "活动发版上下文已就绪";
    current.details = details;
    current.updatedAt = now;
    current.completedAt = current.completedAt || now;
    current.inputs = { ...(current.inputs || {}), ...(result.contextInputs || {}) };
    current.contextSnapshot = { ...(current.contextSnapshot || {}), ...(result.contextInputs || {}) };
    nextTimeline[initializationIndex] = current;
    return {
      changed: true,
      state: {
        ...state,
        initialization: { status: "completed", contextPreparationStatus: "completed" },
        pending: (Array.isArray(state.pending) ? state.pending : []).filter((item) => item?.nodeId !== PREPARE_CONTEXT_NODE_ID),
        timeline: nextTimeline,
      },
    };
  }
  current.status = "failed";
  current.progress = 0;
  current.contextPreparationStatus = "failed";
  current.summary = result.summary || "准备活动发版上下文失败";
  current.details = details;
  current.updatedAt = now;
  nextTimeline[initializationIndex] = current;
  return {
    changed: true,
    state: {
      ...state,
      initialization: { status: "failed", contextPreparationStatus: "failed" },
      pending: (Array.isArray(state.pending) ? state.pending : []).filter((item) => item?.nodeId !== PREPARE_CONTEXT_NODE_ID),
      timeline: nextTimeline,
    },
  };
}

export function buildPrepareContextReleaseRunGraph(composite, context = {}, inputs = {}, options = {}) {
  const compositeId = String(composite?.id || composite?.compositeId || "release-initialization:prepare-context").trim();
  const skillRoots = selectReleaseAgentSkillRoots(options.skillRoots || context.skillRoots || (context.skillRoot ? [context.skillRoot] : []), compositeId);
  const skillRoot = skillRoots[0] || "";
  const scriptPath = releaseManagementScriptPath(skillRoot);
  const resolvedInputs = resolvePrepareContextInputs(context, inputs, options);
  const executionInputs = resolvedInputs.inputs;
  const inputSlots = Object.entries(executionInputs)
    .filter(([name]) => String(name || "").trim() && !String(name).startsWith("__"))
    .map(([name, value]) => ({ type: "text", name: String(name), value: String(value ?? ""), showOnNode: false }));
  return {
    version: 1,
    meta: {
      releaseCompositeId: compositeId,
      compositeId,
      context: { ...context },
      inputs: { ...executionInputs },
      agentDriven: false,
      prepareContextFastPath: true,
      skillRoots,
    },
    instances: {
      release_agent: {
        definitionId: "tool_nodejs",
        label: composite.title || compositeId,
        script: prepareContextWrapperScript(scriptPath, skillRoot),
        input: [{ type: "node", name: "prev", value: "" }, ...inputSlots],
        output: [
          { type: "node", name: "next", value: "" },
          { type: "text", name: "result", value: "" },
        ],
        releaseAgent: { capabilityId: compositeId, skillHints: ["release-management"] },
      },
    },
    edges: [],
    ui: { nodePositions: { release_agent: { x: 120, y: 100 } } },
  };
}

export function buildReleaseRunGraph(action, context = {}, inputs = {}) {
  if (!action?.id || !action?.source?.scriptPath) throw new Error("A discovered release action is required");
  const inputSlots = Object.entries(inputs && typeof inputs === "object" ? inputs : {})
    .filter(([name]) => String(name || "").trim())
    .map(([name, value]) => ({ type: "text", name: String(name), value: String(value ?? ""), showOnNode: false }));
  return {
    version: 1,
    meta: {
      releaseActionId: action.id,
      context: { ...context },
      inputs: { ...inputs },
    },
    instances: {
      release_action: {
        definitionId: "tool_nodejs",
        label: action.title || action.action || action.id,
        script: wrapperScript(action.skill, action.action, action.source.scriptPath, action.source.skillRoot),
        input: [{ type: "node", name: "prev", value: "" }, ...inputSlots],
        output: [{ type: "node", name: "next", value: "" }],
      },
    },
    edges: [],
    ui: { nodePositions: { release_action: { x: 120, y: 100 } } },
  };
}

function buildLegacyCompositeReleaseRunGraph(composite, atomicNodes = [], context = {}, inputs = {}) {
  if (!composite?.id || !Array.isArray(composite.actions) || composite.actions.length === 0) {
    throw new Error("A configured composite release workflow is required");
  }
  const compositeIdentity = String(composite.compositeId || composite.id || "").replace(/^composite:/, "");
  const atomicById = new Map((Array.isArray(atomicNodes) ? atomicNodes : []).filter((node) => node?.id).map((node) => [String(node.id), node]));
  const stepAliases = new Map();
  const entries = composite.actions.flatMap((entry, index) => {
    const id = String(entry?.id || entry?.actionId || "").trim();
    const atomic = atomicById.get(id) || (entry?.source?.scriptPath ? entry : null);
    if (!atomic?.source?.scriptPath) throw new Error(`Composite Action not available: ${id}`);
    const baseStepId = String(entry.stepId || `step-${index + 1}`);
    if (composite.expandSourceFiles === true && id === "release-localization:upload-source-file") {
      const sourceFiles = Array.isArray(atomic.sourceFiles) ? atomic.sourceFiles.map((value) => String(value || "").trim()).filter(Boolean) : [];
      if (sourceFiles.length > 0) {
        const expanded = sourceFiles.map((sourcePath, sourceIndex) => ({
          ...entry,
          id,
          stepId: `${baseStepId}_${sourceIndex + 1}`,
          inputs: { ...(entry.inputs && typeof entry.inputs === "object" ? entry.inputs : {}), source_path: sourcePath },
          sourcePath,
          atomic,
          order: index + sourceIndex,
        }));
        stepAliases.set(baseStepId, expanded[expanded.length - 1].stepId);
        return expanded;
      }
    }
    return [{ ...entry, id, stepId: baseStepId, atomic, order: index }];
  });
  const aliases = { ...(RELEASE_WORKFLOW_CONFIG.statusAliases || {}), ...(composite.statusAliases || {}) };
  const resolveStepId = (stepId) => stepAliases.get(String(stepId || "").trim()) || String(stepId || "").trim();
  const outputNamesByStep = new Map(entries.map((entry) => [entry.stepId, new Set(["result"])]));
  for (const entry of entries) {
    for (const mapping of Object.values(entry.inputs && typeof entry.inputs === "object" ? entry.inputs : {})) {
      if (!mapping || typeof mapping !== "object") continue;
      const fromStep = resolveStepId(mapping.fromStep);
      const output = String(mapping.output || "").trim();
      if (fromStep && outputNamesByStep.has(fromStep) && output) outputNamesByStep.get(fromStep).add(output);
    }
  }
  const instances = {};
  const positions = {};
  for (const entry of entries) {
    const nodeId = `composite_${entry.stepId}`;
    const mappedInputs = entry.inputs && typeof entry.inputs === "object" ? Object.fromEntries(Object.entries(entry.inputs).map(([name, mapping]) => [
      name,
      mapping && typeof mapping === "object" && mapping.fromStep
        ? { ...mapping, fromStep: resolveStepId(mapping.fromStep) }
        : mapping,
    ])) : {};
    const stepExecutionInputs = releaseExecutionInputs(entry.atomic, context, inputs);
    const inputNames = new Set([
      ...((Array.isArray(entry.atomic.inputSchema) ? entry.atomic.inputSchema : []).map((item) => String(item?.key || item?.name || "").trim()).filter(Boolean)),
      ...Object.keys(mappedInputs).map((name) => String(name || "").trim()).filter(Boolean),
      ...Object.keys(stepExecutionInputs).filter((name) => !String(name).startsWith("__")),
      ...(Object.prototype.hasOwnProperty.call(stepExecutionInputs, "__release_confirmation_fingerprint") ? ["__release_confirmation_fingerprint"] : []),
    ]);
    const input = [{ type: "node", name: "prev", value: "" }];
    for (const name of inputNames) {
      const mapping = mappedInputs[name];
      let value = "";
      if (mapping && typeof mapping === "object") {
        const contextKey = String(mapping.context || "").trim();
        if (contextKey) value = inputs?.[contextKey] ?? context?.[contextKey] ?? "";
      } else if (mapping != null) value = mapping;
      if (!value && Object.prototype.hasOwnProperty.call(stepExecutionInputs || {}, name)) value = stepExecutionInputs[name];
      input.push({ type: "text", name, value: String(value ?? ""), showOnNode: false });
    }
    const output = [{ type: "node", name: "next", value: "" }, ...[...outputNamesByStep.get(entry.stepId)].map((name) => ({ type: "text", name, value: "" }))];
    instances[nodeId] = {
      definitionId: "tool_nodejs",
      label: entry.atomic.title || entry.id,
      script: wrapperScript(entry.atomic.skill, entry.atomic.action, entry.atomic.source.scriptPath, entry.atomic.source.skillRoot),
      input,
      output,
      compositeStep: {
        compositeId: compositeIdentity,
        stepId: entry.stepId,
        actionId: entry.id,
        order: entry.order,
        continueOn: (entry.continueOn || []).map((status) => normalizeCompositeStatus(status, aliases)),
        waitFor: entry.waitFor ? { ...entry.waitFor, step: resolveStepId(entry.waitFor.step), statuses: (entry.waitFor.statuses || []).map((status) => normalizeCompositeStatus(status, aliases)) } : null,
        forEach: entry.forEach ? { ...entry.forEach } : null,
        requiresConfirmation: entry.requiresConfirmation === true || entry.atomic.requiresConfirmation === true,
        inputMappings: { ...mappedInputs },
        statusAliases: { ...aliases },
      },
    };
    positions[nodeId] = { x: 120 + entry.order * 360, y: 100 };
  }
  const edges = [];
  const outputIndex = (nodeId, name) => (instances[nodeId].output || []).findIndex((slot) => String(slot?.name || "") === name);
  const inputIndex = (nodeId, name) => (instances[nodeId].input || []).findIndex((slot) => String(slot?.name || "") === name);
  for (let index = 1; index < entries.length; index += 1) {
    const previous = `composite_${entries[index - 1].stepId}`;
    const current = `composite_${entries[index].stepId}`;
    edges.push({ source: previous, sourceHandle: "next", target: current, targetHandle: "prev" });
  }
  for (const entry of entries) {
    const targetId = `composite_${entry.stepId}`;
    for (const [name, mapping] of Object.entries(entry.inputs && typeof entry.inputs === "object" ? entry.inputs : {})) {
      if (!mapping || typeof mapping !== "object") continue;
      const fromStep = resolveStepId(mapping.fromStep);
      if (!fromStep) continue;
      const sourceId = `composite_${fromStep}`;
      if (!instances[sourceId]) throw new Error(`Composite input references unknown step: ${fromStep}`);
      const sourceOutput = String(mapping.output || "result").trim() || "result";
      const sourceSlotIndex = outputIndex(sourceId, sourceOutput);
      const targetSlotIndex = inputIndex(targetId, name);
      if (sourceSlotIndex < 0 || targetSlotIndex < 0) continue;
      edges.push({ source: sourceId, sourceHandle: sourceOutput, target: targetId, targetHandle: name });
    }
  }
  return {
    version: 1,
    meta: {
      releaseCompositeId: compositeIdentity,
      compositeId: compositeIdentity,
      compositeActionIds: [...new Set(entries.map((entry) => entry.id))],
      context: { ...context },
      inputs: { ...inputs },
      statusAliases: { ...aliases },
    },
    instances,
    edges,
    ui: { nodePositions: positions },
  };
}

// 复合能力只物化一个 Agent，由 AgentFlow Agent 读取最新 release-* Skill 并组合执行。
export function buildCompositeReleaseRunGraph(composite, atomicNodes = [], context = {}, inputs = {}, options = {}) {
  if (composite?.promptTemplate || composite?.capabilityGoal || !Array.isArray(composite?.actions)) {
    if (!composite?.id) throw new Error("A configured composite release workflow is required");
    const compositeId = String(composite?.id || composite?.compositeId || "").trim();
    if (compositeId === "release-initialization:prepare-context") {
      return buildPrepareContextReleaseRunGraph(composite, context, inputs, options);
    }
    const effectiveInputs = inputs && typeof inputs === "object" && !Array.isArray(inputs) ? { ...inputs } : {};
    if (compositeId.includes("localization-upload-notify")) delete effectiveInputs.source_path;
    // 审核单/全量：申请人固定为 AgentFlow 平台用户名（OA 拼音），每次注入覆盖。
    if (/submit-approval|full-rollout/.test(compositeId)) {
      const operator = resolveReleaseApprovalOperator(effectiveInputs.operator, context?.operator, options.operator);
      if (operator) effectiveInputs.operator = operator;
      else delete effectiveInputs.operator;
    }
    const skillRoots = options.skillRoots || context.skillRoots || (context.skillRoot ? [context.skillRoot] : []);
    const agentSkillRoots = selectReleaseAgentSkillRoots(skillRoots, compositeId, composite.skillHints || []);
    const previousResult = options.previousResult || context.previousResult || null;
    const requiredReleaseFields = [...new Set((Array.isArray(atomicNodes) ? atomicNodes : [])
      .filter((node) => !composite.skillHints?.length || composite.skillHints.includes(node.skill))
      .flatMap((node) => Array.isArray(node.requiredReleaseFields) ? node.requiredReleaseFields : [])
      .map((field) => String(field || "").trim()).filter(Boolean))];
    const body = buildReleaseAgentPrompt({ capability: composite, context, inputs: effectiveInputs, skillRoots: agentSkillRoots, upstreamOutputs: options.upstreamOutputs || {}, previousResult, requiredReleaseFields });
    return {
      version: 1,
      meta: {
        releaseCompositeId: String(composite.compositeId || composite.id).replace(/^composite:/, ""),
        compositeId: String(composite.compositeId || composite.id).replace(/^composite:/, ""),
        context: { ...context },
        inputs: { ...effectiveInputs },
        agentDriven: true,
        skillRoots: agentSkillRoots,
      },
      instances: {
        release_agent: {
          definitionId: "agent_subAgent",
          label: composite.title || composite.id,
          body,
          input: [
            { type: "node", name: "prev", value: "" },
            { type: "text", name: "skillsContext", value: agentSkillRoots.map((root) => String(root)).join("\n"), showOnNode: false },
            { type: "text", name: "releaseContext", value: JSON.stringify(context || {}), showOnNode: false },
            { type: "text", name: "inputs", value: JSON.stringify(effectiveInputs), showOnNode: false },
          ],
          output: [
            { type: "node", name: "next", value: "" },
            { type: "text", name: "result", value: "" },
          ],
          releaseAgent: { capabilityId: composite.id, skillHints: [...(composite.skillHints || [])] },
        },
      },
      edges: [],
      ui: { nodePositions: { release_agent: { x: 120, y: 100 } } },
    };
  }
  return buildLegacyCompositeReleaseRunGraph(composite, atomicNodes, context, inputs);
}

// 用户需求点: 页面初始化的业务线、平台和版本必须真正传入 release-skill，否则脚本会把一次有效执行误判为缺少上下文的预检。
export function releaseExecutionInputs(action, context = {}, inputs = {}) {
  const skill = String(action?.skill || "").trim().toLowerCase();
  const actionName = String(action?.action || "").trim().toLowerCase();
  const actionId = String(action?.id || "").trim();
  const version = String(context?.version || "").trim();
  const majorVersion = version.split(".").slice(0, 2).join(".");
  const result = { ...(inputs && typeof inputs === "object" ? inputs : {}) };
  result.product = String(context?.businessLine || "likee").trim().toLowerCase() || "likee";
  result.platform = String(context?.platform || "android").trim().toLowerCase() || "android";
  // 所有 release Skill 都显式接收当前批次；补包不能依赖版本后缀的隐式推断。
  if (skill.startsWith("release-")) result.batch = String(context?.batch || "initial").trim().toLowerCase() || "initial";
  if (action?.kind === "composite" || skill === "release-composite") result.minor_version = version;
  if (actionId === "release-initialization:prepare-context") {
    result.minor_version = version;
    result.major_version = majorVersion;
    result.batch = String(context?.batch || "initial").trim().toLowerCase() || "initial";
  }
  if ([
    "release-git", "release-approval", "release-gray-observe", "release-records",
    "release-channel-packages", "release-localization", "release-notification",
    "release-build", "release-google-play", "release-release-notes", "release-metrics",
  ].includes(skill)) {
    result.minor_version = version;
  }
  if (skill === "release-management" && ["create-active-release", "append-release-batch", "register-release-branch", "update-active-release"].includes(actionName)) {
    result.major_version = majorVersion;
  }
  if (skill === "release-management" && actionName === "update-active-release") result.minor_version = version;
  if (skill === "release-metrics" && actionName === "query-version-metrics") result.app_version = version;
  return result;
}

// 用户需求点: release-skill 可能用零退出码返回 preflight_failed，AgentFlow 仍需把它展示为失败并保留重试入口。
export function releaseFailureFromResult(result) {
  const texts = (Array.isArray(result?.events) ? result.events : [])
    .filter((event) => event?.type === "script-finish")
    .map((event) => String(event?.stdout || ""))
    .filter(Boolean);
  const output = texts.join("\n");
  if (!/(?:^|\n)status:\s*(?:preflight_failed|failed|error)\b/m.test(output)) return "";
  const error = output.match(/(?:^|\n)\s*error:\s*(.+?)(?:\n|$)/m);
  return error?.[1]?.trim() || "发版脚本预检失败";
}

// 用户需求点: 发版时间线要展示真实操作耗时，而不是接口返回瞬间写入的 0ms。
export function releaseTimingFromResult(result, fallbackStartedAt = Date.now()) {
  const events = Array.isArray(result?.events) ? result.events : [];
  const finish = [...events].reverse().find((event) => event?.type === "script-finish");
  const start = events.find((event) => event?.type === "script-start" || event?.type === "node-start");
  const durationMs = Number(finish?.durationMs);
  const startedAt = Number(start?.ts);
  const normalizedDuration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : Math.max(0, Date.now() - (Number.isFinite(startedAt) ? startedAt : fallbackStartedAt));
  return {
    startedAt: Number.isFinite(startedAt) ? startedAt : Math.max(0, Date.now() - normalizedDuration),
    completedAt: Date.now(),
    durationMs: normalizedDuration,
  };
}

export async function previewReleaseAction(action, context = {}, inputs = {}, { executePreview, atomicNodes = [], skillRoots = [] } = {}) {
  if (!action?.id) throw new Error("A discovered release action is required");
  const fingerprint = confirmationFingerprint(action, context, inputs);
  const graph = action.kind === "composite"
    ? buildCompositeReleaseRunGraph(action, atomicNodes, context, inputs, { skillRoots: skillRoots.length ? skillRoots : (context.skillRoots || (context.skillRoot ? [context.skillRoot] : [])) })
    : buildReleaseRunGraph(action, context, inputs);
  const preview = typeof executePreview === "function"
    ? await executePreview(graph)
    : { action: action.action, inputs: { ...inputs }, message: "等待执行预览" };
  return { preview, confirmationFingerprint: fingerprint, graph };
}

export async function runReleaseAction(action, context = {}, inputs = {}, options = {}) {
  if (!action?.id) throw new Error("A discovered release action is required");
  const expected = options.confirmationFingerprint;
  if (action.requiresConfirmation && expected !== confirmationFingerprint(action, context, inputs)) {
    const error = new Error("确认指纹已失效，请重新预览");
    error.code = "RELEASE_CONFIRMATION_MISMATCH";
    throw error;
  }
  if (typeof options.runGraph !== "function") {
    return { runId: `release-preview-${Date.now().toString(36)}`, status: "preview", output: null, logs: [] };
  }
  const graph = action.kind === "composite"
    ? buildCompositeReleaseRunGraph(action, options.atomicNodes || [], context, inputs, { skillRoots: options.skillRoots || context.skillRoots || (context.skillRoot ? [context.skillRoot] : []), previousResult: options.previousResult })
    : buildReleaseRunGraph(action, context, inputs);
  return options.runGraph(graph, options);
}

export async function stopReleaseAction(runId, { stopRun } = {}) {
  if (!String(runId || "").trim()) throw new Error("runId is required");
  if (typeof stopRun === "function") return stopRun(runId);
  return { stopped: false, runId };
}
