/**
 * The release skills are intentionally represented as data.  The UI can use
 * this catalog today and a real AgentFlow adapter can replace the simulator
 * without changing the node lifecycle model.
 */

const ALL_BUSINESS_LINES = ["likee", "bigolive", "hello"];
const BOTH_PLATFORMS = ["android", "ios"];

function node(definition) {
  const result = {
    businessLines: ALL_BUSINESS_LINES,
    platforms: BOTH_PLATFORMS,
    durationMs: 600,
    nextNodeIds: [],
    ...definition,
  };
  result.businessLines = Object.freeze([...result.businessLines]);
  result.platforms = Object.freeze([...result.platforms]);
  result.nextNodeIds = Object.freeze([...result.nextNodeIds]);
  return Object.freeze(result);
}

export const RELEASE_NODE_CATALOG = Object.freeze([
  node({
    id: "release-setup",
    title: "接入发版工程",
    description: "发现并接入当前业务线与平台的本地工程及发版 Skill。",
    skill: "release-setup",
    category: "发版准备",
    nextNodeIds: ["release-management"],
  }),
  node({
    id: "release-management",
    title: "确认发版上下文",
    description: "创建或选择活动发版，登记批次、版本和共享 release 分支。",
    skill: "release-management",
    category: "发版准备",
    nextNodeIds: ["release-git", "release-localization"],
  }),
  node({
    id: "release-git",
    title: "准备发版分支与合并",
    description: "创建或复用 release 分支，处理受管理提交及合主干 MR。",
    skill: "release-git",
    category: "发版准备",
    nextNodeIds: ["release-localization", "release-release-notes"],
  }),
  node({
    id: "release-localization",
    title: "同步多语言",
    description: "上传源多语言并同步翻译回仓，核对工程 Git 差异。",
    skill: "release-localization",
    category: "发版准备",
    nextNodeIds: ["release-notification", "release-release-notes"],
  }),
  node({
    id: "release-approval-initial",
    title: "首次发版审核",
    description: "为首包创建首次发版审核草稿并等待人工确认。",
    skill: "release-approval",
    category: "版本发布",
    platforms: ["ios"],
    nextNodeIds: ["release-records"],
  }),
  node({
    id: "release-approval",
    title: "全量发布审核",
    description: "为首包或补包创建全量发布审核草稿。",
    skill: "release-approval",
    category: "版本全量",
    nextNodeIds: ["release-metrics", "release-gray-observe"],
  }),
  node({
    id: "release-release-notes",
    title: "上传版本更新说明",
    description: "预览并上传 iOS 多语言版本更新说明。",
    skill: "release-release-notes",
    category: "版本发布",
    platforms: ["ios"],
    nextNodeIds: ["release-approval-initial", "release-records"],
  }),
  node({
    id: "release-metrics",
    title: "保存指标快照",
    description: "查询目标构建指标并保存可复用的指标快照。",
    skill: "release-metrics",
    category: "指标检查",
    nextNodeIds: ["release-gray-observe", "release-approval"],
  }),
  node({
    id: "release-gray-observe",
    title: "灰度观察",
    description: "观察灰度指标并对可疑面板进行下钻分析。",
    skill: "release-gray-observe",
    category: "指标检查",
    nextNodeIds: ["release-approval", "release-notification"],
  }),
  node({
    id: "release-records",
    title: "登记发版记录",
    description: "整理发版摘要，并在确认后追加平台发版记录。",
    skill: "release-records",
    category: "版本全量",
    nextNodeIds: ["release-notification"],
  }),
  node({
    id: "release-records-supplement",
    title: "登记补包记录",
    description: "记录 Android 补包批次、灰度比例和补包原因。",
    skill: "release-records",
    category: "版本全量",
    platforms: ["android"],
    nextNodeIds: ["release-approval", "release-notification"],
  }),
  node({
    id: "release-channel-packages",
    title: "生成 Android 渠道包",
    description: "全量后按清单生成通用 Walle 渠道包与支付渠道包。",
    skill: "release-channel-packages",
    category: "版本全量",
    platforms: ["android"],
    nextNodeIds: ["release-notification"],
  }),
  node({
    id: "release-notification",
    title: "发送发版通知",
    description: "预览并独立确认后发送发版阶段的脱敏事件通知。",
    skill: "release-notification",
    category: "协作通知",
    nextNodeIds: [],
  }),
].map((definition) => definition));

const normalize = (value) => String(value ?? "").trim().toLowerCase();

export function getReleaseNodes({ businessLine, platform } = {}) {
  const line = normalize(businessLine);
  const targetPlatform = normalize(platform);
  const matchingIds = new Set(RELEASE_NODE_CATALOG
    .filter((item) => item.businessLines.includes(line) && item.platforms.includes(targetPlatform))
    .map((item) => item.id));
  return RELEASE_NODE_CATALOG
    .filter((item) => matchingIds.has(item.id))
    .map((item) => {
      const nextNodeIds = item.nextNodeIds.filter((nextId) => matchingIds.has(nextId));
      // Android's supplement and channel-package stages are deliberately
      // attached only in the Android graph, so iOS never sees those edges.
      if (targetPlatform === "android" && item.id === "release-records") {
        nextNodeIds.push("release-records-supplement");
      }
      if (targetPlatform === "android" && item.id === "release-records-supplement") {
        nextNodeIds.push("release-channel-packages");
      }
      return {
      ...item,
      businessLines: [...item.businessLines],
      platforms: [...item.platforms],
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

export function runReleaseNode(nodeDefinition, context, { signal, onProgress } = {}) {
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
      resolve({
        runId,
        message: `${nodeDefinition.title} 已完成（${context?.version || "1.0.0"}）`,
      });
    }, durationMs);
  });
}
