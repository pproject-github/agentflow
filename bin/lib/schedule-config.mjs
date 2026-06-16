import fs from "fs";
import path from "path";
import { getFlowYamlAbs } from "./catalog-flows.mjs";

export const SCHEDULE_CONFIG_FILENAME = "schedule.json";
export const SCHEDULE_STATE_FILENAME = "schedule-state.json";

const DEFAULT_SCHEDULE = {
  enabled: false,
  cron: "",
  timezone: "Asia/Shanghai",
  preset: "",
  overlapPolicy: "skip",
  misfirePolicy: "skip",
};

const CRON_FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 7 },
];

const VALID_OVERLAP_POLICIES = new Set(["skip"]);
const VALID_MISFIRE_POLICIES = new Set(["skip"]);

function normalizeTimezone(tz) {
  const value = typeof tz === "string" && tz.trim() ? tz.trim() : DEFAULT_SCHEDULE.timezone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    throw new Error(`Invalid timezone: ${value}`);
  }
}

function parseCronNumber(raw, field) {
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid ${field.name} value: ${raw}`);
  const n = Number(raw);
  const normalized = field.name === "dayOfWeek" && n === 7 ? 0 : n;
  if (n < field.min || n > field.max) throw new Error(`Invalid ${field.name} value: ${raw}`);
  return normalized;
}

function addRange(values, field, start, end, step) {
  if (step <= 0) throw new Error(`Invalid ${field.name} step`);
  if (start > end) throw new Error(`Invalid ${field.name} range`);
  for (let n = start; n <= end; n += step) {
    values.add(field.name === "dayOfWeek" && n === 7 ? 0 : n);
  }
}

function parseCronField(raw, field) {
  const text = String(raw || "").trim();
  if (!text) throw new Error(`Missing ${field.name}`);
  const values = new Set();
  values.cronWildcard = text === "*";
  for (const partRaw of text.split(",")) {
    const part = partRaw.trim();
    if (!part) throw new Error(`Invalid ${field.name} field`);
    const [rangeRaw, stepRaw] = part.split("/");
    if (part.split("/").length > 2) throw new Error(`Invalid ${field.name} step`);
    const step = stepRaw == null ? 1 : parseCronNumber(stepRaw, { ...field, min: 1 });
    if (rangeRaw === "*") {
      addRange(values, field, field.min, field.max, step);
      continue;
    }
    const dashIdx = rangeRaw.indexOf("-");
    if (dashIdx >= 0) {
      const start = parseCronNumber(rangeRaw.slice(0, dashIdx), field);
      const end = parseCronNumber(rangeRaw.slice(dashIdx + 1), field);
      addRange(values, field, start, end, step);
      continue;
    }
    if (stepRaw != null) throw new Error(`Invalid ${field.name} step target`);
    values.add(parseCronNumber(rangeRaw, field));
  }
  return values;
}

export function parseCronExpression(cron) {
  const parts = String(cron || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    throw new Error("Cron must contain 5 fields: minute hour day month weekday");
  }
  return CRON_FIELDS.map((field, i) => parseCronField(parts[i], field));
}

function zonedParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const out = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0;
  return out;
}

function cronMatches(parsed, parts) {
  const [minutes, hours, days, months, weekdays] = parsed;
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  const dayMatches =
    days.cronWildcard || weekdays.cronWildcard
      ? days.has(parts.day) && weekdays.has(weekday)
      : days.has(parts.day) || weekdays.has(weekday);
  return (
    minutes.has(parts.minute) &&
    hours.has(parts.hour) &&
    months.has(parts.month) &&
    dayMatches
  );
}

export function computeNextRunAt(cron, timezone, fromDate = new Date()) {
  const parsed = parseCronExpression(cron);
  const tz = normalizeTimezone(timezone);
  const startMs = Math.floor(fromDate.getTime() / 60000) * 60000 + 60000;
  const maxMinutes = 366 * 24 * 60;
  for (let i = 0; i < maxMinutes; i++) {
    const candidate = new Date(startMs + i * 60000);
    if (cronMatches(parsed, zonedParts(candidate, tz))) return candidate.toISOString();
  }
  throw new Error("Could not find next run within one year");
}

export function computeNextRunAtFromSchedule(schedule, fromDate = new Date()) {
  const normalized = normalizeSchedule(schedule);
  if (!normalized.cron) return null;
  return computeNextRunAt(normalized.cron, normalized.timezone, fromDate);
}

export function normalizeSchedule(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const enabled = Boolean(src.enabled);
  const cron = typeof src.cron === "string" ? src.cron.trim() : "";
  const timezone = normalizeTimezone(src.timezone);
  const preset = typeof src.preset === "string" ? src.preset.trim() : "";
  const overlapPolicy = VALID_OVERLAP_POLICIES.has(src.overlapPolicy) ? src.overlapPolicy : DEFAULT_SCHEDULE.overlapPolicy;
  const misfirePolicy = VALID_MISFIRE_POLICIES.has(src.misfirePolicy) ? src.misfirePolicy : DEFAULT_SCHEDULE.misfirePolicy;
  let nextRunAt = null;
  if (cron) {
    parseCronExpression(cron);
    nextRunAt = computeNextRunAt(cron, timezone);
  } else if (enabled) {
    throw new Error("Cron is required when schedule is enabled");
  }
  return { enabled, cron, timezone, preset, overlapPolicy, misfirePolicy, nextRunAt };
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function readScheduleState(workspaceRoot, flowId, flowSource, opts = {}) {
  const paths = getFlowSchedulePaths(workspaceRoot, flowId, flowSource, opts);
  if (paths.error) return { success: false, error: paths.error };
  try {
    return { success: true, state: readJsonIfExists(paths.statePath) || {}, statePath: paths.statePath };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : String(e) };
  }
}

export function writeScheduleState(workspaceRoot, flowId, flowSource, state, opts = {}) {
  const paths = getFlowSchedulePaths(workspaceRoot, flowId, flowSource, opts);
  if (paths.error) return { success: false, error: paths.error };
  try {
    fs.writeFileSync(paths.statePath, JSON.stringify(state && typeof state === "object" ? state : {}, null, 2) + "\n", "utf-8");
    return { success: true, statePath: paths.statePath };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : String(e) };
  }
}

export function getFlowSchedulePaths(workspaceRoot, flowId, flowSource, opts = {}) {
  const yamlRes = getFlowYamlAbs(workspaceRoot, flowId, flowSource, opts);
  if (yamlRes.error || !yamlRes.path) return { error: yamlRes.error || "Could not resolve flow.yaml" };
  const flowDir = path.dirname(yamlRes.path);
  return {
    flowDir,
    configPath: path.join(flowDir, SCHEDULE_CONFIG_FILENAME),
    statePath: path.join(flowDir, SCHEDULE_STATE_FILENAME),
  };
}

export function readFlowSchedule(workspaceRoot, flowId, flowSource, opts = {}) {
  const paths = getFlowSchedulePaths(workspaceRoot, flowId, flowSource, opts);
  if (paths.error) return { success: false, error: paths.error };
  try {
    const configRaw = readJsonIfExists(paths.configPath) || DEFAULT_SCHEDULE;
    const state = readJsonIfExists(paths.statePath) || {};
    return { success: true, schedule: normalizeSchedule(configRaw), state };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : String(e) };
  }
}

export function writeFlowSchedule(workspaceRoot, flowId, flowSource, schedule, opts = {}) {
  const paths = getFlowSchedulePaths(workspaceRoot, flowId, flowSource, opts);
  if (paths.error) return { success: false, error: paths.error };
  try {
    const normalized = normalizeSchedule(schedule);
    const toWrite = {
      enabled: normalized.enabled,
      cron: normalized.cron,
      timezone: normalized.timezone,
      preset: normalized.preset,
      overlapPolicy: normalized.overlapPolicy,
      misfirePolicy: normalized.misfirePolicy,
    };
    fs.writeFileSync(paths.configPath, JSON.stringify(toWrite, null, 2) + "\n", "utf-8");
    return { success: true, schedule: normalized };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : String(e) };
  }
}
