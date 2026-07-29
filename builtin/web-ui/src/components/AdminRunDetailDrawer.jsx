import { useCallback, useEffect, useMemo, useState } from "react";

function formatTime(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(number));
}

function eventKindText(kind) {
  if (kind === "thinking") return "Thinking";
  if (kind === "tool") return "工具";
  if (kind === "error") return "错误";
  if (kind === "result") return "结果";
  return "过程";
}

function statusText(status) {
  const value = String(status || "unknown");
  if (value === "success") return "成功";
  if (value === "failed") return "失败";
  if (value === "running") return "运行中";
  if (value === "stopped") return "已停止";
  if (value === "interrupted") return "中断";
  return value;
}

export default function AdminRunDetailDrawer({ run, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("timeline");

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
    setTab("timeline");
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
  const thinking = useMemo(
    () => events.filter((event) => event?.kind === "thinking"),
    [events],
  );
  const rawLines = Array.isArray(detail?.rawLines) ? detail.rawLines : [];
  const visibleEvents = tab === "thinking" ? thinking : events;

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
            <button type="button" onClick={() => void loadDetail()} disabled={loading} title="刷新详情">
              <span className="material-symbols-outlined" aria-hidden>refresh</span>
            </button>
            <button type="button" onClick={onClose} title="关闭">
              <span className="material-symbols-outlined" aria-hidden>close</span>
            </button>
          </div>
        </header>

        <div className="af-admin-run-detail__tabs" role="tablist" aria-label="Run 详情分类">
          <button type="button" className={tab === "timeline" ? "is-active" : ""} onClick={() => setTab("timeline")}>
            过程 <span>{events.length}</span>
          </button>
          <button type="button" className={tab === "thinking" ? "is-active" : ""} onClick={() => setTab("thinking")}>
            Thinking <span>{thinking.length}</span>
          </button>
          <button type="button" className={tab === "raw" ? "is-active" : ""} onClick={() => setTab("raw")}>
            原始日志 <span>{rawLines.length}</span>
          </button>
        </div>

        {detail?.truncated ? (
          <div className="af-admin-run-detail__notice">
            日志较大，当前展示最新的 512 KB / 2000 条记录。
          </div>
        ) : null}
        {error ? <div className="af-admin-run-detail__error">{error}</div> : null}
        {loading && !detail ? <div className="af-admin-run-detail__empty">正在读取 Run 详情...</div> : null}

        <div className="af-admin-run-detail__body">
          {tab === "raw" ? (
            rawLines.length > 0 ? (
              <pre className="af-admin-run-detail__raw">{rawLines.join("\n")}</pre>
            ) : (
              <div className="af-admin-run-detail__empty">这个 Run 没有原始日志。</div>
            )
          ) : visibleEvents.length > 0 ? (
            <div className="af-admin-run-detail__timeline">
              {visibleEvents.map((event, index) => (
                <article key={event.id || `${event.ts || 0}-${index}`} className={`af-admin-run-detail__event is-${event.kind || "process"}`}>
                  <div className="af-admin-run-detail__event-meta">
                    <time>{formatTime(event.ts)}</time>
                    <span className={`af-admin-run-detail__kind is-${event.kind || "process"}`}>{eventKindText(event.kind)}</span>
                    <span>{event.type || "event"}</span>
                    {event.nodeId ? <code>{event.nodeId}</code> : null}
                  </div>
                  <pre>{event.text || "-"}</pre>
                </article>
              ))}
            </div>
          ) : (
            <div className="af-admin-run-detail__empty">
              {tab === "thinking"
                ? "该模型或 CLI 没有为这个 Run 输出可记录的 Thinking。"
                : "这个 Run 暂无过程事件。"}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
