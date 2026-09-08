import { useCallback, useEffect, useState } from "react";
import { Background, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import RunInspector from "./RunInspector.jsx";
import { buildRunAuditTrace } from "../lib/runInspectorModel.js";

function formatTime(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "-";
  const d = new Date(n);
  const pad = (x) => String(x).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDuration(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return "-";
  if (n < 1000) return `${Math.round(n)}ms`;
  const sec = Math.round(n / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return `${min}m${String(rest).padStart(2, "0")}s`;
}

function statusClass(status) {
  const s = String(status || "").toLowerCase();
  if (s.includes("success")) return "success";
  if (s.includes("fail") || s.includes("error")) return "failed";
  if (s.includes("skip") || s.includes("disabled")) return "skipped";
  if (s.includes("running")) return "running";
  if (s.includes("stop")) return "stopped";
  return "idle";
}

function sameRunList(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index];
    return left?.runId === right?.runId
      && left?.status === right?.status
      && left?.startedAt === right?.startedAt
      && left?.completedAt === right?.completedAt
      && left?.durationMs === right?.durationMs
      && left?.error === right?.error;
  });
}

function collectArtifacts(value, out = [], depth = 0) {
  if (depth > 8 || value == null) return out;
  if (Array.isArray(value)) {
    value.forEach((item) => collectArtifacts(item, out, depth + 1));
    return out;
  }
  if (typeof value !== "object") return out;
  for (const [key, item] of Object.entries(value)) {
    if (key === "outputFiles" || key === "artifacts") {
      const list = Array.isArray(item) ? item : [];
      for (const artifact of list) {
        if (typeof artifact === "string") out.push({ path: artifact, name: artifact });
        else if (artifact && typeof artifact === "object") out.push(artifact);
      }
    }
    collectArtifacts(item, out, depth + 1);
  }
  return out;
}

function artifactHref(artifact, flowParams) {
  const path = String(artifact?.path || artifact?.relativePath || artifact?.name || "").trim();
  const url = String(artifact?.url || artifact?.href || "").trim();
  return url || (/^(?:outputs|artifacts)\//.test(path)
    ? `/api/workspace/file/raw?flowId=${encodeURIComponent(flowParams?.flowId || "")}&flowSource=${encodeURIComponent(flowParams?.flowSource || "user")}&path=${encodeURIComponent(path)}`
    : "");
}

function RunFlowCanvas({ nodes = [], edges = [], nodeTypes, edgeTypes, runTrace }) {
  const statusByNodeId = new Map((runTrace?.nodes || []).map((node) => [String(node.nodeId || ""), node.status]));
  const runNodes = nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      nodeStatus: statusByNodeId.get(String(node.id)) || "pending",
      runNotExecuted: !statusByNodeId.has(String(node.id)),
    },
    draggable: false,
    selectable: false,
  }));
  const runEdges = edges;
  if (!runNodes.length) return (
    <div className="af-work-run-empty af-work-run-empty--canvas">
      <span className="material-symbols-outlined" aria-hidden>account_tree</span>
      <strong>暂无 Run 流程</strong>
      <p>执行一次后，这里会展示本次 Run 实际经过的节点和连线。</p>
    </div>
  );
  return (
    <ReactFlowProvider>
      <div className="af-work-run-flow__canvas" aria-label="本次 Run 流程（只读）">
        <ReactFlow
          nodes={runNodes}
          edges={runEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          elementsSelectable={false}
          panOnDrag
          zoomOnScroll
          zoomOnDoubleClick={false}
          fitView
          fitViewOptions={{ padding: 0.2, minZoom: 0.2, maxZoom: 1.1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="rgba(255,255,255,0.1)" gap={20} size={1} />
        </ReactFlow>
      </div>
    </ReactFlowProvider>
  );
}

export default function WorkspaceRunLogsDrawer({
  flowParams,
  scheduleNodeId = "",
  runNodeId = "",
  lastRunId = "",
  label = "",
  flowNodes = [],
  flowEdges = [],
  nodeTypes,
  edgeTypes,
  onClose,
}) {
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [detail, setDetail] = useState(null);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState("");

  const loadRuns = useCallback(async () => {
    if (!flowParams?.flowId) return;
    setLoadingRuns(true);
    setError("");
    try {
      const q = new URLSearchParams();
      q.set("flowId", flowParams.flowId);
      q.set("flowSource", flowParams.flowSource || "user");
      if (flowParams.adminOwnerId) q.set("adminOwnerId", flowParams.adminOwnerId);
      if (scheduleNodeId) q.set("scheduleNodeId", scheduleNodeId);
      else if (runNodeId) q.set("runNodeId", runNodeId);
      q.set("limit", "80");
      const res = await fetch(`/api/workspace/run-logs?${q.toString()}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "读取日志失败");
      const nextRuns = Array.isArray(json.runs) ? json.runs : [];
      setRuns((current) => (sameRunList(current, nextRuns) ? current : nextRuns));
      setSelectedRunId((current) => {
        const latest = nextRuns[0] || null;
        if (latest && String(latest.status || "") === "running" && latest.runId !== current) return latest.runId;
        if (current && nextRuns.some((item) => item.runId === current)) return current;
        if (lastRunId && nextRuns.some((item) => item.runId === lastRunId)) return lastRunId;
        return latest?.runId || "";
      });
    } catch (e) {
      setError(String(e.message || e));
      setRuns([]);
    } finally {
      setLoadingRuns(false);
    }
  }, [flowParams?.adminOwnerId, flowParams?.flowId, flowParams?.flowSource, lastRunId, runNodeId, scheduleNodeId]);

  const loadDetail = useCallback(async (runId) => {
    if (!runId) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    try {
      const q = new URLSearchParams({
        flowId: flowParams?.flowId || "",
        flowSource: flowParams?.flowSource || "user",
      });
      if (flowParams?.adminOwnerId) q.set("adminOwnerId", flowParams.adminOwnerId);
      if (flowParams?.archived) q.set("archived", "1");
      const res = await fetch(`/api/workspace/run-logs/${encodeURIComponent(runId)}?${q.toString()}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "读取日志详情失败");
      setDetail(json);
    } catch (e) {
      setDetail((current) => (current?.run
        ? { ...current, error: String(e.message || e) }
        : { error: String(e.message || e), events: [] }));
    } finally {
      setLoadingDetail(false);
    }
  }, [flowParams?.adminOwnerId, flowParams?.archived, flowParams?.flowId, flowParams?.flowSource]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    void loadDetail(selectedRunId);
  }, [loadDetail, selectedRunId]);

  useEffect(() => {
    const selected = runs.find((item) => item.runId === selectedRunId);
    if (!selected || selected.status !== "running") return undefined;
    const id = window.setInterval(() => {
      void loadRuns();
      if (selectedRunId) void loadDetail(selectedRunId);
    }, 2000);
    return () => window.clearInterval(id);
  }, [loadDetail, loadRuns, runs, selectedRunId]);

  const selectedRun = detail?.run || runs.find((item) => item.runId === selectedRunId) || null;
  const runTrace = selectedRun ? buildRunAuditTrace(detail?.events || [], selectedRun) : null;
  const reportStages = (runTrace?.nodes || []).map((node) => {
    const artifacts = Array.from(new Map(
      collectArtifacts(node.events || []).map((item) => {
        const key = String(item?.path || item?.url || item?.name || "").trim();
        return [key, { ...item, key, href: artifactHref(item, flowParams) }];
      }).filter(([key]) => key),
    ).values());
    return { id: node.nodeId || node.id, label: node.label || node.nodeId || "运行阶段", status: node.status, artifacts };
  });

  return (
    <div className="af-work-run-logs">
      <div className="af-work-run-logs__header">
        <div className="af-work-run-logs__heading">
          <h2>工作台</h2>
          <span className="af-work-run-logs__heading-separator">/</span>
          <span className="af-work-run-logs__flow-name">{label || scheduleNodeId || runNodeId || "Workspace Run"}</span>
        </div>
        <div className="af-work-run-logs__header-actions">
          <button type="button" className="af-icon-btn" onClick={() => void loadRuns()} title="刷新执行记录" aria-label="刷新执行记录">
            <span className="material-symbols-outlined">refresh</span>
          </button>
          <button type="button" className="af-icon-btn" onClick={onClose} aria-label="关闭工作台">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
      </div>
      {error ? <div className="af-work-run-logs__error">{error}</div> : null}
      <div className="af-work-run-logs__body">
        <div className="af-work-run-logs__list af-work-run-flow">
          <div className="af-work-run-flow__head"><span>RUN 流程</span><small>只读 · 当前 Run</small></div>
          <RunFlowCanvas nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} runTrace={runTrace} />
          {/* Run 进行中时列表每 2 秒刷新一次。加载态若自己占一行，就会不停地插入又移除，
              整个列表跟着上下跳。改成标题行里的一段行内提示，布局高度始终不变。 */}
          <div className="af-work-run-logs__section-title">
            最近执行
            {loadingRuns ? (
              <span className="af-work-run-logs__section-status" aria-live="polite">读取中…</span>
            ) : null}
          </div>
          {runs.length === 0 ? (
            <div className="af-work-run-empty af-work-run-empty--list">
              <span className="material-symbols-outlined" aria-hidden>history</span>
              <strong>{loadingRuns ? "正在读取执行记录…" : "暂无执行记录"}</strong>
              <p>运行流程后，记录会显示在这里。</p>
            </div>
          ) : null}
          {runs.map((run) => (
            <button
              type="button"
              key={run.runId}
              className={"af-work-run-logs__run" + (run.runId === selectedRunId ? " af-work-run-logs__run--active" : "")}
              onClick={() => setSelectedRunId(run.runId)}
              title={run.runId}
            >
              <span className={`af-work-run-logs__status af-work-run-logs__status--${statusClass(run.status)}`}>{run.status || "unknown"}</span>
              <span className="af-work-run-logs__run-label">{run.label || run.runNodeId || run.scheduleNodeId || "Workspace Run"}</span>
              <span>{formatTime(run.startedAt)}</span>
              <span>{formatDuration(run.durationMs)}</span>
            </button>
          ))}
        </div>
        <div className="af-work-run-logs__detail">
          {!selectedRun ? (
            <div className="af-work-run-empty af-work-run-empty--detail">
              <span className="material-symbols-outlined" aria-hidden>play_circle</span>
              <strong>还没有可查看的 Run</strong>
              <p>先在 Workspace 中执行一次流程，工作台会在这里显示流程、日志和报告。</p>
              <button type="button" onClick={onClose}>返回 Workspace 执行</button>
            </div>
          ) : (
            <>
              <div className="af-work-run-logs__detail-head">
                <div>
                  <div className="af-work-run-logs__section-title">详情</div>
                  {selectedRun.label ? <div className="af-work-run-logs__detail-label">{selectedRun.label}</div> : null}
                  <div className="af-work-run-logs__run-id">{selectedRun.runId || "-"}</div>
                </div>
                <span className={`af-work-run-logs__status af-work-run-logs__status--${statusClass(selectedRun.status)}`}>{selectedRun.status}</span>
              </div>
              {detail?.error ? <div className="af-work-run-logs__error">{detail.error}</div> : null}
              {loadingDetail && !detail ? (
                <div className="af-run-inspector__empty">正在读取日志详情…</div>
              ) : (
                <RunInspector
                  run={selectedRun}
                  events={Array.isArray(detail?.events) ? detail.events : []}
                  loading={loadingDetail}
                  report={{ eventCount: detail?.events?.length || 0, stages: reportStages }}
                  flowNodes={flowNodes}
                  artifacts={reportStages.flatMap((stage) => (stage.artifacts || []).map((artifact) => ({ ...artifact, nodeId: stage.id })))}
                  runState={detail?.runState}
                  runStateEvents={detail?.runStateEvents || []}
                  runStateHistory={detail?.runStateHistory || []}
                  waterfallOnly
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
