import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getReleaseNodes, inferReleaseContext, runReleaseNode } from "../lib/releaseNodeCatalog.js";

const EMPTY_STATE = { timeline: [], pending: [], customNodes: [] };

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

function readState(key) {
  if (typeof window === "undefined" || !window.localStorage) return { ...EMPTY_STATE };
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || "null");
    if (!value || typeof value !== "object") return { ...EMPTY_STATE };
    return {
      timeline: Array.isArray(value.timeline) ? value.timeline : [],
      pending: Array.isArray(value.pending) ? value.pending : [],
      customNodes: Array.isArray(value.customNodes) ? value.customNodes : [],
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function itemId(nodeId) {
  return `${nodeId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function statusLabel(status) {
  return { completed: "已完成", running: "执行中", failed: "失败", pending: "待执行" }[status] || status;
}

function makePending(node) {
  return {
    id: itemId(node.id), nodeId: node.id, title: node.title, description: node.description,
    category: node.category, status: "pending", progress: 0, createdAt: Date.now(), error: "",
  };
}

export default function ReleaseWorkflowPanel({ workspace, onContextChange }) {
  const inferred = useMemo(() => inferReleaseContext(workspace || {}), [workspace]);
  const [context, setContext] = useState(inferred);
  const [state, setState] = useState(() => readState(storageKey(workspace, inferred)));
  const [storageWarning, setStorageWarning] = useState("");
  const [message, setMessage] = useState("");
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
  const nodeById = useMemo(() => new Map(allNodes.map((node) => [node.id, node])), [allNodes]);
  const completedIds = useMemo(() => new Set(state.timeline.map((item) => item.nodeId || item.id)), [state.timeline]);
  const pendingIds = useMemo(() => new Set(state.pending.map((item) => item.nodeId)), [state.pending]);
  const runningCount = state.pending.filter((item) => item.status === "running").length;

  useEffect(() => {
    setContext(inferred);
  }, [inferred]);

  useEffect(() => {
    hydratedKey.current = "";
    setState(readState(key));
    setStorageWarning("");
  }, [key]);

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
    const runKey = key;
    const runGeneration = runGenerationRef.current;
    const runToken = ++runSequenceRef.current;
    const isCurrentRun = () => runKey === activeKeyRef.current && runGeneration === runGenerationRef.current;
    const controller = new AbortController();
    controllers.current.set(item.id, { controller, token: runToken });
    setState((previous) => ({
      ...previous,
      pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, status: "running", startedAt: Date.now(), error: "", progress: 0 } : entry),
    }));
    try {
      const result = await runReleaseNode(node, context, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (!isCurrentRun()) return;
          setState((previous) => ({ ...previous, pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, progress } : entry) }));
        },
      });
      if (!isCurrentRun()) return;
      setState((previous) => {
        const completed = previous.timeline.some((entry) => (entry.nodeId || entry.id) === node.id);
        const timeline = completed ? previous.timeline : [...previous.timeline, { ...item, status: "completed", completedAt: Date.now(), progress: 100, message: result.message }];
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
  }, [context, key, nodeById]);

  const cancelNode = useCallback((item) => {
    controllers.current.get(item?.id)?.controller?.abort();
    if (!item) return;
    setState((previous) => ({ ...previous, pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, status: "pending", progress: 0, error: "" } : entry) }));
    setMessage(`${item.title} 已取消`);
  }, []);

  const retryNode = useCallback((item) => {
    if (!item || item.status !== "failed") return;
    const pending = { ...item, status: "pending", error: "", progress: 0 };
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
    };
    setState((previous) => ({ ...previous, customNodes: [...previous.customNodes, node], pending: [...previous.pending, makePending(node)] }));
    setCustomTitle(""); setCustomDescription(""); setCustomNext([]); setMessage(`${title} 已加入待执行阶段`);
  }, [context.businessLine, context.platform, customDescription, customNext, customTitle]);

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
        </div>
        <div className="af-release-counts"><span>已完成 {state.timeline.length}</span><span>待执行 {state.pending.filter((item) => item.status === "pending").length}</span><span>执行中 {runningCount}</span></div>
      </header>
      {storageWarning ? <div className="af-release-notice">{storageWarning}</div> : null}
      {message ? <div className="af-release-message" role="status">{message}</div> : null}
      <div className="af-release-columns">
        <div className="af-release-section"><h3>发版时间线</h3>{state.timeline.length === 0 ? <div className="af-release-empty">完成的阶段会按时间顺序出现在这里。</div> : <div className="af-release-timeline">{state.timeline.map((item) => <article key={item.id} className="af-release-node af-release-node--completed"><div><strong>{item.title}</strong><small>{item.category || "发版阶段"}</small></div><span>{statusLabel("completed")}</span></article>)}</div>}</div>
        <div className="af-release-section"><div className="af-release-section__heading"><h3>待执行阶段</h3><select aria-label="全部阶段" value={manualNodeId} onChange={(event) => setManualNodeId(event.target.value)}><option value="">全部阶段</option>{availableManualNodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select>{manualNodeId ? <button type="button" onClick={() => { enqueueNode(manualNodeId); setManualNodeId(""); }}>添加</button> : null}</div>{state.pending.length === 0 ? <div className="af-release-empty">暂无待执行阶段，可从“全部阶段”添加。</div> : <div className="af-release-pending">{state.pending.map((item) => <article key={item.id} className={`af-release-node af-release-node--${item.status}${item.status === "running" ? " af-release-node--running" : ""}${item.status === "failed" ? " af-release-node--failed" : ""}`}><div><strong>{item.title}</strong><small>{item.description}</small>{item.status === "failed" ? <em>{item.error}</em> : null}{item.status === "running" ? <progress max="100" value={item.progress || 0} /> : null}</div><div className="af-release-node__actions">{item.status === "running" ? <button type="button" onClick={() => cancelNode(item)}>取消</button> : item.status === "failed" ? <button type="button" onClick={() => retryNode(item)}>重试</button> : <button type="button" onClick={() => executeNode(item)}>执行</button>}</div></article>)}</div>}</div>
      </div>
      <form className="af-release-custom" onSubmit={createCustomNode}><h3>新增自定义阶段</h3><div className="af-release-custom__fields"><input placeholder="阶段名称" value={customTitle} onChange={(event) => setCustomTitle(event.target.value)} /><input placeholder="描述（可选）" value={customDescription} onChange={(event) => setCustomDescription(event.target.value)} /><button type="submit" disabled={!customTitle.trim()}>加入待执行</button></div><fieldset><legend>完成后推理的阶段</legend><div className="af-release-checkboxes">{availableManualNodes.map((node) => <label key={node.id}><input type="checkbox" checked={customNext.includes(node.id)} onChange={() => toggleCustomNext(node.id)} />{node.title}</label>)}</div></fieldset></form>
    </section>
  );
}
