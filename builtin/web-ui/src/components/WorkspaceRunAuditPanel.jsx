import { useCallback, useEffect, useMemo, useState } from "react";
import RunInspector from "./RunInspector.jsx";

function runQuery(flowParams = {}) {
  const query = new URLSearchParams({
    flowId: String(flowParams.flowId || ""),
    flowSource: String(flowParams.flowSource || "user"),
  });
  if (flowParams.adminOwnerId) query.set("adminOwnerId", String(flowParams.adminOwnerId));
  if (flowParams.archived) query.set("archived", "1");
  return query;
}

export default function WorkspaceRunAuditPanel({ flowParams, session }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const runId = String(session?.id || "");
  const live = ["running", "stopping", "waiting"].includes(String(session?.status || ""));

  const load = useCallback(async () => {
    if (!runId || !flowParams?.flowId) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/workspace/run-logs/${encodeURIComponent(runId)}?${runQuery(flowParams)}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "读取审核记录失败");
      setDetail(body);
      setError("");
    } catch (loadError) {
      // A newly started Run may not have reached the durable log index yet.
      // Keep rendering the live in-memory events and retry while it is active.
      setError(String(loadError?.message || loadError));
    } finally {
      setLoading(false);
    }
  }, [flowParams, runId]);

  useEffect(() => {
    setDetail(null);
    setError("");
    void load();
  }, [load]);

  useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [live, load]);

  const fallbackRun = useMemo(() => ({
    runId,
    runNodeId: session?.runNodeId || "",
    label: session?.label || session?.alias || "Workspace Run",
    status: session?.status || "running",
    startedAt: session?.startedAt || 0,
    endedAt: session?.endedAt || 0,
    durationMs: session?.endedAt && session?.startedAt
      ? Math.max(0, Number(session.endedAt) - Number(session.startedAt))
      : 0,
    trigger: "manual",
  }), [runId, session]);
  const events = Array.isArray(detail?.events) && detail.events.length
    ? detail.events
    : Array.isArray(session?.events) ? session.events : [];

  return (
    <div className="af-composer-run-audit">
      {error && !events.length && !loading ? (
        <div className="af-composer-run-audit__notice">
          <span className="material-symbols-outlined" aria-hidden>history</span>
          <span>审核记录正在落库，可稍后刷新。</span>
          <button type="button" onClick={() => void load()}>重试</button>
        </div>
      ) : null}
      <RunInspector
        compact
        run={detail?.run || fallbackRun}
        events={events}
        loading={loading}
      />
    </div>
  );
}
