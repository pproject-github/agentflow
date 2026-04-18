import { useEffect, useState } from "react";
import { useRoute } from "./routeContext.jsx";

export default function RunningIndicator() {
  const { navigate, path } = useRoute();
  const [runs, setRuns] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/pipeline-recent-runs");
        if (!r.ok) return;
        const j = await r.json();
        if (cancelled) return;
        const list = Array.isArray(j.runs) ? j.runs : [];
        setRuns(list.filter((x) => x && x.status === "running"));
      } catch { /* ignore */ }
    };
    load();
    const id = window.setInterval(load, 3000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  if (runs.length === 0) return null;

  const goTo = (r) => {
    const sp = new URLSearchParams({ flowId: r.flowId, flowSource: r.flowSource || "workspace" });
    navigate(`/flow?${sp.toString()}`);
    setOpen(false);
  };

  const currentQS = path === "/flow" ? new URLSearchParams(window.location.search) : null;
  const currentFlowId = currentQS?.get("flowId") || "";

  const single = runs.length === 1;

  return (
    <div className="af-run-indicator" role="status" aria-live="polite">
      {open && !single && (
        <div className="af-run-indicator__menu" onMouseLeave={() => setOpen(false)}>
          {runs.map((r) => (
            <button
              key={`${r.flowId}:${r.runId}`}
              type="button"
              className={
                "af-run-indicator__item" +
                (r.flowId === currentFlowId ? " af-run-indicator__item--current" : "")
              }
              onClick={() => goTo(r)}
              title={`${r.flowId} · ${r.runId}`}
            >
              <span className="af-run-indicator__dot" />
              <span className="af-run-indicator__flow">{r.flowId}</span>
              <span className="af-run-indicator__run">{r.runId.slice(0, 12)}</span>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className="af-run-indicator__btn"
        onClick={() => (single ? goTo(runs[0]) : setOpen((v) => !v))}
        title={single ? `${runs[0].flowId} 运行中，点击跳转` : `${runs.length} 个 pipeline 运行中`}
      >
        <span className="af-run-indicator__pulse" />
        <span className="af-run-indicator__label">
          {single ? runs[0].flowId : `${runs.length} running`}
        </span>
      </button>
    </div>
  );
}
