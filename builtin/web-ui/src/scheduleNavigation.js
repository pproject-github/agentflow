export function scheduleTargetUrl(schedule = {}) {
  const flowId = String(schedule?.flowId || "").trim();
  if (!flowId) return "";

  const query = new URLSearchParams({
    flowId,
    flowSource: String(schedule?.flowSource || "user").trim() || "user",
  });
  const workspaceId = String(schedule?.workspaceId || "").trim();
  if (workspaceId) query.set("workspaceId", workspaceId);
  if (schedule?.kind === "workspace") {
    const focusNodeId = String(schedule?.scheduleNodeId || "").trim();
    if (focusNodeId) query.set("focusNodeId", focusNodeId);
  }
  return `/workspace?${query.toString()}`;
}

export function scheduleTargetLabel(schedule = {}) {
  return schedule?.kind === "workspace" && String(schedule?.scheduleNodeId || "").trim()
    ? "打开节点"
    : "打开项目";
}
