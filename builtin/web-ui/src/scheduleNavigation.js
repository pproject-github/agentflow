/**
 * 别人的流程要带 adminOwnerId。
 *
 * `flowSource=user` 在服务端是按**发请求的人**去解析的：不带 owner 的链接会让
 * 管理员去自己的目录里找一个别人的 flowId，结果就是打不开。
 *
 * 自己的排程不带——带上会让 workspaceWritable 变成 false，等于把自己的流程
 * 锁成只读。
 */
export function scheduleOwnerQueryParam(schedule = {}, currentUserId = "") {
  const ownerUserId = String(schedule?.ownerUserId || "").trim();
  if (!ownerUserId || ownerUserId === String(currentUserId || "").trim()) return null;
  return ownerUserId;
}

export function scheduleTargetUrl(schedule = {}, currentUserId = "") {
  const flowId = String(schedule?.flowId || "").trim();
  if (!flowId) return "";

  const query = new URLSearchParams({
    flowId,
    flowSource: String(schedule?.flowSource || "user").trim() || "user",
  });
  const workspaceId = String(schedule?.workspaceId || "").trim();
  if (workspaceId) query.set("workspaceId", workspaceId);
  const adminOwnerId = scheduleOwnerQueryParam(schedule, currentUserId);
  if (adminOwnerId) query.set("adminOwnerId", adminOwnerId);
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
