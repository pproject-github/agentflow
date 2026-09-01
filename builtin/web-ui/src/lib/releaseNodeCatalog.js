/**
 * The release skills are intentionally represented as data.  The UI can use
 * this catalog today and a real AgentFlow adapter can replace the simulator
 * without changing the node lifecycle model.
 */

import { selectReleaseWorkflow, selectReleaseCompositeWorkflow, workflowStageNodeIds } from "../../../../shared/release-workflow-config.js";

const ALL_BUSINESS_LINES = ["likee", "bigolive", "hello"];
const BOTH_PLATFORMS = ["android", "ios"];
const FALLBACK_LOCALIZATION_SOURCE_FILES = Object.freeze({
  android: Object.freeze([
    "iHeima/res/values/strings.xml",
    "iHeima/src/samsung/res/values/strings_samsung.xml",
    "iHeima/src/xiaomi/res/values/strings_xiaomi.xml",
    "iHeima/src/rustore/res/values/strings_rustore.xml",
    "iHeima/reslive/values/livestrings.xml",
    "modules/common/res/values/lib_strings.xml",
    "modules/common/res/values/countries_strings.xml",
    "effectone_modules/editor/editor-ui/src/main/res/values/eo_editor_ui_strings.xml",
    "effectone_modules/record/recorder-ui/src/main/res/values/eo_recorder_ui_strings.xml",
    "effectone_modules/base/base-ui/src/main/res/values/eo_base_ui_strings.xml",
  ]),
  ios: Object.freeze([
    "yymeet/Resources/MultiLanguage/en.lproj/Localizable.strings",
    "yymeet/Resources/MultiLanguage/en.lproj/countries.strings",
    "yymeet/Resources/MultiLanguage/en.lproj/InfoPlist.strings",
    "yymeet/Resources/MultiLanguage/en.lproj/Localizable.stringsdict",
    "yymeet/Resources/MultiLanguage/en.lproj/PushExtensionLocalizable.strings",
    "yymeet/Resources/MultiLanguage/en.lproj/TodayExtensionLocalizable.strings",
    "yymeet/Resources/MultiLanguage/en.lproj/WidgetExtensionLocalizable.strings",
    "yymeet/Resources/MultiLanguage/en.lproj/xib.strings",
  ]),
});

function node(definition) {
  const result = {
    businessLines: ALL_BUSINESS_LINES,
    platforms: BOTH_PLATFORMS,
    durationMs: 600,
    nextNodeIds: [],
    inputSchema: [],
    ...definition,
  };
  result.businessLines = Object.freeze([...result.businessLines]);
  result.platforms = Object.freeze([...result.platforms]);
  result.nextNodeIds = Object.freeze([...result.nextNodeIds]);
  result.inputSchema = Object.freeze(result.inputSchema.map((input) => Object.freeze({ ...input })));
  return Object.freeze(result);
}

export const RELEASE_NODE_CATALOG = Object.freeze([
  node({
    id: "release-setup",
    title: "接入发版工程",
    description: "发现并接入当前业务线与平台的本地工程及发版 Skill。",
    skill: "release-setup",
    category: "发版准备",
    processId: "preparation",
    processOrder: 10,
    nextNodeIds: ["release-management"],
  }),
  node({
    id: "release-management",
    title: "确认发版上下文",
    description: "创建或选择活动发版，登记批次、版本和共享 release 分支。",
    skill: "release-management",
    category: "发版准备",
    processId: "preparation",
    processOrder: 20,
    nextNodeIds: ["release-git", "release-localization"],
  }),
  node({
    id: "release-git",
    title: "准备发版分支与合并",
    description: "创建或复用 release 分支，处理受管理提交及合主干 MR。",
    skill: "release-git",
    category: "发版准备",
    processId: "preparation",
    processOrder: 60,
    nextNodeIds: ["release-localization", "release-approval", "release-release-notes"],
  }),
  node({
    id: "release-localization",
    title: "同步多语言",
    description: "上传源多语言并同步翻译回仓，核对工程 Git 差异。",
    skill: "release-localization",
    category: "发版准备",
    processId: "localization",
    processOrder: 10,
    nextNodeIds: ["release-approval", "release-release-notes"],
  }),
  node({
    id: "release-approval-initial",
    title: "首次发版审核",
    description: "为首包创建首次发版审核草稿并等待人工确认。",
    skill: "release-approval",
    category: "版本发布",
    processId: "approval",
    processOrder: 10,
    platforms: ["ios"],
    nextNodeIds: ["release-approval", "release-records"],
  }),
  node({
    id: "release-approval",
    title: "全量发布审核",
    description: "为首包或补包创建全量发布审核草稿。",
    skill: "release-approval",
    category: "版本全量",
    processId: "approval",
    processOrder: 20,
    nextNodeIds: ["release-metrics", "release-gray-observe"],
  }),
  node({
    id: "release-release-notes",
    title: "上传版本更新说明",
    description: "预览并上传 iOS 多语言版本更新说明。",
    skill: "release-release-notes",
    category: "版本发布",
    processId: "store",
    processOrder: 10,
    platforms: ["ios"],
    nextNodeIds: ["release-approval-initial", "release-records"],
  }),
  node({
    id: "release-metrics",
    title: "保存指标快照",
    description: "查询目标构建指标并保存可复用的指标快照。",
    skill: "release-metrics",
    category: "指标检查",
    processId: "metrics",
    processOrder: 10,
    nextNodeIds: ["release-gray-observe", "release-records"],
  }),
  node({
    id: "release-gray-observe",
    title: "灰度观察",
    description: "观察灰度指标并对可疑面板进行下钻分析。",
    skill: "release-gray-observe",
    category: "指标检查",
    processId: "gray-observe",
    processOrder: 10,
    nextNodeIds: ["release-records", "release-notification"],
  }),
  node({
    id: "release-records",
    title: "登记发版记录",
    description: "整理发版摘要，并在确认后追加平台发版记录。",
    skill: "release-records",
    category: "版本全量",
    processId: "records",
    processOrder: 10,
    nextNodeIds: ["release-records-supplement", "release-channel-packages", "release-notification"],
  }),
  node({
    id: "release-records-supplement",
    title: "登记补包记录",
    description: "记录 Android 补包批次、灰度比例和补包原因。",
    skill: "release-records",
    category: "版本全量",
    processId: "records",
    processOrder: 20,
    platforms: ["android"],
    inputSchema: [
      {
        key: "gray_percent",
        label: "灰度百分比 (%)",
        type: "number",
        required: true,
        min: 1,
        max: 100,
        integer: true,
        step: 1,
        placeholder: "例如 10",
      },
    ],
    nextNodeIds: ["release-channel-packages", "release-notification"],
  }),
  node({
    id: "release-channel-packages",
    title: "生成 Android 渠道包",
    description: "全量后按清单生成通用 Walle 渠道包与支付渠道包。",
    skill: "release-channel-packages",
    category: "版本全量",
    processId: "channel-packages",
    processOrder: 10,
    platforms: ["android"],
    nextNodeIds: ["release-notification"],
  }),
  node({
    id: "release-notification",
    title: "发送发版通知",
    description: "预览并独立确认后发送发版阶段的脱敏事件通知。",
    skill: "release-notification",
    category: "协作通知",
    processId: "notification",
    processOrder: 10,
    nextNodeIds: [],
  }),
].map((definition) => definition));

const normalize = (value) => String(value ?? "").trim().toLowerCase();

function fallbackActionTitle(actionId) {
  const action = String(actionId || "").split(":")[1] || actionId;
  return action.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function defaultLocalizationSourcePath(platform) {
  // 用户需求点: 静态目录也要给多语言上传填入当前平台工程内的受审源文件相对路径。
  return normalize(platform) === "ios"
    ? "yymeet/Resources/MultiLanguage/en.lproj/Localizable.strings"
    : "iHeima/res/values/strings.xml";
}

// 用户需求点: API 不可用时，静态目录也必须提供共享 workflow 引用的 action-level 节点。
function configuredFallbackNodes(context = {}) {
  const workflow = selectReleaseWorkflow(context);
  if (!workflow) return [];
  const baseBySkill = new Map(RELEASE_NODE_CATALOG.map((item) => [item.skill, item]));
  const nodes = [];
  for (const stage of workflow.stages || []) {
    if (Array.isArray(stage.batches) && !stage.batches.includes(normalize(context.batch || "initial"))) continue;
    workflowStageNodeIds(stage).forEach((id, index) => {
      const [skill] = String(id).split(":");
      const base = baseBySkill.get(skill) || {};
      let inputSchema = [];
      if (id === "release-git:create-release-branch") {
        inputSchema = [{ key: "release_branch", label: "Release 分支名", type: "text", required: false, placeholder: "例如 release/v1.1" }];
      } else if (id === "release-localization:upload-source-file") {
        inputSchema = [{ key: "source_path", label: "源文件", type: "text", required: true, defaultValue: defaultLocalizationSourcePath(context.platform) }];
      } else if (id === "release-records:append-release-wiki-row"
        && normalize(context.platform) === "android"
        && normalize(context.batch || "initial") === "supplemental") {
        inputSchema = [{ key: "gray_percent", label: "灰度百分比 (%)", type: "number", required: true, min: 1, max: 100, integer: true, step: 1, placeholder: "例如 10" }];
      } else if (id === "release-records:record-store-approved") {
        // 过审登记使用 observe_record_id / dau 等可选输入，不能复用补包节点的灰度百分比字段。
        inputSchema = [];
      }
      nodes.push({
        ...base,
        id,
        title: fallbackActionTitle(id),
        description: base.description || `${fallbackActionTitle(id)} 发版动作。`,
        skill,
        action: String(id).slice(skill.length + 1),
        category: base.category || stage.title,
        processId: stage.id,
        processOrder: index,
        processTitle: stage.title,
        workflowId: workflow.id,
        businessLines: [...workflow.businessLines],
        platforms: [...workflow.platforms],
        ...(id === "release-localization:upload-source-file"
          ? { sourceFiles: [...(FALLBACK_LOCALIZATION_SOURCE_FILES[normalize(context.platform)] || [defaultLocalizationSourcePath(context.platform)])] }
          : {}),
        inputSchema,
        nextNodeIds: [],
      });
    });
  }
  return nodes;
}

// 用户需求点: API 暂不可用时，静态目录也要保持复合流程默认推荐与线上 catalog 一致。
function configuredFallbackCompositeNodes(context = {}, atomicNodes = []) {
  const workflow = selectReleaseWorkflow(context);
  if (!workflow) return [];
  const byId = new Map(atomicNodes.map((node) => [node.id, node]));
  const result = [];
  const seen = new Set();
  for (const stage of workflow.stages || []) {
    if (Array.isArray(stage.batches) && !stage.batches.includes(normalize(context.batch || "initial"))) continue;
    for (const compositeId of (stage.compositeIds || stage.capabilityIds || workflowStageNodeIds(stage))) {
      const composite = selectReleaseCompositeWorkflow({ ...context, compositeId, stageId: stage.id });
      if (!composite || seen.has(composite.id)) continue;
      if (!Array.isArray(composite.actions)) {
        result.push({
          id: `composite:${composite.id}`, kind: "composite", compositeId: composite.id,
          title: composite.title, description: composite.description, skill: "release-composite",
          action: composite.id, category: stage.title || "发版阶段", processId: stage.id, processOrder: -1,
          processTitle: stage.title, workflowId: workflow.id, businessLines: [...workflow.businessLines], platforms: [...workflow.platforms],
          skillHints: [...(composite.skillHints || [])], promptTemplate: composite.promptTemplate || "",
          inputSchema: (composite.inputs || []).map((input) => ({ ...input })), outputs: (composite.outputs || []).map((output) => ({ ...output })),
          requiresConfirmation: composite.requiresConfirmation === true, actions: undefined, nextNodeIds: [],
          scopeKey: `${context.businessLine}/${context.platform}/${context.version || "1.0.0"}/${context.batch || "initial"}`,
        });
        seen.add(composite.id);
        continue;
      }
      const actions = (composite.actions || []).map((entry, index) => {
        const atomic = byId.get(entry.id);
        return {
          ...entry,
          stepId: entry.stepId || `step-${index + 1}`,
          id: entry.id,
          title: atomic?.title || fallbackActionTitle(entry.id),
          description: atomic?.description || "",
          inputSchema: atomic?.inputSchema || [],
        };
      });
      if (actions.some((entry) => !byId.has(entry.id))) continue;
      const internalKeys = new Set(actions.flatMap((entry) => Object.entries(entry.inputs || {})
        .filter(([, mapping]) => mapping && typeof mapping === "object" && mapping.fromStep)
        .map(([key]) => key)));
      const inputSchema = [];
      const keys = new Set();
      for (const action of actions) {
        for (const schema of action.inputSchema) {
          const key = String(schema?.key || schema?.name || "").trim();
          if (composite.expandSourceFiles === true && action.id === "release-localization:upload-source-file" && key === "source_path") continue;
          if (!key || internalKeys.has(key) || keys.has(key)) continue;
          keys.add(key);
          inputSchema.push({ ...schema, key });
        }
        for (const [key, mapping] of Object.entries(action.inputs || {})) {
          if (!key || keys.has(key) || !mapping || typeof mapping !== "object" || !mapping.context) continue;
          keys.add(key);
          inputSchema.push({ key, label: key.replace(/[_-]+/g, " "), type: "text", required: false });
        }
      }
      result.push({
        id: `composite:${composite.id}`,
        kind: "composite",
        compositeId: composite.id,
        title: composite.title,
        description: composite.description,
        skill: "release-composite",
        action: composite.id,
        category: stage.title || "发版阶段",
        processId: stage.id,
        processOrder: -1,
        processTitle: stage.title,
        workflowId: workflow.id,
        businessLines: [...workflow.businessLines],
        platforms: [...workflow.platforms],
        ...(composite.expandSourceFiles === true ? { expandSourceFiles: true } : {}),
        actions,
        inputSchema,
        requiresConfirmation: actions.some((entry) => entry.requiresConfirmation === true),
        nextNodeIds: [],
        scopeKey: `${context.businessLine}/${context.platform}/${context.version || "1.0.0"}/${context.batch || "initial"}`,
      });
      seen.add(composite.id);
    }
  }
  return result;
}

export function getReleaseNodes({ businessLine, platform, version = "1.0.0", batch = "initial" } = {}) {
  const line = normalize(businessLine);
  const targetPlatform = normalize(platform);
  if (!selectReleaseWorkflow({ businessLine: line, platform: targetPlatform, batch })) return [];
  const catalog = configuredFallbackNodes({ businessLine: line, platform: targetPlatform, version, batch });
  const composites = configuredFallbackCompositeNodes({ businessLine: line, platform: targetPlatform, version, batch }, catalog);
  catalog.push(...composites);
  const allIds = new Set(catalog.map((item) => item.id));
  return catalog
    .map((item) => {
      const nextNodeIds = item.nextNodeIds.filter((nextId) => allIds.has(nextId));
      return {
        ...item,
        businessLines: [...item.businessLines],
        platforms: [...item.platforms],
        inputSchema: item.inputSchema.map((input) => ({ ...input })),
        nextNodeIds: [...new Set(nextNodeIds)],
      };
    });
}

function workspaceText(workspace) {
  if (workspace == null) return "";
  if (typeof workspace === "string") return normalize(workspace);
  try {
    return normalize(JSON.stringify(workspace));
  } catch {
    return normalize(workspace);
  }
}

function discoverVersion(workspace, text) {
  const candidates = typeof workspace === "object" && workspace !== null
    ? [workspace.version, workspace.releaseVersion, workspace.appVersion, workspace.packageVersion]
    : [];
  for (const candidate of candidates) {
    const match = String(candidate ?? "").match(/\bv?\d+\.\d+(?:\.\d+)(?:[-+][0-9a-z.-]+)?\b/i);
    if (match) return match[0].replace(/^v/i, "");
  }
  const match = text.match(/\bv?\d+\.\d+(?:\.\d+)(?:[-+][0-9a-z.-]+)?\b/i);
  return match ? match[0].replace(/^v/i, "") : "1.0.0";
}

export function inferReleaseContext(workspace = {}) {
  const text = workspaceText(workspace);
  const businessLine = text.includes("bigolive") ? "bigolive" : text.includes("hello") ? "hello" : "likee";
  const platform = /ios|iphone/.test(text) ? "ios" : "android";
  return { businessLine, platform, version: discoverVersion(workspace, text) };
}

function createAbortError() {
  const error = new Error("Release node execution was cancelled");
  error.name = "AbortError";
  return error;
}

function createRunId() {
  const randomId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 12);
  return `release-${Date.now().toString(36)}-${randomId}`;
}

export function runReleaseNode(nodeDefinition, context, { signal, onProgress, onRunStart } = {}) {
  return new Promise((resolve, reject) => {
    if (!nodeDefinition || typeof nodeDefinition !== "object" || !nodeDefinition.id) {
      reject(new Error("A release node definition is required"));
      return;
    }
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const runId = createRunId();
    if (typeof onRunStart === "function") onRunStart(runId);
    const durationMs = Math.min(Math.max(Number(nodeDefinition.durationMs) || 600, 40), 1000);
    const progress = (value) => {
      if (typeof onProgress === "function") onProgress(value);
    };
    let halfwayTimer;
    let finishTimer;
    const cleanup = () => {
      clearTimeout(halfwayTimer);
      clearTimeout(finishTimer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(createAbortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    progress(0);
    halfwayTimer = setTimeout(() => progress(50), Math.max(20, durationMs / 2));
    finishTimer = setTimeout(() => {
      cleanup();
      progress(100);
      if (context?.simulateFailure || context?.selfTestFailure) {
        reject(new Error("本地自测失败：已启用失败模式，请关闭后重试"));
        return;
      }
      resolve({
        runId,
        message: `${nodeDefinition.title} 已完成（${context?.version || "1.0.0"}）`,
      });
    }, durationMs);
  });
}
