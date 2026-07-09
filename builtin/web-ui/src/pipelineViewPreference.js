const STORAGE_KEY = "agentflow.pipelineViewPreference";

function flowKey(flowId, flowSource = "user", archived = false) {
  return `${String(flowSource || "user")}:${String(flowId || "")}:${archived ? "archived" : "active"}`;
}

function safeRead() {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeWrite(value) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* quota */
  }
}

function normalizeView(view) {
  if (view === "display") return "display";
  return view === "pipeline" ? "pipeline" : "workspace";
}

function isReadonlyBuiltinFlowSource(source) {
  const s = String(source || "").toLowerCase();
  return s === "builtin" || s === "admin";
}

function normalizeViewForFlow(flow, view) {
  const normalized = normalizeView(view);
  return normalized === "pipeline" && isReadonlyBuiltinFlowSource(flow?.source) ? "workspace" : normalized;
}

function hasPipeline(flow) {
  return flow?.hasPipeline !== false && flow?.hasFlow !== false && flow?.flowYaml !== false;
}

export function recordPipelineView(flowId, flowSource, view, archived = false) {
  if (!flowId) return;
  const store = safeRead();
  store[flowKey(flowId, flowSource, archived)] = {
    view: normalizeView(view),
    at: Date.now(),
  };
  safeWrite(store);
}

export function getPreferredPipelineView(flow, fallback = "workspace") {
  if (!flow?.id) return normalizeView(fallback);
  const store = safeRead();
  const entry = store[flowKey(flow.id, flow.source ?? "user", Boolean(flow.archived))];
  const preferred = normalizeViewForFlow(flow, entry?.view || fallback);
  return preferred === "pipeline" && !hasPipeline(flow) ? "workspace" : preferred;
}

export function flowUrlForView(flow, view = "workspace") {
  const normalizedView = normalizeViewForFlow(flow, view);
  if (!flow?.id) return normalizedView === "pipeline" ? "/flow" : normalizedView === "display" ? "/workspace?view=display" : "/workspace";
  const q = new URLSearchParams({
    flowId: flow.id,
    flowSource: flow.source ?? "user",
  });
  if (flow.archived) q.set(normalizedView === "pipeline" ? "flowArchived" : "archived", "1");
  if (normalizedView === "display") q.set("view", "display");
  return `/${normalizedView === "pipeline" ? "flow" : "workspace"}?${q.toString()}`;
}

export function preferredFlowUrl(flow, fallback = "workspace") {
  return flowUrlForView(flow, getPreferredPipelineView(flow, fallback));
}
