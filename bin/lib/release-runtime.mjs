import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  RELEASE_WORKFLOW_CONFIG,
  releaseActionProcessMetadata,
  selectReleaseWorkflow,
  workflowActionIds,
  workflowStageNodeIds,
  selectReleaseCompositeWorkflow,
  insertableReleaseCapabilities,
} from "../../shared/release-workflow-config.js";

const DEFAULT_BUSINESS_LINES = ["likee", "bigolive", "hello"];
const DEFAULT_BATCHES = ["initial", "supplemental"];
const ACTION_ORDER = [
  "release-setup",
  "release-management",
  "release-git",
  "release-localization",
  "release-release-notes",
  "release-approval",
  "release-metrics",
  "release-gray-observe",
  "release-records",
  "release-channel-packages",
  "release-google-play",
  "release-notification",
];
const INFERRED_ACTIONS = {
  "release-management": [
    ["create-active-release", ["product", "platform", "major_version", "publish_date"], true],
    ["append-release-batch", ["product", "platform", "major_version", "publish_date"], true],
    ["register-release-branch", ["product", "platform", "major_version", "release_branch"], true],
    ["update-active-release", ["product", "platform", "major_version", "minor_version", "build_number", "batch", "expected_major_version", "publish_date"], true],
  ],
  "release-setup": [
    ["configure-notification-recipient", ["product", "platform"], true],
    ["discover-skills", [], false],
  ],
};

const ACTION_DESCRIPTIONS = Object.freeze({
  "release-setup:configure-notification-recipient": "配置当前发版的默认通知人。",
  "release-setup:discover-skills": "发现当前工程可用的发版 Skill。",
  "release-management:append-release-batch": "为活动发版追加补包批次。",
  "release-management:register-release-branch": "登记当前版本的 release 分支。",
  "release-management:update-active-release": "更新活动发版的版本、构建号和批次信息。",
  "release-git:create-release-branch": "创建或复用当前版本的 release 分支。",
  "release-git:commit-managed-changes": "提交发版范围内受管理的变更。",
  "release-git:merge-release-to-main": "发起并确认 release 分支合入主干。",
  "release-git:merge-release-to-develop": "发起并确认 release 分支合回开发分支。",
  "release-git:enable-mr-auto-merge": "为满足条件的 MR 开启自动合并。",
  "release-localization:upload-source-file": "上传当前版本源多语言文件。",
  "release-localization:prepare-translation-archive": "准备待应用的翻译归档。",
  "release-localization:apply-translations": "将翻译内容应用到当前工程。",
  "release-localization:commit-localization-changes": "提交多语言同步产生的变更。",
  "release-approval:create-initial-release-approval": "创建首包发版审核草稿。",
  "release-approval:create-full-rollout-approval": "创建全量发布审核草稿。",
  "release-metrics:query-version-metrics": "查询当前版本的发布指标。",
  "release-metrics:save-metrics-snapshot": "保存当前版本指标快照。",
  "release-gray-observe:observe-gray-dashboard": "观察灰度看板关键指标。",
  "release-gray-observe:investigate-gray-anomaly": "对灰度异常进行 SQL 下钻分析。",
  "release-records:compose-update-summary": "整理当前版本更新摘要。",
  "release-records:append-release-wiki-row": "将发版信息追加到 Wiki。",
  "release-records:record-store-approved": "登记商店审核通过结果。",
  "release-records:record-full-rollout-time": "登记全量发布时间。",
  "release-channel-packages:plan-channel-packages": "规划本次渠道包清单。",
  "release-channel-packages:trigger-channel-package": "触发单个渠道包构建。",
  "release-channel-packages:trigger-channel-packages-batch": "批量触发渠道包构建。",
  "release-channel-packages:refresh-channel-package-build": "刷新渠道包构建状态。",
  "release-google-play:preview-aab-submission": "预览 AAB 提交参数。",
  "release-google-play:submit-aab-internal-testing": "提交 AAB 到 Internal testing。",
  "release-release-notes:upload-ios-release-notes": "上传 iOS 版本更新说明。",
  "release-notification:send-notification": "发送发版阶段通知。",
  "release-notification:send-rollout-notification": "发送灰度或全量发布通知。",
});

function contextSnapshot({ businessLine = "likee", platform = "android", version = "1.0.0", batch = "initial" } = {}) {
  return {
    businessLine: String(businessLine || "likee").trim().toLowerCase() || "likee",
    platform: String(platform || "android").trim().toLowerCase() || "android",
    version: String(version || "1.0.0").trim() || "1.0.0",
    batch: String(batch || "initial").trim().toLowerCase() || "initial",
  };
}

// 用户需求点: 节点只能在初始化选定的业务、平台、版本和批次范围内运行，因此所有运行请求使用同一稳定范围键。
export function releaseContextKey(context = {}) {
  const snapshot = contextSnapshot(context);
  return [snapshot.businessLine, snapshot.platform, snapshot.version, snapshot.batch].join("/");
}

const RELEASE_SECRET_KEY = /(token|secret|password|passwd|webhook|authorization|cookie|api[-_]?key)/i;
function sanitizeReleaseValue(value, key = "") {
  if (RELEASE_SECRET_KEY.test(String(key || ""))) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => sanitizeReleaseValue(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitizeReleaseValue(item, name)]));
  return value;
}

// Agent 常把整段结果 JSON 与尾随 Markdown 粘在同一字符串；只认「整段都是 JSON」会丢掉 steps/artifacts。
function parseLeadingJsonValue(text) {
  const source = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!source.startsWith("{") && !source.startsWith("[")) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (char === "\\") { escape = true; continue; }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") { inString = true; continue; }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          return { value: JSON.parse(source.slice(0, index + 1)), rest: source.slice(index + 1).trim() };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function mergeNestedReleaseResult(value, nested, trailingText = "") {
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return value;
  if (!(nested.summary || nested.status || nested.artifacts || nested.records || nested.steps || nested.waiting)) return value;
  const trailing = String(trailingText || "").trim();
  const nestedSummary = String(nested.summary || nested.message || "").trim();
  const preferTrailing = trailing && (trailing.includes("**") || /\[[^\]]+\]\(https?:\/\//.test(trailing) || trailing.includes("\n"));
  return {
    ...value,
    ...nested,
    status: nested.status || value.status,
    summary: preferTrailing ? trailing : (nestedSummary || trailing || value.summary),
    steps: Array.isArray(nested.steps) && nested.steps.length ? nested.steps : value.steps,
    records: Array.isArray(nested.records) && nested.records.length ? nested.records : value.records,
    artifacts: Array.isArray(nested.artifacts) && nested.artifacts.length ? nested.artifacts : value.artifacts,
    waiting: nested.waiting !== undefined ? nested.waiting : value.waiting,
    next_action: nested.next_action || value.next_action,
  };
}

export function normalizeReleaseAgentResult(raw) {
  const envelopeStatus = raw && typeof raw === "object" ? raw.status : undefined;
  let value = raw;
  if (raw && typeof raw === "object" && raw.result !== undefined) value = raw.result;
  if (typeof value === "string") {
    const parsed = parseLeadingJsonValue(value);
    if (parsed && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)) {
      value = mergeNestedReleaseResult({ status: "completed" }, parsed.value, parsed.rest);
    } else {
      const text = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      try { value = JSON.parse(text); } catch { value = { status: /\b(fail|error|失败)\b/i.test(text) ? "failed" : "completed", summary: text }; }
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) value = { status: "failed", summary: "Agent 未返回结构化结果" };
  // Agent 偶发把整段 JSON 再次塞进 summary（可能还粘着尾随 Markdown）；拆开以免页面只剩一坨字符串。
  const nestedSummary = String(value.summary || "").trim();
  const nestedParsed = parseLeadingJsonValue(nestedSummary);
  if (nestedParsed?.value) {
    value = mergeNestedReleaseResult(value, nestedParsed.value, nestedParsed.rest);
  }
  const statusValue = String(envelopeStatus || value.status || "").trim().toLowerCase();
  const status = ["completed", "waiting", "failed"].includes(statusValue) ? statusValue : (statusValue ? "failed" : "completed");
  return sanitizeReleaseValue({
    ...value,
    status,
    summary: String(value.summary || value.message || value.error || "").trim(),
    steps: Array.isArray(value.steps) ? value.steps : [],
    records: Array.isArray(value.records) ? value.records : [],
    artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
    ...(value.waiting && typeof value.waiting === "object" ? { waiting: value.waiting } : {}),
    ...(value.next_action ? { next_action: String(value.next_action) } : {}),
  });
}

// AgentFlow runWorkspaceGraph 返回的是 graph/events 包装对象；发版 Agent 的最终 JSON
// 通常位于 release_agent 的 result 文本输出槽，不能只读取顶层 result。
export function releaseAgentResultFromWorkspaceRun(runResult, fallbackContext = {}) {
  if (runResult == null) return null;
  if (runResult?.result !== undefined && runResult?.result !== null && runResult?.result !== "") {
    return normalizeReleaseAgentResult(runResult.result);
  }
  const instances = runResult?.graph?.instances && typeof runResult.graph.instances === "object"
    ? runResult.graph.instances
    : {};
  const agentEntry = instances.release_agent || Object.values(instances).find((instance) => instance?.releaseAgent);
  const output = Array.isArray(agentEntry?.output) ? agentEntry.output : [];
  const resultSlot = output.find((slot) => String(slot?.name || "").trim() === "result");
  const value = resultSlot?.value ?? resultSlot?.default;
  if (value !== undefined && value !== null && String(value).trim() !== "") {
    const rawValue = String(value).trim();
    // agent_subAgent 的持久化输出槽可能只返回相对产物路径（例如
    // outputs/release_agent/result.txt），真正的结构化结果在该文件中。
    // 优先按发版工程根目录解析，避免把路径文本误记为 completed summary。
    const roots = [
      runResult?.graph?.meta?.context?.repositoryRoot,
      runResult?.graph?.meta?.context?.workspacePath,
      runResult?.runtimeRoot,
      fallbackContext?.repositoryRoot,
      fallbackContext?.workspacePath,
    ].map((root) => String(root || "").trim()).filter(Boolean);
    const candidates = [
      path.isAbsolute(rawValue) ? rawValue : "",
      ...roots.map((root) => path.resolve(root, rawValue)),
    ].filter((candidate, index, list) => candidate && list.indexOf(candidate) === index);
    for (const candidate of candidates) {
      try {
        if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
        const content = fs.readFileSync(candidate, "utf8").trim();
        if (content) return normalizeReleaseAgentResult(content);
      } catch {
        // Fall through to the inline value when the artifact is unavailable.
      }
    }
    return normalizeReleaseAgentResult(value);
  }
  return null;
}

export function applyReleaseAgentResult(stateInput, nodeId, rawResult) {
  const state = {
    ...(stateInput && typeof stateInput === "object" ? stateInput : {}),
    timeline: Array.isArray(stateInput?.timeline) ? [...stateInput.timeline] : [],
    pending: Array.isArray(stateInput?.pending) ? [...stateInput.pending] : [],
  };
  const result = normalizeReleaseAgentResult(rawResult);
  const index = state.pending.findIndex((item) => item?.nodeId === nodeId || item?.id === nodeId);
  const current = index >= 0 ? { ...state.pending[index] } : { id: nodeId, nodeId };
  const details = { ...(current.details || {}), steps: result.steps, records: result.records, artifacts: result.artifacts, summary: result.summary };
  if (result.status === "completed" || result.status === "waiting") {
    // waiting = 人工闸说明项，无续跑交互；按成功入时间线，waiting 字段留给 UI 待办。
    const completed = {
      ...current,
      nodeId,
      status: "completed",
      progress: 100,
      details,
      output: result,
      completedAt: Date.now(),
      error: "",
      failedAt: undefined,
      ...(result.status === "waiting"
        ? { waiting: result.waiting || { reason: result.summary || "待人工处理" } }
        : {}),
    };
    state.pending = state.pending.filter((_item, itemIndex) => itemIndex !== index);
    state.timeline = [...state.timeline.filter((item) => item.id !== completed.id && item.nodeId !== nodeId), completed];
    return { state, advance: true, retryable: false, result };
  }
  const pending = {
    ...current,
    nodeId,
    status: result.status,
    progress: 0,
    details,
    ...(result.status === "failed" ? { error: result.summary || "发版 Agent 执行失败", failedAt: Date.now() } : {}),
  };
  if (index >= 0) state.pending[index] = pending; else state.pending.push(pending);
  return { state, advance: false, retryable: result.status === "failed", result };
}

export function createSupplementalBatch(stateInput = {}) {
  const source = stateInput && typeof stateInput === "object" ? stateInput : {};
  const context = { ...(source.context || {}), batch: "supplemental", batchIndex: Number(source.context?.batchIndex ?? source.batchIndex ?? 0) + 1 };
  return {
    context,
    state: {
      ...source,
      context,
      batch: "supplemental",
      batchIndex: context.batchIndex,
      timeline: [],
      pending: [],
      runs: {},
    },
  };
}

function normalizeList(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (value == null || value === "") return [...fallback];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function titleFromAction(actionName) {
  return String(actionName || "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function descriptionFromAction(skillName, actionName, action) {
  const explicit = action?.description || action?.summary || action?.help;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const mapped = ACTION_DESCRIPTIONS[`${skillName}:${actionName}`];
  if (mapped) return mapped;
  return `执行${titleFromAction(actionName)}。`;
}

const ACTION_INPUT_METADATA = Object.freeze({
  "release-git:create-release-branch": Object.freeze([Object.freeze({
    key: "release_branch",
    label: "Release 分支名",
    type: "text",
    required: false,
    placeholder: "release/v1.1",
  })]),
});

function defaultLocalizationSourcePath(context = {}) {
  // 用户需求点: 多语言上传默认使用当前工程内受审源文件，不能把工程根目录当成 source_path。
  return String(context?.platform || "").trim().toLowerCase() === "ios"
    ? "yymeet/Resources/MultiLanguage/en.lproj/Localizable.strings"
    : "iHeima/res/values/strings.xml";
}

// 用户需求点: Create Release Branch 必须允许操作员输入完整分支名，留空时仍沿用 release-skill 的标准命名规则。
function inputDefinitionsForAction(skillName, actionName, declaredInputs, context = {}) {
  const actionKey = `${skillName}:${actionName}`;
  const declared = Array.isArray(declaredInputs) ? declaredInputs : [];
  let definitions = declared
    .map((input) => {
      if (input && typeof input === "object") {
        const key = String(input.key || input.name || "").trim();
        return key ? { ...input, key, label: input.label || key.replace(/[_-]+/g, " "), type: input.type || "text", required: input.required === true } : null;
      }
      const key = String(input || "").trim();
      return key ? { key, label: key.replace(/[_-]+/g, " "), type: "text", required: false } : null;
    })
    .filter(Boolean);
  if (actionKey === "release-localization:upload-source-file") {
    const defaultValue = defaultLocalizationSourcePath(context);
    definitions = definitions.map((definition) => definition.key === "source_path"
      ? { ...definition, ...(definition.defaultValue ? {} : { defaultValue }) }
      : definition);
  }
  const metadata = (ACTION_INPUT_METADATA[actionKey] || []).map((definition) => {
    if (definition.key !== "release_branch") return { ...definition };
    const version = String(context?.version || "").trim();
    const majorVersion = version.split(".").slice(0, 2).join(".");
    return { ...definition, ...(majorVersion ? { defaultValue: `release/v${majorVersion}` } : {}) };
  });
  const grayPercentOverride = actionKey === "release-records:append-release-wiki-row"
    && String(context.platform || "").trim().toLowerCase() === "android"
    && String(context.batch || "initial").trim().toLowerCase() === "supplemental"
    ? [{ key: "gray_percent", label: "灰度百分比 (%)", type: "number", required: true, min: 1, max: 100, integer: true, step: 1, placeholder: "例如 10" }]
    : [];
  const overrides = [...metadata, ...grayPercentOverride];
  if (overrides.length === 0) return definitions;
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
  for (const definition of overrides) byKey.set(definition.key, { ...(byKey.get(definition.key) || {}), ...definition });
  return [...byKey.values()];
}

function categoryForSkill(skillName) {
  if (/setup|management|git/i.test(skillName)) return "发版准备";
  if (/metric|gray/i.test(skillName)) return "指标检查";
  if (/approval|records|channel|release-notes|google-play/i.test(skillName)) return "版本发布";
  if (/notification/i.test(skillName)) return "协作通知";
  if (/localization/i.test(skillName)) return "多语言";
  return "发版阶段";
}

function readFrontmatter(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const parsed = yaml.load(match[1]);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function readYamlObject(filePath) {
  const parsed = yaml.load(fs.readFileSync(filePath, "utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function reviewedLocalizationSourceFiles(skillRoot, context = {}) {
  const skillDir = path.join(path.resolve(skillRoot), "release-localization");
  const runtimePath = path.join(skillDir, ".runtime.yaml");
  let useTestProject = false;
  try {
    const runtime = fs.existsSync(runtimePath) ? readYamlObject(runtimePath) : {};
    useTestProject = runtime?.crowdin?.use_test_project === true;
  } catch {
    useTestProject = false;
  }
  const profileName = `${String(context.businessLine || "likee").trim().toLowerCase()}-${String(context.platform || "android").trim().toLowerCase()}.${useTestProject ? "test" : "production"}.yaml`;
  const profilePath = path.join(skillDir, "presets", profileName);
  try {
    const profile = readYamlObject(profilePath);
    return [...new Set((Array.isArray(profile.source_files) ? profile.source_files : [])
      .map((entry) => String(entry?.source_path || "").trim())
      .filter(Boolean))];
  } catch {
    return [];
  }
}

function actionDefinition({ skillRoot, skillPath, skillName, skillMeta, action, context, profileIds = [] }) {
  const actionName = String(action?.name || "").trim();
  const actionKey = `${skillName}:${actionName}`;
  const processMetadata = releaseActionProcessMetadata(actionKey, {
    id: actionKey,
    skill: skillName,
    processId: action?.process_id || action?.processId || action?.process?.id || action?.workflow_process_id || action?.stage_id,
    processOrder: action?.process_order ?? action?.processOrder ?? action?.process?.order ?? action?.workflow_process_order ?? action?.stage_order,
    processTitle: action?.process_title || action?.processTitle || action?.process?.title,
  }, RELEASE_WORKFLOW_CONFIG, context);
  const skillDir = path.dirname(skillPath);
  const scriptCandidates = [
    path.join(skillDir, "scripts", "run.py"),
    path.join(skillDir, "scripts", `${skillName.replace(/^release-/, "")}.py`),
  ];
  const scriptPath = scriptCandidates.find((candidate) => fs.existsSync(candidate)) || scriptCandidates[0];
  const releaseContext = action?.release_context && typeof action.release_context === "object" ? action.release_context : {};
  const inputs = inputDefinitionsForAction(skillName, actionName, action?.inputs, context);
  return {
    id: `${skillName}:${actionName}`,
    title: titleFromAction(actionName),
    description: descriptionFromAction(skillName, actionName, action),
    skill: skillName,
    action: actionName,
    category: categoryForSkill(skillName),
    businessLines: profileIds.length > 0 ? [context.businessLine] : [...DEFAULT_BUSINESS_LINES],
    platforms: normalizeList(action?.platforms, ["ios", "android"]).map((item) => item.toLowerCase()),
    allowedBatches: normalizeList(releaseContext.allowed_batches, DEFAULT_BATCHES),
    requiresConfirmation: action?.requires_confirmation === true,
    acceptsCurrentRelease: skillMeta.accepts_current_release !== false,
    inputSchema: inputs,
    ...(actionKey === "release-localization:upload-source-file"
      ? { sourceFiles: reviewedLocalizationSourceFiles(skillRoot, context) }
      : {}),
    nextNodeIds: [],
    processId: processMetadata.processId,
    processOrder: processMetadata.processOrder,
    processTitle: processMetadata.processTitle,
    profileIds: [...profileIds],
    contextSnapshot: { ...context },
    scopeKey: releaseContextKey(context),
    runnable: fs.existsSync(scriptPath),
    error: fs.existsSync(scriptPath) ? "" : `缺少执行脚本：${path.relative(skillRoot, scriptPath)}`,
    source: {
      skillRoot,
      skillPath,
      scriptPath,
    },
  };
}

export function releaseActionId(skillName, actionName) {
  return `${String(skillName || "").trim()}:${String(actionName || "").trim()}`;
}

export function readReleaseAction(skillRoot, skillName, actionName) {
  const skillPath = path.join(path.resolve(skillRoot), String(skillName || "").trim(), "SKILL.md");
  if (!fs.existsSync(skillPath)) throw new Error(`Release Skill not found: ${skillName}`);
  const meta = readFrontmatter(skillPath);
  const action = normalizeList(meta.actions).find((item) => String(item || "") === String(actionName || ""));
  if (!action) {
    const actions = Array.isArray(meta.actions) ? meta.actions : [];
    const match = actions.find((item) => item && String(item.name || "") === String(actionName || ""));
    if (!match) throw new Error(`Release Action not found: ${skillName}:${actionName}`);
    return actionDefinition({ skillRoot: path.resolve(skillRoot), skillPath, skillName, skillMeta: meta, action: match });
  }
  return actionDefinition({ skillRoot: path.resolve(skillRoot), skillPath, skillName, skillMeta: meta, action });
}

// 用户需求点: 最新 release-skills 通过 product/platform Profile 绑定领域 Skill，目录异常不能阻断其他可用节点发现。
function discoverProfiles(skillRoot) {
  const profileRoot = path.join(skillRoot, "release-setup", "profiles");
  if (!fs.existsSync(profileRoot)) return [];
  const profiles = [];
  let products;
  try {
    products = fs.readdirSync(profileRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return profiles;
  }
  for (const productEntry of products) {
    const productRoot = path.join(profileRoot, productEntry.name);
    let files;
    try {
      files = fs.readdirSync(productRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".yaml")) continue;
      try {
        const value = readYamlObject(path.join(productRoot, file.name));
        const productId = String(value.product_id || productEntry.name).trim().toLowerCase();
        const targetPlatform = String(value.platform || file.name.replace(/\.yaml$/, "")).trim().toLowerCase();
        if (!productId || !["ios", "android"].includes(targetPlatform)) continue;
        profiles.push({
          profileId: String(value.profile_id || `${productId}-${targetPlatform}`).trim(),
          productId,
          platform: targetPlatform,
          refs: value.profile_refs && typeof value.profile_refs === "object" ? value.profile_refs : {},
        });
      } catch {
        // Ignore malformed profiles; a valid profile for the selected target may still exist.
      }
    }
  }
  return profiles;
}

function profileSupportsSkill(profile, skillName) {
  if (["release-setup", "release-management"].includes(skillName)) return true;
  return Object.values(profile?.refs || {}).some((value) => String(value || "").split("/", 1)[0] === skillName);
}

export async function discoverReleaseActions({ roots = [], businessLine = "likee", platform = "android", version = "1.0.0", batch = "initial", includeInitializationActions = false } = {}) {
  const context = contextSnapshot({ businessLine, platform, version, batch });
  const line = context.businessLine;
  const targetPlatform = context.platform;
  const targetBatch = context.batch;
  const nodes = [];
  const resolvedRoots = roots.map((configuredRoot) => {
    const configuredPath = path.resolve(String(configuredRoot || ""));
    return fs.existsSync(path.join(configuredPath, "skills")) ? path.join(configuredPath, "skills") : configuredPath;
  }).filter((skillRoot) => fs.existsSync(skillRoot));
  // 用户需求点: 主 Skill 根和扩展 Skill 根共同服从初始化选中的 Profile，不能让无 Profile 的扩展目录绕过范围过滤。
  const matchingProfiles = resolvedRoots.flatMap((skillRoot) => discoverProfiles(skillRoot))
    .filter((profile) => profile.productId === line && profile.platform === targetPlatform);
  const hasMatchingProfiles = matchingProfiles.length > 0;
  for (const skillRoot of resolvedRoots) {
    let skillDirs = [];
    try {
      skillDirs = fs.readdirSync(skillRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const entry of skillDirs) {
      const skillName = entry.name;
      const skillPath = path.join(skillRoot, skillName, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;
      const profileIds = [...new Set(matchingProfiles.filter((profile) => profileSupportsSkill(profile, skillName)).map((profile) => profile.profileId))];
      if (hasMatchingProfiles && profileIds.length === 0) continue;
      let meta;
      try { meta = readFrontmatter(skillPath); } catch { continue; }
      const actions = Array.isArray(meta.actions) && meta.actions.length > 0
        ? meta.actions
        : (INFERRED_ACTIONS[skillName] || []).map(([name, inputs, requiresConfirmation]) => ({
          name,
          inputs,
          platforms: ["ios", "android"],
          requires_confirmation: requiresConfirmation,
        }));
      for (const action of actions) {
        if (!action || typeof action !== "object" || !String(action.name || "").trim()) continue;
        const node = actionDefinition({ skillRoot, skillPath, skillName, skillMeta: meta, action, context, profileIds });
        if (!includeInitializationActions && ["release-management:guide-current-release", "release-management:create-active-release"].includes(node.id)) continue;
        if (!node.businessLines.includes(line) || !node.platforms.includes(targetPlatform) || !node.allowedBatches.includes(targetBatch)) continue;
        nodes.push(node);
      }
    }
  }
  const unique = new Map();
  for (const node of nodes) if (!unique.has(node.id)) unique.set(node.id, node);
  const ordered = Array.from(unique.values()).sort((a, b) => {
    const ai = ACTION_ORDER.indexOf(a.skill);
    const bi = ACTION_ORDER.indexOf(b.skill);
    return (ai < 0 ? ACTION_ORDER.length : ai) - (bi < 0 ? ACTION_ORDER.length : bi) || a.id.localeCompare(b.id);
  });
  return ordered.map((node, index) => ({
    ...node,
    nextNodeIds: node.nextNodeIds.length > 0 ? [...node.nextNodeIds] : ordered.slice(index + 1, index + 3).map((item) => item.id),
  }));
}

// 用户需求点: 初始化节点内部可以复用 release-management 的活动发版创建能力，但该动作不能作为普通流程候选暴露。
export async function discoverReleaseInitializationAction(context = {}, roots = []) {
  const nodes = await discoverReleaseActions({ roots, ...context, includeInitializationActions: true });
  const action = nodes.find((node) => node.id === "release-management:create-active-release");
  if (!action) return null;
  return {
    ...action,
    id: "release-initialization:prepare-context",
    title: "准备活动发版上下文",
    description: "复用已有活动发版；不存在时创建首包活动发版。",
    skill: "release-management",
    action: "create-active-release",
    category: "发版初始化",
    processId: "initialization",
    processOrder: 0,
    processTitle: "发版初始化",
    initializationActionId: "release-management:create-active-release",
  };
}

// 用户需求点: 状态机配置不仅决定推荐顺序，也必须限制当前业务线、平台和批次可执行的节点集合。
export function filterReleaseActionsForWorkflow(nodes = [], context = {}, config = RELEASE_WORKFLOW_CONFIG) {
  const discovered = Array.isArray(nodes) ? nodes.filter((node) => node && node.id) : [];
  const workflow = selectReleaseWorkflow(context, config);
  if (!workflow) return [];
  const allowedIds = workflowActionIds(workflow, context);
  const stageOrderById = new Map();
  const normalizedBatch = String(context?.batch || "initial").trim().toLowerCase() || "initial";
  workflow.stages.forEach((stage, stageIndex) => {
    if (Array.isArray(stage.batches) && !stage.batches.map((value) => String(value || "").trim().toLowerCase()).includes(normalizedBatch)) return;
    workflowStageNodeIds(stage).forEach((id, actionIndex) => {
      if (!stageOrderById.has(id)) stageOrderById.set(id, { stageIndex, actionIndex, stageId: stage.id, stageTitle: stage.title });
    });
  });
  return discovered
    .filter((node) => allowedIds.has(node.id))
    .map((node) => {
      const configured = stageOrderById.get(node.id);
      const metadata = releaseActionProcessMetadata(node.id, node, config, context);
      return {
        ...node,
        workflowId: workflow.id,
        ...metadata,
        ...(configured ? {
          processId: configured.stageId,
          processTitle: configured.stageTitle,
          workflowStageId: configured.stageId,
          workflowStageTitle: configured.stageTitle,
          workflowStageOrder: configured.stageIndex,
          workflowActionOrder: configured.actionIndex,
        } : {}),
      };
    })
    .sort((a, b) => {
      const ao = stageOrderById.get(a.id) || { stageIndex: Number.MAX_SAFE_INTEGER, actionIndex: Number.MAX_SAFE_INTEGER };
      const bo = stageOrderById.get(b.id) || { stageIndex: Number.MAX_SAFE_INTEGER, actionIndex: Number.MAX_SAFE_INTEGER };
      return ao.stageIndex - bo.stageIndex
        || ao.actionIndex - bo.actionIndex
        || Number(a.processOrder || 1000) - Number(b.processOrder || 1000)
        || String(a.id).localeCompare(String(b.id));
    });
}

// 用户需求点: 复合节点由当前 workflow 配置 materialize，内部每个原子 Action 必须同时存在且受同一业务/平台/批次白名单约束。
export function discoverReleaseCompositeActions(context = {}, nodes = [], config = RELEASE_WORKFLOW_CONFIG) {
  const workflow = selectReleaseWorkflow(context, config);
  if (!workflow) return [];
  const atomicById = new Map((Array.isArray(nodes) ? nodes : []).filter((node) => node?.id).map((node) => [String(node.id), node]));
  const result = [];
  const seen = new Set();
  const batch = String(context?.batch || "initial").trim().toLowerCase() || "initial";
  for (const stage of Array.isArray(workflow.stages) ? workflow.stages : []) {
    if (Array.isArray(stage.batches) && !stage.batches.map((value) => String(value || "").trim().toLowerCase()).includes(batch)) continue;
    const ids = Array.isArray(stage.compositeIds) ? stage.compositeIds : (Array.isArray(stage.capabilityIds) ? stage.capabilityIds : workflowStageNodeIds(stage));
    for (const compositeId of ids) {
      const composite = selectReleaseCompositeWorkflow({ ...context, compositeId, stageId: stage.id }, config);
      if (!composite || seen.has(composite.id)) continue;
      if (composite.promptTemplate || !Array.isArray(composite.actions)) {
        const capabilityId = String(composite.id || compositeId).trim();
        result.push({
          id: composite.nodeId || `composite:${capabilityId}`,
          kind: "composite",
          compositeId: capabilityId,
          title: composite.title || capabilityId,
          description: composite.description || "",
          skill: "release-composite",
          action: capabilityId,
          category: "发版阶段",
          businessLines: [...(composite.businessLines || [])],
          platforms: [...(composite.platforms || [])],
          allowedBatches: [...(composite.batches || [])],
          requiresConfirmation: composite.requiresConfirmation === true,
          skillHints: [...(composite.skillHints || [])],
          promptTemplate: String(composite.promptTemplate || composite.description || composite.title || ""),
          inputs: Array.isArray(composite.inputs) ? composite.inputs : [],
          outputs: Array.isArray(composite.outputs) ? composite.outputs : [],
          inputSchema: Array.isArray(composite.inputs) ? composite.inputs : [],
          nextNodeIds: [],
          workflowId: workflow.id,
          processId: composite.stageId || stage.id,
          processTitle: stage.title,
          processOrder: Number.isFinite(Number(stage.order)) ? Number(stage.order) : workflow.stages.indexOf(stage),
          workflowStageId: stage.id,
          workflowStageTitle: stage.title,
          workflowStageOrder: workflow.stages.indexOf(stage),
          workflowActionOrder: 0,
          contextSnapshot: { ...context },
          scopeKey: releaseContextKey(context),
          runnable: true,
          error: "",
          source: { compositeId: capabilityId },
        });
        seen.add(composite.id);
        continue;
      }
      const actionEntries = Array.isArray(composite.actions) ? composite.actions : [];
      const actions = actionEntries.map((entry, index) => {
        const id = String(entry?.id || entry?.actionId || "").trim();
        const atomic = atomicById.get(id);
        return atomic ? {
          ...atomic,
          stepId: String(entry.stepId || `step-${index + 1}`),
          order: index,
          inputs: entry.inputs && typeof entry.inputs === "object" ? { ...entry.inputs } : {},
          continueOn: Array.isArray(entry.continueOn) ? [...entry.continueOn] : [],
          waitFor: entry.waitFor && typeof entry.waitFor === "object" ? { ...entry.waitFor, statuses: Array.isArray(entry.waitFor.statuses) ? [...entry.waitFor.statuses] : [] } : null,
          forEach: entry.forEach && typeof entry.forEach === "object" ? { ...entry.forEach } : null,
          requiresConfirmation: entry.requiresConfirmation === true || atomic.requiresConfirmation === true,
        } : null;
      });
      if (actions.some((action) => !action)) continue;
      const inputSchema = [];
      const inputKeys = new Set();
      const internalInputKeys = new Set(actions.flatMap((action) => Object.entries(action.inputs && typeof action.inputs === "object" ? action.inputs : {})
        .filter(([, mapping]) => mapping && typeof mapping === "object" && String(mapping.fromStep || "").trim())
        .map(([key]) => key)));
      for (const action of actions) {
        for (const input of Array.isArray(action.inputSchema) ? action.inputSchema : []) {
          const key = String(input?.key || input?.name || "").trim();
          if (composite.expandSourceFiles === true && action.id === "release-localization:upload-source-file" && key === "source_path") continue;
          if (!key || internalInputKeys.has(key) || inputKeys.has(key)) continue;
          inputKeys.add(key);
          inputSchema.push({ ...input, key });
        }
        const configured = action.inputs && typeof action.inputs === "object" ? action.inputs : {};
        for (const [key, mapping] of Object.entries(configured)) {
          if (!key || internalInputKeys.has(key) || inputKeys.has(key)) continue;
          inputKeys.add(key);
          const descriptor = { key, label: key.replace(/[_-]+/g, " "), type: "text", required: false };
          if (mapping && typeof mapping === "object") {
            if (mapping.context) descriptor.context = String(mapping.context);
            if (mapping.fromStep) descriptor.fromStep = String(mapping.fromStep);
          } else if (mapping != null) descriptor.defaultValue = String(mapping);
          inputSchema.push(descriptor);
        }
      }
      const first = actions[0];
      const requiresConfirmation = actions.some((action) => action.requiresConfirmation === true);
      result.push({
        id: `composite:${composite.id}`,
        kind: "composite",
        compositeId: composite.id,
        title: composite.title,
        description: composite.description,
        skill: "release-composite",
        action: composite.id,
        category: first.category || "发版阶段",
        businessLines: [...(composite.businessLines || [])],
        platforms: [...(composite.platforms || [])],
        allowedBatches: [...(composite.batches || [])],
        ...(composite.expandSourceFiles === true ? { expandSourceFiles: true } : {}),
        requiresConfirmation,
        statusAliases: { ...(config.statusAliases || {}) },
        acceptsCurrentRelease: actions.every((action) => action.acceptsCurrentRelease !== false),
        inputSchema,
        actions,
        nextNodeIds: [],
        workflowId: workflow.id,
        processId: stage.id,
        processTitle: stage.title,
        processOrder: Number.isFinite(Number(stage.order)) ? Number(stage.order) : workflow.stages.indexOf(stage),
        workflowStageId: stage.id,
        workflowStageTitle: stage.title,
        workflowStageOrder: workflow.stages.indexOf(stage),
        workflowActionOrder: 0,
        contextSnapshot: { ...context },
        scopeKey: releaseContextKey(context),
        runnable: actions.every((action) => action.runnable !== false),
        error: actions.find((action) => action.error)?.error || "",
        source: { compositeId: composite.id },
      });
      seen.add(composite.id);
    }
  }
  // 用户需求点: 自由 Agent 等可插入任意阶段的能力要进入目录，但不占用状态机默认推荐位。
  for (const composite of insertableReleaseCapabilities(context, config)) {
    const capabilityId = String(composite.id || "").trim();
    if (!capabilityId || seen.has(capabilityId)) continue;
    const stage = (workflow.stages || []).find((item) => String(item?.id || "") === String(composite.stageId || ""))
      || (workflow.stages || [])[0]
      || { id: "entry", title: "发版入口", order: 0 };
    result.push({
      id: composite.nodeId || `composite:${capabilityId}`,
      kind: "composite",
      compositeId: capabilityId,
      title: composite.title || capabilityId,
      description: composite.description || "",
      skill: "release-composite",
      action: capabilityId,
      category: "助手驱动",
      businessLines: [...(composite.businessLines || [])],
      platforms: [...(composite.platforms || [])],
      allowedBatches: [...(composite.batches || [])],
      requiresConfirmation: composite.requiresConfirmation === true,
      insertableInAnyStage: true,
      skillHints: [...(composite.skillHints || [])],
      promptTemplate: String(composite.promptTemplate || composite.description || composite.title || ""),
      inputs: Array.isArray(composite.inputs) ? composite.inputs : [],
      outputs: Array.isArray(composite.outputs) ? composite.outputs : [],
      inputSchema: Array.isArray(composite.inputs) ? composite.inputs : [],
      nextNodeIds: [],
      workflowId: workflow.id,
      processId: composite.stageId || stage.id,
      processTitle: stage.title,
      processOrder: Number.isFinite(Number(stage.order)) ? Number(stage.order) : 0,
      workflowStageId: stage.id,
      workflowStageTitle: stage.title,
      workflowStageOrder: (workflow.stages || []).indexOf(stage),
      workflowActionOrder: 0,
      contextSnapshot: { ...context },
      scopeKey: releaseContextKey(context),
      runnable: true,
      error: "",
      source: { compositeId: capabilityId },
    });
    seen.add(capabilityId);
  }
  return result;
}
