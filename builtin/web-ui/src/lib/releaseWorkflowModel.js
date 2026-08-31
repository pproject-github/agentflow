import { createReleaseProcessStateMachine, deriveProcessStates, deriveWorkflowCursor, processTitleForId, recommendNextProcessNodes } from "./releaseWorkflowStateMachine.js";

function workspaceValue(workspace) {
  if (typeof workspace === "string") return workspace;
  if (!workspace || typeof workspace !== "object") return "";
  return workspace.path || workspace.repoUrl || workspace.label || workspace.name || workspace.id || "";
}

function paramValue(params, key) {
  if (params instanceof URLSearchParams) return params.get(key) || "";
  if (typeof params === "string") return new URLSearchParams(params).get(key) || "";
  if (params && typeof params === "object") return String(params[key] || "");
  return "";
}

// 用户需求点: 节点进入下一阶段时，标准参数应根据节点定义自动填充，同时保留操作员后来修改的值。
export function defaultInputsForNode(node, inputs = {}) {
  const result = inputs && typeof inputs === "object" && !Array.isArray(inputs) ? { ...inputs } : {};
  for (const schema of Array.isArray(node?.inputSchema) ? node.inputSchema : []) {
    const key = String(schema?.key || "").trim();
    if (!key) continue;
    const current = result[key];
    if ((current === undefined || current === null || (typeof current === "string" && current.trim() === ""))
      && schema.defaultValue !== undefined && schema.defaultValue !== null) {
      result[key] = schema.defaultValue;
    }
  }
  return result;
}

// 用户需求点: 后续页面携带的业务线、平台、版本参数是发版流程的唯一上下文来源，进入后不能再被页面控件改写。
export function resolveReleaseContext(workspace = {}, params = "") {
  const businessLine = paramValue(params, "businessLine") || workspace?.businessLine || "likee";
  const platformValue = paramValue(params, "platform") || workspace?.platform || "android";
  const version = paramValue(params, "version") || workspace?.version || workspace?.releaseVersion || "1.0.0";
  const explicitBatch = paramValue(params, "batch") || workspace?.batch || "";
  const result = {
    businessLine: String(businessLine).trim().toLowerCase() || "likee",
    platform: /ios|iphone/i.test(String(platformValue)) ? "ios" : "android",
    version: String(version).trim() || "1.0.0",
  };
  if (explicitBatch) result.batch = String(explicitBatch).trim().toLowerCase() || "initial";
  return result;
}

// 用户需求点: 首次进入业务线、平台、版本组合时，需要把上下文作为初始化状态节点的一部分保留下来。
export function createInitializationNode(context = {}, workspace) {
  const businessLine = String(context.businessLine || "likee");
  const platform = String(context.platform || "android");
  const version = String(context.version || "1.0.0");
  const batch = String(context.batch || "initial");
  const inputs = {
    businessLine,
    platform,
    version,
    workspace: workspaceValue(workspace),
  };
  if (context.batch) inputs.batch = batch;
  return {
    id: "release-initialization",
    title: "初始化状态",
    description: `初始化发版上下文：${businessLine} / ${platform} / ${version} / ${batch}`,
    skill: "release-initialization",
    category: "发版初始化",
    businessLines: [businessLine],
    platforms: [platform],
    durationMs: 300,
    nextNodeIds: ["release-setup"],
    inputSchema: [],
    inputs,
    contextSnapshot: { ...inputs },
    scopeKey: `${businessLine}/${platform}/${version}/${batch}`,
  };
}

// 用户需求点: 进入发版页即代表业务线、平台、版本已声明，初始化节点必须直接落在已完成时间线，不应再触发执行。
export function seedInitializationState(state, node) {
  if (!state || !node) return state;
  const timeline = Array.isArray(state.timeline) ? state.timeline : [];
  const pending = Array.isArray(state.pending) ? state.pending : [];
  if (timeline.length > 0 || pending.length > 0) return state;
  const timestamp = Date.now();
  return {
    ...state,
    timeline: [{
      id: "release-initialization",
      nodeId: node.id,
      title: node.title,
      description: node.description,
      category: node.category,
      status: "completed",
      progress: 100,
      createdAt: timestamp,
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 0,
      operator: "系统初始化",
      error: "",
      inputs: { ...node.inputs },
      contextSnapshot: { ...node.contextSnapshot },
      scopeKey: node.scopeKey,
    }],
    pending: [],
  };
}

// 用户需求点: 初始化后只能选择、推荐和运行当前业务、平台、版本（及批次）集合内的节点。
export function nodeMatchesContext(node, context) {
  if (!node || !context) return false;
  const businessLine = String(context.businessLine || "").toLowerCase();
  const platform = String(context.platform || "").toLowerCase();
  const snapshot = node.contextSnapshot || {};
  return (!Array.isArray(node.businessLines) || node.businessLines.length === 0 || node.businessLines.includes(businessLine))
    && (!Array.isArray(node.platforms) || node.platforms.length === 0 || node.platforms.includes(platform))
    && (!snapshot.businessLine || String(snapshot.businessLine).toLowerCase() === businessLine)
    && (!snapshot.platform || String(snapshot.platform).toLowerCase() === platform)
    && (!snapshot.version || String(snapshot.version) === String(context.version))
    && (!snapshot.batch || String(snapshot.batch).toLowerCase() === String(context.batch || "initial").toLowerCase());
}

// 用户需求点: 前端推荐节点与自定义候选必须使用当前业务线、平台和批次的共享状态机配置。
export function seedNextRecommendations(state, nodes = [], config) {
  if (!state || !Array.isArray(nodes) || nodes.length === 0) return state;
  const timeline = Array.isArray(state.timeline) ? state.timeline : [];
  const pending = Array.isArray(state.pending) ? state.pending : [];
  if (timeline.length === 0) return state;
  const initialization = timeline.find((item) => item?.nodeId === "release-initialization") || timeline[0];
  const context = state.context || initialization?.contextSnapshot || initialization?.inputs || {};
  const machine = createReleaseProcessStateMachine({
    context,
    config,
    nodes: nodes.filter((node) => node?.id !== "release-initialization"),
  });
  // 服务端旧快照可能残留其他业务/版本的待执行节点；这些节点在当前上下文不可见，不能阻塞本次流程推荐。
  const currentScope = `${context.businessLine}/${context.platform}/${context.version}/${context.batch || "initial"}`;
  const eligiblePending = pending.filter((item) => {
    if (!item?.nodeId) return false;
    if (item.scopeKey && item.scopeKey !== currentScope) return false;
    const snapshot = item.contextSnapshot || {};
    return (!snapshot.businessLine || String(snapshot.businessLine).toLowerCase() === String(context.businessLine).toLowerCase())
      && (!snapshot.platform || String(snapshot.platform).toLowerCase() === String(context.platform).toLowerCase())
      && (!snapshot.version || String(snapshot.version) === String(context.version))
      && (!snapshot.batch || String(snapshot.batch).toLowerCase() === String(context.batch || "initial").toLowerCase());
  });
  const recommendations = eligiblePending.length > 0
    ? []
    : recommendNextProcessNodes({ machine, timeline, pending: eligiblePending });
  const processStates = Object.fromEntries(deriveProcessStates({ machine, timeline, pending: eligiblePending }));
  const workflowCursor = deriveWorkflowCursor({ machine, timeline, pending: eligiblePending });
  if (recommendations.length === 0) return { ...state, processStates, workflowCursor };
  const now = Date.now();
  return {
    ...state,
    processStates,
    workflowCursor,
    pending: [...pending, ...recommendations.map((node, index) => {
      return {
        id: `${node.id}-recommended-${now}-${index}`,
        nodeId: node.id,
        title: node.title,
        description: node.description,
        category: node.category,
        processId: node.processId,
        processOrder: node.processOrder,
        processTitle: node.processTitle || processTitleForId(node.processId),
        status: "pending",
        progress: 0,
        createdAt: now,
        operator: "未记录",
        inputs: defaultInputsForNode(node),
        scopeKey: node.scopeKey || `${context.businessLine}/${context.platform}/${context.version}/${context.batch || "initial"}`,
        contextSnapshot: { ...context },
      };
    })],
  };
}

// 用户需求点: 历史发版记录也必须以初始化状态作为第一节点，但不能删除或覆盖已有时间线。
export function ensureInitializationFirst(state, node) {
  if (!state || !node) return state;
  const timeline = Array.isArray(state.timeline) ? state.timeline : [];
  const pending = Array.isArray(state.pending) ? state.pending : [];
  const timelineIndex = timeline.findIndex((item) => item?.nodeId === node.id);
  if (timelineIndex >= 0) {
    const initialization = {
      ...node,
      ...timeline[timelineIndex],
      inputs: { ...node.inputs, ...(timeline[timelineIndex]?.inputs || {}) },
      contextSnapshot: { ...node.contextSnapshot, ...(timeline[timelineIndex]?.contextSnapshot || {}) },
      scopeKey: timeline[timelineIndex]?.scopeKey || node.scopeKey,
    };
    const reordered = [initialization, ...timeline.slice(0, timelineIndex), ...timeline.slice(timelineIndex + 1)];
    return { ...state, timeline: reordered };
  }
  const pendingIndex = pending.findIndex((item) => item?.nodeId === node.id);
  if (pendingIndex >= 0) {
    const initialization = { ...node, ...pending[pendingIndex] };
    const first = timeline[0];
    const timestamp = Number(initialization?.createdAt || first?.createdAt || first?.startedAt || first?.completedAt) || Date.now();
    return {
      ...state,
      timeline: [{
        ...initialization,
        id: initialization.id || "release-initialization",
        status: "completed",
        progress: 100,
        createdAt: initialization.createdAt || timestamp,
        startedAt: initialization.startedAt || timestamp,
        completedAt: initialization.completedAt || timestamp,
        durationMs: initialization.durationMs ?? 0,
        operator: initialization.operator && initialization.operator !== "未记录" ? initialization.operator : "历史数据",
        inputs: { ...node.inputs, ...(initialization.inputs || {}) },
        contextSnapshot: { ...node.contextSnapshot, ...(initialization.contextSnapshot || {}) },
        scopeKey: initialization.scopeKey || node.scopeKey,
      }, ...timeline],
      pending: [...pending.slice(0, pendingIndex), ...pending.slice(pendingIndex + 1)],
    };
  }
  if (timeline.length > 0) {
    const first = timeline[0];
    const timestamp = Number(first?.createdAt || first?.startedAt || first?.completedAt) || Date.now();
    return {
      ...state,
      timeline: [{
        id: `${node.id}-legacy`,
        nodeId: node.id,
        title: node.title,
        description: node.description,
        category: node.category,
        status: "completed",
        progress: 100,
        createdAt: timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
        durationMs: 0,
        operator: "历史数据",
        inputs: { ...node.inputs },
        contextSnapshot: { ...node.contextSnapshot },
        scopeKey: node.scopeKey,
      }, ...timeline],
    };
  }
  if (pending.length > 0) {
    const timestamp = Number(pending[0]?.createdAt) || Date.now();
    return {
      ...state,
      timeline: [{
        id: `${node.id}-legacy`,
        nodeId: node.id,
        title: node.title,
        description: node.description,
        category: node.category,
        status: "completed",
        progress: 100,
        createdAt: timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
        durationMs: 0,
        operator: "历史数据",
        inputs: { ...node.inputs },
        contextSnapshot: { ...node.contextSnapshot },
        scopeKey: node.scopeKey,
      }, ...timeline],
    };
  }
  return seedInitializationState(state, node);
}

// 用户需求点: 自定义阶段直接复用所选预置定义，不允许额外创建名称或描述。
export function selectPresetNodes(nodes, selectedIds) {
  const ids = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  return (Array.isArray(nodes) ? nodes : []).filter((node) => ids.has(node.id));
}

// 用户需求点: 自定义添加阶段是流程出错时的补充后路，同一预置节点可以被重复加入，因此每次选择都要有独立实例。
export function createPresetInstance(node) {
  const sourcePresetId = String(node?.id || "").trim();
  const instanceId = `custom-${sourcePresetId || "release-node"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    ...node,
    id: instanceId,
    sourcePresetId,
    businessLines: Array.isArray(node?.businessLines) ? [...node.businessLines] : [],
    platforms: Array.isArray(node?.platforms) ? [...node.platforms] : [],
    nextNodeIds: Array.isArray(node?.nextNodeIds) ? [...node.nextNodeIds] : [],
    inputSchema: Array.isArray(node?.inputSchema) ? node.inputSchema.map((input) => ({ ...input })) : [],
  };
}

// 用户需求点: 发版时间线必须能回溯每个阶段由谁在何时完成，并展示该阶段耗时。
export function createCompletionMetadata({ operator, startedAt, completedAt } = {}) {
  const start = Number(startedAt);
  const end = Number(completedAt);
  return {
    operator: String(operator || "未记录"),
    startedAt: Number.isFinite(start) ? start : undefined,
    completedAt: Number.isFinite(end) ? end : undefined,
    durationMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined,
  };
}
