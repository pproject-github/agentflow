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
  };
}

// 用户需求点: 初始化节点只在当前版本还没有任何发版状态时自动加入，避免切换页面或刷新后重复插入。
export function seedInitializationState(state, node) {
  if (!state || !node) return state;
  const timeline = Array.isArray(state.timeline) ? state.timeline : [];
  const pending = Array.isArray(state.pending) ? state.pending : [];
  if (timeline.length > 0 || pending.length > 0) return state;
  return {
    ...state,
    pending: [{
      id: "release-initialization-pending",
      nodeId: node.id,
      title: node.title,
      description: node.description,
      category: node.category,
      status: "pending",
      progress: 0,
      createdAt: Date.now(),
      error: "",
      inputs: { ...node.inputs },
    }],
  };
}

// 用户需求点: 历史发版记录也必须以初始化状态作为第一节点，但不能删除或覆盖已有时间线。
export function ensureInitializationFirst(state, node) {
  if (!state || !node) return state;
  const timeline = Array.isArray(state.timeline) ? state.timeline : [];
  const pending = Array.isArray(state.pending) ? state.pending : [];
  const timelineIndex = timeline.findIndex((item) => item?.nodeId === node.id);
  if (timelineIndex >= 0) {
    if (timelineIndex === 0) return state;
    const initialization = timeline[timelineIndex];
    return { ...state, timeline: [initialization, ...timeline.slice(0, timelineIndex), ...timeline.slice(timelineIndex + 1)] };
  }
  const pendingIndex = pending.findIndex((item) => item?.nodeId === node.id);
  if (pendingIndex >= 0) {
    const initialization = pending[pendingIndex];
    if (timeline.length > 0) {
      const first = timeline[0];
      const timestamp = Number(first?.createdAt || first?.startedAt || first?.completedAt) || Date.now();
      return {
        ...state,
        timeline: [{
          ...initialization,
          status: "completed",
          progress: 100,
          createdAt: initialization.createdAt || timestamp,
          startedAt: initialization.startedAt || timestamp,
          completedAt: initialization.completedAt || timestamp,
          durationMs: initialization.durationMs ?? 0,
          operator: initialization.operator || "历史数据",
        }, ...timeline],
        pending: [...pending.slice(0, pendingIndex), ...pending.slice(pendingIndex + 1)],
      };
    }
    if (pendingIndex === 0) return state;
    return { ...state, pending: [initialization, ...pending.slice(0, pendingIndex), ...pending.slice(pendingIndex + 1)] };
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
      }, ...timeline],
    };
  }
  if (pending.length > 0) {
    return {
      ...state,
      pending: [{
        id: `${node.id}-legacy-pending`,
        nodeId: node.id,
        title: node.title,
        description: node.description,
        category: node.category,
        status: "pending",
        progress: 0,
        createdAt: Date.now(),
        operator: "未记录",
        inputs: { ...node.inputs },
      }, ...pending],
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
