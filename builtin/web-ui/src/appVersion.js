/* global __APP_VERSION__ */
export const CLIENT_APP_VERSION = typeof __APP_VERSION__ !== "undefined"
  ? String(__APP_VERSION__ || "0.0.0")
  : "0.0.0";

export const APP_VERSION_CHECK_INTERVAL_MS = 60_000;
export const APP_VERSION_SNOOZE_MS = 30 * 60_000;

export function normalizeAppVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

function compareAppVersions(left, right) {
  const a = normalizeAppVersion(left).split("-")[0].split(".").map((part) => Number(part) || 0);
  const b = normalizeAppVersion(right).split("-")[0].split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
}

export function hasAppVersionChanged(clientVersion, serverVersion) {
  const client = normalizeAppVersion(clientVersion);
  const server = normalizeAppVersion(serverVersion);
  // An older backend can coexist briefly with a newer static bundle during a
  // restart/deploy. It is not an update for the user and must not be shown as
  // “newer → older”.
  return Boolean(client && server && compareAppVersions(server, client) > 0);
}

export function appVersionSnoozeKey(clientVersion, serverVersion) {
  return `agentflow.app-version.snooze:${normalizeAppVersion(clientVersion)}:${normalizeAppVersion(serverVersion)}`;
}
