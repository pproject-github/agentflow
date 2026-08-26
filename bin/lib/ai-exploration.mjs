import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const EXPLORATION_DIR = path.join(".workspace", "agentflow", "explorations");
const SESSION_ID_RE = /^exp_[a-z0-9_-]{8,80}$/i;
const EVENT_TYPES = new Set(["run", "turn", "decision", "agent", "tool", "command", "file", "artifact", "status"]);
const EVENT_STATUSES = new Set(["planned", "running", "success", "error", "blocked", "skipped"]);
const EVENT_PHASES = new Set(["planned", "simulated", "observed", "materialized"]);
const SIDE_EFFECTS = new Set(["none", "read", "write", "external"]);

function explorationRoot(workspaceRoot) {
  return path.join(path.resolve(workspaceRoot), EXPLORATION_DIR);
}

function sessionDir(workspaceRoot, sessionId) {
  const id = normalizeSessionId(sessionId);
  return path.join(explorationRoot(workspaceRoot), id);
}

function sessionMetadataPath(workspaceRoot, sessionId) {
  return path.join(sessionDir(workspaceRoot, sessionId), "session.json");
}

function sessionEventsPath(workspaceRoot, sessionId) {
  return path.join(sessionDir(workspaceRoot, sessionId), "trace.jsonl");
}

function normalizeSessionId(value) {
  const id = String(value || "").trim();
  if (!SESSION_ID_RE.test(id)) throw new Error("Invalid exploration session id");
  return id;
}

function clip(value, max = 2000) {
  return redactSecrets(String(value ?? "")).trim().slice(0, max);
}

function redactSecrets(value) {
  return String(value || "")
    .replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9_.-]{8,}\b/gi, "[redacted]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function sessionSummary(raw = {}) {
  return {
    version: 1,
    id: normalizeSessionId(raw.id),
    title: clip(raw.title || "AI 探索运行", 160),
    goal: clip(raw.goal || "", 4000),
    summary: clip(raw.summary || "", 2000),
    mode: EVENT_PHASES.has(String(raw.mode || "")) ? String(raw.mode) : "planned",
    status: ["draft", "planning", "ready", "running", "completed", "failed"].includes(String(raw.status || ""))
      ? String(raw.status)
      : "draft",
    source: {
      provider: clip(raw.source?.provider || "agentflow", 80),
      agent: clip(raw.source?.agent || "workspace", 120),
    },
    eventCount: Math.max(0, Number(raw.eventCount || 0) || 0),
    createdAt: String(raw.createdAt || new Date().toISOString()),
    updatedAt: String(raw.updatedAt || raw.createdAt || new Date().toISOString()),
    ...(raw.materializedAt ? { materializedAt: String(raw.materializedAt) } : {}),
  };
}

export function createAiExplorationSession(workspaceRoot, input = {}) {
  const now = new Date().toISOString();
  const id = `exp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const session = sessionSummary({
    id,
    title: input.title,
    goal: input.goal,
    mode: input.mode,
    status: input.status || "draft",
    source: input.source,
    createdAt: now,
    updatedAt: now,
  });
  const dir = sessionDir(workspaceRoot, id);
  fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true, mode: 0o700 });
  writeJsonAtomic(sessionMetadataPath(workspaceRoot, id), session);
  fs.writeFileSync(sessionEventsPath(workspaceRoot, id), "", { encoding: "utf-8", mode: 0o600 });
  return session;
}

export function listAiExplorationSessions(workspaceRoot, limit = 50) {
  const root = explorationRoot(workspaceRoot);
  if (!fs.existsSync(root)) return [];
  const sessions = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SESSION_ID_RE.test(entry.name)) continue;
    try {
      sessions.push(sessionSummary(readJson(sessionMetadataPath(workspaceRoot, entry.name))));
    } catch {
      // A corrupt exploration is omitted instead of breaking the Workspace.
    }
  }
  return sessions
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
}

export function readAiExplorationSession(workspaceRoot, sessionId) {
  const session = sessionSummary(readJson(sessionMetadataPath(workspaceRoot, sessionId)));
  const events = [];
  const eventPath = sessionEventsPath(workspaceRoot, session.id);
  if (fs.existsSync(eventPath)) {
    for (const line of fs.readFileSync(eventPath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* retain readable events */ }
    }
  }
  return { ...session, events };
}

export function updateAiExplorationSession(workspaceRoot, sessionId, patch = {}) {
  const current = readAiExplorationSession(workspaceRoot, sessionId);
  const next = sessionSummary({
    ...current,
    ...patch,
    source: patch.source ? { ...current.source, ...patch.source } : current.source,
    updatedAt: new Date().toISOString(),
  });
  writeJsonAtomic(sessionMetadataPath(workspaceRoot, next.id), next);
  return next;
}

function normalizeArtifacts(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, 20).map((artifact) => ({
    kind: clip(artifact?.kind || "file", 40),
    path: clip(artifact?.path || "", 500),
    label: clip(artifact?.label || artifact?.path || "artifact", 160),
    ...(artifact?.sha256 ? { sha256: clip(artifact.sha256, 80) } : {}),
  })).filter((artifact) => artifact.path || artifact.label);
}

export function normalizeAiTraceEvent(raw = {}, defaults = {}) {
  const now = new Date().toISOString();
  const phase = EVENT_PHASES.has(String(raw.phase || defaults.phase || "")) ? String(raw.phase || defaults.phase) : "observed";
  const type = EVENT_TYPES.has(String(raw.type || "")) ? String(raw.type) : "status";
  const status = EVENT_STATUSES.has(String(raw.status || "")) ? String(raw.status) : (phase === "planned" ? "planned" : "running");
  const sideEffect = SIDE_EFFECTS.has(String(raw.sideEffect || "")) ? String(raw.sideEffect) : "none";
  return {
    id: clip(raw.id || `evt_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`, 100),
    traceId: clip(raw.traceId || defaults.traceId || "", 100),
    spanId: clip(raw.spanId || raw.id || `span_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`, 100),
    parentSpanId: clip(raw.parentSpanId || "", 100),
    sequence: Math.max(1, Number(raw.sequence || defaults.sequence || 1) || 1),
    phase,
    type,
    name: clip(raw.name || type, 160),
    summary: clip(raw.summary || raw.description || "", 2000),
    status,
    sideEffect,
    requiresApproval: raw.requiresApproval === true || ["write", "external"].includes(sideEffect),
    startedAt: String(raw.startedAt || now),
    ...(raw.endedAt ? { endedAt: String(raw.endedAt) } : {}),
    ...(raw.inputPreview ? { inputPreview: clip(raw.inputPreview, 2000) } : {}),
    ...(raw.outputPreview ? { outputPreview: clip(raw.outputPreview, 2000) } : {}),
    artifacts: normalizeArtifacts(raw.artifacts),
  };
}

export function appendAiTraceEvents(workspaceRoot, sessionId, rawEvents = [], defaults = {}) {
  const session = readAiExplorationSession(workspaceRoot, sessionId);
  const incoming = Array.isArray(rawEvents) ? rawEvents : [rawEvents];
  if (!incoming.length) return { session, events: [] };
  if (session.eventCount + incoming.length > 5000) throw new Error("Exploration trace exceeds 5000 events");
  const events = incoming.map((event, index) => normalizeAiTraceEvent(event, {
    ...defaults,
    traceId: session.id,
    sequence: session.eventCount + index + 1,
  }));
  fs.appendFileSync(sessionEventsPath(workspaceRoot, session.id), events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf-8");
  const next = updateAiExplorationSession(workspaceRoot, session.id, {
    eventCount: session.eventCount + events.length,
    mode: defaults.phase || session.mode,
  });
  return { session: next, events };
}

export function parseAiPlanResult(text, sessionId) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidates = [raw, fenced].filter(Boolean);
  let parsed;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { parsed = JSON.parse(candidate.slice(start, end + 1)); break; } catch { /* next */ }
      }
    }
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Plan agent did not return valid JSON");
  const spans = Array.isArray(parsed.spans) ? parsed.spans : Array.isArray(parsed.steps) ? parsed.steps : [];
  if (!spans.length) throw new Error("Plan agent returned no executable spans");
  return {
    title: clip(parsed.title || "AI 执行计划", 160),
    summary: clip(parsed.summary || "", 2000),
    events: spans.slice(0, 120).map((span, index) => normalizeAiTraceEvent({
      ...span,
      id: span.id || `plan_${index + 1}`,
      spanId: span.spanId || span.id || `plan_${index + 1}`,
      parentSpanId: span.parentSpanId || span.parentId || "",
      type: span.type || "turn",
      status: "planned",
      phase: "planned",
      sideEffect: span.sideEffect || "none",
      startedAt: new Date().toISOString(),
    }, { traceId: sessionId, phase: "planned", sequence: index + 1 })),
  };
}

export function materializableAiTraceEvents(session) {
  const events = Array.isArray(session?.events) ? session.events : [];
  const planned = events.filter((event) => event.phase === "planned");
  if (planned.length) return planned;
  return events.filter((event) => event.phase === "observed");
}

export function classifyAiToolSideEffect(toolName, subtype = "") {
  const value = `${toolName || ""} ${subtype || ""}`.trim().toLowerCase();
  if (/(?:^|[_\W])thinking(?:$|[_\W])/.test(value)) return "none";
  if (/(?:^|[_\W])(web|http|curl|fetch|mcp|publish|send|notify|deploy)(?:$|[_\W])/.test(value)) return "external";
  if (/(?:^|[_\W])(read|search|find|grep|glob|list|inspect|status|stat|cat|head|tail)(?:$|[_\W])/.test(value)) return "read";
  return "write";
}

export function aiPlanPrompt({ goal = "", workspaceSource = "" } = {}) {
  return [
    "你是 AgentFlow 的只读 Plan Agent。只规划，不执行工具，不修改文件。",
    "把用户目标转换为一张预计 AI 运行图。只输出合法 JSON，不要 Markdown 代码围栏。",
    "JSON 格式：",
    '{"title":"短标题","summary":"计划摘要","spans":[{"id":"step_1","parentSpanId":"","type":"turn|decision|agent|tool|command|file|artifact","name":"步骤名","summary":"做什么以及为什么","sideEffect":"none|read|write|external","requiresApproval":false,"inputPreview":"预计输入","outputPreview":"预期输出"}]}',
    "要求：id 唯一；parentSpanId 表达父子关系；写文件、发布、发送、删除、外部写请求必须标记 requiresApproval=true；搜索与读取标记 read；不要假装已经得到任何执行结果。",
    workspaceSource ? `\n## 当前 Workspace DSL\n\n${workspaceSource}` : "",
    `\n## 用户目标\n\n${clip(goal, 12000)}`,
  ].filter(Boolean).join("\n");
}

export function aiMaterializationPrompt(session, workspaceSource = "") {
  const events = materializableAiTraceEvents(session);
  const plan = events.map((event) => ({
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    type: event.type,
    name: event.name,
    summary: event.summary,
    sideEffect: event.sideEffect,
    requiresApproval: event.requiresApproval,
  }));
  return [
    "你是 AgentFlow 流程固化 Agent。把已审核的 AI Plan 固化到当前 Workspace DSL 调整态。",
    "必须实际编辑 workspace.flow.js；稳定脚本放入 nodes/<name>/index.mjs；不要执行该流程，不要发布。",
    "过滤纯搜索噪声；把输入参数化；把判断映射为 control.if，把受控重复映射为 control.while，把产物映射为 Display；副作用步骤必须保留清晰名称和输入。",
    "修改完成后运行 `agentflow flow dsl lint <当前流程目录>`。最终只简短说明生成了哪些节点以及仍需人工确认的副作用。",
    workspaceSource ? `\n## 当前 Workspace DSL\n\n${workspaceSource}` : "",
    `\n## 探索目标\n\n${clip(session?.goal || "", 8000)}`,
    `\n## 已审核 Plan Trace\n\n${JSON.stringify(plan, null, 2)}`,
  ].filter(Boolean).join("\n");
}

export function writeAiExplorationMaterialization(workspaceRoot, sessionId, value = {}) {
  const session = readAiExplorationSession(workspaceRoot, sessionId);
  const payload = {
    version: 1,
    sessionId: session.id,
    materializedAt: new Date().toISOString(),
    spanIds: materializableAiTraceEvents(session).map((event) => event.spanId).filter(Boolean),
    nodeIds: (Array.isArray(value.nodeIds) ? value.nodeIds : []).map((id) => clip(id, 160)).filter(Boolean),
    ...(value.designRevision ? { designRevision: clip(value.designRevision, 160) } : {}),
  };
  writeJsonAtomic(path.join(sessionDir(workspaceRoot, session.id), "materialization.json"), payload);
  return payload;
}
