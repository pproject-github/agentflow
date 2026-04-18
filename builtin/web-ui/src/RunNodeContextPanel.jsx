import { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  RunContextPromptBody,
  RunContextOutputBody,
  runContextOutputFormatPill,
} from "./runContextDisplay.jsx";

/**
 * Run-mode right sidebar: shows a selected node's execution context.
 * Top: execution history rounds (with status + date).
 * Body: prompt + output slot contents for the selected round.
 */

const FETCH_TIMEOUT_MS = 20000;

const RUN_NODE_CTX_WIDTH_STORAGE_KEY = "af:run-node-ctx-width";

/** 与原先 CSS `min(26rem, calc(100vw - 2rem))` 默认一致 */
function defaultRunNodeCtxWidthPx() {
  if (typeof window === "undefined") return 416;
  return Math.min(26 * 16, window.innerWidth - 32);
}

function clampRunNodeCtxWidthPx(w) {
  const min = 200;
  const max = Math.max(min + 80, Math.min(Math.floor(window.innerWidth * 0.92), 1200));
  if (!Number.isFinite(w)) return clampRunNodeCtxWidthPx(defaultRunNodeCtxWidthPx());
  return Math.min(Math.max(Math.round(w), min), max);
}

function readRunNodeCtxWidthPx() {
  try {
    const raw = localStorage.getItem(RUN_NODE_CTX_WIDTH_STORAGE_KEY);
    if (raw == null) return clampRunNodeCtxWidthPx(defaultRunNodeCtxWidthPx());
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return clampRunNodeCtxWidthPx(defaultRunNodeCtxWidthPx());
    return clampRunNodeCtxWidthPx(n);
  } catch {
    return clampRunNodeCtxWidthPx(defaultRunNodeCtxWidthPx());
  }
}

async function fetchNodeExecContextJson(flowId, instanceId, runId, signal) {
  const q = new URLSearchParams({ flowId, instanceId });
  if (runId && String(runId).trim()) q.set("runId", String(runId).trim());
  const r = await fetch(`/api/node-exec-context?${q.toString()}`, { signal });
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(
      text.startsWith("<!") || text.startsWith("<html")
        ? "apiConnectError"
        : "invalidJson",
    );
  }
  if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
  return j;
}

/** Map error keys to i18n keys, pass through unknown messages */
function localizeError(t, msg) {
  const key = `flow:runContext.${msg}`;
  const localized = t(key);
  return localized !== key ? localized : msg;
}

export default function RunNodeContextPanel({ instanceId, flowId, runId, nodeStatus, onClose }) {
  const { t } = useTranslation();
  const [narrowLayout, setNarrowLayout] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 960px)").matches,
  );
  const [panelWidthPx, setPanelWidthPx] = useState(readRunNodeCtxWidthPx);
  const ctxResizeDragRef = useRef(
    /** @type {{ active: boolean, pointerId: number, startX: number, startW: number }} */ ({
      active: false,
      pointerId: -1,
      startX: 0,
      startW: 416,
    }),
  );

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [rounds, setRounds] = useState([]);
  const [selectedRound, setSelectedRound] = useState(null);
  const [expandedSection, setExpandedSection] = useState(/** @type {null | "prompt" | "output"} */ (null));
  const bodyRef = useRef(null);
  const pollRef = useRef(null);
  const refreshSeqRef = useRef(0);
  /** 仅用于首屏请求：与 refreshSeq 分离，避免 runId 切换 / 清理时永远卡在「加载中」 */
  const loadGenRef = useRef(0);

  useLayoutEffect(() => {
    const mq = window.matchMedia("(max-width: 960px)");
    const onChange = () => setNarrowLayout(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    function onResize() {
      setPanelWidthPx((w) => clampRunNodeCtxWidthPx(w));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const persistRunNodeCtxWidth = useCallback(() => {
    setPanelWidthPx((w) => {
      const clamped = clampRunNodeCtxWidthPx(w);
      try {
        localStorage.setItem(RUN_NODE_CTX_WIDTH_STORAGE_KEY, String(clamped));
      } catch {
        /* ignore */
      }
      return clamped;
    });
  }, []);

  const onCtxResizePointerDown = useCallback(
    (e) => {
      if (narrowLayout || e.button !== 0) return;
      e.preventDefault();
      const el = e.currentTarget;
      ctxResizeDragRef.current = {
        active: true,
        pointerId: e.pointerId,
        startX: e.clientX,
        startW: panelWidthPx,
      };
      el.setPointerCapture(e.pointerId);
    },
    [narrowLayout, panelWidthPx],
  );

  const onCtxResizePointerMove = useCallback(
    (e) => {
      const d = ctxResizeDragRef.current;
      if (!d.active || e.pointerId !== d.pointerId) return;
      const delta = d.startX - e.clientX;
      setPanelWidthPx(clampRunNodeCtxWidthPx(d.startW + delta));
    },
    [],
  );

  const onCtxResizePointerUp = useCallback(
    (e) => {
      const d = ctxResizeDragRef.current;
      if (!d.active || e.pointerId !== d.pointerId) return;
      d.active = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      persistRunNodeCtxWidth();
    },
    [persistRunNodeCtxWidth],
  );

  const onCtxResizeLostCapture = useCallback(() => {
    const d = ctxResizeDragRef.current;
    if (!d.active) return;
    d.active = false;
    persistRunNodeCtxWidth();
  }, [persistRunNodeCtxWidth]);

  const applyRoundsPayload = useCallback((list) => {
    const next = Array.isArray(list) ? list : [];
    setRounds(next);
    setSelectedRound((prev) => {
      if (prev && next.some((r) => r.execId === prev)) return prev;
      return next.length > 0 ? next[next.length - 1].execId : null;
    });
  }, []);

  /** 轮询 / nodeStatus 刷新：不操纵首屏 loading */
  const refreshContext = useCallback(() => {
    if (!instanceId || !flowId) return;
    const seq = ++refreshSeqRef.current;
    const ac = new AbortController();
    const t = window.setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    (async () => {
      try {
        const j = await fetchNodeExecContextJson(flowId, instanceId, runId, ac.signal);
        if (seq !== refreshSeqRef.current) return;
        applyRoundsPayload(Array.isArray(j.rounds) ? j.rounds : []);
      } catch {
        /* 轮询失败不覆盖侧栏：保留上一轮数据，避免执行中偶发超时刷成错误态 */
      } finally {
        window.clearTimeout(t);
      }
    })();
  }, [instanceId, flowId, runId, applyRoundsPayload]);

  useEffect(() => {
    if (!instanceId || !flowId) {
      setLoading(false);
      setError("");
      setRounds([]);
      return;
    }
    const gen = ++loadGenRef.current;
    setLoading(true);
    setError("");
    setRounds([]);
    setSelectedRound(null);

    const ac = new AbortController();
    const t = window.setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);

    (async () => {
      try {
        const j = await fetchNodeExecContextJson(flowId, instanceId, runId, ac.signal);
        if (gen !== loadGenRef.current) return;
        applyRoundsPayload(Array.isArray(j.rounds) ? j.rounds : []);
      } catch (e) {
        if (gen !== loadGenRef.current) return;
        const msg = e?.name === "AbortError" ? "requestTimeout" : e.message || String(e);
        setError(msg);
      } finally {
        window.clearTimeout(t);
        if (gen === loadGenRef.current) setLoading(false);
      }
    })();

    return () => {
      ac.abort();
      loadGenRef.current++;
      refreshSeqRef.current++;
    };
  }, [instanceId, flowId, runId, applyRoundsPayload]);

  useEffect(() => {
    if (nodeStatus) refreshContext();
  }, [nodeStatus, refreshContext]);

  useEffect(() => {
    clearInterval(pollRef.current);
    const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;
    /**
     * 运行中：画布上该节点为 running 但磁盘上尚未出现 round 时也要轮询，否则会一直停在空态；
     * 已有 round 且状态为 running 时继续轮询直至写完。
     */
    const shouldPoll =
      (nodeStatus === "running" && rounds.length === 0) ||
      Boolean(lastRound && lastRound.status === "running");
    if (shouldPoll && instanceId && flowId) {
      pollRef.current = setInterval(() => refreshContext(), 2000);
    }
    return () => clearInterval(pollRef.current);
  }, [rounds, instanceId, flowId, runId, nodeStatus, refreshContext]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [selectedRound]);

  const active = rounds.find((r) => r.execId === selectedRound);

  const panelStyle = narrowLayout ? undefined : { width: `${panelWidthPx}px` };

  return (
    <aside
      className="af-run-ctx-panel"
      style={panelStyle}
      aria-label={t("flow:runContext.title")}
    >
      {!narrowLayout ? (
        <div
          className="af-run-ctx-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("flow:runContext.resizeHandle")}
          onPointerDown={onCtxResizePointerDown}
          onPointerMove={onCtxResizePointerMove}
          onPointerUp={onCtxResizePointerUp}
          onPointerCancel={onCtxResizePointerUp}
          onLostPointerCapture={onCtxResizeLostCapture}
        />
      ) : null}
      <div className="af-run-ctx-panel__main">
        <div className="af-run-ctx-head">
          <h2 className="af-run-ctx-title" title={instanceId}>{instanceId}</h2>
          <button type="button" className="af-icon-btn" onClick={onClose} aria-label={t("common:common.close")}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {loading && <div className="af-run-ctx-placeholder">{t("common:common.loading")}</div>}
        {error && <div className="af-run-ctx-error">{localizeError(t, error)}</div>}

        {!loading && !error && rounds.length === 0 && (
          <div className="af-run-ctx-placeholder">
            {nodeStatus === "running"
              ? t("flow:runContext.executingNoArtifacts")
              : t("flow:runContext.noData")}
          </div>
        )}

        {rounds.length > 0 && (
          <>
            <div className="af-run-ctx-rounds">
              {rounds.map((r) => {
                const isActive = r.execId === selectedRound;
                const statusCls =
                  r.status === "success" ? " af-run-ctx-round--success" :
                  r.status === "failed" ? " af-run-ctx-round--failed" :
                  r.status === "running" ? " af-run-ctx-round--running" : "";
                return (
                  <button
                    key={r.execId}
                    type="button"
                    className={"af-run-ctx-round" + (isActive ? " af-run-ctx-round--active" : "") + statusCls}
                    onClick={() => setSelectedRound(r.execId)}
                  >
                    <span className="af-run-ctx-round-id">
                      {r.execId === "latest" ? t("flow:runContext.latest") : `#${r.execId}`}
                    </span>
                    <span className={"af-run-ctx-round-status" + statusCls}>
                      {r.status || "–"}
                    </span>
                    {r.finishedAt && (
                      <span className="af-run-ctx-round-date">
                        {formatDate(r.finishedAt)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {active && (
              <div className="af-run-ctx-body" ref={bodyRef}>
                {active.inputs && active.inputs.length > 0 && (
                  <section className="af-run-ctx-section">
                    <h3 className="af-run-ctx-section-title">
                      <span className="material-symbols-outlined af-run-ctx-section-icon" aria-hidden>input</span>
                      Inputs
                    </h3>
                    {active.inputs.map((inp, i) => (
                      <div key={`${inp.slot}-${i}`} className="af-run-ctx-output-slot">
                        <div className="af-run-ctx-slot-head">
                          <div className="af-run-ctx-slot-name">{inp.slot}</div>
                        </div>
                        <pre className="af-run-ctx-slot-text">{inp.value}</pre>
                      </div>
                    ))}
                  </section>
                )}
                {active.prompt != null && (
                  <section className="af-run-ctx-section">
                    <h3 className="af-run-ctx-section-title">
                      <span className="material-symbols-outlined af-run-ctx-section-icon" aria-hidden>description</span>
                      Prompt
                      <button
                        type="button"
                        className="af-icon-btn af-run-ctx-section-expand"
                        onClick={() => setExpandedSection("prompt")}
                        title={t("flow:nodeProps.expand")}
                      >
                        <span className="material-symbols-outlined">open_in_full</span>
                      </button>
                    </h3>
                    <RunContextPromptBody text={active.prompt} />
                  </section>
                )}
                {active.outputs && active.outputs.length > 0 && (
                  <section className="af-run-ctx-section">
                    <h3 className="af-run-ctx-section-title">
                      <span className="material-symbols-outlined af-run-ctx-section-icon" aria-hidden>output</span>
                      Outputs
                      <button
                        type="button"
                        className="af-icon-btn af-run-ctx-section-expand"
                        onClick={() => setExpandedSection("output")}
                        title={t("flow:nodeProps.expand")}
                      >
                        <span className="material-symbols-outlined">open_in_full</span>
                      </button>
                    </h3>
                    {active.outputs.map((o, i) => {
                      const hint = runContextOutputFormatPill(o);
                      return (
                        <div key={`${o.slot}-${i}`} className="af-run-ctx-output-slot">
                          <div className="af-run-ctx-slot-head">
                            <div className="af-run-ctx-slot-name">{o.slot}</div>
                            {hint ? (
                              <span className="af-run-ctx-format-badge" title={t("flow:runContext.detectedContentType")}>
                                {hint}
                              </span>
                            ) : null}
                          </div>
                          <RunContextOutputBody o={o} />
                        </div>
                      );
                    })}
                  </section>
                )}
                {!active.prompt && (!active.outputs || active.outputs.length === 0) && (
                  <div className="af-run-ctx-placeholder">{t("flow:runContext.roundNoContent")}</div>
                )}
              </div>
            )}
          </>
        )}
      </div>
      {expandedSection && active && (
        <div
          className="af-node-props-expand-overlay"
          role="dialog"
          aria-modal="true"
          onClick={(e) => { if (e.target === e.currentTarget) setExpandedSection(null); }}
        >
          <div className="af-node-props-expand-panel">
            <div className="af-node-props-expand-head">
              <span className="af-node-props-expand-title">
                {expandedSection === "prompt" ? "Prompt" : "Outputs"}
              </span>
              <button type="button" className="af-icon-btn" onClick={() => setExpandedSection(null)} aria-label={t("common:common.close")}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="af-node-props-expand-body af-run-ctx-expand-body">
              {expandedSection === "prompt" && active.prompt != null && (
                <RunContextPromptBody text={active.prompt} />
              )}
              {expandedSection === "output" && active.outputs && active.outputs.map((o, i) => {
                const hint = runContextOutputFormatPill(o);
                return (
                  <div key={`${o.slot}-${i}`} className="af-run-ctx-output-slot" style={{ marginBottom: "1rem" }}>
                    <div className="af-run-ctx-slot-head">
                      <div className="af-run-ctx-slot-name">{o.slot}</div>
                      {hint ? (
                        <span className="af-run-ctx-format-badge">{hint}</span>
                      ) : null}
                    </div>
                    <RunContextOutputBody o={o} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return iso;
  }
}
