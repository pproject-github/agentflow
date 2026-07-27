/* global __APP_VERSION__ */
export const CLIENT_APP_VERSION = typeof __APP_VERSION__ !== "undefined"
  ? String(__APP_VERSION__ || "0.0.0")
  : "0.0.0";

export const APP_VERSION_CHECK_INTERVAL_MS = 60_000;
export const APP_VERSION_SNOOZE_MS = 30 * 60_000;

export function normalizeAppVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

export function hasAppVersionChanged(clientVersion, serverVersion) {
  const client = normalizeAppVersion(clientVersion);
  const server = normalizeAppVersion(serverVersion);
  return Boolean(client && server && client !== server);
}

export function appVersionSnoozeKey(clientVersion, serverVersion) {
  return `agentflow.app-version.snooze:${normalizeAppVersion(clientVersion)}:${normalizeAppVersion(serverVersion)}`;
}
