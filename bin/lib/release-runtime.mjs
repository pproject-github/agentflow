import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  RELEASE_WORKFLOW_CONFIG,
  releaseActionProcessMetadata,
  selectReleaseWorkflow,
  workflowActionIds,
  workflowStageNodeIds,
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

// 用户需求点: Create Release Branch 必须允许操作员输入完整分支名，留空时仍沿用 release-skill 的标准命名规则。
function inputDefinitionsForAction(skillName, actionName, declaredInputs, context = {}) {
  const actionKey = `${skillName}:${actionName}`;
  const declared = Array.isArray(declaredInputs) ? declaredInputs : [];
  const definitions = declared
    .map((input) => {
      if (input && typeof input === "object") {
        const key = String(input.key || input.name || "").trim();
        return key ? { ...input, key, label: input.label || key.replace(/[_-]+/g, " "), type: input.type || "text", required: input.required === true } : null;
      }
      const key = String(input || "").trim();
      return key ? { key, label: key.replace(/[_-]+/g, " "), type: "text", required: false } : null;
    })
    .filter(Boolean);
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

export async function discoverReleaseActions({ roots = [], businessLine = "likee", platform = "android", version = "1.0.0", batch = "initial" } = {}) {
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
        if (["release-management:guide-current-release", "release-management:create-active-release"].includes(node.id)) continue;
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
