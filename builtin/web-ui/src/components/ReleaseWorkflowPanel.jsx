import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getReleaseNodes, inferReleaseContext, runReleaseNode } from "../lib/releaseNodeCatalog.js";
import { createCompletionMetadata, createInitializationNode, createInitializationPreparationNode, createPresetInstance, defaultInputsForNode, ensureInitializationFirst, externalInputSchemaForNode, normalizeCompositeSteps, removePendingNode, resolveReleaseContext, seedInitializationPreparationState, seedNextRecommendations } from "../lib/releaseWorkflowModel.js";
import { createReleaseProcessStateMachine, processTitleForId, selectWorkflowProcessNodes } from "../lib/releaseWorkflowStateMachine.js";
import ReleaseNodeInspector from "./ReleaseNodeInspector.jsx";

function emptyState() {
  return { timeline: [], pending: [], dismissedNodeIds: [], customNodes: [] };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function timestampValue(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
}

function safeInputs(value) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, entry]) =>
    typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"));
}

function normalizeTimelineItem(value, index) {
  if (!isRecord(value) || typeof value.nodeId !== "string" || !value.nodeId.trim()) return null;
  const nodeId = value.nodeId.trim();
  return {
    id: stringValue(value.id).trim() || `${nodeId}-timeline-${index}`,
    nodeId,
    title: stringValue(value.title, nodeId),
    description: stringValue(value.description),
    category: stringValue(value.category, "发版阶段"),
    status: "completed",
    progress: 100,
    createdAt: timestampValue(value.createdAt),
    startedAt: timestampValue(value.startedAt),
    completedAt: timestampValue(value.completedAt),
    failedAt: timestampValue(value.failedAt),
    durationMs: Number.isFinite(Number(value.durationMs)) ? Number(value.durationMs) : undefined,
    operator: stringValue(value.operator, "未记录"),
    runId: stringValue(value.runId),
    message: stringValue(value.message),
    error: stringValue(value.error),
    inputs: safeInputs(value.inputs),
    output: value.output,
    logs: Array.isArray(value.logs) ? value.logs : value.log,
    action: stringValue(value.action),
    skill: stringValue(value.skill),
    preview: value.preview,
    confirmationFingerprint: stringValue(value.confirmationFingerprint),
    scopeKey: stringValue(value.scopeKey),
    contextSnapshot: isRecord(value.contextSnapshot) ? { ...value.contextSnapshot } : undefined,
    processId: stringValue(value.processId),
    processOrder: Number.isFinite(Number(value.processOrder)) ? Number(value.processOrder) : undefined,
    processTitle: stringValue(value.processTitle),
    workflowId: stringValue(value.workflowId),
    templateId: stringValue(value.templateId),
    templateStepId: stringValue(value.templateStepId),
    kind: stringValue(value.kind),
    compositeId: stringValue(value.compositeId),
    details: isRecord(value.details) ? { ...value.details, steps: normalizeCompositeSteps(value.details.steps) } : undefined,
  };
}

function normalizePendingItem(value, index) {
  if (!isRecord(value) || typeof value.nodeId !== "string" || !value.nodeId.trim()) return null;
  const nodeId = value.nodeId.trim();
  const status = ["pending", "running", "failed"].includes(value.status) ? value.status : "pending";
  return {
    id: stringValue(value.id).trim() || `${nodeId}-pending-${index}`,
    nodeId,
    title: stringValue(value.title, nodeId),
    description: stringValue(value.description),
    category: stringValue(value.category, "发版阶段"),
    // 正在执行的节点必须保持运行态；否则刷新后会被误判为待执行并暴露删除操作。
    status,
    progress: Math.min(Math.max(Number(value.progress) || 0, 0), 100),
    createdAt: timestampValue(value.createdAt) || Date.now(),
    startedAt: timestampValue(value.startedAt),
    completedAt: timestampValue(value.completedAt),
    failedAt: timestampValue(value.failedAt),
    operator: stringValue(value.operator, "未记录"),
    runId: stringValue(value.runId),
    error: stringValue(value.error),
    message: stringValue(value.message),
    inputs: safeInputs(value.inputs),
    output: value.output,
    logs: Array.isArray(value.logs) ? value.logs : value.log,
    action: stringValue(value.action),
    skill: stringValue(value.skill),
    preview: value.preview,
    confirmationFingerprint: stringValue(value.confirmationFingerprint),
    scopeKey: stringValue(value.scopeKey),
    contextSnapshot: isRecord(value.contextSnapshot) ? { ...value.contextSnapshot } : undefined,
    processId: stringValue(value.processId),
    processOrder: Number.isFinite(Number(value.processOrder)) ? Number(value.processOrder) : undefined,
    processTitle: stringValue(value.processTitle),
    workflowId: stringValue(value.workflowId),
    templateId: stringValue(value.templateId),
    templateStepId: stringValue(value.templateStepId),
    kind: stringValue(value.kind),
    compositeId: stringValue(value.compositeId),
    details: isRecord(value.details) ? { ...value.details, steps: normalizeCompositeSteps(value.details.steps) } : undefined,
  };
}

function normalizeCustomNode(value) {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim() || !value.id.startsWith("custom-") || typeof value.title !== "string" || !value.title.trim()) return null;
  const asStringArray = (entry) => Array.isArray(entry) ? entry.filter((item) => typeof item === "string" && item.trim()) : [];
  return {
    id: value.id,
    title: value.title,
    description: stringValue(value.description, "自定义发版阶段"),
    skill: stringValue(value.skill, "custom"),
    category: stringValue(value.category, "自定义阶段"),
    businessLines: asStringArray(value.businessLines),
    platforms: asStringArray(value.platforms),
    sourcePresetId: stringValue(value.sourcePresetId),
    templateId: stringValue(value.templateId),
    templateStepId: stringValue(value.templateStepId),
    templateStepIndex: Number.isFinite(Number(value.templateStepIndex)) ? Number(value.templateStepIndex) : undefined,
    durationMs: Number.isFinite(Number(value.durationMs)) ? Number(value.durationMs) : 600,
    nextNodeIds: asStringArray(value.nextNodeIds),
    inputSchema: Array.isArray(value.inputSchema) ? value.inputSchema.filter(isRecord).map((input) => ({ ...input })) : [],
    scopeKey: stringValue(value.scopeKey),
    contextSnapshot: isRecord(value.contextSnapshot) ? { ...value.contextSnapshot } : undefined,
    processId: stringValue(value.processId),
    processOrder: Number.isFinite(Number(value.processOrder)) ? Number(value.processOrder) : undefined,
    processTitle: stringValue(value.processTitle),
    workflowId: stringValue(value.workflowId),
  };
}

function uniqueByNodeId(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.nodeId)) return false;
    seen.add(item.nodeId);
    return true;
  });
}

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function workspaceIdentity(workspace) {
  if (workspace == null) return "workspace";
  if (typeof workspace === "string") return workspace;
  return workspace.id || workspace.path || workspace.repoUrl || workspace.label || "workspace";
}

function storageKey(workspace, context) {
  return ["agentflow-release", workspaceIdentity(workspace), context.businessLine, context.platform, context.version, context.batch || "initial"]
    .map((value) => encodeURIComponent(String(value || "")))
    .join(":");
}

function readState(key, catalogNodeIds = null) {
  if (typeof window === "undefined" || !window.localStorage) return emptyState();
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || "null");
    if (!isRecord(value)) return emptyState();
    const customNodes = uniqueById(Array.isArray(value.customNodes) ? value.customNodes.map(normalizeCustomNode).filter(Boolean) : []);
    const knownNodeIds = catalogNodeIds ? new Set([...catalogNodeIds, ...customNodes.map((item) => item.id)]) : null;
    const timeline = uniqueByNodeId(Array.isArray(value.timeline) ? value.timeline.map(normalizeTimelineItem).filter(Boolean) : [])
      .filter((item) => !knownNodeIds || knownNodeIds.has(item.nodeId));
    const completedIds = new Set(timeline.map((item) => item.nodeId));
    const pending = uniqueByNodeId(Array.isArray(value.pending) ? value.pending.map(normalizePendingItem).filter(Boolean) : [])
      .filter((item) => !completedIds.has(item.nodeId) && (!knownNodeIds || knownNodeIds.has(item.nodeId)));
    return {
      context: isRecord(value.context) ? { ...value.context } : undefined,
      workflowId: stringValue(value.workflowId),
      timeline,
      pending,
      dismissedNodeIds: Array.isArray(value.dismissedNodeIds)
        ? [...new Set(value.dismissedNodeIds.map((item) => String(item || "").trim()).filter(Boolean))]
        : [],
      customNodes,
    };
  } catch {
    return emptyState();
  }
}

function itemId(nodeId) {
  return `${nodeId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function statusLabel(status) {
  return { completed: "已完成", running: "执行中", failed: "失败", pending: "待执行" }[status] || status;
}

function formatDateTime(value) {
  const timestamp = timestampValue(value);
  if (!timestamp) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function formatDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) return "未记录";
  if (duration < 1000) return `${duration}ms`;
  return `${(duration / 1000).toFixed(duration >= 10000 ? 0 : 1)}s`;
}

function compositeDetailsFromResult(result, node, existing = {}) {
  if (node?.kind !== "composite" && existing?.steps?.length) return existing;
  const explicit = result?.details?.steps || result?.result?.details?.steps || result?.result?.steps || result?.steps;
  if (Array.isArray(explicit)) return { ...existing, steps: normalizeCompositeSteps(explicit) };
  const graph = result?.result?.graph || result?.graph;
  const instances = graph?.instances;
  if (!instances || !Array.isArray(node?.actions)) return existing;
  const steps = node.actions.map((action, index) => {
    const instance = instances[`composite_${action.stepId || index}`] || {};
    return {
      stepId: action.stepId,
      actionId: action.id,
      title: action.title,
      status: instance.status || "completed",
      runId: instance.runId,
      output: instance.output,
      error: instance.error || "",
    };
  });
  return { ...existing, steps: normalizeCompositeSteps(steps) };
}

// 用户需求点: 已完成阶段不依赖横向拖动，要按执行顺序蛇形换行并保持连续方向轨迹。
function groupCompletedTimelineRows(items, rowSize = 3) {
  const rows = [];
  for (let index = 0; index < items.length; index += rowSize) {
    rows.push(items.slice(index, index + rowSize));
  }
  return rows;
}

// 用户需求点: 新增或推荐的 Create Release Branch 节点要直接带上标准分支名，操作员仍可在输入框中覆盖它。
function makePending(node, inputs = {}, context = {}) {
  return {
    id: itemId(node.id), nodeId: node.id, title: node.title, description: node.description,
    category: node.category, status: "pending", progress: 0, createdAt: Date.now(), error: "", operator: "未记录", inputs: defaultInputsForNode(node, safeInputs(inputs)),
    scopeKey: node.scopeKey || `${context.businessLine}/${context.platform}/${context.version}/${context.batch || "initial"}`,
    contextSnapshot: { ...context },
    processId: node.processId || "",
    processOrder: Number.isFinite(Number(node.processOrder)) ? Number(node.processOrder) : undefined,
    processTitle: node.processTitle || processTitleForId(node.processId),
    workflowId: node.workflowId || "",
    templateId: node.templateId || "",
    templateStepId: node.templateStepId || "",
    kind: node.kind || "",
    compositeId: node.compositeId || "",
    details: node.kind === "composite" ? { steps: [] } : undefined,
  };
}

function itemMatchesContext(item, context) {
  if (!item?.scopeKey) return true;
  return item.scopeKey === `${context.businessLine}/${context.platform}/${context.version}/${context.batch || "initial"}`;
}

function validateNodeInputs(node, item) {
  for (const schema of node?.inputSchema || []) {
    // 服务端旧快照或异步回填可能暂时没有保存输入；执行时应使用节点定义的默认值，
    // 否则页面虽显示默认参数，校验却仍会把它当成空值并提前返回，用户看起来像点击无反应。
    const value = item?.inputs?.[schema.key] ?? schema.defaultValue;
    if (schema.required && (value === undefined || value === null || String(value).trim() === "")) {
      return `请填写${schema.label}`;
    }
    if (schema.type === "number" && value !== undefined && String(value).trim() !== "") {
      const numberValue = Number(value);
      if (!Number.isFinite(numberValue)
        || (schema.integer && !Number.isInteger(numberValue))
        || (schema.min !== undefined && numberValue < schema.min)
        || (schema.max !== undefined && numberValue > schema.max)) {
        return `${schema.label}需为 ${schema.min}~${schema.max} 的整数`;
      }
    }
  }
  return "";
}

export default function ReleaseWorkflowPanel({ workspace, releaseContext: navigationContext, operator = "未记录" }) {
  const inferred = useMemo(() => navigationContext
    ? resolveReleaseContext(workspace || {}, navigationContext)
    : inferReleaseContext(workspace || {}), [navigationContext, workspace]);
  const initialNode = useMemo(() => createInitializationNode(inferred, workspace), [inferred, workspace]);
  const initialPreparationNode = useMemo(() => createInitializationPreparationNode(inferred, workspace), [inferred, workspace]);
  const context = inferred;
  const [state, setState] = useState(() => seedNextRecommendations(
    seedInitializationPreparationState(
      ensureInitializationFirst(
        readState(
          storageKey(workspace, inferred),
          new Set([initialNode.id, initialPreparationNode.id, ...getReleaseNodes(inferred).map((node) => node.id)]),
        ),
        initialNode,
      ),
      initialNode,
      initialPreparationNode,
    ),
    [initialNode, initialPreparationNode, ...getReleaseNodes(inferred)],
  ));
  const [storageWarning, setStorageWarning] = useState("");
  const [message, setMessage] = useState("");
  const [selfTestFailure, setSelfTestFailure] = useState(false);
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [remoteCatalog, setRemoteCatalog] = useState([]);
  const [inspector, setInspector] = useState(null);
  const controllers = useRef(new Map());
  const hydratedKey = useRef("");
  const activeKeyRef = useRef("");
  const runGenerationRef = useRef(0);
  const runSequenceRef = useRef(0);
  // 用户需求点: 本地新增或执行阶段后，迟到的远程旧状态不能覆盖当前发版操作结果。
  const localMutationRef = useRef(false);

  const key = useMemo(() => storageKey(workspace, context), [workspace, context]);
  activeKeyRef.current = key;
  const catalogNodes = useMemo(() => remoteCatalog.length > 0 ? remoteCatalog : getReleaseNodes(context), [context, remoteCatalog]);
  const workflowMachine = useMemo(() => createReleaseProcessStateMachine({ context, nodes: catalogNodes }), [catalogNodes, context]);
  const customNodeOptions = useMemo(() => selectWorkflowProcessNodes({ machine: workflowMachine, nodes: catalogNodes }), [catalogNodes, workflowMachine]);
  const customNodeGroups = useMemo(() => {
    const groups = [];
    const byProcess = new Map();
    for (const node of customNodeOptions) {
      const processId = node.workflowProcessId || node.processId || "other";
      let group = byProcess.get(processId);
      if (!group) {
        group = { id: processId, title: node.workflowProcessTitle || node.processTitle || processTitleForId(processId), nodes: [] };
        byProcess.set(processId, group);
        groups.push(group);
      }
      group.nodes.push(node);
    }
    return groups;
  }, [customNodeOptions]);
  const initializationNode = useMemo(() => createInitializationNode(context, workspace), [context, workspace]);
  const initializationPreparationNode = useMemo(() => createInitializationPreparationNode(context, workspace), [context, workspace]);
  const allNodes = useMemo(() => [initializationNode, initializationPreparationNode, ...catalogNodes, ...state.customNodes], [catalogNodes, initializationNode, initializationPreparationNode, state.customNodes]);
  const knownNodeIds = useMemo(() => new Set(allNodes.map((node) => node.id)), [allNodes]);
  const visibleState = useMemo(() => {
    const timeline = state.timeline.filter((item) => knownNodeIds.has(item.nodeId) && itemMatchesContext(item, context));
    const completedIds = new Set(timeline.map((item) => item.nodeId));
    const pending = state.pending
      .filter((item) => knownNodeIds.has(item.nodeId) && itemMatchesContext(item, context) && !completedIds.has(item.nodeId));
    return { ...state, timeline, pending };
  }, [context, knownNodeIds, state]);
  const nodeById = useMemo(() => new Map(allNodes.map((node) => [node.id, node])), [allNodes]);
  const completedRows = useMemo(() => groupCompletedTimelineRows(visibleState.timeline), [visibleState.timeline]);
  const runningCount = visibleState.pending.filter((item) => item.status === "running").length;

  useEffect(() => {
    hydratedKey.current = "";
    const loaded = readState(key, new Set([initializationNode.id, initializationPreparationNode.id, ...catalogNodes.map((node) => node.id)]));
    if (!localMutationRef.current) {
      setState(seedNextRecommendations(seedInitializationPreparationState(ensureInitializationFirst(loaded, initializationNode), initializationNode, initializationPreparationNode), [initializationNode, initializationPreparationNode, ...catalogNodes]));
    }
    setStorageWarning("");
  }, [catalogNodes, initializationNode, initializationPreparationNode, key]);

  useEffect(() => {
    localMutationRef.current = false;
  }, [key]);

  useEffect(() => {
    setState((previous) => seedNextRecommendations(
      { ...previous, context: { ...context } },
      [initializationNode, initializationPreparationNode, ...catalogNodes],
    ));
  }, [catalogNodes, context, initializationNode, initializationPreparationNode]);

  useEffect(() => () => {
    runGenerationRef.current += 1;
    controllers.current.forEach((entry) => entry.controller?.abort());
    controllers.current.clear();
  }, [key]);

  useEffect(() => {
    if (hydratedKey.current !== key) {
      hydratedKey.current = key;
      return;
    }
    if (typeof window === "undefined" || !window.localStorage) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
      setStorageWarning("");
    } catch {
      setStorageWarning("本地状态暂不可保存");
    }
  }, [key, state]);

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({
      workspaceId: workspaceIdentity(workspace),
      workspacePath: workspace?.path || "",
      businessLine: context.businessLine,
      platform: context.platform,
      version: context.version,
      batch: context.batch || "initial",
    });
    Promise.all([
      fetch(`/api/release/catalog?${query.toString()}`).then((response) => response.ok ? response.json() : null).catch(() => null),
      fetch(`/api/release/state?${query.toString()}`).then((response) => response.ok ? response.json() : null).catch(() => null),
    ]).then(([catalogPayload, statePayload]) => {
      if (cancelled) return;
      if (Array.isArray(catalogPayload?.nodes) && catalogPayload.nodes.length > 0) setRemoteCatalog(catalogPayload.nodes);
      if (statePayload?.state && isRecord(statePayload.state)) {
        setState((previous) => seedNextRecommendations(
          // 用户需求点: 用户操作优先，避免网络较慢时服务端旧快照抹掉刚添加或正在执行的节点。
          localMutationRef.current ? previous :
          seedInitializationPreparationState(ensureInitializationFirst((() => {
            const remoteState = statePayload.state;
            const sourceNodes = Array.isArray(catalogPayload?.nodes) && catalogPayload.nodes.length > 0 ? catalogPayload.nodes : catalogNodes;
            const knownIds = new Set([
              initializationNode.id,
              initializationPreparationNode.id,
              ...sourceNodes.map((node) => node.id),
              ...(Array.isArray(previous.customNodes) ? previous.customNodes : []).map((node) => node.id),
            ]);
            const remoteTimeline = (Array.isArray(remoteState.timeline) ? remoteState.timeline : [])
              .map(normalizeTimelineItem)
              .filter(Boolean)
              .filter((item) => knownIds.has(item.nodeId) && itemMatchesContext(item, context));
            const completedIds = new Set(remoteTimeline.map((item) => item.nodeId));
            const remotePending = (Array.isArray(remoteState.pending) ? remoteState.pending : [])
              .map(normalizePendingItem)
              .filter(Boolean)
              .filter((item) => knownIds.has(item.nodeId) && itemMatchesContext(item, context) && !completedIds.has(item.nodeId));
            // customNodes 尚未由后端持久化，保留本地自定义节点及其待执行实例。
            const localCustomNodes = Array.isArray(previous.customNodes) ? previous.customNodes : [];
            const localCustomPending = (Array.isArray(previous.pending) ? previous.pending : [])
              .filter((item) => localCustomNodes.some((node) => node.id === item.nodeId));
            return {
              ...previous,
              ...remoteState,
              timeline: remoteTimeline,
              pending: uniqueByNodeId([...remotePending, ...localCustomPending]),
              customNodes: localCustomNodes,
              context: { ...context },
            };
          })(), initializationNode), initializationNode, initializationPreparationNode),
          [initializationNode, initializationPreparationNode, ...(Array.isArray(catalogPayload?.nodes) && catalogPayload.nodes.length > 0 ? catalogPayload.nodes : catalogNodes)],
        ));
      }
    });
    return () => { cancelled = true; };
  }, [catalogNodes, context, initializationNode, initializationPreparationNode, workspace]);

  // 用户需求点: 节点详情必须反映最新运行态，完成后立即切换为只读，不能继续显示执行按钮。
  useEffect(() => {
    setInspector((previous) => {
      if (!previous?.item?.id) return previous;
      const latest = [...(Array.isArray(state.timeline) ? state.timeline : []), ...(Array.isArray(state.pending) ? state.pending : [])]
        .find((entry) => entry.id === previous.item.id);
      if (!latest) return previous;
      const mode = latest.status === "completed" ? "completed" : latest.status === "failed" ? "failed" : "pending";
      return previous.item === latest && previous.mode === mode ? previous : { ...previous, item: latest, mode };
    });
  }, [state]);

  const executeNode = useCallback(async (item) => {
    if (!item || item.status === "completed" || controllers.current.has(item.id)) return;
    const node = nodeById.get(item.nodeId);
    if (!node) {
      setMessage(`${item.title || item.nodeId || "发版节点"} 定义已失效，请刷新节点列表后重试`);
      return;
    }
    if (!itemMatchesContext(item, context) || (node.scopeKey && node.scopeKey !== `${context.businessLine}/${context.platform}/${context.version}/${context.batch || "initial"}`)) {
      setMessage("节点不属于当前业务、平台和版本上下文");
      return;
    }
    const normalizedInputs = defaultInputsForNode(node, item.inputs || {}, context);
    const executionItem = normalizedInputs === item.inputs ? item : { ...item, inputs: normalizedInputs };
    const inputError = validateNodeInputs(node, executionItem);
    if (inputError) {
      setMessage(inputError);
      return;
    }
    const runKey = key;
    const runGeneration = runGenerationRef.current;
    const runToken = ++runSequenceRef.current;
    const isCurrentRun = () => runKey === activeKeyRef.current && runGeneration === runGenerationRef.current;
    const controller = new AbortController();
    const startedAt = Date.now();
    localMutationRef.current = true;
    controllers.current.set(item.id, { controller, token: runToken });
    setState((previous) => seedNextRecommendations({
      ...previous,
      pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, inputs: normalizedInputs, status: "running", startedAt, completedAt: undefined, failedAt: undefined, error: "", progress: 0, operator } : entry),
    }, [initializationNode, initializationPreparationNode, ...catalogNodes]));
    try {
      const actionId = node.sourcePresetId || node.id;
      const requestPayload = {
        workspaceId: workspaceIdentity(workspace),
        workspacePath: workspace?.path || "",
        businessLine: context.businessLine,
        platform: context.platform,
        version: context.version,
        batch: context.batch || "initial",
        actionId,
        itemId: item.id,
        inputs: normalizedInputs,
        confirmationFingerprint: item.confirmationFingerprint || "",
        scopeKey: node.scopeKey || `${context.businessLine}/${context.platform}/${context.version}/${context.batch || "initial"}`,
        processId: node.processId || item.processId || "",
        ...(node.kind === "composite" && (item.status === "failed" || item.retrying)
          ? { resumeFromStep: item.details?.steps?.find((step) => step.status === "failed")?.stepId || "" }
          : {}),
      };
      let result;
      let runDetails;
      if (typeof fetch === "function" && node.skill !== "custom") {
        if (node.requiresConfirmation && !item.confirmationFingerprint) {
          const previewResponse = await fetch("/api/release/nodes/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestPayload), signal: controller.signal });
          const previewPayload = await previewResponse.json().catch(() => ({}));
          if (!previewResponse.ok) throw new Error(previewPayload.error || `HTTP ${previewResponse.status}`);
          // 活动发版已存在时，服务端会在 preview 请求中直接幂等复用并返回 completed。
          // 不能把这个完成结果误当成普通预览，否则节点会一直停留在待执行，看起来像点击无反应。
          if (previewPayload.status !== "completed") {
            setState((previous) => ({ ...previous, pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, status: "pending", preview: previewPayload.preview, confirmationFingerprint: previewPayload.confirmationFingerprint, runId: previewPayload.runId || entry.runId } : entry) }));
            setInspector((previous) => previous?.item?.id === item.id ? { ...previous, item: { ...previous.item, status: "pending", preview: previewPayload.preview, confirmationFingerprint: previewPayload.confirmationFingerprint, runId: previewPayload.runId || previous.item.runId } } : previous);
            setMessage("预览已生成，请在节点详情中确认后执行");
            controllers.current.delete(item.id);
            return;
          }
          const rawMessage = previewPayload.message || previewPayload.result?.output || previewPayload.result?.message;
          result = {
            ...previewPayload,
            runId: previewPayload.runId,
            message: typeof rawMessage === "string" && rawMessage.trim() ? rawMessage : `${node.title} 已完成`,
            output: previewPayload.result?.output || previewPayload.result,
            details: compositeDetailsFromResult(previewPayload, node, previewPayload.details || {}),
          };
        }
        if (!result) {
          const response = await fetch("/api/release/nodes/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestPayload), signal: controller.signal });
          const payload = await response.json().catch(() => ({}));
          runDetails = payload.details || payload.result?.details || (Array.isArray(payload.result?.steps) ? { steps: payload.result.steps } : undefined);
          if (!response.ok) {
            const error = new Error(payload.error || `HTTP ${response.status}`);
            error.details = runDetails;
            throw error;
          }
          // 用户需求点: AgentFlow 返回的 graph 是对象，页面提示和时间线消息必须始终是可渲染文本，不能把运行图对象直接交给 React。
          const rawMessage = payload.message || payload.result?.output || payload.result?.message;
          result = {
            ...payload,
            runId: payload.runId,
            message: typeof rawMessage === "string" && rawMessage.trim() ? rawMessage : `${node.title} 已完成`,
            output: payload.result?.output || payload.result?.graph || payload.result,
            details: compositeDetailsFromResult(payload, node, runDetails || {}),
          };
        }
      } else {
        result = await runReleaseNode(node, { ...context, inputs: item.inputs, simulateFailure: selfTestFailure }, {
        signal: controller.signal,
        onRunStart: (runId) => {
          if (!isCurrentRun()) return;
          setState((previous) => ({
            ...previous,
            pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, runId } : entry),
          }));
        },
        onProgress: (progress) => {
          if (!isCurrentRun()) return;
          setState((previous) => ({ ...previous, pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, progress } : entry) }));
        },
        });
      }
      // 工作空间列表异步回填时可能只改变了前端 storage key；只要本次请求没有被取消，
      // 仍应提交 AgentFlow 已返回的结果，不能静默丢弃导致节点看起来没有反应。
      if (controller.signal.aborted) return;
      setState((previous) => {
        const completed = previous.timeline.some((entry) => (entry.nodeId || entry.id) === node.id);
        const currentItem = previous.pending.find((entry) => entry.id === item.id) || item;
        const persistedItem = { ...currentItem, retrying: undefined };
        const completedAt = Date.now();
        const currentOperator = currentItem.operator && currentItem.operator !== "未记录" ? currentItem.operator : operator;
        const timeline = completed ? previous.timeline : [...previous.timeline, {
          ...persistedItem,
          kind: currentItem.kind || node.kind || "",
          compositeId: currentItem.compositeId || node.compositeId || "",
          details: currentItem.kind === "composite" || node.kind === "composite"
            ? compositeDetailsFromResult(result, node, { ...(currentItem.details || {}), ...(result.details || {}) })
            : currentItem.details,
          processId: currentItem.processId || node.processId || "",
          processOrder: currentItem.processOrder ?? node.processOrder,
          processTitle: currentItem.processTitle || node.processTitle || processTitleForId(node.processId),
          workflowId: currentItem.workflowId || node.workflowId || previous.workflowId || "",
          scopeKey: currentItem.scopeKey || node.scopeKey || `${context.businessLine}/${context.platform}/${context.version}/${context.batch || "initial"}`,
          status: "completed",
          progress: 100,
          message: result.message,
          output: result.result || result.output || result.graph || result,
          logs: result.logs || result.events || [],
          runId: result.runId || currentItem.runId,
          ...createCompletionMetadata({ operator: currentOperator, startedAt: currentItem.startedAt || startedAt, completedAt }),
        }];
        const pending = previous.pending.filter((entry) => entry.id !== item.id);
        return seedNextRecommendations(
          {
            ...previous,
            timeline,
            pending,
            context: { ...context },
            ...(node.id === initializationPreparationNode.id
              ? { initialization: { status: "completed", preparationNodeId: initializationPreparationNode.id } }
              : {}),
          },
          [initializationNode, initializationPreparationNode, ...catalogNodes],
        );
      });
      setMessage(result.message || `${node.title} 已完成`);
    } catch (error) {
      if (error?.name === "AbortError") return;
      setState((previous) => seedNextRecommendations({
        ...previous,
        pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, status: "failed", error: String(error?.message || error || "执行失败"), failedAt: Date.now(), operator: entry.operator || operator, details: entry.kind === "composite" ? compositeDetailsFromResult({ details: error?.details }, node, entry.details || {}) : entry.details } : entry),
      }, [initializationNode, initializationPreparationNode, ...catalogNodes]));
      setMessage(`${node.title} 执行失败`);
    } finally {
      if (controllers.current.get(item.id)?.token === runToken) controllers.current.delete(item.id);
    }
  }, [catalogNodes, context, initializationNode, initializationPreparationNode, key, nodeById, operator, selfTestFailure]);

  const cancelNode = useCallback((item) => {
    localMutationRef.current = true;
    controllers.current.get(item?.id)?.controller?.abort();
    if (item?.runId) {
      void fetch("/api/release/runs/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: item.runId }) }).catch(() => {});
    }
    if (!item) return;
    setState((previous) => seedNextRecommendations({
      ...previous,
      pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, status: "pending", progress: 0, error: "" } : entry),
    }, [initializationNode, initializationPreparationNode, ...catalogNodes]));
    setMessage(`${item.title} 已取消`);
  }, [catalogNodes, initializationNode, initializationPreparationNode]);

  const retryNode = useCallback((item) => {
    if (!item || item.status !== "failed") return;
    localMutationRef.current = true;
    // 保留 failed 标记传给 executeNode，使复合流程可以携带 resumeFromStep；
    // UI 状态仍立即切换为 pending，避免用户重复点击。
    const retryItem = { ...item, status: "failed", retrying: true, error: "", failedAt: undefined, progress: 0 };
    const pending = { ...retryItem, status: "pending" };
    setState((previous) => seedNextRecommendations({
      ...previous,
      pending: previous.pending.map((entry) => entry.id === item.id ? pending : entry),
    }, [initializationNode, initializationPreparationNode, ...catalogNodes]));
    void executeNode(retryItem);
  }, [catalogNodes, initializationNode, initializationPreparationNode, executeNode]);

  const deleteNode = useCallback(async (item) => {
    if (!item || item.status === "running" || String(item.nodeId || "").startsWith("custom-")) return;
    const query = new URLSearchParams({
      businessLine: context.businessLine,
      platform: context.platform,
      version: context.version,
      batch: context.batch || "initial",
      workspaceId: workspaceIdentity(workspace),
    });
    localMutationRef.current = true;
    try {
      const response = await fetch(`/api/release/pending/${encodeURIComponent(item.id)}?${query.toString()}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setState((previous) => seedNextRecommendations(
        removePendingNode(previous, item),
        [initializationNode, initializationPreparationNode, ...catalogNodes],
      ));
      setInspector((previous) => previous?.item?.id === item.id ? null : previous);
      setMessage(`${item.title} 已删除`);
    } catch (error) {
      setMessage(String(error?.message || error));
    }
  }, [catalogNodes, context.batch, context.businessLine, context.platform, context.version, initializationNode, initializationPreparationNode, workspace]);

  const updateNodeInput = useCallback((itemIdValue, inputKey, value) => {
    localMutationRef.current = true;
    setState((previous) => ({
      ...previous,
      pending: previous.pending.map((entry) => entry.id === itemIdValue
        ? { ...entry, inputs: { ...entry.inputs, [inputKey]: value }, error: entry.status === "failed" ? "" : entry.error }
        : entry),
    }));
  }, []);

  const renderNodeInputs = (node, item) => externalInputSchemaForNode(node).length > 0 ? (() => {
    // 历史状态可能保存了工程绝对路径；卡片展示必须与执行前归一化保持一致，避免用户继续提交旧值。
    const renderedInputs = defaultInputsForNode(node, item.inputs || {}, context);
    return <div className="af-release-node__inputs">
      {externalInputSchemaForNode(node).map((schema) => (
        <label key={schema.key}>
          <span>{schema.label}{schema.required ? " *" : ""}</span>
          <input
            type={schema.type || "text"}
            min={schema.min}
            max={schema.max}
            step={schema.step}
            placeholder={schema.placeholder}
            value={renderedInputs?.[schema.key] ?? schema.defaultValue ?? ""}
            disabled={item.status === "running"}
            onChange={(event) => updateNodeInput(item.id, schema.key, event.target.value)}
          />
        </label>
      ))}
    </div>;
  })() : null;

  const renderInitializationContext = (item) => item.nodeId === initializationNode.id || item.nodeId === initializationPreparationNode.id ? (
    <div className="af-release-context-chips">
      <span>{context.businessLine}</span><span>{context.platform}</span><span>{context.version}</span>
    </div>
  ) : null;

  // 用户需求点: 自定义添加阶段是补充流程的后路，同一预置节点可以反复选择并生成独立待执行卡片。
  const addPresetNode = useCallback((preset) => {
    if (!preset) return;
    localMutationRef.current = true;
    const node = createPresetInstance(preset);
    setState((previous) => ({
      ...previous,
      customNodes: [...previous.customNodes, node],
      pending: [...previous.pending, makePending(node, {}, context)],
    }));
    setAddNodeOpen(false);
    setMessage(`${node.title} 已加入待执行阶段`);
  }, [context]);

  const openInspector = useCallback((item) => {
    const node = nodeById.get(item?.nodeId);
    if (!item || !node) return;
    setInspector({ item, node, mode: item.status === "completed" ? "completed" : item.status === "failed" ? "failed" : "pending" });
  }, [nodeById]);

  const saveInspectorItem = useCallback(async (nextItem) => {
    if (!nextItem || nextItem.status === "completed") return;
    const query = new URLSearchParams({ businessLine: context.businessLine, platform: context.platform, version: context.version, batch: context.batch || "initial", workspaceId: workspaceIdentity(workspace) });
    try {
      const response = await fetch(`/api/release/pending/${encodeURIComponent(nextItem.id)}?${query.toString()}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inputs: nextItem.inputs || {} }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setState((previous) => ({ ...previous, pending: previous.pending.map((entry) => entry.id === nextItem.id ? { ...entry, inputs: nextItem.inputs || {} } : entry) }));
      setInspector((previous) => previous ? { ...previous, item: { ...previous.item, inputs: nextItem.inputs || {} } } : previous);
      setMessage("节点参数已保存");
    } catch (error) {
      setMessage(String(error?.message || error));
    }
  }, [context.batch, context.businessLine, context.platform, context.version, workspace]);

  const runInspectorItem = useCallback((nextItem) => {
    const localOnly = nextItem?.nodeId === initializationPreparationNode.id
      || String(nextItem?.nodeId || "").startsWith("custom-");
    void (localOnly ? Promise.resolve() : saveInspectorItem(nextItem)).then(() => executeNode(nextItem));
  }, [executeNode, initializationPreparationNode.id, saveInspectorItem]);

  return (
    <section className="af-release-panel">
      <header className="af-release-context">
        <div className="af-release-context__identity"><span className="af-release-eyebrow">发版时间线</span><h2>{workspace?.label || workspace?.name || "当前工作空间"}</h2><small>{workspace?.path || workspace?.repoUrl || "本地发版时间线"}</small><div className="af-release-context-chips"><span>{context.businessLine}</span><span>{context.platform}</span><span>{context.version}</span></div></div>
        <div className="af-release-counts"><span>已完成 {visibleState.timeline.length}</span><span>待执行 {visibleState.pending.filter((item) => item.status === "pending").length}</span><span>执行中 {runningCount}</span><label className="af-release-self-test"><input type="checkbox" checked={selfTestFailure} onChange={(event) => setSelfTestFailure(event.target.checked)} />模拟失败</label></div>
      </header>
      {storageWarning ? <div className="af-release-notice">{storageWarning}</div> : null}
      {message ? <div className="af-release-message" role="status">{message}</div> : null}
      <div className="af-release-flow-groups">
        <section className="af-release-stage-group af-release-stage-group--completed">
          <div className="af-release-section__heading"><div><h3>已完成阶段</h3><span>{visibleState.timeline.length} 个节点</span></div><small>按执行顺序记录发版轨迹</small></div>
          <div className="af-release-completed-flow">
            {completedRows.length === 0 ? <div className="af-release-empty">初始化节点或已完成阶段会从这里开始。</div> : completedRows.map((row, rowIndex) => (
              <div key={row[0]?.id || rowIndex} className={`af-release-completed-row${rowIndex % 2 === 1 ? " is-reverse" : ""}`}>
                {row.map((item, itemIndex) => (
                  <div key={item.id} className="af-release-completed-step">
                    <article className="af-release-timeline-card af-release-node--completed" role="button" tabIndex="0" onClick={() => openInspector(item)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") openInspector(item); }}><div className="af-release-timeline-card__dot" aria-hidden="true" /><div className="af-release-timeline-card__body"><div className="af-release-timeline-card__topline"><span>{item.category || "发版阶段"}</span><b>{statusLabel("completed")}</b></div><strong>{item.title}</strong><small>{item.description || "已完成发版阶段"}</small>{renderInitializationContext(item)}<div className="af-release-timeline-card__meta"><span>完成 {formatDateTime(item.completedAt)}</span><span>耗时 {formatDuration(item.durationMs)}</span><span>操作人 {item.operator || "未记录"}</span></div></div></article>
                    {itemIndex < row.length - 1 ? <span className="af-release-completed-arrow material-symbols-outlined" aria-hidden="true">{rowIndex % 2 === 1 ? "arrow_back" : "arrow_forward"}</span> : null}
                  </div>
                ))}
                {rowIndex < completedRows.length - 1 ? <span className="af-release-completed-turn" aria-hidden="true"><i className="material-symbols-outlined">{rowIndex % 2 === 0 ? "arrow_back" : "arrow_forward"}</i></span> : null}
              </div>
            ))}
          </div>
        </section>
        <div className="af-release-group-bridge" aria-hidden="true"><span>下一阶段</span></div>
        <section className="af-release-stage-group af-release-stage-group--pending">
          <div className="af-release-section__heading"><div><h3>添加阶段</h3><span>{visibleState.pending.length} 个节点</span></div><small>平级添加与执行区，可执行、取消或重试</small></div>
          <div className="af-release-pending-grid">
            {visibleState.pending.length === 0 ? <div className="af-release-empty">暂无待执行阶段。</div> : visibleState.pending.map((item) => {
              const node = nodeById.get(item.nodeId);
              return <article key={item.id} className={`af-release-node af-release-node--${item.status}`} role="button" tabIndex="0" onClick={() => openInspector(item)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") openInspector(item); }}>
                <div><div className="af-release-node__topline"><span>{item.processTitle || item.category || "发版阶段"}</span><b>{statusLabel(item.status)}</b></div><strong>{item.title}</strong><small>{item.description}</small>{renderInitializationContext(item)}<div className="af-release-node__meta"><span>操作人 {item.operator || "未记录"}</span>{item.startedAt ? <span>开始 {formatDateTime(item.startedAt)}</span> : null}{item.failedAt ? <span>失败 {formatDateTime(item.failedAt)}</span> : null}</div>{renderNodeInputs(node, item)}{item.status === "failed" ? <em>{item.error}</em> : null}{item.status === "running" ? <progress aria-label={`${item.title} 执行进度`} max="100" value={item.progress || 0} /> : null}</div>
                <div className="af-release-node__actions">{item.status === "running" ? <button type="button" onClick={(event) => { event.stopPropagation(); cancelNode(item); }}>取消</button> : item.status === "failed" ? <button type="button" onClick={(event) => { event.stopPropagation(); retryNode(item); }}>重试</button> : <button type="button" onClick={(event) => { event.stopPropagation(); executeNode(item); }}>执行</button>}{item.status !== "running" && !String(item.nodeId || "").startsWith("custom-") ? <button type="button" className="af-release-node__delete" aria-label={`删除${item.title}`} onClick={(event) => { event.stopPropagation(); void deleteNode(item); }}>删除</button> : null}</div>
              </article>;
            })}
            <div className="af-release-add-node">
              <button type="button" className="af-release-add-node__trigger" aria-expanded={addNodeOpen} onClick={() => setAddNodeOpen((open) => !open)} disabled={customNodeOptions.length === 0}><span className="af-release-add-node__icon" aria-hidden="true">+</span><span><strong>自定义添加阶段</strong><small>从当前业务线、平台和批次的流程节点中选择，可重复添加</small></span><span className="material-symbols-outlined" aria-hidden="true">{addNodeOpen ? "expand_less" : "expand_more"}</span></button>
              {addNodeOpen ? <div className="af-release-add-node__options">{customNodeGroups.map((group) => <section key={group.id} className="af-release-add-node__group"><h4>{group.title}</h4>{group.nodes.map((node) => <button key={node.id} type="button" onClick={() => addPresetNode(node)}><span><strong>{node.title}</strong><small>{node.description}</small></span><em>{node.category}</em></button>)}</section>)}</div> : null}
            </div>
          </div>
        </section>
      </div>
      {inspector ? <ReleaseNodeInspector
        item={inspector.item}
        node={inspector.node}
        mode={inspector.mode}
        onClose={() => setInspector(null)}
        onSave={saveInspectorItem}
        onPreview={executeNode}
        onRun={runInspectorItem}
        onStop={cancelNode}
        context={context}
      /> : null}
    </section>
  );
}
