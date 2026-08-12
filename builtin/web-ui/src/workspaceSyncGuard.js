export function workspaceBackgroundLoadSkipReason({
  background = false,
  requestId = 0,
  currentRequestId = 0,
  interactionActive = false,
  dirty = false,
  startedEditVersion = 0,
  currentEditVersion = 0,
  startedRevision = "",
  currentRevision = "",
} = {}) {
  if (requestId !== currentRequestId) return "superseded";
  if (!background) return "";
  // A refresh can start immediately before a pointer interaction. Re-check at
  // response time so its stale graph cannot replace live drag/resize geometry.
  if (interactionActive) return "interaction-active";
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

export function workspaceCanvasInteractionIsActive({
  nodeInteraction = false,
  pointerCount = 0,
  viewportInteraction = false,
} = {}) {
  return Boolean(
    nodeInteraction
    || viewportInteraction
    || Number(pointerCount) > 0
  );
}

export function workspaceCanvasInteractionCommitsChanges(changes = []) {
  const interaction = workspaceCanvasInteractionPhase(changes);
  return interaction.mutated && !interaction.active;
}

export function workspaceCanvasChangeIsContinuous(change) {
  return Boolean(
    (change?.type === "position" && change.position && change.dragging === true)
    || (change?.type === "dimensions" && change.dimensions && change.resizing === true)
  );
}

export function workspaceCanvasChangeFinishesInteraction(change) {
  return Boolean(
    (change?.type === "position" && change.position && change.dragging === false)
    || (change?.type === "dimensions" && change.dimensions && change.resizing === false)
  );
}

export function partitionWorkspaceCanvasChanges(changes = []) {
  const transient = [];
  const committed = [];
  let finishesInteraction = false;
  for (const change of Array.isArray(changes) ? changes : []) {
    if (workspaceCanvasChangeIsContinuous(change)) {
      transient.push(change);
      continue;
    }
    committed.push(change);
    if (workspaceCanvasChangeFinishesInteraction(change)) finishesInteraction = true;
  }
  return { transient, committed, finishesInteraction };
}

export function coalesceWorkspaceCanvasChanges(changes = []) {
  const result = [];
  const replaceableIndexes = new Map();
  for (const change of Array.isArray(changes) ? changes : []) {
    const id = String(change?.id || "").trim();
    const replaceable = id && (change?.type === "position" || change?.type === "dimensions");
    if (!replaceable) {
      result.push(change);
      continue;
    }
    const key = `${change.type}:${id}`;
    const previousIndex = replaceableIndexes.get(key);
    if (previousIndex == null) {
      replaceableIndexes.set(key, result.length);
      result.push(change);
    } else {
      result[previousIndex] = change;
    }
  }
  return result;
}

export function finalizeWorkspaceCanvasChanges(changes = []) {
  return coalesceWorkspaceCanvasChanges(changes).map((change) => {
    if (change?.type === "position" && change.position && change.dragging === true) {
      return { ...change, dragging: false };
    }
    if (change?.type === "dimensions" && change.dimensions && change.resizing === true) {
      return { ...change, resizing: false };
    }
    return change;
  });
}

function normalizedPositiveWorkspaceSize(size) {
  const width = Number(size?.width || 0);
  const height = Number(size?.height || 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Keep a custom node's visible card aligned with React Flow's live resize box.
 * Persisted node data intentionally changes only after pointer-up, so using it
 * during a resize makes the handle move while the card remains frozen.
 */
export function workspaceResizePresentationSize({
  resizing = false,
  liveSize = null,
  persistedSize = null,
} = {}) {
  const persisted = normalizedPositiveWorkspaceSize(persistedSize);
  if (!resizing) return persisted;
  return normalizedPositiveWorkspaceSize(liveSize) || persisted;
}

export function workspaceSyncIndicatorPresentation({
  phase = "loading",
  detail = "",
  nodeInteracting = false,
} = {}) {
  if (nodeInteracting) {
    return {
      phase: "interacting",
      label: "交互保护中",
      detail: "远端更新暂缓，松手后同步",
    };
  }
  const label = {
    loading: "载入中",
    dirty: "有未同步修改",
    saving: "同步中",
    synced: "已同步",
    conflict: "同步冲突",
    error: "同步失败",
    readonly: "只读",
  }[phase] || "同步状态";
  return { phase, label, detail };
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
