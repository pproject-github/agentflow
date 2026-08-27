import { useCallback, useEffect, useState } from "react";
import RunInspector from "./RunInspector.jsx";

function statusText(status) {
  const value = String(status || "unknown");
  if (value === "success") return "成功";
  if (value === "failed") return "失败";
  if (value === "running") return "运行中";
  if (value === "stopped") return "已停止";
  if (value === "interrupted") return "中断";
  return value;
}

export default function AdminRunDetailDrawer({ run, onClose, onOpenFlow }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadDetail = useCallback(async ({ quiet = false } = {}) => {
    if (!run?.runId) return;
    if (!quiet) setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({
        runType: run.runType || "pipeline",
        userId: run.userId || "",
        flowId: run.flowId || "",
        flowSource: run.flowSource || "user",
        runId: run.runId,
      });
      const response = await fetch(`/api/admin/run-detail?${query.toString()}`);
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
      setDetail(json);
    } catch (caught) {
      setError(String(caught?.message || caught));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [run?.flowId, run?.flowSource, run?.runId, run?.runType, run?.userId]);

  useEffect(() => {
    setDetail(null);
    void loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    if (run?.status !== "running") return undefined;
    const interval = window.setInterval(() => {
      if (!document.hidden) void loadDetail({ quiet: true });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [loadDetail, run?.status]);

  const events = Array.isArray(detail?.events) ? detail.events : [];
  const rawLines = Array.isArray(detail?.rawLines) ? detail.rawLines : [];

  return (
    <div className="af-admin-run-detail-overlay" role="presentation" onMouseDown={onClose}>
      <aside
        className="af-admin-run-detail"
        role="dialog"
        aria-modal="true"
        aria-label="Run 详情"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="af-admin-run-detail__head">
          <div>
            <span className="af-admin-run-detail__eyebrow">
              {run.runType === "workspace" ? "Workspace Run" : "Pipeline Run"} · {statusText(run.status)}
            </span>
            <h2>{run.flowId || "Run 详情"}</h2>
            <p>{run.username || run.userId} · <code>{run.runId}</code></p>
          </div>
          <div className="af-admin-run-detail__actions">
            {onOpenFlow ? (
              <button
                type="button"
                className="af-admin-run-detail__open-flow"
                onClick={onOpenFlow}
                title="以管理员只读模式查看 Flow"
              >
                <span className="material-symbols-outlined" aria-hidden>account_tree</span>
                <span>查看 Flow</span>
              </button>
            ) : null}
            <button type="button" onClick={() => void loadDetail()} disabled={loading} title="刷新详情">
              <span className="material-symbols-outlined" aria-hidden>refresh</span>
            </button>
            <button type="button" onClick={onClose} title="关闭">
              <span className="material-symbols-outlined" aria-hidden>close</span>
            </button>
          </div>
        </header>

        {detail?.truncated ? (
          <div className="af-admin-run-detail__notice">
            日志较大，当前展示最新的 512 KB / 2000 条记录。
          </div>
        ) : null}
        {error ? <div className="af-admin-run-detail__error">{error}</div> : null}
        {loading && !detail ? <div className="af-admin-run-detail__empty">正在读取 Run 详情...</div> : null}

        <div className="af-admin-run-detail__body">
          <RunInspector run={{ ...run, ...(detail?.run || {}) }} events={events} rawLines={rawLines} loading={loading} />
        </div>
      </aside>
    </div>
  );
}
