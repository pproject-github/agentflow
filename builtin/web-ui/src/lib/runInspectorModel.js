function numericTime(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseRawObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const text = String(value || "").trim();
  if (!text || (text[0] !== "{" && text[0] !== "[")) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
}

function embeddedCommand(event, raw) {
  const candidates = [
    event.command,
    event.script,
    raw?.command,
    raw?.cmd,
    raw?.item?.command,
    raw?.item?.cmd,
    raw?.tool_call?.shell?.command,
    raw?.tool_call?.exec_command?.command,
    raw?.tool_call?.exec_command?.cmd,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === "object") {
      const name = firstText(candidate.command, candidate.name);
      const args = Array.isArray(candidate.args) ? candidate.args.join(" ") : firstText(candidate.args);
      const value = `${name} ${args}`.trim();
      if (value) return value;
    }
  }
  return "";
}

function eventText(event, raw) {
  const direct = firstText(
    event.text,
    event.line,
    event.error,
    event.message,
    event.summary,
    raw?.text,
    raw?.message,
    raw?.error?.message,
    raw?.error,
    raw?.item?.text,
    raw?.item?.message,
  );
  if (direct) return direct;
  try {
    return JSON.stringify(event);
  } catch {
    return String(event?.type || "event");
  }
}

function eventStatus(event, raw) {
  const value = `${event.status || ""} ${raw?.status || ""} ${raw?.item?.status || ""} ${event.type || ""} ${event.kind || ""}`.toLowerCase();
  const exitCode = event.exitCode ?? raw?.exitCode ?? raw?.exit_code ?? raw?.item?.exit_code;
  if (value.includes("error") || value.includes("failed") || value.includes("fail") || (exitCode != null && Number(exitCode) !== 0)) return "error";
  if (value.includes("stop") || value.includes("cancel") || value.includes("interrupt")) return "cancelled";
  if (value.includes("waiting") || value.includes("queued") || value.includes("deferred")) return "waiting";
  if (value.includes("retry")) return "retrying";
  if (value.includes("skip") || value.includes("disabled")) return "skipped";
  if (value.includes("start") || value.includes("running") || value.includes("progress")) return "running";
  if (value.includes("done") || value.includes("finish") || value.includes("complete") || value.includes("success")) return "success";
  return "info";
}

function eventKind(event, raw) {
  const value = `${event.kind || ""} ${event.type || ""} ${event.eventType || ""} ${raw?.type || ""} ${raw?.item?.type || ""}`.toLowerCase();
  if (value.includes("thinking") || value.includes("reason")) return "thinking";
  if (value.includes("script") || value.includes("command") || value.includes("tool")) return "tool";
  if (value.includes("prompt") || value.includes("assistant") || value.includes("result")) return "message";
  if (value.includes("error") || value.includes("fail")) return "error";
  if (value.includes("node")) return "node";
  if (value.includes("scheduler") || value.includes("run-start") || value.includes("run-finish")) return "run";
  return "event";
}

function eventLabel(event, raw, kind) {
  if (event.type === "node-start" || event.type === "node-done") return firstText(event.definitionId, event.nodeId, event.type);
  if (event.type === "script-start" || event.type === "script-finish") return event.type === "script-start" ? "执行脚本" : "脚本结果";
  if (event.type === "scheduler-triggered") return "定时调度触发";
  if (event.type === "run-start") return event.scheduled ? "ScheduleRun 启动" : "Run 启动";
  if (event.type === "run-finish") return "Run 完成";
  if (event.type === "agent-recovery") return "恢复 Agent 产物";
  if (event.type === "agent-retry") return "Agent 新 Turn 重试";
  if (event.type === "natural") return firstText(event.kind, "Agent 消息");
  if (event.type === "raw") return firstText(event.eventType, raw?.type, raw?.item?.type, "原始事件");
  return firstText(event.name, event.type, raw?.type, kind, "event");
}

export function normalizeRunInspectorEvents(rawEvents = []) {
  return (Array.isArray(rawEvents) ? rawEvents : []).map((source, index) => {
    const event = source && typeof source === "object" ? source : { text: String(source || "") };
    const embedded = parseRawObject(event.raw) || parseRawObject(event.text);
    const ts = numericTime(event.ts ?? event.at ?? event.startedAt, index + 1);
    const kind = eventKind(event, embedded);
    const command = embeddedCommand(event, embedded);
    const nodeId = firstText(event.nodeId, event.runNodeId, event.instanceId, embedded?.nodeId, embedded?.instanceId);
    const type = firstText(event.type, event.event, embedded?.type, "event");
    const durationMs = Math.max(0, Number(event.durationMs ?? event.timing?.elapsedMs ?? embedded?.durationMs ?? 0) || 0);
    return {
      ...event,
      key: `${ts}-${index}-${firstText(event.id, type)}`,
      index,
      ts,
      type,
      kind,
      status: eventStatus(event, embedded),
      nodeId,
      definitionId: firstText(event.definitionId, embedded?.definitionId),
      label: eventLabel(event, embedded, kind),
      text: eventText(event, embedded),
      command,
      script: firstText(event.script),
      scriptSha256: firstText(event.scriptSha256),
      cwd: firstText(event.cwd),
      stdout: firstText(event.stdout),
      stderr: firstText(event.stderr),
      exitCode: event.exitCode ?? embedded?.exitCode ?? embedded?.exit_code ?? embedded?.item?.exit_code,
      durationMs,
      rawObject: embedded,
      source: event,
    };
  });
}

function aggregateTurnStatus(events, fallback = "info") {
  const statuses = new Set(events.map((event) => event.status));
  const latest = events.at(-1)?.status || "";
  if (statuses.has("error")) return "error";
  if (["cancelled", "waiting", "retrying", "running", "success", "skipped"].includes(latest)) return latest;
  if (statuses.has("cancelled")) return "cancelled";
  if (statuses.has("success")) return "success";
  if (statuses.has("running")) return "running";
  return fallback;
}

function turnTitle(id, events, run) {
  const first = events[0] || {};
  if (id === "run") return run?.scheduled || run?.trigger === "scheduled" ? "ScheduleRun 触发" : "Run 触发";
  return firstText(first.definitionId, first.nodeId, first.label, "运行步骤");
}

export function buildRunInspectorTurns(rawEvents = [], run = {}, now = Date.now()) {
  const events = normalizeRunInspectorEvents(rawEvents);
  const groups = new Map();
  const activeNodeTurn = new Map();
  const nodeOccurrences = new Map();
  const ensure = (id) => {
    if (!groups.has(id)) groups.set(id, { id, events: [], order: groups.size });
    return groups.get(id);
  };

  for (const event of events) {
    let turnId = "run";
    const runEvent = ["run-start", "run-finish", "scheduler-triggered", "run-waiting", "stop-requested", "stop-completed"].includes(event.type)
      || ["workspace_run", "workspace_scheduled_run"].includes(event.definitionId);
    if (event.nodeId && !runEvent) {
      const nodeId = event.nodeId;
      if (event.type === "node-start") {
        const occurrence = (nodeOccurrences.get(nodeId) || 0) + 1;
        nodeOccurrences.set(nodeId, occurrence);
        activeNodeTurn.set(nodeId, `node:${nodeId}:${occurrence}`);
      } else if (!activeNodeTurn.has(nodeId)) {
        const occurrence = nodeOccurrences.get(nodeId) || 1;
        nodeOccurrences.set(nodeId, occurrence);
        activeNodeTurn.set(nodeId, `node:${nodeId}:${occurrence}`);
      }
      turnId = activeNodeTurn.get(nodeId);
    }
    const group = ensure(turnId);
    group.events.push({ ...event, turnId });
    if (event.nodeId && ["node-done", "node-error"].includes(event.type)) activeNodeTurn.delete(event.nodeId);
  }

  const runStart = numericTime(run?.startedAt, events[0]?.ts || now);
  const runEnd = numericTime(run?.endedAt, run?.status === "running" ? now : events.at(-1)?.ts || runStart);
  return Array.from(groups.values()).map((group, index) => {
    const startedAt = Math.min(...group.events.map((event) => event.ts || runStart));
    const explicitDurations = group.events.map((event) => event.ts + event.durationMs).filter((value) => value > startedAt);
    const endedAt = Math.max(startedAt, ...group.events.map((event) => event.ts || startedAt), ...explicitDurations);
    const status = group.id === "run" && run?.status
      ? aggregateTurnStatus(group.events, String(run.status).toLowerCase())
      : aggregateTurnStatus(group.events);
    return {
      ...group,
      index: index + 1,
      title: turnTitle(group.id, group.events, run),
      status,
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      runOffsetMs: Math.max(0, startedAt - runStart),
      runDurationMs: Math.max(1, runEnd - runStart),
    };
  });
}

export function runInspectorTimelineRows(turns = []) {
  const duration = Math.max(1, ...turns.map((turn) => turn.runDurationMs || 1));
  return turns.map((turn) => ({
    ...turn,
    offsetPct: Math.max(0, Math.min(100, (turn.runOffsetMs / duration) * 100)),
    widthPct: Math.max(1.2, Math.min(100, (turn.durationMs / duration) * 100)),
  }));
}

export function formatRunInspectorDuration(value) {
  const ms = Math.max(0, Number(value || 0));
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}
