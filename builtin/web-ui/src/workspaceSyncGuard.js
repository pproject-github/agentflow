export function workspaceBackgroundLoadSkipReason({
  background = false,
  requestId = 0,
  currentRequestId = 0,
  dirty = false,
  startedEditVersion = 0,
  currentEditVersion = 0,
  startedRevision = "",
  currentRevision = "",
} = {}) {
  if (requestId !== currentRequestId) return "superseded";
  if (!background) return "";
  if (
    dirty
    || currentEditVersion !== startedEditVersion
    || currentRevision !== startedRevision
  ) {
    return "local-edits";
  }
  return "";
}

export function workspaceSaveBaselineAfterSuccess({
  savedGraph,
  sentGraph,
  savedRevision = "",
  currentRevision = "",
} = {}) {
  return {
    graph: savedGraph || sentGraph || null,
    revision: String(savedRevision || currentRevision || ""),
  };
}

export function workspaceCanvasInteractionPhase(changes = []) {
  let active = false;
  let finished = false;
  let mutated = false;
  for (const change of Array.isArray(changes) ? changes : []) {
    if (change?.type === "position" && change.position) {
      mutated = true;
      if (change.dragging === true) active = true;
      if (change.dragging === false) finished = true;
      continue;
    }
    if (change?.type === "dimensions" && change.dimensions) {
      mutated = true;
      if (change.resizing === true) active = true;
      if (change.resizing === false) finished = true;
      continue;
    }
    if (["add", "remove", "replace"].includes(change?.type)) mutated = true;
  }
  return { active, finished, mutated };
}

export function coalesceWorkspaceSaveRequest(pending, next) {
  return {
    ...next,
    waiters: [
      ...(Array.isArray(pending?.waiters) ? pending.waiters : []),
      ...(Array.isArray(next?.waiters) ? next.waiters : []),
    ],
  };
}

export function workspaceLoadResourcePlan({ background = false } = {}) {
  return {
    graph: true,
    nodes: !background,
    files: !background,
  };
}

export function shouldSkipWorkspaceRemoteRefresh({
  eventType = "",
  revision = "",
  currentRevision = "",
  targetRevision = "",
  refreshPending = false,
} = {}) {
  if (eventType !== "graph.committed" || !revision) return false;
  if (revision === currentRevision) return true;
  return revision === targetRevision && refreshPending;
}
