import {
  RELEASE_WORKFLOW_CONFIG,
  releaseActionProcessMetadata,
  selectReleaseWorkflow,
  workflowStageNodeIds,
  workflowActionIds,
} from "../../../../shared/release-workflow-config.js";

const PROCESS_ORDER = RELEASE_WORKFLOW_CONFIG.processOrder;
const PROCESS_TITLES = RELEASE_WORKFLOW_CONFIG.processTitles;

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function contextScope(context = {}) {
  return {
    businessLine: normalize(context.businessLine),
    platform: normalize(context.platform),
    version: String(context.version || "").trim(),
    batch: normalize(context.batch || "initial") || "initial",
  };
}

function nodeMatchesContext(node, context) {
  const scope = contextScope(context);
  const snapshot = node?.contextSnapshot || {};
  const businessLines = Array.isArray(node?.businessLines) ? node.businessLines.map(normalize) : [];
  const platforms = Array.isArray(node?.platforms) ? node.platforms.map(normalize) : [];
  return (!businessLines.length || businessLines.includes(scope.businessLine))
    && (!platforms.length || platforms.includes(scope.platform))
    && (!snapshot.businessLine || normalize(snapshot.businessLine) === scope.businessLine)
    && (!snapshot.platform || normalize(snapshot.platform) === scope.platform)
    && (!snapshot.version || String(snapshot.version) === scope.version)
    && (!snapshot.batch || normalize(snapshot.batch) === scope.batch);
}

export function processIdForNode(node = {}, config = RELEASE_WORKFLOW_CONFIG, context = {}) {
  const explicit = normalize(
    node.processId
      || node.process?.id
      || node.workflowProcessId
      || node.stageId
      || node.phaseId,
  );
  if (explicit) return explicit;
  return releaseActionProcessMetadata(node.id, node, config, context).processId;
}

export function processTitleForId(processId) {
  const id = normalize(processId);
  return PROCESS_TITLES[id] || id;
}

function processOrderForNode(node = {}, config = RELEASE_WORKFLOW_CONFIG, context = {}) {
  const explicit = Number(node.processOrder ?? node.process?.order ?? node.workflowProcessOrder ?? node.stageOrder);
  if (Number.isFinite(explicit)) return explicit;
  return releaseActionProcessMetadata(node.id, node, config, context).processOrder;
}

function processRank(processId) {
  const index = PROCESS_ORDER.indexOf(processId);
  return index < 0 ? PROCESS_ORDER.length : index;
}

// 用户需求点: 流程是推荐和状态判断的业务单位，Action 只是流程内有序操作节点。
export function createReleaseProcessStateMachine({ nodes = [], context = {}, config = RELEASE_WORKFLOW_CONFIG } = {}) {
  const scope = contextScope(context);
  const eligibleNodes = (Array.isArray(nodes) ? nodes : [])
    .filter((node) => node && node.id && nodeMatchesContext(node, scope))
    .filter((node) => !["release-management:guide-current-release", "release-management:create-active-release"].includes(node.id))
    .map((node) => ({
      ...node,
      processId: processIdForNode(node, config, scope),
      processOrder: processOrderForNode(node, config, scope),
      processTitle: String(node.processTitle || node.process?.title || processTitleForId(processIdForNode(node, config, scope))).trim(),
    }));
  const workflow = selectReleaseWorkflow(scope, config);
  const activeStages = (workflow?.stages || []).filter((stage) => (
    !Array.isArray(stage.batches) || stage.batches.includes(scope.batch)
  ));
  const configuredActionIds = workflowActionIds(workflow, scope);
  if (workflow) {
    // 用户需求点: 配置引用的节点才是当前业务线、平台和批次的可执行集合，自定义阶段不能平铺整个 catalog。
    const workflowNodes = eligibleNodes.filter((node) => configuredActionIds.has(node.id));
    const byId = new Map(workflowNodes.map((node) => [node.id, node]));
    const processes = activeStages.map((stage, index) => {
      const stageNodes = workflowStageNodeIds(stage).map((id) => byId.get(id)).filter(Boolean);
      return {
        id: stage.id,
        title: stage.title,
        order: index,
        nodeIds: stageNodes.map((node) => node.id),
        nodes: stageNodes,
        optional: stage.optional === true,
        optionalNodeIds: [...(stage.optionalNodeIds || [])],
        nextProcessIds: activeStages.slice(index + 1).map((next) => next.id),
      };
    }).filter((process) => process.nodes.length > 0);
    const nodeToProcess = new Map();
    for (const process of processes) for (const nodeId of process.nodeIds) nodeToProcess.set(nodeId, process.id);
    return {
      context: scope,
      nodes: workflowNodes,
      workflow: {
        id: workflow.id,
        title: workflow.title,
        evidence: { ...workflow.evidence },
      },
      processes,
      nodeToProcess,
    };
  }
  const groups = new Map();
  for (const node of eligibleNodes) {
    if (!groups.has(node.processId)) groups.set(node.processId, []);
    groups.get(node.processId).push(node);
  }
  const processes = [...groups.entries()]
    .map(([id, processNodes]) => {
      const orderedNodes = processNodes
        .slice()
        .sort((a, b) => a.processOrder - b.processOrder || String(a.id).localeCompare(String(b.id)));
      return {
        id,
        title: PROCESS_TITLES[id] || id,
        order: processRank(id),
        nodeIds: orderedNodes.map((node) => node.id),
        nodes: orderedNodes,
      };
    })
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const nodeToProcess = new Map();
  for (const process of processes) for (const nodeId of process.nodeIds) nodeToProcess.set(nodeId, process.id);
  return { context: scope, nodes: eligibleNodes, workflow: null, processes, nodeToProcess };
}

// 用户需求点: 自定义阶段只能从当前业务线、平台和批次对应的流程节点中选择，
// 不能把未纳入当前状态机的 Skill/Action 平铺到候选集合里。
export function selectWorkflowProcessNodes({ machine, nodes = [] } = {}) {
  if (!machine) return [];
  const byId = new Map((Array.isArray(nodes) ? nodes : []).filter((node) => node?.id).map((node) => [node.id, node]));
  const seen = new Set();
  const selected = [];
  for (const process of machine.processes || []) {
    for (const processNode of process.nodes || []) {
      const node = byId.get(processNode.id) || processNode;
      if (!node?.id || seen.has(node.id)) continue;
      seen.add(node.id);
      selected.push({
        ...node,
        workflowProcessId: process.id,
        workflowProcessTitle: process.title,
        workflowProcessOrder: process.order,
      });
    }
  }
  return selected;
}

function recordStatusByNode(timeline, pending) {
  const statuses = new Map();
  for (const item of Array.isArray(timeline) ? timeline : []) {
    if (item?.nodeId) statuses.set(item.nodeId, normalizeNodeStatus(item.status || "completed"));
  }
  for (const item of Array.isArray(pending) ? pending : []) {
    if (!item?.nodeId || !item.status) continue;
    // API hydrate 或旧本地数据可能同时保留完成 timeline 和过期 pending；完成事实优先。
    const existing = statuses.get(item.nodeId);
    if (!existing || existing === "pending") statuses.set(item.nodeId, normalizeNodeStatus(item.status));
  }
  return statuses;
}

function normalizeNodeStatus(status) {
  const value = normalize(status);
  if (["completed", "succeeded", "skipped"].includes(value)) return "completed";
  if (["failed", "external_result_unknown"].includes(value)) return "failed";
  if (["running", "previewing", "awaiting_confirmation", "ready", "blocked"].includes(value)) return "running";
  return "pending";
}

// 用户需求点: 流程状态由流程内节点的实际执行状态推导，失败或执行中不能自动跨到下一流程。
export function deriveProcessStates({ machine, timeline = [], pending = [] } = {}) {
  const statuses = recordStatusByNode(timeline, pending);
  const processStates = new Map();
  for (const process of machine?.processes || []) {
    const optionalIds = new Set(process.optionalNodeIds || []);
    const nodeStatuses = process.nodeIds.filter((nodeId) => !optionalIds.has(nodeId)).map((nodeId) => statuses.get(nodeId) || "pending");
    const optionalStatuses = process.nodeIds.filter((nodeId) => optionalIds.has(nodeId)).map((nodeId) => statuses.get(nodeId) || "pending");
    let state = "pending";
    if (nodeStatuses.some((status) => status === "failed") || optionalStatuses.some((status) => status === "failed")) state = "failed";
    else if (nodeStatuses.some((status) => status === "running") || optionalStatuses.some((status) => status === "running")) state = "running";
    else if (process.optional && optionalStatuses.every((status) => status === "pending") && nodeStatuses.every((status) => status === "pending")) state = "completed";
    else if (nodeStatuses.length > 0 && nodeStatuses.every((status) => status === "completed")) state = "completed";
    processStates.set(process.id, state);
  }
  return processStates;
}

// Exposes the state-machine cursor for the UI and future AgentFlow adapters.
// The cursor describes the current business stage independently of the next
// concrete Action recommended inside that stage.
export function deriveWorkflowCursor({ machine, timeline = [], pending = [] } = {}) {
  const processStates = deriveProcessStates({ machine, timeline, pending });
  const active = (machine?.processes || []).find((process) => {
    const state = processStates.get(process.id);
    return state === "running" || state === "failed" || state === "pending";
  });
  if (!active) {
    return {
      workflowId: machine?.workflow?.id || "",
      workflowTitle: machine?.workflow?.title || "",
      currentProcessId: "",
      currentProcessTitle: "",
      currentState: "completed",
      nextProcessId: "",
      terminal: true,
    };
  }
  const index = machine.processes.indexOf(active);
  const state = processStates.get(active.id) || "pending";
  return {
    workflowId: machine?.workflow?.id || "",
    workflowTitle: machine?.workflow?.title || "",
    currentProcessId: active.id,
    currentProcessTitle: active.title,
    currentState: state,
    nextProcessId: machine.processes[index + 1]?.id || "",
    terminal: false,
  };
}

function completedNodeIds(timeline) {
  return new Set((Array.isArray(timeline) ? timeline : [])
    .filter((item) => normalizeNodeStatus(item?.status || "completed") === "completed")
    .map((item) => item.nodeId));
}

// 用户需求点: 流程未完成时只推荐本流程的下一个节点，只有流程全部完成后才推荐下一流程的首个节点。
export function recommendNextProcessNodes({ machine, timeline = [], pending = [] } = {}) {
  if (!machine) return [];
  const processStates = deriveProcessStates({ machine, timeline, pending });
  const completed = completedNodeIds(timeline);
  const pendingIds = new Set((Array.isArray(pending) ? pending : []).map((item) => item?.nodeId).filter(Boolean));
  for (const process of machine.processes || []) {
    const state = processStates.get(process.id);
    if (state === "failed" || state === "running") return [];
    if (state !== "completed") {
      const optionalIds = new Set(process.optionalNodeIds || []);
      const next = process.nodes.find((node) => !optionalIds.has(node.id) && !completed.has(node.id));
      if (!next || pendingIds.has(next.id)) return [];
      return [next];
    }
  }
  return [];
}

export { PROCESS_ORDER, PROCESS_TITLES };
