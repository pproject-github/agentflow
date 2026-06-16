import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import yaml from "js-yaml";
import { listFlowsJson } from "./catalog-flows.mjs";
import {
  computeNextRunAtFromSchedule,
  readFlowSchedule,
  readScheduleState,
  writeScheduleState,
} from "./schedule-config.mjs";
import { getRunDir, PACKAGE_ROOT } from "./paths.mjs";
import { isApplyProcessAlive } from "./run-apply-active-lock.mjs";
import { log } from "./log.mjs";

const DEFAULT_POLL_MS = 30_000;
const RUN_CONFIG_FILENAME = "run-config.json";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scheduleIdentity(schedule) {
  return [
    schedule.enabled ? "1" : "0",
    schedule.cron || "",
    schedule.timezone || "",
    schedule.preset || "",
    schedule.overlapPolicy || "skip",
    schedule.misfirePolicy || "skip",
  ].join("\t");
}

function readRunConfig(flowDir) {
  const configPath = path.join(flowDir, RUN_CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) return { presets: {}, activePreset: null };
  try {
    const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return {
      presets: data.presets && typeof data.presets === "object" ? data.presets : {},
      activePreset: typeof data.activePreset === "string" ? data.activePreset : null,
    };
  } catch {
    return { presets: {}, activePreset: null };
  }
}

function buildCliInputArgs(flowDir, presetName) {
  const cfg = readRunConfig(flowDir);
  const name = presetName || cfg.activePreset || "";
  const preset = name && cfg.presets && typeof cfg.presets[name] === "object" ? cfg.presets[name] : null;
  if (!preset) return [];
  let flow;
  try {
    flow = yaml.load(fs.readFileSync(path.join(flowDir, "flow.yaml"), "utf-8"));
  } catch {
    flow = null;
  }
  const instances = flow && typeof flow === "object" && flow.instances && typeof flow.instances === "object" ? flow.instances : {};
  const edges = flow && typeof flow === "object" && Array.isArray(flow.edges) ? flow.edges : [];
  const provideToInputName = {};
  for (const e of edges) {
    if (!e || !e.source || !e.target) continue;
    const source = String(e.source);
    const target = String(e.target);
    if (!preset.hasOwnProperty(source)) continue;
    const sourceInst = instances[source] || {};
    const sourceDef = String(sourceInst.definitionId || "");
    if (!sourceDef.startsWith("provide_")) continue;
    const m = /^input-(\d+)$/.exec(String(e.targetHandle || ""));
    if (!m) continue;
    const targetInst = instances[target] || {};
    const inputs = Array.isArray(targetInst.input) ? targetInst.input : [];
    const slot = inputs[parseInt(m[1], 10)];
    if (slot && typeof slot.name === "string" && slot.name.trim()) {
      provideToInputName[source] = {
        name: slot.name.trim(),
        isFile: sourceDef.startsWith("provide_file"),
      };
    }
  }
  const args = [];
  for (const [inputName, value] of Object.entries(preset)) {
    if (!inputName || typeof inputName !== "string") continue;
    const mapped = provideToInputName[inputName];
    if (!mapped) continue;
    args.push("--input", `${mapped.name}=${mapped.isFile ? "file:" : ""}${String(value ?? "")}`);
  }
  return args;
}

function hasHigherPriorityDuplicate(workspaceRoot, flow) {
  if ((flow.source || "user") !== "workspace") return false;
  return listFlowsJson(workspaceRoot).some((f) => f.id === flow.id && !f.archived && (f.source || "user") === "user");
}

function getLatestRunUuidForFlow(workspaceRoot, flowId) {
  const runRoot = path.dirname(getRunDir(workspaceRoot, flowId, "00000000000000"));
  if (!fs.existsSync(runRoot)) return null;
  try {
    const dirs = fs.readdirSync(runRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{14}$/.test(e.name))
      .map((e) => e.name)
      .sort();
    return dirs[dirs.length - 1] || null;
  } catch {
    return null;
  }
}

function isFlowCurrentlyRunning(workspaceRoot, flowId, state) {
  const candidates = [];
  if (state && typeof state.lastRunUuid === "string") candidates.push(state.lastRunUuid);
  const latest = getLatestRunUuidForFlow(workspaceRoot, flowId);
  if (latest) candidates.push(latest);
  for (const uuid of candidates) {
    const runDir = getRunDir(workspaceRoot, flowId, uuid);
    if (isApplyProcessAlive(runDir)) return true;
  }
  return false;
}

function baseState(flow, schedule, previousState) {
  return {
    ...(previousState && typeof previousState === "object" ? previousState : {}),
    flowId: flow.id,
    flowSource: flow.source || "user",
    scheduleIdentity: scheduleIdentity(schedule),
    updatedAt: new Date().toISOString(),
  };
}

function ensureNextRunAt(workspaceRoot, flow, schedule, state) {
  const identity = scheduleIdentity(schedule);
  if (state.scheduleIdentity === identity && state.nextRunAt) return state;
  const nextRunAt = schedule.enabled && schedule.cron ? computeNextRunAtFromSchedule(schedule) : null;
  const next = {
    ...baseState(flow, schedule, state),
    nextRunAt,
    lastError: "",
  };
  writeScheduleState(workspaceRoot, flow.id, flow.source || "user", next);
  return next;
}

function startScheduledRun(workspaceRoot, flow, schedule, state) {
  const flowDir = flow.path || "";
  const agentflowBin = path.join(PACKAGE_ROOT, "bin", "agentflow.mjs");
  const args = [agentflowBin, "apply", flow.id, "--machine-readable", "--workspace-root", path.resolve(workspaceRoot), "--force"];
  args.push(...buildCliInputArgs(flowDir, schedule.preset));
  const child = spawn(process.execPath, args, {
    cwd: path.resolve(workspaceRoot),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
    detached: true,
  });

  const startedAt = new Date().toISOString();
  let lastRunUuid = null;
  let stdoutBuf = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString("utf8");
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt && evt.event === "apply-start" && typeof evt.uuid === "string") {
          lastRunUuid = evt.uuid;
          writeScheduleState(workspaceRoot, flow.id, flow.source || "user", {
            ...baseState(flow, schedule, state),
            nextRunAt: computeNextRunAtFromSchedule(schedule),
            lastTriggeredAt: startedAt,
            lastRunUuid,
            lastPid: child.pid || null,
            lastError: "",
          });
        }
      } catch {
        /* ignore non-json lines */
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) log.debug(`[scheduler] ${flow.id}: ${text.slice(0, 1000)}`);
  });

  child.on("exit", (code, signal) => {
    const prev = readScheduleState(workspaceRoot, flow.id, flow.source || "user").state || state;
    writeScheduleState(workspaceRoot, flow.id, flow.source || "user", {
      ...baseState(flow, schedule, prev),
      nextRunAt: prev.nextRunAt || computeNextRunAtFromSchedule(schedule),
      lastTriggeredAt: prev.lastTriggeredAt || startedAt,
      lastRunUuid: lastRunUuid || prev.lastRunUuid || null,
      lastExitCode: code,
      lastExitSignal: signal || "",
      lastFinishedAt: new Date().toISOString(),
      lastError: code === 0 ? "" : `scheduled run exited with code ${code}${signal ? ` signal ${signal}` : ""}`,
    });
  });

  child.unref();
  return child;
}

export function listScheduleStatuses(workspaceRoot) {
  const rows = [];
  for (const flow of listFlowsJson(workspaceRoot)) {
    if (flow.archived || flow.source === "builtin") continue;
    const scheduleRes = readFlowSchedule(workspaceRoot, flow.id, flow.source || "user");
    if (!scheduleRes.success) {
      rows.push({ flowId: flow.id, flowSource: flow.source || "user", enabled: false, error: scheduleRes.error });
      continue;
    }
    const schedule = scheduleRes.schedule;
    const stateRes = readScheduleState(workspaceRoot, flow.id, flow.source || "user");
    const state = stateRes.success ? stateRes.state : {};
    rows.push({
      flowId: flow.id,
      flowSource: flow.source || "user",
      enabled: Boolean(schedule.enabled),
      cron: schedule.cron || "",
      timezone: schedule.timezone || "",
      preset: schedule.preset || "",
      nextRunAt: state.nextRunAt || schedule.nextRunAt || null,
      lastTriggeredAt: state.lastTriggeredAt || null,
      lastRunUuid: state.lastRunUuid || null,
      lastError: hasHigherPriorityDuplicate(workspaceRoot, flow)
        ? "workspace flow is shadowed by a user flow with the same id"
        : state.lastError || "",
      running: isFlowCurrentlyRunning(workspaceRoot, flow.id, state),
    });
  }
  rows.sort((a, b) => {
    const ea = a.enabled ? 0 : 1;
    const eb = b.enabled ? 0 : 1;
    return ea - eb || String(a.nextRunAt || "").localeCompare(String(b.nextRunAt || "")) || a.flowId.localeCompare(b.flowId);
  });
  return rows;
}

export async function startScheduler(workspaceRoot, opts = {}) {
  const pollMs = Math.max(1000, Number(opts.pollMs) || DEFAULT_POLL_MS);
  const once = Boolean(opts.once);
  log.info(`AgentFlow scheduler started. workspace=${path.resolve(workspaceRoot)} poll=${pollMs}ms`);
  while (true) {
    const now = Date.now();
    for (const flow of listFlowsJson(workspaceRoot)) {
      if (flow.archived || flow.source === "builtin") continue;
      const flowSource = flow.source || "user";
      const scheduleRes = readFlowSchedule(workspaceRoot, flow.id, flowSource);
      if (!scheduleRes.success) {
        log.debug(`[scheduler] ${flow.id}: ${scheduleRes.error}`);
        continue;
      }
      const schedule = scheduleRes.schedule;
      if (!schedule.enabled || !schedule.cron) continue;
      if (hasHigherPriorityDuplicate(workspaceRoot, flow)) {
        const stateRes = readScheduleState(workspaceRoot, flow.id, flowSource);
        writeScheduleState(workspaceRoot, flow.id, flowSource, {
          ...baseState(flow, schedule, stateRes.success ? stateRes.state : {}),
          nextRunAt: null,
          lastError: "workspace flow is shadowed by a user flow with the same id; scheduled run skipped",
          lastErrorAt: new Date().toISOString(),
        });
        continue;
      }
      const stateRes = readScheduleState(workspaceRoot, flow.id, flowSource);
      let state = ensureNextRunAt(workspaceRoot, flow, schedule, stateRes.success ? stateRes.state : {});
      if (!state.nextRunAt || Date.parse(state.nextRunAt) > now) continue;

      if (isFlowCurrentlyRunning(workspaceRoot, flow.id, state)) {
        const nextRunAt = computeNextRunAtFromSchedule(schedule);
        writeScheduleState(workspaceRoot, flow.id, flowSource, {
          ...baseState(flow, schedule, state),
          nextRunAt,
          lastSkippedAt: new Date().toISOString(),
          lastSkipReason: "running",
        });
        log.info(`[scheduler] skip ${flow.id}: already running; next=${nextRunAt}`);
        continue;
      }

      try {
        const child = startScheduledRun(workspaceRoot, flow, schedule, state);
        const nextRunAt = computeNextRunAtFromSchedule(schedule);
        writeScheduleState(workspaceRoot, flow.id, flowSource, {
          ...baseState(flow, schedule, state),
          nextRunAt,
          lastTriggeredAt: new Date().toISOString(),
          lastPid: child.pid || null,
          lastError: "",
        });
        log.info(`[scheduler] triggered ${flow.id}; pid=${child.pid || "?"}; next=${nextRunAt}`);
      } catch (e) {
        const nextRunAt = computeNextRunAtFromSchedule(schedule);
        writeScheduleState(workspaceRoot, flow.id, flowSource, {
          ...baseState(flow, schedule, state),
          nextRunAt,
          lastError: e && e.message ? e.message : String(e),
          lastErrorAt: new Date().toISOString(),
        });
        log.info(`[scheduler] failed ${flow.id}: ${e && e.message ? e.message : String(e)}`);
      }
    }
    if (once) return;
    await sleep(pollMs);
  }
}
