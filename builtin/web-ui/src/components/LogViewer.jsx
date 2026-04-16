/**
 * Composer Logs Viewer：右侧 drawer，左列会话列表，右列事件时间线 + tag 过滤。
 * 仅在 dev 模式（AGENTFLOW_DEV=1）显示入口按钮。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const TAG_GROUPS = {
  ai: [
    "planner-system", "planner-user", "planner-response",
    "agent-step-prompt", "repair-prompt",
    "ai-thinking", "ai-assistant", "ai-result", "ai-tool",
  ],
  flow: ["composer-start", "classify", "plan", "phase-plan", "phase-complete", "phase-auto-continue", "composer-done"],
  step: ["step-start", "step-progress", "step-done", "validation"],
  output: ["natural", "status"],
  error: ["error"],
};

const TAG_COLORS = {
  "planner-system": "#9ecaff",
  "planner-user": "#9ecaff",
  "planner-response": "#7c4dff",
  "agent-step-prompt": "#7c4dff",
  "repair-prompt": "#ff6b6b",
  "ai-thinking": "#a8b9d4",
  "ai-assistant": "#e8deff",
  "ai-result": "#00e475",
  "ai-tool": "#9ecaff",
  "composer-start": "#00e475",
  "composer-done": "#00e475",
  "step-start": "#e8deff",
  "step-done": "#e8deff",
  "step-progress": "#e8deff",
  "natural": "#a8a8a8",
  "status": "#a8a8a8",
  "error": "#ff6b6b",
  "phase-plan": "#00e475",
  "phase-complete": "#00e475",
};

function formatBytes(n) {
  if (!n || n < 1024) return `${n || 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}.${d.getMilliseconds().toString().padStart(3, "0")}`;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function tagGroupOf(tag, payload) {
  // 老日志兼容：tag="natural" 但 payload.kind=thinking|assistant|result → 归入 ai
  if (tag === "natural" && payload && typeof payload === "object") {
    const kind = payload.kind;
    if (kind === "thinking" || kind === "assistant" || kind === "result" || kind === "tool") return "ai";
    if (kind === "error") return "error";
  }
  for (const [g, tags] of Object.entries(TAG_GROUPS)) {
    if (tags.includes(tag)) return g;
  }
  return "other";
}

function EventRow({ event, defaultExpanded }) {
  const [expanded, setExpanded] = useState(Boolean(defaultExpanded));
  const color = TAG_COLORS[event.tag] || "#a8a8a8";
  const payload = event.payload;
  const isObj = payload && typeof payload === "object";
  const text = isObj ? (typeof payload.text === "string" ? payload.text : "") : String(payload || "");
  const meta = isObj ? payload.meta : null;
  const summary = useMemo(() => {
    if (text) return text.slice(0, 140).replace(/\s+/g, " ");
    if (isObj) {
      const keys = Object.keys(payload).filter((k) => k !== "text" && k !== "meta");
      const head = keys.slice(0, 3).map((k) => {
        const v = payload[k];
        if (v == null) return `${k}:null`;
        if (typeof v === "object") return `${k}:{…}`;
        return `${k}:${String(v).slice(0, 30)}`;
      }).join("  ");
      return head;
    }
    return "";
  }, [payload, text, isObj]);

  const copyAll = useCallback((e) => {
    e.stopPropagation();
    const dump = isObj ? JSON.stringify(payload, null, 2) : String(payload);
    try { navigator.clipboard.writeText(dump); } catch { /* ignore */ }
  }, [payload, isObj]);

  return (
    <div style={{
      borderLeft: `3px solid ${color}`,
      background: expanded ? "#1c1b1b" : "#131313",
      marginBottom: 4,
      borderRadius: 4,
      cursor: "pointer",
      transition: "background 120ms",
    }}
      onClick={() => setExpanded((v) => !v)}
    >
      <div style={{ padding: "6px 10px", display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
        <span style={{ color: "#9a9a9a", fontFamily: "monospace", flexShrink: 0 }}>{formatTime(event.ts)}</span>
        <span style={{
          color,
          fontWeight: 600,
          fontFamily: "monospace",
          flexShrink: 0,
          padding: "1px 6px",
          background: "rgba(255,255,255,0.04)",
          borderRadius: 3,
        }}>{event.tag}</span>
        <span style={{
          color: "#c5c2c1",
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: "monospace",
        }}>{summary}</span>
        {expanded && (
          <button
            type="button"
            onClick={copyAll}
            style={{
              background: "rgba(124,77,255,0.15)",
              color: "#e8deff",
              border: "none",
              borderRadius: 3,
              padding: "2px 8px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >Copy</button>
        )}
      </div>
      {expanded && (
        <div style={{ padding: "0 10px 10px 10px", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
          {meta && Object.keys(meta).length > 0 && (
            <div style={{
              marginTop: 8,
              padding: 8,
              background: "#0e0e0e",
              borderRadius: 4,
              fontSize: 11,
              fontFamily: "monospace",
              color: "#9ecaff",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}>{JSON.stringify(meta, null, 2)}</div>
          )}
          {text ? (
            <pre style={{
              marginTop: 8,
              padding: 10,
              background: "#0e0e0e",
              borderRadius: 4,
              fontSize: 12,
              color: "#e5e2e1",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 600,
              overflowY: "auto",
              margin: "8px 0 0 0",
              fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
            }}>{text}</pre>
          ) : isObj ? (
            <pre style={{
              marginTop: 8,
              padding: 10,
              background: "#0e0e0e",
              borderRadius: 4,
              fontSize: 12,
              color: "#e5e2e1",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              maxHeight: 400,
              overflowY: "auto",
              margin: "8px 0 0 0",
              fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
            }}>{JSON.stringify(payload, null, 2)}</pre>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default function LogViewer({ open, onClose, flowId }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [sessionDetail, setSessionDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filterFlow, setFilterFlow] = useState(true);
  const [enabledGroups, setEnabledGroups] = useState({ ai: true, flow: true, step: true, output: true, error: true });
  const [search, setSearch] = useState("");
  const pollRef = useRef(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const qs = filterFlow && flowId ? `?flowId=${encodeURIComponent(flowId)}` : "";
      const resp = await fetch(`/api/composer-logs${qs}`);
      const data = await resp.json();
      setSessions(Array.isArray(data.sessions) ? data.sessions : []);
    } catch (e) {
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [flowId, filterFlow]);

  const loadSessionDetail = useCallback(async (sessionId) => {
    if (!sessionId) {
      setSessionDetail(null);
      return;
    }
    setDetailLoading(true);
    try {
      const resp = await fetch(`/api/composer-logs/${encodeURIComponent(sessionId)}`);
      const data = await resp.json();
      setSessionDetail(data);
    } catch (e) {
      setSessionDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    loadSessions();
  }, [open, loadSessions]);

  useEffect(() => {
    if (!open || !selectedSessionId) return;
    loadSessionDetail(selectedSessionId);
    // 选中会话时轮询，方便实时查看正在跑的会话
    pollRef.current = setInterval(() => loadSessionDetail(selectedSessionId), 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [open, selectedSessionId, loadSessionDetail]);

  const filteredEvents = useMemo(() => {
    const events = sessionDetail?.events || [];
    const searchLower = search.trim().toLowerCase();
    return events.filter((ev) => {
      const grp = tagGroupOf(ev.tag, ev.payload);
      if (!enabledGroups[grp] && grp !== "other") return false;
      if (!searchLower) return true;
      const haystack = [ev.tag, JSON.stringify(ev.payload || "")].join(" ").toLowerCase();
      return haystack.includes(searchLower);
    });
  }, [sessionDetail, enabledGroups, search]);

  const tagCounts = useMemo(() => {
    const events = sessionDetail?.events || [];
    const counts = {};
    for (const ev of events) {
      const grp = tagGroupOf(ev.tag, ev.payload);
      counts[grp] = (counts[grp] || 0) + 1;
    }
    return counts;
  }, [sessionDetail]);

  if (!open) return null;

  return (
    <div style={{
      position: "fixed",
      top: 0,
      right: 0,
      bottom: 0,
      width: "min(1100px, 80vw)",
      background: "#131313",
      borderLeft: "1px solid rgba(255,255,255,0.08)",
      display: "flex",
      flexDirection: "column",
      zIndex: 9999,
      boxShadow: "-8px 0 32px rgba(0,0,0,0.5)",
      color: "#e5e2e1",
      fontFamily: "Inter, system-ui, sans-serif",
    }}>
      <div style={{
        padding: "12px 16px",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexShrink: 0,
        background: "#1c1b1b",
      }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Composer Logs</span>
        <span style={{ fontSize: 11, color: "#9a9a9a" }}>
          {flowId ? `flowId: ${flowId}` : "no flow selected"}
        </span>
        <label style={{ fontSize: 11, color: "#9a9a9a", display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={filterFlow}
            onChange={(e) => setFilterFlow(e.target.checked)}
            disabled={!flowId}
          />
          仅显示当前 flow
        </label>
        <button
          type="button"
          onClick={loadSessions}
          style={{
            background: "rgba(124,77,255,0.15)",
            color: "#e8deff",
            border: "none",
            borderRadius: 4,
            padding: "4px 10px",
            fontSize: 12,
            cursor: "pointer",
          }}
        >Refresh</button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onClose}
          style={{
            background: "transparent",
            color: "#e5e2e1",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 4,
            padding: "4px 12px",
            fontSize: 12,
            cursor: "pointer",
          }}
        >Close</button>
      </div>

      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
        <div style={{
          width: 280,
          borderRight: "1px solid rgba(255,255,255,0.06)",
          overflowY: "auto",
          background: "#0e0e0e",
          flexShrink: 0,
        }}>
          {loading && <div style={{ padding: 12, fontSize: 12, color: "#9a9a9a" }}>Loading…</div>}
          {!loading && sessions.length === 0 && (
            <div style={{ padding: 12, fontSize: 12, color: "#9a9a9a" }}>
              {filterFlow && flowId ? "no sessions for this flow" : "no sessions"}
            </div>
          )}
          {sessions.map((s) => {
            const active = selectedSessionId === s.sessionId;
            return (
              <div
                key={s.sessionId}
                onClick={() => setSelectedSessionId(s.sessionId)}
                style={{
                  padding: "10px 12px",
                  borderBottom: "1px solid rgba(255,255,255,0.04)",
                  cursor: "pointer",
                  background: active ? "rgba(124,77,255,0.18)" : "transparent",
                  borderLeft: active ? "3px solid #7c4dff" : "3px solid transparent",
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, color: "#e5e2e1" }}>
                  {formatDate(s.mtime)}
                </div>
                <div style={{ fontSize: 11, color: "#9ecaff", marginTop: 2, fontFamily: "monospace" }}>
                  {s.flowId || "(no flow)"}
                </div>
                {s.promptPreview && (
                  <div style={{
                    fontSize: 11,
                    color: "#9a9a9a",
                    marginTop: 4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                  }}>{s.promptPreview}</div>
                )}
                <div style={{ fontSize: 10, color: "#6a6a6a", marginTop: 4 }}>
                  {formatBytes(s.size)} · {s.model || "default"}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
          <div style={{
            padding: "10px 16px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            flexShrink: 0,
            background: "#1c1b1b",
          }}>
            {Object.keys(TAG_GROUPS).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setEnabledGroups((prev) => ({ ...prev, [g]: !prev[g] }))}
                style={{
                  background: enabledGroups[g] ? "rgba(124,77,255,0.25)" : "transparent",
                  color: enabledGroups[g] ? "#e8deff" : "#6a6a6a",
                  border: `1px solid ${enabledGroups[g] ? "rgba(124,77,255,0.4)" : "rgba(255,255,255,0.08)"}`,
                  borderRadius: 999,
                  padding: "3px 12px",
                  fontSize: 11,
                  cursor: "pointer",
                  fontFamily: "monospace",
                  textTransform: "uppercase",
                }}
              >
                {g} {tagCounts[g] != null ? `(${tagCounts[g]})` : ""}
              </button>
            ))}
            <input
              type="text"
              placeholder="search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                marginLeft: 8,
                flex: 1,
                minWidth: 120,
                background: "#0e0e0e",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 4,
                color: "#e5e2e1",
                padding: "4px 8px",
                fontSize: 12,
              }}
            />
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: 12, minHeight: 0 }}>
            {!selectedSessionId && (
              <div style={{ color: "#9a9a9a", fontSize: 12, padding: 20, textAlign: "center" }}>
                Select a session on the left to view events
              </div>
            )}
            {detailLoading && !sessionDetail && (
              <div style={{ color: "#9a9a9a", fontSize: 12, padding: 20 }}>Loading…</div>
            )}
            {sessionDetail && filteredEvents.length === 0 && (
              <div style={{ color: "#9a9a9a", fontSize: 12, padding: 20 }}>
                No events match current filter ({sessionDetail.events?.length || 0} total)
              </div>
            )}
            {filteredEvents.map((ev, i) => (
              <EventRow key={`${ev.ts}_${i}`} event={ev} defaultExpanded={ev.tag === "error"} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
