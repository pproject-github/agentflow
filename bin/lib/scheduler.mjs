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
import { getAgentflowUserContexts, getRunDir, PACKAGE_ROOT } from "./paths.mjs";
import { isApplyProcessAlive } from "./run-apply-active-lock.mjs";
import { log } from "./log.mjs";
import { readUserEnvObject } from "./user-env.mjs";
import { writeResult } from "../pipeline/write-result.mjs";

const DEFAULT_POLL_MS = 30_000;
const RUN_CONFIG_FILENAME = "run-config.json";
const WAIT_STATE_FILENAME = "wait-state.json";
const WAIT_STATES_FILENAME = "wait-states.json";

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

function hasHigherPriorityDuplicate(workspaceRoot, flow, opts = {}) {
  if ((flow.source || "user") !== "workspace") return false;
  return listFlowsJson(workspaceRoot, opts).some((f) => f.id === flow.id && !f.archived && (f.source || "user") === "user");
}

function getLatestRunUuidForFlow(workspaceRoot, flowId, opts = {}) {
  const runRoot = path.dirname(getRunDir(workspaceRoot, flowId, "00000000000000", opts));
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

function listRunDirsForFlow(flow) {
  const flowDir = flow.path || "";
  const runRoot = flowDir ? path.join(flowDir, "runBuild") : "";
  if (!runRoot || !fs.existsSync(runRoot)) return [];
  try {
    return fs.readdirSync(runRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{14}$/.test(e.name))
      .map((e) => ({ uuid: e.name, runDir: path.join(runRoot, e.name) }));
  } catch {
    return [];
  }
}

function readJsonObject(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return state && typeof state === "object" ? state : null;
  } catch {
    return null;
  }
}

function waitStateKey(state) {
  return String((state && (state.id || state.instanceId)) || "");
}

function persistedWaitState(state) {
  const {
    waitPath: _waitPath,
    legacyPath: _legacyPath,
    registryPath: _registryPath,
    runDir: _runDir,
    ...persisted
  } = state && typeof state === "object" ? state : {};
  return persisted;
}

function readWaitStates(runDir) {
  const legacyPath = path.join(runDir, WAIT_STATE_FILENAME);
  const registryPath = path.join(runDir, WAIT_STATES_FILENAME);
  const states = [];
  const seen = new Set();
  const registry = readJsonObject(registryPath);
  if (registry && Array.isArray(registry.waits)) {
    for (const raw of registry.waits) {
      if (!raw || typeof raw !== "object") continue;
      const state = { ...raw, runDir, legacyPath, registryPath };
      const key = waitStateKey(state);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      states.push(state);
    }
  }
  const legacy = readJsonObject(legacyPath);
  if (legacy) {
    const state = { ...legacy, runDir, waitPath: legacyPath, legacyPath, registryPath: fs.existsSync(registryPath) ? registryPath : null };
    const key = waitStateKey(state);
    if (key && !seen.has(key)) states.push(state);
  }
  return states;
}

function writeWaitState(waitState, patch = {}) {
  const next = {
    ...(waitState && typeof waitState === "object" ? waitState : {}),
    ...(patch && typeof patch === "object" ? patch : {}),
    updatedAt: new Date().toISOString(),
  };
  const runDir = next.runDir || (next.waitPath ? path.dirname(next.waitPath) : "");
  if (!runDir) return;

  const legacyPath = next.legacyPath || next.waitPath || path.join(runDir, WAIT_STATE_FILENAME);
  const registryPath = next.registryPath || path.join(runDir, WAIT_STATES_FILENAME);
  const persisted = persistedWaitState(next);
  const key = waitStateKey(persisted);

  const registry = readJsonObject(registryPath);
  if (registry && Array.isArray(registry.waits)) {
    const waits = registry.waits.filter((w) => waitStateKey(w) !== key);
    waits.push(persisted);
    fs.writeFileSync(registryPath, JSON.stringify({ ...registry, updatedAt: new Date().toISOString(), waits }, null, 2) + "\n", "utf-8");
  }
  fs.writeFileSync(legacyPath, JSON.stringify(persisted, null, 2) + "\n", "utf-8");
}

function readNodeResultStatus(runDir, instanceId) {
  const resultPath = path.join(runDir, "intermediate", instanceId, `${instanceId}.result.md`);
  if (!fs.existsSync(resultPath)) return null;
  try {
    const raw = fs.readFileSync(resultPath, "utf-8");
    const m = raw.match(/^\s*status:\s*["']?([^"'\s]+)["']?/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function isFlowCurrentlyRunning(workspaceRoot, flowId, state, opts = {}) {
  const candidates = [];
  if (state && typeof state.lastRunUuid === "string") candidates.push(state.lastRunUuid);
  const latest = getLatestRunUuidForFlow(workspaceRoot, flowId, opts);
  if (latest) candidates.push(latest);
  for (const uuid of candidates) {
    const runDir = getRunDir(workspaceRoot, flowId, uuid, opts);
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

function ensureNextRunAt(workspaceRoot, flow, schedule, state, opts = {}) {
  const identity = scheduleIdentity(schedule);
  if (state.scheduleIdentity === identity && state.nextRunAt) return state;
  const nextRunAt = schedule.enabled && schedule.cron ? computeNextRunAtFromSchedule(schedule) : null;
  const next = {
    ...baseState(flow, schedule, state),
    nextRunAt,
    lastError: "",
  };
  writeScheduleState(workspaceRoot, flow.id, flow.source || "user", next, opts);
  return next;
}

function startScheduledRun(workspaceRoot, flow, schedule, state, opts = {}) {
  const flowDir = flow.path || "";
  const agentflowBin = path.join(PACKAGE_ROOT, "bin", "agentflow.mjs");
  const args = [agentflowBin, "apply", flow.id, "--machine-readable", "--workspace-root", path.resolve(workspaceRoot), "--force"];
  args.push(...buildCliInputArgs(flowDir, schedule.preset));
  const child = spawn(process.execPath, args, {
    cwd: path.resolve(workspaceRoot),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...readUserEnvObject(opts.userId), FORCE_COLOR: "0", AGENTFLOW_USER_ID: opts.userId || "" },
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
          }, opts);
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
    const prev = readScheduleState(workspaceRoot, flow.id, flow.source || "user", opts).state || state;
    writeScheduleState(workspaceRoot, flow.id, flow.source || "user", {
      ...baseState(flow, schedule, prev),
      nextRunAt: prev.nextRunAt || computeNextRunAtFromSchedule(schedule),
      lastTriggeredAt: prev.lastTriggeredAt || startedAt,
      lastRunUuid: lastRunUuid || prev.lastRunUuid || null,
      lastExitCode: code,
      lastExitSignal: signal || "",
      lastFinishedAt: new Date().toISOString(),
      lastError: code === 0 ? "" : `scheduled run exited with code ${code}${signal ? ` signal ${signal}` : ""}`,
    }, opts);
  });

  child.unref();
  return child;
}

function startWaitingRunResume(workspaceRoot, flow, waitState, opts = {}) {
  const agentflowBin = path.join(PACKAGE_ROOT, "bin", "agentflow.mjs");
  const uuid = String(waitState.uuid || "");
  const instanceId = String(waitState.instanceId || "");
  const args = [
    agentflowBin,
    "resume",
    flow.id,
    uuid,
    instanceId,
    "--machine-readable",
    "--workspace-root",
    path.resolve(workspaceRoot),
    "--force",
  ];
  const child = spawn(process.execPath, args, {
    cwd: path.resolve(workspaceRoot),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...readUserEnvObject(opts.userId), FORCE_COLOR: "0", AGENTFLOW_USER_ID: opts.userId || "" },
    detached: true,
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) log.debug(`[scheduler] resume ${flow.id}/${uuid}: ${text.slice(0, 1000)}`);
  });
  child.on("exit", (code, signal) => {
    const runDir = waitState.runDir || (waitState.waitPath ? path.dirname(waitState.waitPath) : "");
    if (!runDir) return;
    const latest = readWaitStates(runDir).find((s) => waitStateKey(s) === waitStateKey(waitState));
    if (!latest || latest.wakeAt !== waitState.wakeAt || latest.instanceId !== waitState.instanceId) return;
    writeWaitState(latest, {
      status: code === 0 ? "resumed" : "waiting",
      lastResumeExitCode: code,
      lastResumeExitSignal: signal || "",
      lastResumeFinishedAt: new Date().toISOString(),
      ...(code === 0 ? {} : { lastError: `resume exited with code ${code}${signal ? ` signal ${signal}` : ""}` }),
    });
  });
  child.unref();
  return child;
}

function countActiveWaitsForFlow(flow) {
  let count = 0;
  for (const run of listRunDirsForFlow(flow)) {
    for (const waitState of readWaitStates(run.runDir)) {
      if (waitState && (waitState.status === "waiting" || waitState.status === "resuming")) count += 1;
    }
  }
  return count;
}

function hasNodeBranchEdge(runDir, instanceId, branchName) {
  const flowJsonPath = path.join(runDir, "intermediate", "flow.json");
  const flow = readJsonObject(flowJsonPath);
  if (!flow || !Array.isArray(flow.edges)) return false;
  const outputSlotTypes = flow.outputSlotTypes && flow.outputSlotTypes[instanceId];
  if (!outputSlotTypes || typeof outputSlotTypes !== "object") return false;
  const idx = Object.keys(outputSlotTypes).indexOf(branchName);
  if (idx < 0) return false;
  const sourceHandle = `output-${idx}`;
  return flow.edges.some((e) => e && e.source === instanceId && (e.sourceHandle || "output-0") === sourceHandle);
}

export function cancelScheduledRun(workspaceRoot, flowId, uuid) {
  const flow = listFlowsJson(workspaceRoot).find((f) => f.id === flowId && !f.archived && f.source !== "builtin");
  if (!flow) return { ok: false, error: `flow not found: ${flowId}` };
  const runDir = getRunDir(workspaceRoot, flow.id, uuid);
  if (!fs.existsSync(runDir)) return { ok: false, error: `run not found: ${flowId}/${uuid}` };
  const cancelledAt = new Date().toISOString();
  fs.writeFileSync(path.join(runDir, "cancelled.json"), JSON.stringify({ cancelled: true, cancelledAt }, null, 2) + "\n", "utf-8");
  let updated = 0;
  let propagated = 0;
  let resumePid = null;
  for (const waitState of readWaitStates(runDir)) {
    if (waitState.status !== "waiting" && waitState.status !== "resuming") continue;
    const instanceId = String(waitState.instanceId || "");
    const canPropagate =
      waitState.reason === "control_interval_loop" &&
      instanceId &&
      hasNodeBranchEdge(runDir, instanceId, "cancelled") &&
      !resumePid;
    if (canPropagate) {
      writeResult(
        workspaceRoot,
        flow.id,
        uuid,
        instanceId,
        { status: "success", message: "已取消", branch: "cancelled" },
        { execId: Number(waitState.execId) || undefined, preserveBody: false },
      );
      const child = startWaitingRunResume(workspaceRoot, flow, { ...waitState, uuid, runDir, branch: "cancelled" });
      resumePid = child.pid || null;
      writeWaitState(waitState, { status: "resuming", branch: "cancelled", cancelledAt, resumePid, resumeStartedAt: cancelledAt });
      propagated += 1;
    } else {
      writeWaitState(waitState, { status: "cancelled", cancelledAt });
    }
    updated += 1;
  }
  return { ok: true, flowId, uuid, cancelledAt, updatedWaits: updated, propagatedWaits: propagated, resumePid };
}

export function listScheduleStatuses(workspaceRoot, opts = {}) {
  const rows = [];
  for (const flow of listFlowsJson(workspaceRoot, opts)) {
    if (flow.archived || flow.source === "builtin") continue;
    const scheduleRes = readFlowSchedule(workspaceRoot, flow.id, flow.source || "user", opts);
    if (!scheduleRes.success) {
      rows.push({ flowId: flow.id, flowSource: flow.source || "user", enabled: false, error: scheduleRes.error });
      continue;
    }
    const schedule = scheduleRes.schedule;
    const stateRes = readScheduleState(workspaceRoot, flow.id, flow.source || "user", opts);
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
      lastError: hasHigherPriorityDuplicate(workspaceRoot, flow, opts)
        ? "workspace flow is shadowed by a user flow with the same id"
        : state.lastError || "",
      running: isFlowCurrentlyRunning(workspaceRoot, flow.id, state, opts),
      waiting: countActiveWaitsForFlow(flow),
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
    const contexts = opts.userId ? [{ userId: opts.userId }] : getAgentflowUserContexts();
    for (const scheduleCtx of contexts) {
    for (const flow of listFlowsJson(workspaceRoot, scheduleCtx)) {
      if (flow.archived || flow.source === "builtin") continue;
      const flowSource = flow.source || "user";
      let resumedWaitingRun = false;
      for (const run of listRunDirsForFlow(flow)) {
        if (resumedWaitingRun) break;
        for (const waitState of readWaitStates(run.runDir)) {
          if (!waitState || !waitState.wakeAt || !waitState.instanceId) continue;
          if (waitState.status === "resuming" && !isFlowCurrentlyRunning(workspaceRoot, flow.id, { lastRunUuid: run.uuid }, scheduleCtx)) {
            const nodeStatus = readNodeResultStatus(run.runDir, String(waitState.instanceId));
            writeWaitState(waitState, {
              status: nodeStatus === "pending" ? "waiting" : "resumed",
              reconciledAt: new Date().toISOString(),
            });
            continue;
          }
          if (waitState.status !== "waiting") continue;
          if (Date.parse(waitState.wakeAt) > now) continue;
          if (isFlowCurrentlyRunning(workspaceRoot, flow.id, { lastRunUuid: run.uuid }, scheduleCtx)) continue;
          const nextState = {
            ...waitState,
            status: "resuming",
            resumePid: null,
            resumeStartedAt: new Date().toISOString(),
          };
          try {
            const child = startWaitingRunResume(workspaceRoot, flow, { ...waitState, uuid: run.uuid, runDir: run.runDir }, scheduleCtx);
            nextState.resumePid = child.pid || null;
            writeWaitState(waitState, nextState);
            resumedWaitingRun = true;
            log.info(`[scheduler] resume ${flow.id}/${run.uuid} at ${waitState.instanceId}; pid=${child.pid || "?"}`);
            break;
          } catch (e) {
            writeWaitState(waitState, {
              status: "waiting",
              lastError: e && e.message ? e.message : String(e),
              lastErrorAt: new Date().toISOString(),
            });
            log.info(`[scheduler] resume failed ${flow.id}/${run.uuid}: ${e && e.message ? e.message : String(e)}`);
          }
        }
      }

      const scheduleRes = readFlowSchedule(workspaceRoot, flow.id, flowSource, scheduleCtx);
      if (!scheduleRes.success) {
        log.debug(`[scheduler] ${flow.id}: ${scheduleRes.error}`);
        continue;
      }
      const schedule = scheduleRes.schedule;
      if (!schedule.enabled || !schedule.cron) continue;
      if (hasHigherPriorityDuplicate(workspaceRoot, flow, scheduleCtx)) {
        const stateRes = readScheduleState(workspaceRoot, flow.id, flowSource, scheduleCtx);
        writeScheduleState(workspaceRoot, flow.id, flowSource, {
          ...baseState(flow, schedule, stateRes.success ? stateRes.state : {}),
          nextRunAt: null,
          lastError: "workspace flow is shadowed by a user flow with the same id; scheduled run skipped",
          lastErrorAt: new Date().toISOString(),
        }, scheduleCtx);
        continue;
      }
      const stateRes = readScheduleState(workspaceRoot, flow.id, flowSource, scheduleCtx);
      let state = ensureNextRunAt(workspaceRoot, flow, schedule, stateRes.success ? stateRes.state : {}, scheduleCtx);
      if (!state.nextRunAt || Date.parse(state.nextRunAt) > now) continue;

      if (isFlowCurrentlyRunning(workspaceRoot, flow.id, state, scheduleCtx)) {
        const nextRunAt = computeNextRunAtFromSchedule(schedule);
        writeScheduleState(workspaceRoot, flow.id, flowSource, {
          ...baseState(flow, schedule, state),
          nextRunAt,
          lastSkippedAt: new Date().toISOString(),
          lastSkipReason: "running",
        }, scheduleCtx);
        log.info(`[scheduler] skip ${flow.id}: already running; next=${nextRunAt}`);
        continue;
      }

      try {
        const child = startScheduledRun(workspaceRoot, flow, schedule, state, scheduleCtx);
        const nextRunAt = computeNextRunAtFromSchedule(schedule);
        writeScheduleState(workspaceRoot, flow.id, flowSource, {
          ...baseState(flow, schedule, state),
          nextRunAt,
          lastTriggeredAt: new Date().toISOString(),
          lastPid: child.pid || null,
          lastError: "",
        }, scheduleCtx);
        log.info(`[scheduler] triggered ${flow.id}; pid=${child.pid || "?"}; next=${nextRunAt}`);
      } catch (e) {
        const nextRunAt = computeNextRunAtFromSchedule(schedule);
        writeScheduleState(workspaceRoot, flow.id, flowSource, {
          ...baseState(flow, schedule, state),
          nextRunAt,
          lastError: e && e.message ? e.message : String(e),
          lastErrorAt: new Date().toISOString(),
        }, scheduleCtx);
        log.info(`[scheduler] failed ${flow.id}: ${e && e.message ? e.message : String(e)}`);
      }
    }
    }
    if (once) return;
    await sleep(pollMs);
  }
}
