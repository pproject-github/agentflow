import { useEffect, useMemo, useState } from "react";
import {
  buildRunAuditTrace,
  buildRunStateSnapshot,
  formatRunInspectorDuration,
  runInspectorTimelineRows,
} from "../lib/runInspectorModel.js";

function clock(value) {
  const time = Number(value || 0);
  if (!Number.isFinite(time) || time <= 0) return "--:--:--";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(time));
}

function statusIcon(status) {
  if (status === "success") return "check_circle";
  if (status === "error") return "error";
  if (status === "incomplete") return "warning";
  if (status === "waiting") return "hourglass_top";
  if (status === "retrying") return "sync";
  if (status === "cancelled") return "cancel";
  if (status === "running") return "progress_activity";
  if (status === "skipped") return "skip_next";
  if (status === "not_run") return "remove_circle_outline";
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

function reportStatusLabel(status) {
  const value = String(status || "").toLowerCase();
  if (value.includes("success")) return "执行成功";
  if (value.includes("fail") || value.includes("error")) return "执行失败";
  if (value.includes("running")) return "执行中";
  if (value.includes("cancel") || value.includes("stop")) return "已停止";
  return status || "未知状态";
}

function stateStatusLabel(status) {
  return ({
    success: "已完成",
    running: "执行中",
    waiting: "等待处理",
    error: "执行失败",
    cancelled: "已停止",
    skipped: "已跳过",
    pending: "待执行",
    not_run: "未参与本次执行",
  })[status] || "未知状态";
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

export default function RunInspector({ run, events = [], rawLines = [], loading = false, compact = false, report = null, waterfallOnly = false, flowNodes = [], artifacts = [], runState: persistedRunState = null, runStateEvents = [], runStateHistory = [] }) {
  const [selectedSpanId, setSelectedSpanId] = useState("");
  const [tab, setTab] = useState("state");
  const [search, setSearch] = useState("");
  const trace = useMemo(() => buildRunAuditTrace(events, run), [events, run]);
  const runState = useMemo(() => buildRunStateSnapshot(events, run, flowNodes, artifacts), [events, flowNodes, run, artifacts]);
  const businessState = persistedRunState?.state && typeof persistedRunState.state === "object" ? persistedRunState.state : null;
  const timeline = useMemo(() => runInspectorTimelineRows(trace.spans, trace), [trace]);
  const callFrames = useMemo(() => {
    const frames = new Map();
    for (const event of events) {
      const frameId = String(event?.callFrameId || "").trim();
      if (!frameId) continue;
      const current = frames.get(frameId) || {
        id: frameId,
        parentNodeId: String(event?.parentNodeId || ""),
        subflowId: String(event?.subflowId || ""),
        whileRole: String(event?.whileRole || ""),
        status: "running",
        currentNodeId: "",
      };
      if (event?.parentNodeId) current.parentNodeId = String(event.parentNodeId);
      if (event?.subflowId) current.subflowId = String(event.subflowId);
      if (event?.whileRole) current.whileRole = String(event.whileRole);
      if (event?.nodeId) current.currentNodeId = String(event.nodeId);
      if (["node-waiting", "subflow-waiting", "waiting"].includes(String(event?.type || ""))) current.status = "waiting";
      if (String(event?.type || "") === "subflow-done") current.status = "success";
      else if (String(event?.type || "") === "node-done" && current.status !== "waiting") current.status = "success";
      frames.set(frameId, current);
    }
    return Array.from(frames.values());
  }, [events]);
  const primaryRows = trace.turns.length ? trace.turns : trace.nodes;
  const selectedSpan = trace.spans.find((span) => span.id === selectedSpanId) || primaryRows[0] || trace.spans[0] || null;
  const query = search.trim().toLowerCase();

  useEffect(() => {
    setSelectedSpanId("");
    setTab("state");
    setSearch("");
  }, [run?.runId]);

  if (loading && !events.length) return <div className="af-run-inspector__empty">正在读取 Run Trace…</div>;

  return (
    <section className={`af-run-inspector${compact ? " af-run-inspector--compact" : ""}${waterfallOnly ? " af-run-inspector--waterfall-only" : ""}`} aria-label="Run Inspector">
      <header className="af-run-inspector__toolbar">
        <div className="af-run-inspector__tabs">
          <button type="button" className={tab === "state" ? "is-active" : ""} onClick={() => setTab("state")}>状态 <span>{runState.stages.length}</span></button>
          <button type="button" className={tab === "trace" ? "is-active" : ""} onClick={() => setTab("trace")}>Trace <span>{trace.spans.length}</span></button>
          <button type="button" className={tab === "raw" ? "is-active" : ""} onClick={() => setTab("raw")}>Raw <span>{rawLines.length || events.length}</span></button>
          {report ? <button type="button" className={tab === "report" ? "is-active" : ""} onClick={() => setTab("report")}>摘要</button> : null}
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

      {tab === "state" ? (
        <div className="af-run-state">
          <section className={`af-run-state__hero is-${runState.status}`}>
            <div>
              <span className="af-run-state__eyebrow">RUN STATE · v{runState.version}</span>
              <h2>{stateStatusLabel(runState.status)}</h2>
              <code>{runState.runId || run?.runId || "-"}</code>
            </div>
            <span className="af-run-state__icon material-symbols-outlined">{statusIcon(runState.status)}</span>
          </section>
          <div className="af-run-state__facts">
            <div><span>当前阶段</span><strong>{runState.currentStage?.label || "—"}</strong><small>{runState.currentStage ? stateStatusLabel(runState.currentStage.status) : "暂无"}</small></div>
            <div><span>进度</span><strong>{runState.progress.completed} / {runState.progress.total || 0}</strong><small>{runState.progress.percent}%</small></div>
            <div><span>等待项</span><strong>{runState.waiting.length}</strong><small>{runState.pending.length ? `${runState.pending.length} 个待执行` : "无"}</small></div>
            <div><span>最近事件</span><strong>{runState.lastEvent?.type || "—"}</strong><small>{runState.lastEvent?.label || "暂无事件"}</small></div>
          </div>
          {businessState ? (
            <section className="af-run-state__section af-run-state__business">
              <div className="af-run-state__section-head"><h3>业务 Run State</h3><span>rev {persistedRunState.revision || 0} · 节点上报</span></div>
              <pre>{JSON.stringify(businessState, null, 2)}</pre>
              {runStateEvents.length ? <small className="af-run-state__state-events">最近更新：{runStateEvents.slice(-3).map((event) => `${event.operation || "update"} · ${event.nodeId || "node"}`).join("；")}</small> : null}
            </section>
          ) : null}
          {callFrames.length ? (
            <section className="af-run-state__section af-run-state__call-frames">
              <div className="af-run-state__section-head"><h3>子流程调用帧</h3><span>{callFrames.length} frames</span></div>
              <div className="af-run-state__stages">
                {callFrames.map((frame) => (
                  <div className={`af-run-state__stage is-${frame.status}`} key={frame.id}>
                    <span className="material-symbols-outlined">account_tree</span>
                    <div><strong>{frame.subflowId || "Subflow"}</strong><small>{frame.status} · {frame.currentNodeId || frame.parentNodeId || "—"}{frame.whileRole ? ` · ${frame.whileRole}` : ""}</small></div>
                    <code title={frame.id}>{frame.id.slice(0, 12)}</code>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {runStateHistory.length ? (
            <details className="af-run-state__history"><summary>Checkpoint 历史（{runStateHistory.length}）</summary>
              <div>{runStateHistory.slice().reverse().map((checkpoint, index) => (
                <div className="af-run-state__history-row" key={`${checkpoint.revision}-${checkpoint.ts}-${index}`}><strong>rev {checkpoint.revision}</strong><span>{checkpoint.nodeId || "Run"}</span><small>{checkpoint.status}</small></div>
              ))}</div>
            </details>
          ) : null}
          {runState.waiting.length ? <section className="af-run-state__notice is-waiting"><span className="material-symbols-outlined">hourglass_top</span><div><strong>Run 正在等待处理</strong><p>{runState.waiting.map((item) => item.label).join("、")}</p></div></section> : null}
          {runState.status === "error" ? <section className="af-run-state__notice is-error"><span className="material-symbols-outlined">error</span><div><strong>Run 执行失败</strong><p>{run?.error || "请查看 Trace 或日志定位失败阶段。"}</p></div></section> : null}
          <section className="af-run-state__section">
            <div className="af-run-state__section-head"><h3>阶段状态</h3><span>{runState.stages.length} stages</span></div>
            {runState.stages.length ? <div className="af-run-state__stages">{runState.stages.map((stage) => (
              <div className={`af-run-state__stage is-${stage.status}`} key={stage.id}>
                <span className="material-symbols-outlined">{statusIcon(stage.status)}</span>
                <div><strong>{stage.label}</strong><small>{stateStatusLabel(stage.status)}{stage.branch ? ` · 分支 ${stage.branch.toUpperCase()}` : ""}{stage.lastEvent?.type ? ` · ${stage.lastEvent.type}` : ""}</small></div>
                <span className="af-run-state__stage-duration">{stage.durationMs ? formatRunInspectorDuration(stage.durationMs) : "—"}</span>
              </div>
            ))}</div> : <p className="af-run-state__empty">流程图暂无节点；状态将在 Run 事件到达后补充。</p>}
          </section>
          <details className="af-run-state__snapshot"><summary>查看 State 快照（只读投影）</summary><pre>{JSON.stringify(runState, null, 2)}</pre></details>
        </div>
      ) : tab === "report" ? (
        <div className="af-run-report">
          <section className="af-run-report__hero">
            <div>
              <span className="af-run-report__eyebrow">RUN 摘要</span>
              <h2>{report.label || run?.label || run?.runNodeId || "Workspace Run"}</h2>
              <code>{run?.runId || "-"}</code>
            </div>
            <span className={`af-work-run-logs__status af-work-run-logs__status--${String(run?.status || "").toLowerCase()}`}>{reportStatusLabel(run?.status)}</span>
          </section>
          <div className="af-run-report__facts">
            <div><span>触发方式</span><strong>{run?.scheduled || run?.trigger === "scheduled" ? "Scheduled Run" : "手动执行"}</strong></div>
            <div><span>开始时间</span><strong>{clock(run?.startedAt)}</strong></div>
            <div><span>耗时</span><strong>{formatRunInspectorDuration(run?.durationMs)}</strong></div>
            <div><span>事件数</span><strong>{report.eventCount ?? events.length}</strong></div>
          </div>
          <section className="af-run-report__section">
            <h3>执行结论</h3>
            <p>{report.summary || (run?.error ? run.error : reportStatusLabel(run?.status))}</p>
          </section>
          <section className="af-run-report__section">
            <h3>阶段产物</h3>
            {report.stages?.length ? report.stages.map((stage) => (
              <div className="af-run-report__stage" key={stage.id || stage.label}>
                <div className="af-run-report__stage-head"><strong>{stage.label}</strong><span>{stage.status || "unknown"}</span></div>
                {stage.artifacts?.length ? stage.artifacts.map((artifact, index) => (
                  <div className="af-run-report__artifact" key={`${artifact.name || artifact.path || "artifact"}-${index}`}>
                    <span className="material-symbols-outlined" aria-hidden>description</span>
                    {artifact.href ? <a href={artifact.href} target="_blank" rel="noreferrer">{artifact.name || artifact.path}</a> : <span>{artifact.name || artifact.path}</span>}
                  </div>
                )) : <p>该阶段没有产物。</p>}
              </div>
            )) : <p>本次执行没有可识别的阶段产物。</p>}
          </section>
        </div>
      ) : tab === "raw" ? (
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
            {!waterfallOnly ? <div className="af-run-inspector__turns">
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
            </div> : null}

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
