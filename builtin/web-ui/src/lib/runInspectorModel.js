function numericTime(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finiteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return NaN;
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

function jsonText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function messageText(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const content = Array.isArray(value.content) ? value.content : [];
  return content.map((item) => firstText(item?.text, item?.content)).filter(Boolean).join("\n").trim();
}

function rawTool(raw) {
  const call = raw?.tool_call && typeof raw.tool_call === "object"
    ? raw.tool_call
    : raw?.toolCall && typeof raw.toolCall === "object"
      ? raw.toolCall
      : {};
  const key = Object.keys(call).find((item) => /ToolCall$/i.test(item))
    || Object.keys(call).find((item) => /^(shell|read|grep|glob|edit|write|exec_command)$/i.test(item))
    || "";
  const payload = key && call[key] && typeof call[key] === "object" ? call[key] : {};
  return { key, payload, call };
}

function toolKindLabel(key, payload = {}, raw = {}) {
  const command = firstText(payload?.args?.command, payload?.args?.cmd, raw?.item?.command);
  if (/ck_fetch\.py/.test(command)) return "CK 查询";
  if (/collect_important_mails\.py|list_mails_by_date\.py|read_mail_content\.py/.test(command)) return "邮件脚本";
  if (/npm\s+run\s+build|build:web-ui/.test(command)) return "前端构建";
  const normalized = String(key || raw?.item?.type || raw?.name || raw?.tool || "").replace(/ToolCall$/i, "").toLowerCase();
  const labels = {
    shell: "Shell 命令",
    exec_command: "Shell 命令",
    command_execution: "Shell 命令",
    read: "读取文件",
    grep: "搜索代码",
    glob: "查找文件",
    edit: "编辑文件",
    write: "写入文件",
  };
  return labels[normalized] || firstText(key, raw?.item?.type, raw?.name, raw?.tool, "工具调用");
}

function toolFields(raw) {
  const { key, payload, call } = rawTool(raw);
  const args = payload?.args && typeof payload.args === "object" ? payload.args : raw?.item?.arguments || raw?.arguments || {};
  const resultEnvelope = payload?.result && typeof payload.result === "object" ? payload.result : raw?.item?.result || raw?.result || {};
  const result = resultEnvelope?.success || resultEnvelope?.failure || resultEnvelope;
  const command = firstText(args?.command, args?.cmd, result?.command, raw?.item?.command);
  const path = firstText(args?.path, args?.file_path, raw?.item?.path);
  const startedAt = finiteNumber(raw?.startedAtMs, call?.startedAtMs, payload?.startedAtMs);
  const completedAt = finiteNumber(raw?.completedAtMs, call?.completedAtMs, payload?.completedAtMs);
  return {
    name: firstText(key, raw?.item?.type, raw?.name, raw?.tool, "tool_call"),
    label: toolKindLabel(key, payload, raw),
    args,
    result,
    command,
    path,
    startedAt,
    completedAt,
    cwd: firstText(args?.workingDirectory, args?.cwd, result?.workingDirectory),
    stdout: firstText(result?.stdout, raw?.item?.aggregated_output),
    stderr: firstText(result?.stderr),
    exitCode: result?.exitCode ?? result?.exit_code ?? raw?.item?.exit_code,
  };
}

function embeddedCommand(event, raw) {
  const fields = toolFields(raw || {});
  const candidates = [
    event.command,
    event.script,
    fields.command,
    raw?.command,
    raw?.cmd,
    raw?.item?.command,
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
    raw?.text,
    messageText(raw?.message),
    raw?.error?.message,
    raw?.error,
    raw?.item?.text,
    raw?.item?.message,
    raw?.result,
    event.line,
    event.error,
    event.message,
    event.summary,
    event.text,
  );
  if (direct) return direct;
  return jsonText(event);
}

function eventStatus(event, raw) {
  const tool = toolFields(raw || {});
  const value = `${event.status || ""} ${raw?.status || ""} ${raw?.subtype || ""} ${raw?.item?.status || ""} ${event.type || ""} ${event.kind || ""}`.toLowerCase();
  const exitCode = event.exitCode ?? tool.exitCode ?? raw?.exitCode ?? raw?.exit_code ?? raw?.item?.exit_code;
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
  if (value.includes("prompt") || value.includes("assistant") || value.includes("result") || value.includes("user")) return "message";
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
  if (event.type === "agent-retry") return "Agent 新 Attempt";
  if (event.type === "natural") return firstText(event.kind, "Agent 消息");
  if (event.type === "raw" && raw?.type === "tool_call") return toolFields(raw).label;
  if (event.type === "raw") return firstText(event.eventType, raw?.type, raw?.item?.type, "原始事件");
  return firstText(event.name, event.type, raw?.type, kind, "event");
}

export function normalizeRunInspectorEvents(rawEvents = []) {
  return (Array.isArray(rawEvents) ? rawEvents : []).map((source, index) => {
    const event = source && typeof source === "object" ? source : { text: String(source || "") };
    const embedded = parseRawObject(event.raw) || parseRawObject(event.text);
    const tool = toolFields(embedded || {});
    const ts = numericTime(event.ts ?? event.at ?? event.startedAt, index + 1);
    const kind = eventKind(event, embedded);
    const command = embeddedCommand(event, embedded);
    const nodeId = firstText(event.nodeId, event.runNodeId, event.instanceId, embedded?.nodeId, embedded?.instanceId);
    const type = firstText(event.type, event.event, embedded?.type, "event");
    const rawType = firstText(embedded?.type, event.eventType);
    const rawSubtype = firstText(embedded?.subtype);
    const durationMs = Math.max(0, Number(event.durationMs ?? event.timing?.elapsedMs ?? embedded?.durationMs ?? embedded?.duration_ms ?? 0) || 0);
    return {
      ...event,
      key: `${ts}-${index}-${firstText(event.id, type)}`,
      index,
      ts,
      type,
      rawType,
      rawSubtype,
      kind,
      status: eventStatus(event, embedded),
      nodeId,
      definitionId: firstText(event.definitionId, embedded?.definitionId),
      label: eventLabel(event, embedded, kind),
      text: eventText(event, embedded),
      command,
      path: firstText(event.path, tool.path),
      args: tool.args,
      result: tool.result,
      script: firstText(event.script),
      scriptSha256: firstText(event.scriptSha256),
      cwd: firstText(event.cwd, tool.cwd),
      stdout: firstText(event.stdout, tool.stdout),
      stderr: firstText(event.stderr, tool.stderr),
      exitCode: event.exitCode ?? tool.exitCode ?? embedded?.exitCode ?? embedded?.exit_code ?? embedded?.item?.exit_code,
      durationMs,
      sessionId: firstText(embedded?.session_id, embedded?.sessionId, event.sessionId),
      modelCallId: firstText(embedded?.model_call_id, embedded?.modelCallId, embedded?.response_id, event.modelCallId),
      callId: firstText(embedded?.call_id, embedded?.callId, embedded?.tool_call?.toolCallId, embedded?.item?.id, event.callId),
      model: firstText(embedded?.model, embedded?.api_config?.model, event.model),
      usage: embedded?.usage && typeof embedded.usage === "object" ? embedded.usage : null,
      toolName: tool.name,
      toolStartedAt: tool.startedAt,
      toolCompletedAt: tool.completedAt,
      rawObject: embedded,
      source: event,
    };
  });
}

function aggregateStatus(events, fallback = "info") {
  const statuses = new Set(events.map((event) => event.status));
  const latest = events.at(-1)?.status || "";
  if (statuses.has("error")) return "error";
  if (statuses.has("incomplete")) return "incomplete";
  if (["cancelled", "waiting", "retrying", "running", "success", "skipped"].includes(latest)) return latest;
  if (statuses.has("cancelled")) return "cancelled";
  if (statuses.has("success")) return "success";
  if (statuses.has("running")) return "running";
  return fallback;
}

function spanTimes(events, fallbackStart, fallbackEnd = fallbackStart) {
  const starts = events.map((event) => event.ts).filter(Number.isFinite);
  const explicitEnds = events.map((event) => event.ts + (Number(event.durationMs) || 0)).filter(Number.isFinite);
  const startedAt = starts.length ? Math.min(...starts) : fallbackStart;
  const endedAt = Math.max(startedAt, starts.length ? Math.max(...starts) : fallbackEnd, explicitEnds.length ? Math.max(...explicitEnds) : fallbackEnd);
  return { startedAt, endedAt, durationMs: Math.max(0, endedAt - startedAt) };
}

function makeSpan({ id, parentId = "", kind, label, status = "info", depth = 0, events = [], startedAt, endedAt, ...rest }) {
  const times = spanTimes(events, startedAt, endedAt);
  return {
    id,
    parentId,
    kind,
    label,
    status,
    depth,
    events,
    ...times,
    ...rest,
  };
}

function nodeOccurrences(events, runStart, runEnd) {
  const nodes = [];
  const active = new Map();
  const counts = new Map();
  const create = (event) => {
    const nodeId = event.nodeId || "unknown";
    const occurrence = (counts.get(nodeId) || 0) + 1;
    counts.set(nodeId, occurrence);
    const node = {
      id: `node:${nodeId}:${occurrence}`,
      nodeId,
      occurrence,
      definitionId: event.definitionId,
      label: firstText(event.definitionId, nodeId, "运行节点"),
      events: [],
      startedAt: event.ts || runStart,
      endedAt: event.ts || runStart,
    };
    nodes.push(node);
    active.set(nodeId, node);
    return node;
  };
  for (const event of events) {
    const runEvent = ["run-start", "run-finish", "scheduler-triggered", "run-waiting", "stop-requested", "stop-completed", "done"].includes(event.type)
      || ["workspace_run", "workspace_scheduled_run"].includes(event.definitionId);
    if (!event.nodeId || runEvent) continue;
    let node = active.get(event.nodeId);
    if (event.type === "node-start") node = create(event);
    else if (!node) node = create(event);
    node.definitionId ||= event.definitionId;
    node.label = firstText(node.definitionId, node.nodeId, "运行节点");
    node.events.push(event);
    event.nodeSpanId = node.id;
    node.endedAt = Math.max(node.endedAt, event.ts + (event.durationMs || 0));
    if (["node-done", "node-error"].includes(event.type)) active.delete(event.nodeId);
  }
  for (const node of nodes) {
    const done = [...node.events].reverse().find((event) => ["node-done", "node-error"].includes(event.type));
    node.status = done ? (done.type === "node-error" ? "error" : aggregateStatus(node.events, "success")) : (runEnd > node.endedAt ? "incomplete" : "running");
    node.endedAt = done?.ts ?? node.endedAt ?? runEnd;
    node.durationMs = Math.max(0, node.endedAt - node.startedAt);
  }
  return nodes;
}

function attemptRanges(node) {
  const boundaries = node.events.filter((event) => event.type === "agent-retry").map((event) => event.ts);
  const ranges = [];
  let start = node.startedAt;
  boundaries.forEach((boundary, index) => {
    ranges.push({ index: index + 1, startedAt: start, endedAt: boundary, retryBoundary: true });
    start = boundary;
  });
  ranges.push({ index: ranges.length + 1, startedAt: start, endedAt: node.endedAt, retryBoundary: false });
  return ranges;
}

function eventInRange(event, range, isLast) {
  return event.ts >= range.startedAt && (isLast ? event.ts <= range.endedAt : event.ts < range.endedAt);
}

function toolSpans(events, parentId, depth, fallbackEnd) {
  const calls = new Map();
  for (const event of events) {
    const isTool = event.rawType === "tool_call" || event.rawObject?.item?.type === "command_execution";
    if (!isTool || !event.callId) continue;
    if (!calls.has(event.callId)) calls.set(event.callId, []);
    calls.get(event.callId).push(event);
  }
  return Array.from(calls.entries()).map(([callId, callEvents]) => {
    const started = callEvents.find((event) => event.rawSubtype === "started") || callEvents[0];
    const completed = [...callEvents].reverse().find((event) => event.rawSubtype === "completed" || event.rawType === "item.completed");
    const detailEvent = completed || started;
    const startedAt = Number.isFinite(started.toolStartedAt) ? started.toolStartedAt : started.ts;
    const endedAt = completed
      ? (Number.isFinite(completed.toolCompletedAt) ? completed.toolCompletedAt : completed.ts)
      : startedAt;
    const status = completed ? (detailEvent.exitCode != null && Number(detailEvent.exitCode) !== 0 ? "error" : "success") : "incomplete";
    return makeSpan({
      id: `tool:${callId}`,
      parentId,
      kind: "tool",
      label: detailEvent.label,
      status,
      depth,
      events: callEvents,
      startedAt,
      endedAt,
      callId,
      modelCallId: detailEvent.modelCallId,
      toolName: detailEvent.toolName,
      command: detailEvent.command,
      path: detailEvent.path,
      args: detailEvent.args,
      result: detailEvent.result,
      cwd: detailEvent.cwd,
      stdout: detailEvent.stdout,
      stderr: detailEvent.stderr,
      exitCode: detailEvent.exitCode,
      incompleteReason: completed ? "" : `缺少 ${callId} 的 completed 事件`,
      fallbackEnd,
    });
  }).sort((a, b) => a.startedAt - b.startedAt);
}

function thinkingSpans(events, parentId, depth) {
  const thinking = events.filter((event) => event.kind === "thinking" && event.type === "raw");
  if (!thinking.length) return [];
  const times = spanTimes(thinking, thinking[0].ts, thinking.at(-1).ts);
  return [makeSpan({
    id: `thinking:${parentId}`,
    parentId,
    kind: "thinking",
    label: "Reasoning",
    status: "success",
    depth,
    events: thinking,
    ...times,
    text: thinking.map((event) => event.text).filter(Boolean).join("\n"),
  })];
}

function assignTurnIds(sessionEvents) {
  const explicit = sessionEvents.map((event, index) => ({ event, index })).filter(({ event }) => event.modelCallId);
  if (!explicit.length) return new Map();
  const assigned = new Map();
  for (const { event } of explicit) assigned.set(event.key, event.modelCallId);
  for (let index = 0; index < sessionEvents.length; index += 1) {
    const event = sessionEvents[index];
    if (assigned.has(event.key)) continue;
    if (!(["thinking", "message"].includes(event.kind)) || ["user", "system", "result"].includes(event.rawType)) continue;
    const next = explicit.find((item) => item.index > index);
    const previous = [...explicit].reverse().find((item) => item.index < index);
    const modelCallId = next?.event?.modelCallId || previous?.event?.modelCallId;
    if (modelCallId) assigned.set(event.key, modelCallId);
  }
  return assigned;
}

function sessionSpans(attempt, node, allSpans) {
  const sessionEvents = attempt.events.filter((event) => event.type === "raw" && event.rawObject);
  const bySession = new Map();
  for (const event of sessionEvents) {
    const sessionId = event.sessionId || `anonymous:${attempt.id}`;
    if (!bySession.has(sessionId)) bySession.set(sessionId, []);
    bySession.get(sessionId).push(event);
  }
  const sessions = [];
  const turns = [];
  for (const [sessionId, events] of bySession.entries()) {
    const system = events.find((event) => event.rawType === "system");
    const result = [...events].reverse().find((event) => event.rawType === "result");
    const model = firstText(system?.model, events.find((event) => event.model)?.model, "Agent");
    const session = makeSpan({
      id: `session:${sessionId}:${attempt.index}`,
      parentId: attempt.id,
      kind: "session",
      label: `${model} Session`,
      status: result ? (result.rawSubtype === "success" && !result.rawObject?.is_error ? "success" : "error") : "incomplete",
      depth: 2,
      events,
      startedAt: system?.ts || events[0]?.ts || attempt.startedAt,
      endedAt: result?.ts || events.at(-1)?.ts || attempt.endedAt,
      sessionId,
      model,
      usage: result?.usage,
      incompleteReason: result ? "" : `缺少 ${sessionId} 的 result 事件`,
    });
    sessions.push(session);
    allSpans.push(session);

    const assigned = assignTurnIds(events);
    const turnIds = [];
    for (const event of events) {
      const turnId = assigned.get(event.key);
      if (turnId && !turnIds.includes(turnId)) turnIds.push(turnId);
    }
    turnIds.forEach((modelCallId, turnIndex) => {
      const turnEvents = events.filter((event) => assigned.get(event.key) === modelCallId);
      const children = [];
      const tools = toolSpans(turnEvents, `turn:${modelCallId}`, 4, session.endedAt);
      const reasoning = thinkingSpans(turnEvents, `turn:${modelCallId}`, 4);
      children.push(...reasoning, ...tools);
      const status = tools.some((span) => span.status === "error")
        ? "error"
        : tools.some((span) => span.status === "incomplete")
          ? "incomplete"
          : "success";
      const turn = makeSpan({
        id: `turn:${modelCallId}`,
        parentId: session.id,
        kind: "turn",
        label: `Model Turn ${turnIndex + 1}`,
        status,
        depth: 3,
        events: turnEvents,
        startedAt: turnEvents[0]?.ts || session.startedAt,
        endedAt: Math.max(...turnEvents.map((event) => event.ts), ...children.map((span) => span.endedAt)),
        modelCallId,
        sessionId,
        model,
        turnIndex: turnIndex + 1,
        children,
      });
      turns.push(turn);
      allSpans.push(turn, ...children);
    });
    session.children = turns.filter((turn) => turn.sessionId === sessionId && turn.parentId === session.id);
    if (session.children.some((turn) => turn.status === "error")) session.status = "error";
    else if (session.children.some((turn) => turn.status === "incomplete")) session.status = "incomplete";
  }
  return { sessions, turns };
}

function scriptSpans(node, allSpans) {
  const spans = [];
  const starts = [];
  for (const event of node.events) {
    if (event.type === "script-start") starts.push(event);
    if (event.type !== "script-finish") continue;
    const start = starts.shift();
    const events = start ? [start, event] : [event];
    const span = makeSpan({
      id: `script:${node.id}:${spans.length + 1}`,
      parentId: node.id,
      kind: "script",
      label: firstText(start?.label, "执行脚本"),
      status: event.exitCode != null && Number(event.exitCode) !== 0 ? "error" : "success",
      depth: 1,
      events,
      startedAt: start?.ts || Math.max(node.startedAt, event.ts - (event.durationMs || 0)),
      endedAt: event.ts,
      script: firstText(start?.script, event.script),
      scriptSha256: firstText(start?.scriptSha256, event.scriptSha256),
      command: firstText(start?.command, event.command),
      cwd: firstText(start?.cwd, event.cwd),
      stdout: event.stdout,
      stderr: event.stderr,
      exitCode: event.exitCode,
    });
    spans.push(span);
    allSpans.push(span);
  }
  for (const start of starts) {
    const span = makeSpan({
      id: `script:${node.id}:${spans.length + 1}`,
      parentId: node.id,
      kind: "script",
      label: "执行脚本",
      status: "incomplete",
      depth: 1,
      events: [start],
      startedAt: start.ts,
      endedAt: start.ts,
      script: start.script,
      command: start.command,
      cwd: start.cwd,
      incompleteReason: "缺少 script-finish 事件",
    });
    spans.push(span);
    allSpans.push(span);
  }
  return spans;
}

export function buildRunAuditTrace(rawEvents = [], run = {}, now = Date.now()) {
  const events = normalizeRunInspectorEvents(rawEvents);
  const runStart = numericTime(run?.startedAt, events[0]?.ts || now);
  const runEnd = numericTime(run?.endedAt, run?.status === "running" ? now : events.at(-1)?.ts || runStart);
  const nodes = nodeOccurrences(events, runStart, runEnd);
  const spans = [];
  const attempts = [];
  const sessions = [];
  const turns = [];

  for (const node of nodes) {
    const nodeSpan = makeSpan({
      ...node,
      parentId: "run",
      kind: "node",
      depth: 0,
      status: node.status,
    });
    spans.push(nodeSpan);
    const hasAgentTrace = node.events.some((event) => event.sessionId || event.modelCallId || event.rawType === "tool_call" || event.type === "agent-retry");
    if (hasAgentTrace) {
      const ranges = attemptRanges(node);
      ranges.forEach((range, index) => {
        const attemptEvents = node.events.filter((event) => eventInRange(event, range, index === ranges.length - 1));
        const attempt = makeSpan({
          id: `attempt:${node.id}:${range.index}`,
          parentId: node.id,
          kind: "attempt",
          label: `Attempt ${range.index}`,
          status: range.retryBoundary ? "retrying" : aggregateStatus(attemptEvents, node.status),
          depth: 1,
          events: attemptEvents,
          startedAt: range.startedAt,
          endedAt: range.endedAt,
          index: range.index,
          nodeId: node.nodeId,
        });
        attempts.push(attempt);
        spans.push(attempt);
        const nested = sessionSpans(attempt, node, spans);
        sessions.push(...nested.sessions);
        turns.push(...nested.turns);
        attempt.children = nested.sessions;
      });
      nodeSpan.children = attempts.filter((attempt) => attempt.parentId === node.id);
    } else {
      nodeSpan.children = scriptSpans(node, spans);
    }
  }

  const orderedSpans = spans.sort((a, b) => a.startedAt - b.startedAt || a.depth - b.depth);
  const gaps = orderedSpans.filter((span) => span.incompleteReason);
  return {
    run: makeSpan({
      id: "run",
      kind: "run",
      label: run?.scheduled || run?.trigger === "scheduled" ? "ScheduleRun" : "Run",
      status: firstText(run?.status, aggregateStatus(events)),
      events,
      startedAt: runStart,
      endedAt: runEnd,
      runId: run?.runId,
    }),
    events,
    nodes: orderedSpans.filter((span) => span.kind === "node"),
    attempts,
    sessions,
    turns,
    spans: orderedSpans,
    gaps,
    durationMs: Math.max(1, runEnd - runStart),
    startedAt: runStart,
    endedAt: runEnd,
  };
}

export function buildRunInspectorTurns(rawEvents = [], run = {}, now = Date.now()) {
  return buildRunAuditTrace(rawEvents, run, now).turns;
}

function stateStatus(value, fallback = "pending") {
  const normalized = String(value || "").toLowerCase();
  if (["success", "succeeded", "done", "completed", "complete"].includes(normalized)) return "success";
  if (["failed", "failure", "error"].includes(normalized)) return "error";
  if (["waiting", "paused", "blocked", "polling", "deferred"].includes(normalized)) return "waiting";
  if (["queued", "queue", "created"].includes(normalized)) return "pending";
  if (["running", "in_progress", "in-progress", "started"].includes(normalized)) return "running";
  if (["cancelled", "canceled", "stopped", "stop"].includes(normalized)) return "cancelled";
  if (["skipped", "skip", "disabled"].includes(normalized)) return "skipped";
  return fallback;
}

function flowNodeLabel(node) {
  return firstText(
    node?.data?.label,
    node?.data?.name,
    node?.data?.title,
    node?.label,
    node?.name,
    node?.definitionId,
    node?.id,
    "运行阶段",
  );
}

function safeStateValue(value) {
  if (value == null) return "";
  const text = String(value);
  if (/token|password|secret|authorization|cookie|api[-_]?key/i.test(text)) return "[已隐藏]";
  return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}

function stateEventSummary(event) {
  return {
    type: safeStateValue(event?.type || event?.rawType || "event"),
    status: stateStatus(event?.status, "info"),
    nodeId: safeStateValue(event?.nodeId),
    label: safeStateValue(event?.label || event?.text || event?.type),
    ts: Number.isFinite(event?.ts) ? event.ts : 0,
  };
}

/**
 * 分支节点走了哪一边。运行时把它报在 node-done 的 `branch` 字段上，也写进
 * `control_if branch: true` 这行状态里；不摊开的话，看完整个面板也不知道 if 判成了什么。
 */
function stageBranchTaken(nodeEvents = []) {
  for (const event of [...nodeEvents].reverse()) {
    const direct = String(event?.branch ?? "").trim();
    if (direct) return direct.toLowerCase();
    const fromLine = /branch:\s*(true|false)/i.exec(String(event?.line || event?.text || ""));
    if (fromLine) return fromLine[1].toLowerCase();
  }
  return "";
}

/**
 * Builds a stable, UI-safe projection of the current Workspace Run state.
 * This is an execution-state projection (events + graph), not a replacement
 * for a future business Graph State/Reducer implementation.
 */
export function buildRunStateSnapshot(rawEvents = [], run = {}, flowNodes = [], artifacts = [], now = Date.now()) {
  const trace = buildRunAuditTrace(rawEvents, run, now);
  const events = trace.events;
  const executed = new Map();
  for (const node of trace.nodes) executed.set(String(node.nodeId || node.id), node);

  // Run / Scheduled Run are entry triggers, not executable stages. Their
  // run-start event carries the running status of the whole run and must not
  // become a fake "当前阶段" or inflate the progress denominator.
  const graphNodes = (Array.isArray(flowNodes) ? flowNodes : []).filter((node) => {
    const definitionId = String(node?.data?.definitionId || node?.definitionId || "").trim();
    return !["workspace_run", "workspace_scheduled_run"].includes(definitionId);
  });
  const runTerminal = ["success", "error", "cancelled"].includes(stateStatus(run?.status, ""));
  const stages = graphNodes.map((node) => {
    const id = String(node?.id || node?.nodeId || node?.definitionId || "");
    const execution = executed.get(id);
    const nodeEvents = execution?.events || events.filter((event) => String(event.nodeId || "") === id);
    const latest = [...nodeEvents].reverse().find(Boolean);
    // 一次 Run 的执行计划只覆盖入口可达的那部分图；数据提供型节点（文本、密码、Load Skills…）
    // 作为输入被就地解析，从不作为阶段执行。Run 已经终结后还把它们显示成"待执行"，既像卡住了，
    // 又把进度分母撑大（成功的 Run 卡在 2/33）。它们是没参与这次执行，不是等着执行。
    let status = execution?.status || (runTerminal && !nodeEvents.length ? "not_run" : "pending");
    if (nodeEvents.some((event) => ["node-waiting", "run-waiting"].includes(event.type) || event.status === "waiting")) status = "waiting";
    else if (nodeEvents.some((event) => event.type === "node-skipped" || event.status === "skipped")) status = "skipped";
    else if (nodeEvents.some((event) => event.type === "node-error" || event.status === "error")) status = "error";
    else if (nodeEvents.some((event) => event.type === "node-start" || event.status === "running")) status = execution?.status || "running";
    const stageArtifacts = Array.isArray(artifacts)
      ? artifacts.filter((item) => String(item?.id || item?.nodeId || item?.stageId || "") === id || String(item?.nodeId || "") === id)
      : [];
    return {
      id,
      label: flowNodeLabel(node),
      status,
      branch: stageBranchTaken(nodeEvents),
      startedAt: execution?.startedAt || 0,
      endedAt: execution?.endedAt || 0,
      durationMs: execution?.durationMs || 0,
      lastEvent: latest ? stateEventSummary(latest) : null,
      artifacts: stageArtifacts.map((item) => ({
        name: safeStateValue(item?.name || item?.path || item?.relativePath),
        path: safeStateValue(item?.path || item?.relativePath),
        href: safeStateValue(item?.href || item?.url),
      })).filter((item) => item.name || item.path),
    };
  });
  for (const node of trace.nodes) {
    if (stages.some((stage) => stage.id === String(node.nodeId || node.id))) continue;
    stages.push({
      id: String(node.nodeId || node.id),
      label: safeStateValue(node.label || node.nodeId || "运行阶段"),
      status: node.status || "pending",
      startedAt: node.startedAt || 0,
      endedAt: node.endedAt || 0,
      durationMs: node.durationMs || 0,
      lastEvent: stateEventSummary(node.events?.at(-1)),
      artifacts: [],
    });
  }

  const runStatus = stateStatus(run?.status, "") || stateStatus(events.at(-1)?.status, "running");
  // A backend/agent failure can terminate the Run before emitting node-error.
  // Do not leave the last node looking active when the authoritative Run is terminal.
  if (runStatus === "error") {
    stages.forEach((stage) => {
      if (["running", "incomplete"].includes(stage.status)) stage.status = "error";
    });
  } else if (runStatus === "cancelled") {
    stages.forEach((stage) => {
      if (["running", "incomplete"].includes(stage.status)) stage.status = "cancelled";
    });
  }
  const current = [...stages].reverse().find((stage) => ["running", "waiting", "error"].includes(stage.status))
    || [...stages].reverse().find((stage) => stage.status === "success")
    || null;
  // 没参与本次执行的节点不该进分母，否则一个成功的 Run 会显示成 2/33 · 6%。
  const plannedStages = stages.filter((stage) => stage.status !== "not_run");
  const completed = plannedStages.filter((stage) => ["success", "skipped"].includes(stage.status)).length;
  const waiting = stages.filter((stage) => stage.status === "waiting").map((stage) => ({ id: stage.id, label: stage.label }));
  const pending = stages.filter((stage) => stage.status === "pending").map((stage) => ({ id: stage.id, label: stage.label }));
  const last = events.at(-1);
  return {
    version: 1,
    runId: safeStateValue(run?.runId),
    status: runStatus,
    currentStage: current ? { id: current.id, label: current.label, status: current.status } : null,
    progress: {
      completed,
      total: plannedStages.length,
      percent: plannedStages.length ? Math.round((completed / plannedStages.length) * 100) : 0,
    },
    pending,
    waiting,
    stages,
    lastEvent: last ? stateEventSummary(last) : null,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    durationMs: trace.durationMs,
  };
}

export function runInspectorTimelineRows(spans = [], trace = null) {
  const startedAt = trace?.startedAt ?? Math.min(...spans.map((span) => span.startedAt));
  const duration = trace?.durationMs ?? Math.max(1, ...spans.map((span) => span.endedAt - startedAt));
  return spans.map((span) => ({
    ...span,
    offsetPct: Math.max(0, Math.min(100, ((span.startedAt - startedAt) / duration) * 100)),
    widthPct: Math.max(0.65, Math.min(100, (span.durationMs / duration) * 100)),
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
