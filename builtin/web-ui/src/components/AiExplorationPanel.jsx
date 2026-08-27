import { useCallback, useEffect, useMemo, useState } from "react";

function scopePayload(flowParams = {}) {
  return {
    flowId: flowParams.flowId || "",
    flowSource: flowParams.flowSource || "user",
    ...(flowParams.adminOwnerId ? { adminOwnerId: flowParams.adminOwnerId } : {}),
    ...(flowParams.archived ? { archived: true } : {}),
  };
}

function scopeQuery(flowParams = {}, extra = {}) {
  const params = new URLSearchParams();
  const payload = { ...scopePayload(flowParams), ...extra };
  for (const [key, value] of Object.entries(payload)) {
    if (value === "" || value == null || value === false) continue;
    params.set(key, value === true ? "1" : String(value));
  }
  return params.toString();
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function phaseLabel(phase) {
  if (phase === "planned") return "PLAN";
  if (phase === "simulated") return "DRY-RUN";
  if (phase === "materialized") return "DSL";
  return "ACTUAL";
}

function statusIcon(status) {
  if (status === "success") return "check_circle";
  if (status === "blocked") return "block";
  if (status === "error") return "error";
  if (status === "running") return "progress_activity";
  return "radio_button_unchecked";
}

function traceDepth(event, bySpan) {
  let depth = 0;
  let parent = event.parentSpanId;
  const seen = new Set();
  while (parent && bySpan.has(parent) && !seen.has(parent) && depth < 6) {
    seen.add(parent);
    depth += 1;
    parent = bySpan.get(parent)?.parentSpanId;
  }
  return depth;
}

export default function AiExplorationPanel({ flowParams, workspaceWritable, model = "", onClose, onMaterialized }) {
  const [sessions, setSessions] = useState([]);
  const [active, setActive] = useState(null);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [sideEffectsApproved, setSideEffectsApproved] = useState(false);
  const [showOnlyPlan, setShowOnlyPlan] = useState(false);

  const loadSessions = useCallback(async () => {
    const payload = await requestJson(`/api/workspace/explorations?${scopeQuery(flowParams)}`);
    setSessions(Array.isArray(payload.explorations) ? payload.explorations : []);
    return payload.explorations || [];
  }, [flowParams]);

  const loadDetail = useCallback(async (id) => {
    if (!id) return null;
    const payload = await requestJson(`/api/workspace/exploration?${scopeQuery(flowParams, { id })}`);
    setActive(payload.exploration || null);
    return payload.exploration || null;
  }, [flowParams]);

  useEffect(() => {
    let cancelled = false;
    void loadSessions().then((items) => {
      if (cancelled || active || !items[0]?.id) return;
      void loadDetail(items[0].id);
    }).catch((loadError) => {
      if (!cancelled) setError(String(loadError.message || loadError));
    });
    return () => { cancelled = true; };
  }, [active, loadDetail, loadSessions]);

  useEffect(() => {
    if (!active?.id || !["planning", "running"].includes(active.status)) return undefined;
    const timer = window.setInterval(() => void loadDetail(active.id).catch(() => {}), 4000);
    return () => window.clearInterval(timer);
  }, [active?.id, active?.status, loadDetail]);

  const createPlan = useCallback(async () => {
    const text = goal.trim();
    if (!text || busy) return;
    setBusy("plan");
    setError("");
    setSideEffectsApproved(false);
    try {
      const payload = await requestJson("/api/workspace/exploration/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...scopePayload(flowParams), goal: text, model }),
      });
      setActive(payload.exploration || null);
      await loadSessions();
    } catch (planError) {
      setError(String(planError.message || planError));
    } finally {
      setBusy("");
    }
  }, [busy, flowParams, goal, loadSessions, model]);

  const createExternalTrace = useCallback(async () => {
    if (busy) return;
    setBusy("external");
    setError("");
    try {
      const payload = await requestJson("/api/workspace/exploration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...scopePayload(flowParams),
          title: goal.trim() || "外部 Agent 运行",
          goal: goal.trim(),
          mode: "observed",
          status: "running",
          source: { provider: "external", agent: "Codex / Agent SDK" },
        }),
      });
      setActive({ ...(payload.exploration || {}), events: [] });
      await loadSessions();
    } catch (createError) {
      setError(String(createError.message || createError));
    } finally {
      setBusy("");
    }
  }, [busy, flowParams, goal, loadSessions]);

  const runDryCheck = useCallback(async () => {
    if (!active?.id || busy) return;
    setBusy("dry-run");
    setError("");
    setSideEffectsApproved(false);
    try {
      const payload = await requestJson("/api/workspace/exploration/dry-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...scopePayload(flowParams), id: active.id }),
      });
      setActive(payload.exploration || null);
      await loadSessions();
    } catch (dryError) {
      setError(String(dryError.message || dryError));
    } finally {
      setBusy("");
    }
  }, [active?.id, busy, flowParams, loadSessions]);

  const materialize = useCallback(async () => {
    if (!active?.id || busy) return;
    setBusy("materialize");
    setError("");
    setActive((current) => current ? { ...current, status: "running", mode: "observed" } : current);
    try {
      const payload = await requestJson("/api/workspace/exploration/materialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...scopePayload(flowParams), id: active.id, model, approveSideEffects: sideEffectsApproved }),
      });
      setActive((current) => current ? { ...current, ...(payload.exploration || {}) } : payload.exploration);
      await loadSessions();
      await onMaterialized?.(payload);
    } catch (materializeError) {
      setError(String(materializeError.message || materializeError));
      await loadDetail(active.id).catch(() => {});
    } finally {
      setBusy("");
    }
  }, [active?.id, busy, flowParams, loadDetail, loadSessions, model, onMaterialized, sideEffectsApproved]);

  const events = Array.isArray(active?.events) ? active.events : [];
  const visibleEvents = showOnlyPlan ? events.filter((event) => event.phase === "planned") : events;
  const bySpan = useMemo(() => new Map(visibleEvents.map((event) => [event.spanId, event])), [visibleEvents]);
  const plannedEvents = events.filter((event) => event.phase === "planned");
  const materializableEvents = plannedEvents.length ? plannedEvents : events.filter((event) => event.phase === "observed");
  const dangerous = materializableEvents.filter((event) => event.requiresApproval || ["write", "external"].includes(event.sideEffect));
  const ingestBody = active?.id ? JSON.stringify({
    ...scopePayload(flowParams),
    id: active.id,
    phase: "observed",
    events: [{ type: "tool", name: "exec_command", status: "success", sideEffect: "read", summary: "Describe the observed step" }],
  }, null, 2) : "";

  return (
    <aside className="af-pipeline-drawer af-pipeline-drawer--wide af-ai-exploration" aria-label="AI 探索运行图">
      <header className="af-ai-exploration__head">
        <div>
          <span className="af-ai-exploration__eyebrow">AGENT EXECUTION TRACE</span>
          <h2>AI 探索运行图</h2>
          <p>先看计划和副作用，再执行；验证成功后固化为 Workspace DSL。</p>
        </div>
        <button type="button" className="af-pipeline-drawer-close af-icon-btn" onClick={onClose} aria-label="关闭 AI 探索运行图">
          <span className="material-symbols-outlined">close</span>
        </button>
      </header>

      <section className="af-ai-exploration__create">
        <textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="描述希望 AI 完成的目标，例如：分析昨天失败的流水线并生成可复用修复流程" />
        <div className="af-ai-exploration__create-actions">
          <button type="button" className="af-btn-primary" disabled={!workspaceWritable || !goal.trim() || Boolean(busy)} onClick={() => void createPlan()}>
            <span className="material-symbols-outlined">account_tree</span>
            {busy === "plan" ? "生成 Plan 中" : "生成预计运行图"}
          </button>
          <button type="button" className="af-set-btn-outline" disabled={!workspaceWritable || Boolean(busy)} onClick={() => void createExternalTrace()}>
            <span className="material-symbols-outlined">hub</span>
            接入外部 Agent
          </button>
        </div>
      </section>

      {sessions.length ? (
        <nav className="af-ai-exploration__sessions" aria-label="探索运行">
          {sessions.map((session) => (
            <button key={session.id} type="button" className={active?.id === session.id ? "is-active" : ""} onClick={() => void loadDetail(session.id)}>
              <span>{session.title}</span>
              <small>{phaseLabel(session.mode)} · {session.eventCount}</small>
            </button>
          ))}
        </nav>
      ) : null}

      {active ? (
        <div className="af-ai-exploration__body">
          <section className="af-ai-exploration__summary">
            <div>
              <span className={`af-ai-exploration__phase is-${active.mode}`}>{phaseLabel(active.mode)}</span>
              <strong>{active.title}</strong>
              <small>{active.source?.provider} · {active.source?.agent}</small>
            </div>
            <p>{active.summary || active.goal || "等待 Trace 事件"}</p>
          </section>

          <div className="af-ai-exploration__toolbar">
            <button type="button" className="af-set-btn-outline" disabled={!events.some((event) => event.phase === "planned") || Boolean(busy)} onClick={() => void runDryCheck()}>
              <span className="material-symbols-outlined">science</span>
              {busy === "dry-run" ? "预检中" : "Dry-run 策略预检"}
            </button>
            <label>
              <input type="checkbox" checked={showOnlyPlan} onChange={(event) => setShowOnlyPlan(event.target.checked)} />
              只看 Plan
            </label>
          </div>

          {dangerous.length ? (
            <section className="af-ai-exploration__risk">
              <strong><span className="material-symbols-outlined">warning</span>{dangerous.length} 个副作用步骤需要审核</strong>
              <p>{dangerous.map((event) => event.name).join("、")}</p>
              <label>
                <input type="checkbox" checked={sideEffectsApproved} onChange={(event) => setSideEffectsApproved(event.target.checked)} />
                我已审核这些副作用，仅授权生成 DSL，不立即执行
              </label>
            </section>
          ) : null}

          <section className="af-ai-trace" aria-label="AI 执行 Trace">
            {visibleEvents.length ? visibleEvents.map((event) => {
              const depth = traceDepth(event, bySpan);
              return (
                <article key={`${event.sequence}-${event.id}`} className={`af-ai-trace__event is-${event.status} is-${event.phase}`} style={{ "--trace-depth": depth }}>
                  <span className="af-ai-trace__rail" aria-hidden />
                  <span className="material-symbols-outlined af-ai-trace__status">{statusIcon(event.status)}</span>
                  <div className="af-ai-trace__content">
                    <div className="af-ai-trace__title">
                      <span>{phaseLabel(event.phase)}</span>
                      <strong>{event.name}</strong>
                      <em className={`is-${event.sideEffect}`}>{event.sideEffect}</em>
                    </div>
                    {event.summary ? <p>{event.summary}</p> : null}
                    {event.inputPreview ? <small>输入：{event.inputPreview}</small> : null}
                    {event.outputPreview ? <small>输出：{event.outputPreview}</small> : null}
                  </div>
                </article>
              );
            }) : <div className="af-ai-exploration__empty">尚无事件。外部 Agent 可通过 Trace API 持续写入执行步骤。</div>}
          </section>

          {active.source?.provider === "external" ? (
            <details className="af-ai-exploration__ingest">
              <summary>外部 Agent 接入格式</summary>
              <p>使用当前 AgentFlow Bearer Token 请求 <code>POST /api/workspace/exploration/events</code>：</p>
              <pre>{ingestBody}</pre>
              <button type="button" className="af-set-btn-outline" onClick={() => void navigator.clipboard?.writeText(ingestBody)}>复制请求体</button>
            </details>
          ) : null}

          <footer className="af-ai-exploration__footer">
            <span>固化只生成调整态 DSL，不会发布或启动定时任务。</span>
            <button
              type="button"
              className="af-btn-primary"
              disabled={!workspaceWritable || !events.length || Boolean(busy) || (dangerous.length > 0 && !sideEffectsApproved)}
              onClick={() => void materialize()}
            >
              <span className="material-symbols-outlined">deployed_code</span>
              {busy === "materialize" ? "正在固化" : "固化为 Workspace DSL"}
            </button>
          </footer>
        </div>
      ) : <div className="af-ai-exploration__empty">输入目标生成 Plan，或创建一个 Trace 接收外部 Codex/Agent 的执行事件。</div>}

      {error ? <div className="af-ai-exploration__error" role="alert">{error}</div> : null}
    </aside>
  );
}
