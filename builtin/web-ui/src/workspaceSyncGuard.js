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
