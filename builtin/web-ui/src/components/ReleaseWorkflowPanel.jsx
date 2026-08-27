import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getReleaseNodes, inferReleaseContext, runReleaseNode } from "../lib/releaseNodeCatalog.js";

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
    runId: stringValue(value.runId),
    message: stringValue(value.message),
    error: stringValue(value.error),
    inputs: safeInputs(value.inputs),
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
    runId: stringValue(value.runId),
    error: stringValue(value.error),
    message: stringValue(value.message),
    inputs: safeInputs(value.inputs),
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
    durationMs: Number.isFinite(Number(value.durationMs)) ? Number(value.durationMs) : 600,
    nextNodeIds: asStringArray(value.nextNodeIds),
    inputSchema: [],
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
  return ["agentflow-release", workspaceIdentity(workspace), context.businessLine, context.platform, context.version]
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

function makePending(node, inputs = {}) {
  return {
    id: itemId(node.id), nodeId: node.id, title: node.title, description: node.description,
    category: node.category, status: "pending", progress: 0, createdAt: Date.now(), error: "", inputs: safeInputs(inputs),
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

export default function ReleaseWorkflowPanel({ workspace, onContextChange }) {
  const inferred = useMemo(() => inferReleaseContext(workspace || {}), [workspace]);
  const [context, setContext] = useState(inferred);
  const [state, setState] = useState(() => readState(
    storageKey(workspace, inferred),
    new Set(getReleaseNodes(inferred).map((node) => node.id)),
  ));
  const [storageWarning, setStorageWarning] = useState("");
  const [message, setMessage] = useState("");
  const [selfTestFailure, setSelfTestFailure] = useState(false);
  const [manualNodeId, setManualNodeId] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [customDescription, setCustomDescription] = useState("");
  const [customNext, setCustomNext] = useState([]);
  const controllers = useRef(new Map());
  const hydratedKey = useRef("");
  const activeKeyRef = useRef("");
  const runGenerationRef = useRef(0);
  const runSequenceRef = useRef(0);
  const enqueueReservations = useRef(new Map());

  const key = useMemo(() => storageKey(workspace, context), [workspace, context]);
  activeKeyRef.current = key;
  const catalogNodes = useMemo(() => getReleaseNodes(context), [context]);
  const allNodes = useMemo(() => [...catalogNodes, ...state.customNodes], [catalogNodes, state.customNodes]);
  const knownNodeIds = useMemo(() => new Set(allNodes.map((node) => node.id)), [allNodes]);
  const visibleState = useMemo(() => {
    const timeline = state.timeline.filter((item) => knownNodeIds.has(item.nodeId));
    const completedIds = new Set(timeline.map((item) => item.nodeId));
    const pending = state.pending
      .filter((item) => knownNodeIds.has(item.nodeId) && !completedIds.has(item.nodeId));
    return { ...state, timeline, pending };
  }, [knownNodeIds, state]);
  const nodeById = useMemo(() => new Map(allNodes.map((node) => [node.id, node])), [allNodes]);
  const completedIds = useMemo(() => new Set(visibleState.timeline.map((item) => item.nodeId || item.id)), [visibleState.timeline]);
  const pendingIds = useMemo(() => new Set(visibleState.pending.map((item) => item.nodeId)), [visibleState.pending]);
  const runningCount = visibleState.pending.filter((item) => item.status === "running").length;

  useEffect(() => {
    setContext(inferred);
  }, [inferred]);

  useEffect(() => {
    hydratedKey.current = "";
    setState(readState(key, new Set(catalogNodes.map((node) => node.id))));
    setStorageWarning("");
  }, [catalogNodes, key]);

  useEffect(() => () => {
    runGenerationRef.current += 1;
    controllers.current.forEach((entry) => entry.controller?.abort());
    controllers.current.clear();
    enqueueReservations.current.clear();
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

  const changeContext = useCallback((patch) => {
    const next = { ...context, ...patch };
    setContext(next);
    onContextChange?.(next);
  }, [context, onContextChange]);

  const enqueueNode = useCallback((nodeId) => {
    const node = nodeById.get(nodeId);
    if (!node) return;
    if (completedIds.has(nodeId) || pendingIds.has(nodeId) || enqueueReservations.current.has(nodeId)) {
      setMessage(`${node.title} 已在当前流程中`);
      return;
    }
    const reservation = { result: "" };
    enqueueReservations.current.set(nodeId, reservation);
    setState((previous) => {
      const completed = previous.timeline.some((item) => (item.nodeId || item.id) === nodeId);
      const existing = previous.pending.some((item) => item.nodeId === nodeId);
      if (completed || existing) {
        reservation.result = "duplicate";
        return previous;
      }
      reservation.result = "added";
      return { ...previous, pending: [...previous.pending, makePending(node)] };
    });
    setTimeout(() => {
      if (enqueueReservations.current.get(nodeId) !== reservation) return;
      enqueueReservations.current.delete(nodeId);
      if (reservation.result === "added") setMessage(`${node.title} 已加入待执行阶段`);
      else if (reservation.result === "duplicate") setMessage(`${node.title} 已在当前流程中`);
    }, 0);
  }, [completedIds, nodeById, pendingIds]);

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
      pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, status: "running", startedAt, completedAt: undefined, failedAt: undefined, error: "", progress: 0 } : entry),
    }));
    try {
      const result = await runReleaseNode(node, { ...context, inputs: item.inputs, simulateFailure: selfTestFailure }, {
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
      if (!isCurrentRun()) return;
      setState((previous) => {
        const completed = previous.timeline.some((entry) => (entry.nodeId || entry.id) === node.id);
        const currentItem = previous.pending.find((entry) => entry.id === item.id) || item;
        const timeline = completed ? previous.timeline : [...previous.timeline, {
          ...currentItem,
          status: "completed",
          completedAt: Date.now(),
          progress: 100,
          message: result.message,
          runId: result.runId || currentItem.runId,
        }];
        const pending = previous.pending.filter((entry) => entry.id !== item.id);
        const blocked = new Set([...timeline.map((entry) => entry.nodeId || entry.id), ...pending.map((entry) => entry.nodeId)]);
        const inferredIds = (node.nextNodeIds || []).slice(0, 2).filter((id) => !blocked.has(id) && nodeById.has(id));
        return { ...previous, timeline, pending: [...pending, ...inferredIds.map((id) => makePending(nodeById.get(id)))] };
      });
      if (isCurrentRun()) setMessage(result.message || `${node.title} 已完成`);
    } catch (error) {
      if (error?.name === "AbortError" || !isCurrentRun()) return;
      setState((previous) => ({ ...previous, pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, status: "failed", error: String(error?.message || error || "执行失败"), failedAt: Date.now() } : entry) }));
      setMessage(`${node.title} 执行失败`);
    } finally {
      if (controllers.current.get(item.id)?.token === runToken) controllers.current.delete(item.id);
    }
  }, [context, key, nodeById, selfTestFailure]);

  const cancelNode = useCallback((item) => {
    controllers.current.get(item?.id)?.controller?.abort();
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

  const createCustomNode = useCallback((event) => {
    event.preventDefault();
    const title = customTitle.trim();
    if (!title) return;
    const node = {
      id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title, description: customDescription.trim() || "自定义发版阶段", skill: "custom", category: "自定义阶段",
      businessLines: [context.businessLine], platforms: [context.platform], durationMs: 600, nextNodeIds: [...customNext],
      inputSchema: [],
    };
    setState((previous) => ({ ...previous, customNodes: [...previous.customNodes, node], pending: [...previous.pending, makePending(node)] }));
    setCustomTitle(""); setCustomDescription(""); setCustomNext([]); setMessage(`${title} 已加入待执行阶段`);
  }, [context.businessLine, context.platform, customDescription, customNext, customTitle]);

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

  const toggleCustomNext = (id) => setCustomNext((previous) => previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id]);
  const availableManualNodes = catalogNodes.filter((node) => !completedIds.has(node.id) && !pendingIds.has(node.id));

  useEffect(() => {
    const availableIds = new Set(availableManualNodes.map((node) => node.id));
    setCustomNext((previous) => {
      const next = previous.filter((id) => availableIds.has(id));
      return next.length === previous.length ? previous : next;
    });
  }, [availableManualNodes]);

  return (
    <section className="af-release-panel">
      <header className="af-release-context">
        <div><span className="af-release-eyebrow">发版流程</span><h2>{workspace?.label || workspace?.name || "当前工作空间"}</h2><small>{workspace?.path || workspace?.repoUrl || "本地发版时间线"}</small></div>
        <div className="af-release-context__controls">
          <label>业务线<select value={context.businessLine} onChange={(event) => changeContext({ businessLine: event.target.value })}><option value="likee">Likee</option><option value="bigolive">BigoLive</option><option value="hello">Hello</option></select></label>
          <label>平台<span className="af-release-toggle"><button type="button" className={context.platform === "android" ? "is-active" : ""} onClick={() => changeContext({ platform: "android" })}>Android</button><button type="button" className={context.platform === "ios" ? "is-active" : ""} onClick={() => changeContext({ platform: "ios" })}>iOS</button></span></label>
          <label>版本<input value={context.version} onChange={(event) => changeContext({ version: event.target.value })} /></label>
          <label className="af-release-self-test"><span>本地自测</span><span><input type="checkbox" checked={selfTestFailure} onChange={(event) => setSelfTestFailure(event.target.checked)} />模拟失败模式（重试前关闭）</span></label>
        </div>
        <div className="af-release-counts"><span>已完成 {visibleState.timeline.length}</span><span>待执行 {visibleState.pending.filter((item) => item.status === "pending").length}</span><span>执行中 {runningCount}</span></div>
      </header>
      {storageWarning ? <div className="af-release-notice">{storageWarning}</div> : null}
      {message ? <div className="af-release-message" role="status">{message}</div> : null}
      <div className="af-release-columns">
        <div className="af-release-section"><h3>发版时间线</h3>{visibleState.timeline.length === 0 ? <div className="af-release-empty">完成的阶段会按时间顺序出现在这里。</div> : <div className="af-release-timeline">{visibleState.timeline.map((item) => <article key={item.id} className="af-release-node af-release-node--completed"><div><strong>{item.title}</strong><small>{item.category || "发版阶段"}</small></div><span>{statusLabel("completed")}</span></article>)}</div>}</div>
        <div className="af-release-section"><div className="af-release-section__heading"><h3>待执行阶段</h3><select aria-label="全部阶段" value={manualNodeId} onChange={(event) => setManualNodeId(event.target.value)}><option value="">全部阶段</option>{availableManualNodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select>{manualNodeId ? <button type="button" onClick={() => { enqueueNode(manualNodeId); setManualNodeId(""); }}>添加</button> : null}</div>{visibleState.pending.length === 0 ? <div className="af-release-empty">暂无待执行阶段，可从“全部阶段”添加。</div> : <div className="af-release-pending">{visibleState.pending.map((item) => { const node = nodeById.get(item.nodeId); return <article key={item.id} className={`af-release-node af-release-node--${item.status}${item.status === "running" ? " af-release-node--running" : ""}${item.status === "failed" ? " af-release-node--failed" : ""}`}><div><strong>{item.title}</strong><small>{item.description}</small>{renderNodeInputs(node, item)}{item.status === "failed" ? <em>{item.error}</em> : null}{item.status === "running" ? <progress aria-label={`${item.title} 执行进度`} max="100" value={item.progress || 0} /> : null}</div><div className="af-release-node__actions">{item.status === "running" ? <button type="button" onClick={() => cancelNode(item)}>取消</button> : item.status === "failed" ? <button type="button" onClick={() => retryNode(item)}>重试</button> : <button type="button" onClick={() => executeNode(item)}>执行</button>}</div></article>; })}</div>}</div>
      </div>
      <form className="af-release-custom" onSubmit={createCustomNode}><h3>新增自定义阶段</h3><div className="af-release-custom__fields"><input placeholder="阶段名称" value={customTitle} onChange={(event) => setCustomTitle(event.target.value)} /><input placeholder="描述（可选）" value={customDescription} onChange={(event) => setCustomDescription(event.target.value)} /><button type="submit" disabled={!customTitle.trim()}>加入待执行</button></div><fieldset><legend>完成后推理的阶段</legend><div className="af-release-checkboxes">{availableManualNodes.map((node) => <label key={node.id}><input type="checkbox" checked={customNext.includes(node.id)} onChange={() => toggleCustomNext(node.id)} />{node.title}</label>)}</div></fieldset></form>
    </section>
  );
}
