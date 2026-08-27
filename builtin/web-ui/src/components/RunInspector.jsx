import { useEffect, useMemo, useState } from "react";
import {
  buildRunInspectorTurns,
  formatRunInspectorDuration,
  runInspectorTimelineRows,
} from "../lib/runInspectorModel.js";

function clock(value) {
  const time = Number(value || 0);
  if (!Number.isFinite(time) || time <= 0) return "--:--:--";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(time));
}

function statusIcon(status) {
  if (status === "success") return "check_circle";
  if (status === "error") return "error";
  if (status === "waiting") return "hourglass_top";
  if (status === "retrying") return "sync";
  if (status === "cancelled") return "cancel";
  if (status === "running") return "progress_activity";
  return "radio_button_unchecked";
}

function rawEventText(event) {
  try {
    return JSON.stringify(event?.source || event, null, 2);
  } catch {
    return String(event?.text || "");
  }
}

export default function RunInspector({ run, events = [], rawLines = [], loading = false }) {
  const [selectedTurnId, setSelectedTurnId] = useState("");
  const [selectedEventKey, setSelectedEventKey] = useState("");
  const [tab, setTab] = useState("trace");
  const [search, setSearch] = useState("");
  const turns = useMemo(() => buildRunInspectorTurns(events, run), [events, run]);
  const timeline = useMemo(() => runInspectorTimelineRows(turns), [turns]);
  const selectedTurn = turns.find((turn) => turn.id === selectedTurnId) || turns[0] || null;
  const allEvents = turns.flatMap((turn) => turn.events);
  const selectedEvent = allEvents.find((event) => event.key === selectedEventKey) || selectedTurn?.events[0] || null;
  const query = search.trim().toLowerCase();

  useEffect(() => {
    setSelectedTurnId("");
    setSelectedEventKey("");
    setTab("trace");
    setSearch("");
  }, [run?.runId]);

  const selectTurn = (turn) => {
    setSelectedTurnId(turn.id);
    setSelectedEventKey(turn.events[0]?.key || "");
  };
  const selectEvent = (turn, event) => {
    setSelectedTurnId(turn.id);
    setSelectedEventKey(event.key);
  };

  if (loading && !events.length) return <div className="af-run-inspector__empty">正在读取 Run Trace…</div>;
  if (!events.length) return <div className="af-run-inspector__empty">这个 Run 暂无可审计事件。</div>;

  return (
    <section className="af-run-inspector" aria-label="Run Inspector">
      <header className="af-run-inspector__toolbar">
        <div className="af-run-inspector__tabs">
          <button type="button" className={tab === "trace" ? "is-active" : ""} onClick={() => setTab("trace")}>Trace <span>{turns.length}</span></button>
          <button type="button" className={tab === "raw" ? "is-active" : ""} onClick={() => setTab("raw")}>Raw <span>{rawLines.length || events.length}</span></button>
        </div>
        <div className="af-run-inspector__evidence" aria-label="运行证据版本">
          <span>{run?.scheduled || run?.trigger === "scheduled" ? "SCHEDULE" : "MANUAL"}</span>
          {run?.releaseId ? <code title={`Stable Release ${run.releaseId}`}>{run.releaseId}</code> : <code>Draft</code>}
          {run?.designRevision ? <code title={run.designRevision}>rev {String(run.designRevision).slice(0, 8)}</code> : null}
        </div>
        <label>
          <span className="material-symbols-outlined">search</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 Turn、节点、脚本或输出" />
        </label>
      </header>

      {tab === "raw" ? (
        <pre className="af-run-inspector__raw">{(rawLines.length ? rawLines : events.map((event) => JSON.stringify(event))).join("\n")}</pre>
      ) : (
        <div className="af-run-inspector__layout">
          <div className="af-run-inspector__turns">
            <div className="af-run-inspector__pane-head"><div><span>RUN TURNS</span><strong>{run?.scheduled || run?.trigger === "scheduled" ? "ScheduleRun" : "Run"}</strong></div><small>{turns.length} turns</small></div>
            <div className="af-run-inspector__turn-scroll">
              {turns.map((turn) => {
                const filtered = !query || `${turn.title} ${turn.events.map((event) => `${event.label} ${event.text} ${event.command} ${event.script}`).join(" ")}`.toLowerCase().includes(query);
                if (!filtered) return null;
                return (
                  <section key={turn.id} className={`af-run-turn is-${turn.status}${selectedTurn?.id === turn.id ? " is-selected" : ""}`}>
                    <button type="button" className="af-run-turn__head" onClick={() => selectTurn(turn)}>
                      <span className="material-symbols-outlined">{statusIcon(turn.status)}</span>
                      <span><em>TURN {turn.index}</em><strong>{turn.title}</strong><small>{clock(turn.startedAt)} · {formatRunInspectorDuration(turn.durationMs)}</small></span>
                    </button>
                    <div className="af-run-turn__events">
                      {turn.events.map((event) => (
                        <button key={event.key} type="button" className={`is-${event.status}${selectedEvent?.key === event.key ? " is-selected" : ""}`} onClick={() => selectEvent(turn, event)}>
                          <span>{event.kind}</span><strong>{event.label}</strong><small>{clock(event.ts)}</small>
                          <p>{event.command || event.text}</p>
                        </button>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>

          <div className="af-run-inspector__execution">
            <div className="af-run-inspector__pane-head"><div><span>EXECUTION TIMELINE</span><strong>{formatRunInspectorDuration(run?.durationMs || Math.max(...turns.map((turn) => turn.runDurationMs)))}</strong></div><small>{run?.trigger || (run?.scheduled ? "scheduled" : "manual")}</small></div>
            <div className="af-run-waterfall">
              <div className="af-run-waterfall__ruler"><span>0</span><span>50%</span><span>100%</span></div>
              {timeline.map((turn) => (
                <button key={turn.id} type="button" className={`af-run-waterfall__row is-${turn.status}${selectedTurn?.id === turn.id ? " is-selected" : ""}`} onClick={() => selectTurn(turn)}>
                  <span><em>Turn {turn.index}</em><strong>{turn.title}</strong></span>
                  <span className="af-run-waterfall__track"><span className="af-run-waterfall__bar" style={{ left: `${turn.offsetPct}%`, width: `${Math.min(100 - turn.offsetPct, turn.widthPct)}%` }} /></span>
                  <small>{formatRunInspectorDuration(turn.durationMs)}</small>
                </button>
              ))}
            </div>

            {selectedEvent ? (
              <section className="af-run-event-inspector">
                <header><div><span>{selectedEvent.kind}</span><strong>{selectedEvent.label}</strong></div><small>{selectedEvent.status} · {clock(selectedEvent.ts)}</small></header>
                {selectedEvent.command ? <details open><summary>Command</summary><pre>{selectedEvent.command}</pre></details> : null}
                {selectedEvent.script ? <details open><summary>执行脚本</summary><pre>{selectedEvent.script}</pre></details> : null}
                {selectedEvent.scriptSha256 ? <div className="af-run-event-inspector__cwd"><span>SHA-256</span><code>{selectedEvent.scriptSha256}</code></div> : null}
                {selectedEvent.cwd ? <div className="af-run-event-inspector__cwd"><span>CWD</span><code>{selectedEvent.cwd}</code></div> : null}
                {selectedEvent.exitCode !== undefined && selectedEvent.exitCode !== null ? <div className="af-run-event-inspector__cwd"><span>EXIT</span><code>{selectedEvent.exitCode}</code></div> : null}
                {selectedEvent.stdout ? <details open><summary>stdout</summary><pre>{selectedEvent.stdout}</pre></details> : null}
                {selectedEvent.stderr ? <details open><summary>stderr</summary><pre>{selectedEvent.stderr}</pre></details> : null}
                {!selectedEvent.command && !selectedEvent.script && !selectedEvent.stdout && !selectedEvent.stderr ? <pre className="af-run-event-inspector__text">{selectedEvent.text}</pre> : null}
                <details><summary>原始事件</summary><pre>{rawEventText(selectedEvent)}</pre></details>
              </section>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
