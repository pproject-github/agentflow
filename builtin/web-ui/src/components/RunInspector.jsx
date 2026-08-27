import { useEffect, useMemo, useState } from "react";
import {
  buildRunAuditTrace,
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
  if (status === "incomplete") return "warning";
  if (status === "waiting") return "hourglass_top";
  if (status === "retrying") return "sync";
  if (status === "cancelled") return "cancel";
  if (status === "running") return "progress_activity";
  return "radio_button_unchecked";
}

function kindIcon(kind) {
  if (kind === "node") return "account_tree";
  if (kind === "attempt") return "replay";
  if (kind === "session") return "smart_toy";
  if (kind === "turn") return "forum";
  if (kind === "thinking") return "psychology";
  if (kind === "tool") return "build";
  if (kind === "script") return "terminal";
  return "fiber_manual_record";
}

function rawEventText(value) {
  try {
    return JSON.stringify(value?.source || value, null, 2);
  } catch {
    return String(value?.text || "");
  }
}

function shortened(value, size = 10) {
  const text = String(value || "");
  if (text.length <= size * 2 + 1) return text;
  return `${text.slice(0, size)}…${text.slice(-size)}`;
}

function spanSearchText(span) {
  return [
    span.label,
    span.kind,
    span.model,
    span.modelCallId,
    span.sessionId,
    span.callId,
    span.command,
    span.path,
    span.script,
    ...span.events.map((event) => `${event.label} ${event.text} ${event.command} ${event.path}`),
  ].join(" ").toLowerCase();
}

function eventBody(events, rawType) {
  return events
    .filter((event) => event.rawType === rawType)
    .map((event) => event.text)
    .filter(Boolean)
    .join("\n");
}

function DetailRow({ label, value, title }) {
  if (value === undefined || value === null || value === "") return null;
  return <div className="af-run-event-inspector__cwd"><span>{label}</span><code title={title || String(value)}>{String(value)}</code></div>;
}

function JsonDetail({ title, value, open = false }) {
  if (value == null || value === "" || (typeof value === "object" && !Object.keys(value).length)) return null;
  let text = String(value);
  if (typeof value === "object") {
    try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
  }
  return <details open={open}><summary>{title}</summary><pre>{text}</pre></details>;
}

function SpanInspector({ span }) {
  if (!span) return null;
  const thinking = eventBody(span.events, "thinking");
  const assistant = eventBody(span.events, "assistant");
  const user = eventBody(span.events, "user");
  const resultMessage = eventBody(span.events, "result");
  return (
    <section className={`af-run-event-inspector is-${span.status}`}>
      <header>
        <div><span>{span.kind}</span><strong>{span.label}</strong></div>
        <small>{span.status} · {clock(span.startedAt)} · {formatRunInspectorDuration(span.durationMs)}</small>
      </header>
      {span.incompleteReason ? <div className="af-run-event-inspector__gap"><span className="material-symbols-outlined">warning</span>{span.incompleteReason}</div> : null}
      <div className="af-run-event-inspector__identity">
        <DetailRow label="MODEL" value={span.model} />
        <DetailRow label="SESSION" value={span.sessionId} />
        <DetailRow label="MODEL CALL" value={span.modelCallId} />
        <DetailRow label="TOOL CALL" value={span.callId} />
      </div>
      <JsonDetail title="Input" value={user} />
      <JsonDetail title="Reasoning" value={thinking || (span.kind === "thinking" ? span.text : "")} />
      <JsonDetail title="Assistant Output" value={assistant} open={span.kind === "turn"} />
      <JsonDetail title="Command" value={span.command} open />
      <JsonDetail title="Path" value={span.path} />
      <JsonDetail title="Arguments" value={span.args} open={span.kind === "tool"} />
      <JsonDetail title="执行脚本" value={span.script} open />
      <DetailRow label="SHA-256" value={span.scriptSha256} />
      <DetailRow label="CWD" value={span.cwd} />
      <DetailRow label="EXIT" value={span.exitCode} />
      <JsonDetail title="stdout" value={span.stdout} open />
      <JsonDetail title="stderr" value={span.stderr} open />
      <JsonDetail title="Tool Result" value={span.result} />
      <JsonDetail title="Usage" value={span.usage} />
      <JsonDetail title="Final Result" value={resultMessage} />
      <details><summary>原始证据（{span.events.length}）</summary><pre>{span.events.map(rawEventText).join("\n")}</pre></details>
    </section>
  );
}

export default function RunInspector({ run, events = [], rawLines = [], loading = false, compact = false }) {
  const [selectedSpanId, setSelectedSpanId] = useState("");
  const [tab, setTab] = useState("trace");
  const [search, setSearch] = useState("");
  const trace = useMemo(() => buildRunAuditTrace(events, run), [events, run]);
  const timeline = useMemo(() => runInspectorTimelineRows(trace.spans, trace), [trace]);
  const primaryRows = trace.turns.length ? trace.turns : trace.nodes;
  const selectedSpan = trace.spans.find((span) => span.id === selectedSpanId) || primaryRows[0] || trace.spans[0] || null;
  const query = search.trim().toLowerCase();

  useEffect(() => {
    setSelectedSpanId("");
    setTab("trace");
    setSearch("");
  }, [run?.runId]);

  if (loading && !events.length) return <div className="af-run-inspector__empty">正在读取 Run Trace…</div>;
  if (!events.length) return <div className="af-run-inspector__empty">这个 Run 暂无可审计事件。</div>;

  return (
    <section className={`af-run-inspector${compact ? " af-run-inspector--compact" : ""}`} aria-label="Run Inspector">
      <header className="af-run-inspector__toolbar">
        <div className="af-run-inspector__tabs">
          <button type="button" className={tab === "trace" ? "is-active" : ""} onClick={() => setTab("trace")}>Trace <span>{trace.spans.length}</span></button>
          <button type="button" className={tab === "raw" ? "is-active" : ""} onClick={() => setTab("raw")}>Raw <span>{rawLines.length || events.length}</span></button>
        </div>
        <div className="af-run-inspector__evidence" aria-label="运行证据版本">
          <span>{run?.scheduled || run?.trigger === "scheduled" ? "SCHEDULE" : "MANUAL"}</span>
          {run?.releaseId ? <code title={`Stable Release ${run.releaseId}`}>{run.releaseId}</code> : <code>Draft</code>}
          {run?.designRevision ? <code title={run.designRevision}>rev {String(run.designRevision).slice(0, 8)}</code> : null}
        </div>
        <label>
          <span className="material-symbols-outlined">search</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索模型调用、工具、脚本或输出" />
        </label>
      </header>

      {tab === "raw" ? (
        <pre className="af-run-inspector__raw">{(rawLines.length ? rawLines : events.map((event) => JSON.stringify(event))).join("\n")}</pre>
      ) : (
        <>
          <div className="af-run-inspector__summary">
            <span><strong>{trace.nodes.length}</strong> Nodes</span>
            <span><strong>{trace.sessions.length}</strong> Sessions</span>
            <span><strong>{trace.turns.length}</strong> Model Turns</span>
            <span><strong>{trace.spans.filter((span) => span.kind === "tool").length}</strong> Tools</span>
            <span className={trace.gaps.length ? "is-warning" : "is-ok"}><strong>{trace.gaps.length}</strong> Audit Gaps</span>
          </div>
          <div className="af-run-inspector__layout">
            <div className="af-run-inspector__turns">
              <div className="af-run-inspector__pane-head">
                <div><span>{trace.turns.length ? "MODEL TURNS" : "RUN STEPS"}</span><strong>{run?.scheduled || run?.trigger === "scheduled" ? "ScheduleRun" : "Run"}</strong></div>
                <small>{primaryRows.length} {trace.turns.length ? "turns" : "steps"}</small>
              </div>
              <div className="af-run-inspector__turn-scroll">
                {primaryRows.map((span, index) => {
                  if (query && !spanSearchText(span).includes(query)) return null;
                  const tools = span.children?.filter((child) => child.kind === "tool") || [];
                  return (
                    <section key={span.id} className={`af-run-turn is-${span.status}${selectedSpan?.id === span.id ? " is-selected" : ""}`}>
                      <button type="button" className="af-run-turn__head" onClick={() => setSelectedSpanId(span.id)}>
                        <span className="material-symbols-outlined">{statusIcon(span.status)}</span>
                        <span>
                          <em>{span.kind === "turn" ? `TURN ${span.turnIndex || index + 1}` : span.kind.toUpperCase()}</em>
                          <strong>{span.label}{span.model ? ` · ${span.model}` : ""}</strong>
                          <small>{clock(span.startedAt)} · {formatRunInspectorDuration(span.durationMs)}</small>
                        </span>
                      </button>
                      {span.modelCallId ? <div className="af-run-turn__call-id" title={span.modelCallId}>model_call · {shortened(span.modelCallId, 8)}</div> : null}
                      {span.children?.length ? (
                        <div className="af-run-turn__events">
                          {span.children.map((child) => (
                            <button key={child.id} type="button" className={`is-${child.status}${selectedSpan?.id === child.id ? " is-selected" : ""}`} onClick={() => setSelectedSpanId(child.id)}>
                              <span>{child.kind}</span><strong>{child.label}</strong><small>{formatRunInspectorDuration(child.durationMs)}</small>
                              <p>{child.incompleteReason || child.command || child.path || child.text || (child.kind === "thinking" ? "模型推理过程" : "")}</p>
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {tools.length ? <span className="af-run-turn__tool-count">{tools.length} tool calls</span> : null}
                    </section>
                  );
                })}
              </div>
            </div>

            <div className="af-run-inspector__execution">
              <div className="af-run-inspector__pane-head">
                <div><span>SPAN WATERFALL</span><strong>{formatRunInspectorDuration(trace.durationMs)}</strong></div>
                <small>{run?.trigger || (run?.scheduled ? "scheduled" : "manual")}</small>
              </div>
              <div className="af-run-waterfall">
                <div className="af-run-waterfall__ruler"><span>0</span><span>50%</span><span>100%</span></div>
                {timeline.map((span) => {
                  if (query && !spanSearchText(span).includes(query)) return null;
                  return (
                    <button key={span.id} type="button" className={`af-run-waterfall__row is-${span.status}${selectedSpan?.id === span.id ? " is-selected" : ""}`} onClick={() => setSelectedSpanId(span.id)}>
                      <span style={{ paddingLeft: `${span.depth * 0.72}rem` }}>
                        <span className="material-symbols-outlined">{kindIcon(span.kind)}</span>
                        <em>{span.kind}</em><strong>{span.label}</strong>
                      </span>
                      <span className="af-run-waterfall__track"><span className="af-run-waterfall__bar" style={{ left: `${span.offsetPct}%`, width: `${Math.min(100 - span.offsetPct, span.widthPct)}%` }} /></span>
                      <small>{formatRunInspectorDuration(span.durationMs)}</small>
                    </button>
                  );
                })}
              </div>
              <SpanInspector span={selectedSpan} />
            </div>
          </div>
        </>
      )}
    </section>
  );
}
