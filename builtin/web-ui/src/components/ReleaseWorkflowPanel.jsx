import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getReleaseNodes, inferReleaseContext, runReleaseNode } from "../lib/releaseNodeCatalog.js";
import { createCompletionMetadata, createInitializationNode, createPresetInstance, ensureInitializationFirst, resolveReleaseContext } from "../lib/releaseWorkflowModel.js";
import ReleaseNodeInspector from "./ReleaseNodeInspector.jsx";

function emptyState() {
  return { timeline: [], pending: [], customNodes: [] };
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
    status: status === "running" ? "pending" : status,
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
  };
}

function normalizeCustomNode(value) {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim() || !value.id.startsWith("custom-") || typeof value.title !== "string" || !value.title.trim()) return null;
  const asStringArray = (entry) => Array.isArray(entry) ? entry.filter((item) => typeof item === "string" && item.trim()) : [];
  return {
    id: value.id,
    title: value.title,
    description: stringValue(value.description, "自定义发版阶段"),
    skill: "custom",
    category: stringValue(value.category, "自定义阶段"),
    businessLines: asStringArray(value.businessLines),
    platforms: asStringArray(value.platforms),
    sourcePresetId: stringValue(value.sourcePresetId),
    durationMs: Number.isFinite(Number(value.durationMs)) ? Number(value.durationMs) : 600,
    nextNodeIds: asStringArray(value.nextNodeIds),
    inputSchema: Array.isArray(value.inputSchema) ? value.inputSchema.filter(isRecord).map((input) => ({ ...input })) : [],
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
      timeline,
      pending,
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

// 用户需求点: 已完成阶段不依赖横向拖动，要按执行顺序蛇形换行并保持连续方向轨迹。
function groupCompletedTimelineRows(items, rowSize = 3) {
  const rows = [];
  for (let index = 0; index < items.length; index += rowSize) {
    rows.push(items.slice(index, index + rowSize));
  }
  return rows;
}

function makePending(node, inputs = {}) {
  return {
    id: itemId(node.id), nodeId: node.id, title: node.title, description: node.description,
    category: node.category, status: "pending", progress: 0, createdAt: Date.now(), error: "", operator: "未记录", inputs: safeInputs(inputs),
  };
}

function validateNodeInputs(node, item) {
  for (const schema of node?.inputSchema || []) {
    const value = item?.inputs?.[schema.key];
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
  const context = inferred;
  const [state, setState] = useState(() => ensureInitializationFirst(
    readState(
      storageKey(workspace, inferred),
      new Set([initialNode.id, ...getReleaseNodes(inferred).map((node) => node.id)]),
    ),
    initialNode,
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

  const key = useMemo(() => storageKey(workspace, context), [workspace, context]);
  activeKeyRef.current = key;
  const catalogNodes = useMemo(() => remoteCatalog.length > 0 ? remoteCatalog : getReleaseNodes(context), [context, remoteCatalog]);
  const initializationNode = useMemo(() => createInitializationNode(context, workspace), [context, workspace]);
  const effectiveInitializationNode = useMemo(() => catalogNodes.length > 0 ? { ...initializationNode, nextNodeIds: [catalogNodes[0].id] } : initializationNode, [catalogNodes, initializationNode]);
  const allNodes = useMemo(() => [effectiveInitializationNode, ...catalogNodes, ...state.customNodes], [catalogNodes, effectiveInitializationNode, state.customNodes]);
  const knownNodeIds = useMemo(() => new Set(allNodes.map((node) => node.id)), [allNodes]);
  const visibleState = useMemo(() => {
    const timeline = state.timeline.filter((item) => knownNodeIds.has(item.nodeId));
    const completedIds = new Set(timeline.map((item) => item.nodeId));
    const pending = state.pending
      .filter((item) => knownNodeIds.has(item.nodeId) && !completedIds.has(item.nodeId));
    return { ...state, timeline, pending };
  }, [knownNodeIds, state]);
  const nodeById = useMemo(() => new Map(allNodes.map((node) => [node.id, node])), [allNodes]);
  const completedRows = useMemo(() => groupCompletedTimelineRows(visibleState.timeline), [visibleState.timeline]);
  const runningCount = visibleState.pending.filter((item) => item.status === "running").length;

  useEffect(() => {
    hydratedKey.current = "";
    const loaded = readState(key, new Set([effectiveInitializationNode.id, ...catalogNodes.map((node) => node.id)]));
    setState(ensureInitializationFirst(loaded, effectiveInitializationNode));
    setStorageWarning("");
  }, [catalogNodes, effectiveInitializationNode, key]);

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
        setState((previous) => ensureInitializationFirst({ ...previous, ...statePayload.state }, effectiveInitializationNode));
      }
    });
    return () => { cancelled = true; };
  }, [context.businessLine, context.platform, context.version, context.batch, effectiveInitializationNode, workspace]);

  const executeNode = useCallback(async (item) => {
    if (!item || item.status === "completed" || controllers.current.has(item.id)) return;
    const node = nodeById.get(item.nodeId);
    if (!node) return;
    const inputError = validateNodeInputs(node, item);
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
    controllers.current.set(item.id, { controller, token: runToken });
    setState((previous) => ({
      ...previous,
      pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, status: "running", startedAt, completedAt: undefined, failedAt: undefined, error: "", progress: 0, operator } : entry),
    }));
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
        inputs: item.inputs || {},
        confirmationFingerprint: item.confirmationFingerprint || "",
      };
      let result;
      if (typeof fetch === "function" && node.skill !== "custom") {
        if (node.requiresConfirmation && !item.confirmationFingerprint) {
          const previewResponse = await fetch("/api/release/nodes/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestPayload), signal: controller.signal });
          const previewPayload = await previewResponse.json().catch(() => ({}));
          if (!previewResponse.ok) throw new Error(previewPayload.error || `HTTP ${previewResponse.status}`);
          setState((previous) => ({ ...previous, pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, status: "pending", preview: previewPayload.preview, confirmationFingerprint: previewPayload.confirmationFingerprint, runId: previewPayload.runId || entry.runId } : entry) }));
          setInspector((previous) => previous?.item?.id === item.id ? { ...previous, item: { ...previous.item, status: "pending", preview: previewPayload.preview, confirmationFingerprint: previewPayload.confirmationFingerprint, runId: previewPayload.runId || previous.item.runId } } : previous);
          setMessage("预览已生成，请在节点详情中确认后执行");
          controllers.current.delete(item.id);
          return;
        }
        const response = await fetch("/api/release/nodes/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestPayload), signal: controller.signal });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        result = { runId: payload.runId, message: payload.result?.output || payload.result?.graph || `${node.title} 已完成`, ...payload };
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
      if (!isCurrentRun()) return;
      setState((previous) => {
        const completed = previous.timeline.some((entry) => (entry.nodeId || entry.id) === node.id);
        const currentItem = previous.pending.find((entry) => entry.id === item.id) || item;
        const completedAt = Date.now();
        const currentOperator = currentItem.operator && currentItem.operator !== "未记录" ? currentItem.operator : operator;
        const timeline = completed ? previous.timeline : [...previous.timeline, {
          ...currentItem,
          status: "completed",
          progress: 100,
          message: result.message,
          output: result.result || result.output || result.graph || result,
          logs: result.logs || result.events || [],
          runId: result.runId || currentItem.runId,
          ...createCompletionMetadata({ operator: currentOperator, startedAt: currentItem.startedAt || startedAt, completedAt }),
        }];
        const pending = previous.pending.filter((entry) => entry.id !== item.id);
        const blocked = new Set([...timeline.map((entry) => entry.nodeId || entry.id), ...pending.map((entry) => entry.nodeId)]);
        const inferredIds = (node.nextNodeIds || []).slice(0, 2).filter((id) => !blocked.has(id) && nodeById.has(id));
        return { ...previous, timeline, pending: [...pending, ...inferredIds.map((id) => makePending(nodeById.get(id)))] };
      });
      if (isCurrentRun()) setMessage(result.message || `${node.title} 已完成`);
    } catch (error) {
      if (error?.name === "AbortError" || !isCurrentRun()) return;
      setState((previous) => ({ ...previous, pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, status: "failed", error: String(error?.message || error || "执行失败"), failedAt: Date.now(), operator: entry.operator || operator } : entry) }));
      setMessage(`${node.title} 执行失败`);
    } finally {
      if (controllers.current.get(item.id)?.token === runToken) controllers.current.delete(item.id);
    }
  }, [context, key, nodeById, operator, selfTestFailure]);

  const cancelNode = useCallback((item) => {
    controllers.current.get(item?.id)?.controller?.abort();
    if (item?.runId) {
      void fetch("/api/release/runs/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: item.runId }) }).catch(() => {});
    }
    if (!item) return;
    setState((previous) => ({ ...previous, pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, status: "pending", progress: 0, error: "" } : entry) }));
    setMessage(`${item.title} 已取消`);
  }, []);

  const retryNode = useCallback((item) => {
    if (!item || item.status !== "failed") return;
    const pending = { ...item, status: "pending", error: "", failedAt: undefined, progress: 0 };
    setState((previous) => ({ ...previous, pending: previous.pending.map((entry) => entry.id === item.id ? pending : entry) }));
    void executeNode(pending);
  }, [executeNode]);

  const updateNodeInput = useCallback((itemIdValue, inputKey, value) => {
    setState((previous) => ({
      ...previous,
      pending: previous.pending.map((entry) => entry.id === itemIdValue
        ? { ...entry, inputs: { ...entry.inputs, [inputKey]: value }, error: entry.status === "failed" ? "" : entry.error }
        : entry),
    }));
  }, []);

  const renderNodeInputs = (node, item) => (node?.inputSchema || []).length > 0 ? (
    <div className="af-release-node__inputs">
      {node.inputSchema.map((schema) => (
        <label key={schema.key}>
          <span>{schema.label}{schema.required ? " *" : ""}</span>
          <input
            type={schema.type || "text"}
            min={schema.min}
            max={schema.max}
            step={schema.step}
            placeholder={schema.placeholder}
            value={item.inputs?.[schema.key] ?? ""}
            disabled={item.status === "running"}
            onChange={(event) => updateNodeInput(item.id, schema.key, event.target.value)}
          />
        </label>
      ))}
    </div>
  ) : null;

  const renderInitializationContext = (item) => item.nodeId === effectiveInitializationNode.id ? (
    <div className="af-release-context-chips">
      <span>{context.businessLine}</span><span>{context.platform}</span><span>{context.version}</span>
    </div>
  ) : null;

  // 用户需求点: 自定义添加阶段是补充流程的后路，同一预置节点可以反复选择并生成独立待执行卡片。
  const addPresetNode = useCallback((preset) => {
    if (!preset) return;
    const node = createPresetInstance(preset);
    setState((previous) => ({
      ...previous,
      customNodes: [...previous.customNodes, node],
      pending: [...previous.pending, makePending(node)],
    }));
    setAddNodeOpen(false);
    setMessage(`${node.title} 已加入待执行阶段`);
  }, []);

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
    void saveInspectorItem(nextItem).then(() => executeNode(nextItem));
  }, [executeNode, saveInspectorItem]);

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
                <div><div className="af-release-node__topline"><span>{item.category || "发版阶段"}</span><b>{statusLabel(item.status)}</b></div><strong>{item.title}</strong><small>{item.description}</small>{renderInitializationContext(item)}<div className="af-release-node__meta"><span>操作人 {item.operator || "未记录"}</span>{item.startedAt ? <span>开始 {formatDateTime(item.startedAt)}</span> : null}{item.failedAt ? <span>失败 {formatDateTime(item.failedAt)}</span> : null}</div>{renderNodeInputs(node, item)}{item.status === "failed" ? <em>{item.error}</em> : null}{item.status === "running" ? <progress aria-label={`${item.title} 执行进度`} max="100" value={item.progress || 0} /> : null}</div>
                <div className="af-release-node__actions">{item.status === "running" ? <button type="button" onClick={() => cancelNode(item)}>取消</button> : item.status === "failed" ? <button type="button" onClick={() => retryNode(item)}>重试</button> : <button type="button" onClick={() => executeNode(item)}>执行</button>}</div>
              </article>;
            })}
            <div className="af-release-add-node">
              <button type="button" className="af-release-add-node__trigger" aria-expanded={addNodeOpen} onClick={() => setAddNodeOpen((open) => !open)} disabled={catalogNodes.length === 0}><span className="af-release-add-node__icon" aria-hidden="true">+</span><span><strong>自定义添加阶段</strong><small>自由选择预置节点，允许重复添加</small></span><span className="material-symbols-outlined" aria-hidden="true">{addNodeOpen ? "expand_less" : "expand_more"}</span></button>
              {addNodeOpen ? <div className="af-release-add-node__options">{catalogNodes.map((node) => <button key={node.id} type="button" onClick={() => addPresetNode(node)}><span><strong>{node.title}</strong><small>{node.description}</small></span><em>{node.category}</em></button>)}</div> : null}
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
      /> : null}
    </section>
  );
}
