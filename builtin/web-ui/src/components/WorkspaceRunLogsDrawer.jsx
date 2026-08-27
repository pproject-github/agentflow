import { useCallback, useEffect, useState } from "react";
import RunInspector from "./RunInspector.jsx";

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

export default function WorkspaceRunLogsDrawer({
  flowParams,
  scheduleNodeId = "",
  runNodeId = "",
  lastRunId = "",
  label = "",
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
      setRuns(nextRuns);
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
    setDetail(null);
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
      setDetail({ error: String(e.message || e), events: [] });
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
    const id = window.setInterval(() => {
      void loadRuns();
      if (!selected || selected.status === "running") {
        if (selectedRunId) void loadDetail(selectedRunId);
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [loadDetail, loadRuns, runs, selectedRunId]);

  const selectedRun = detail?.run || runs.find((item) => item.runId === selectedRunId) || null;

  return (
    <div className="af-work-run-logs">
      <div className="af-pipeline-drawer-head">
        <h2 className="af-pipeline-drawer-title">运行记录</h2>
        <button type="button" className="af-pipeline-drawer-close af-icon-btn" onClick={onClose} aria-label="关闭日志侧栏">
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
      <div className="af-work-run-logs__meta">
        <span>{label || scheduleNodeId || runNodeId || "Workspace Run"}</span>
        <button type="button" className="af-icon-btn" onClick={() => void loadRuns()} title="刷新日志" aria-label="刷新日志">
          <span className="material-symbols-outlined">refresh</span>
        </button>
      </div>
      {error ? <div className="af-work-run-logs__error">{error}</div> : null}
      <div className="af-work-run-logs__body">
        <div className="af-work-run-logs__list">
          <div className="af-work-run-logs__section-title">最近执行</div>
          {loadingRuns ? <div className="af-work-run-logs__empty">正在读取执行记录…</div> : null}
          {!loadingRuns && runs.length === 0 ? <div className="af-work-run-logs__empty">暂无执行日志</div> : null}
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
          <div className="af-work-run-logs__detail-head">
            <div>
              <div className="af-work-run-logs__section-title">详情</div>
              {selectedRun?.label ? <div className="af-work-run-logs__detail-label">{selectedRun.label}</div> : null}
              <div className="af-work-run-logs__run-id">{selectedRun?.runId || "-"}</div>
            </div>
            {selectedRun ? (
              <span className={`af-work-run-logs__status af-work-run-logs__status--${statusClass(selectedRun.status)}`}>{selectedRun.status}</span>
            ) : null}
          </div>
          {detail?.error ? <div className="af-work-run-logs__error">{detail.error}</div> : null}
          {loadingDetail && !detail ? (
            <div className="af-run-inspector__empty">正在读取日志详情…</div>
          ) : (
            <RunInspector
              run={selectedRun}
              events={Array.isArray(detail?.events) ? detail.events : []}
              loading={loadingDetail}
            />
          )}
        </div>
      </div>
    </div>
  );
}
