import { spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import { getAgentflowSkillsRoot } from "./paths.mjs";

const PACKAGE_RE = /(?:\.apk|\.aab|\.ipa)(?:[?#]|$)|apk-dir|apk-file/i;
const QR_RE = /(?:^|[^a-z])(?:qr|qrcode)(?:[^a-z]|$)|二维码/i;
const URL_RE = /https?:\/\/[^\s<>"']+/gi;

export const JENKINS_BUILD_STATE_VERSION = 1;
export const DEFAULT_JENKINS_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_JENKINS_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function safeText(value, max = 800) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

function safeCredentialKey(ref) {
  return String(ref || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseDurationMs(raw, fallback) {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text) return fallback;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
  if (!match) throw new Error(`invalid duration: ${raw}`);
  const value = Number(match[1]);
  const unit = match[2] || "s";
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return Math.round(value * factor);
}

export function normalizeJenkinsBuildConfig(inputs = {}) {
  const job = String(inputs.job || inputs.jobName || "").trim();
  if (!job) throw new Error("Jenkins job is required");
  let parameters = {};
  const rawParameters = inputs.parameters ?? inputs.parametersJson ?? "{}";
  if (rawParameters && typeof rawParameters === "object" && !Array.isArray(rawParameters)) {
    parameters = { ...rawParameters };
  } else if (String(rawParameters || "").trim()) {
    const parsed = JSON.parse(String(rawParameters));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Jenkins parameters must be a JSON object");
    parameters = parsed;
  }
  const pollIntervalMs = Math.max(5_000, parseDurationMs(inputs.pollInterval || inputs.pollIntervalSec, DEFAULT_JENKINS_POLL_INTERVAL_MS));
  const timeoutMs = Math.max(pollIntervalMs, parseDurationMs(inputs.timeout || inputs.timeoutSec, DEFAULT_JENKINS_TIMEOUT_MS));
  return {
    job,
    parameters,
    credentialRef: String(inputs.credentialRef || "").trim(),
    pollIntervalMs,
    timeoutMs,
  };
}

export function jenkinsCredentialEnv(env = process.env, credentialRef = "") {
  const key = safeCredentialKey(credentialRef);
  const prefix = key ? `JENKINS_${key}_` : "";
  const pick = (name) => (prefix && env[`${prefix}${name}`]) || env[`JENKINS_${name}`] || "";
  return {
    baseUrl: String(pick("BASE_URL") || "").trim(),
    username: String(pick("USERNAME") || "").trim(),
    token: String(pick("TOKEN") || "").trim(),
  };
}

function candidateSkillDirs(workspaceRoot, env) {
  return [
    env.AGENTFLOW_JENKINS_SKILL_DIR,
    workspaceRoot ? path.join(workspaceRoot, ".agents", "skills", "jenkins") : "",
    workspaceRoot ? path.join(workspaceRoot, ".codex", "skills", "jenkins") : "",
    path.join(getAgentflowSkillsRoot(), "jenkins"),
    path.join(os.homedir(), ".agents", "skills", "jenkins"),
    path.join(os.homedir(), ".codex", "skills", "jenkins"),
    path.join(os.homedir(), ".@nova", "skillhub", "jenkins"),
    path.join(os.homedir(), ".@nova", "skillhub", "jenkins", "latest", "content"),
  ].filter(Boolean);
}

export function resolveJenkinsSkillRuntime(workspaceRoot, env = process.env) {
  for (const dir of candidateSkillDirs(workspaceRoot, env)) {
    const skillDir = path.resolve(String(dir));
    const cli = ["jenkins_cli.py", "jenkins.py"]
      .map((name) => path.join(skillDir, "scripts", name))
      .find((candidate) => fs.existsSync(candidate));
    if (!cli) continue;
    const configuredPython = String(env.AGENTFLOW_JENKINS_PYTHON || "").trim();
    const venvPython = path.join(skillDir, ".venv", "bin", "python");
    if (configuredPython) return { skillDir, cli, command: configuredPython, prefixArgs: [] };
    if (fs.existsSync(venvPython)) return { skillDir, cli, command: venvPython, prefixArgs: [] };
    const systemPython = spawnSync("python3", ["-c", "import jenkins"], { encoding: "utf-8", timeout: 5_000 });
    if (systemPython.status === 0) return { skillDir, cli, command: "python3", prefixArgs: [] };
    const uv = spawnSync("uv", ["--version"], { encoding: "utf-8", timeout: 5_000 });
    if (uv.status === 0) {
      return {
        skillDir,
        cli,
        command: "uv",
        prefixArgs: ["run", "--quiet", "--with", "python-jenkins", "python"],
      };
    }
    return { skillDir, cli, command: "python3", prefixArgs: [] };
  }
  throw new Error("Jenkins skill is not installed; install the `jenkins` skill or set AGENTFLOW_JENKINS_SKILL_DIR");
}

function operationArgs(operation, args) {
  if (operation === "trigger") {
    return ["trigger", "--job-name", String(args.job), "--parameters-json", JSON.stringify(args.parameters || {})];
  }
  if (operation === "queue") return ["queue", "--queue-id", String(args.queueId)];
  if (operation === "build") return ["build", "--job-name", String(args.job), "--build-number", String(args.buildNumber)];
  throw new Error(`unsupported Jenkins operation: ${operation}`);
}

export function createJenkinsSkillInvoker({ workspaceRoot, credentialRef = "", env = process.env, timeoutMs = 30_000 } = {}) {
  const runtime = resolveJenkinsSkillRuntime(workspaceRoot, env);
  const credentials = jenkinsCredentialEnv(env, credentialRef);
  if (!credentials.baseUrl) {
    const suffix = credentialRef ? ` for credentialRef ${credentialRef}` : "";
    throw new Error(`JENKINS_BASE_URL is required${suffix}`);
  }
  return (operation, args = {}) => {
    const child = spawnSync(runtime.command, [...runtime.prefixArgs, runtime.cli, ...operationArgs(operation, args)], {
      cwd: workspaceRoot ? path.resolve(workspaceRoot) : process.cwd(),
      env: {
        ...env,
        JENKINS_BASE_URL: credentials.baseUrl,
        JENKINS_USERNAME: credentials.username,
        JENKINS_TOKEN: credentials.token,
      },
      encoding: "utf-8",
      timeout: Math.max(1_000, Number(timeoutMs) || 30_000),
      maxBuffer: 8 * 1024 * 1024,
    });
    if (child.error) throw new Error(`Jenkins skill failed: ${safeText(child.error.message)}`);
    let payload;
    try {
      payload = JSON.parse(String(child.stdout || "").trim());
    } catch {
      throw new Error(`Jenkins skill returned invalid JSON: ${safeText(child.stderr || child.stdout || "empty output")}`);
    }
    return payload;
  };
}

function hashParameters(parameters) {
  return crypto.createHash("sha256").update(JSON.stringify(parameters || {})).digest("hex").slice(0, 16);
}

function trimUrl(url) {
  return String(url || "").trim().replace(/[.,;:!?\])}]+$/, "");
}

function artifactUrl(buildUrl, artifact) {
  const direct = trimUrl(artifact?.url);
  if (direct) return direct;
  const relative = String(artifact?.relativePath || "").trim();
  if (!relative || !buildUrl) return "";
  return `${String(buildUrl).replace(/\/+$/, "")}/artifact/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

function collectBuildLinks(build = {}) {
  const buildUrl = trimUrl(build.url);
  const packageUrls = [];
  const qrUrls = [];
  const add = (context, rawUrl) => {
    const url = trimUrl(rawUrl);
    if (!/^https?:\/\//i.test(url)) return;
    const haystack = `${context || ""} ${url}`;
    if (QR_RE.test(haystack)) {
      if (!qrUrls.includes(url)) qrUrls.push(url);
    } else if (PACKAGE_RE.test(haystack)) {
      if (!packageUrls.includes(url)) packageUrls.push(url);
    }
  };
  for (const artifact of Array.isArray(build.artifacts) ? build.artifacts : []) {
    add(artifact?.relativePath || artifact?.fileName || "", artifactUrl(buildUrl, artifact));
  }
  const scan = (value, context = "", depth = 0) => {
    if (depth > 5 || value == null) return;
    if (typeof value === "string") {
      for (const url of value.match(URL_RE) || []) add(context, url);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) scan(item, context, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [key, item] of Object.entries(value)) scan(item, `${context} ${key}`, depth + 1);
    }
  };
  scan(build.description || "", "description");
  scan(build.actions || [], "actions");
  return {
    buildUrl,
    url: packageUrls[0] || buildUrl,
    qrUrl: qrUrls[0] || "",
  };
}

function waitResult(state, nowMs, pollIntervalMs, message) {
  const wakeAt = new Date(nowMs + pollIntervalMs).toISOString();
  return {
    kind: "waiting",
    message,
    wakeAt,
    state: { ...state, wakeAt, message, updatedAt: new Date(nowMs).toISOString() },
  };
}

function completeResult(state, nowMs, status, message, links = {}) {
  const completedAt = new Date(nowMs).toISOString();
  const next = {
    ...state,
    phase: "complete",
    status,
    message,
    url: links.url || state.url || state.buildUrl || "",
    qrUrl: links.qrUrl || state.qrUrl || "",
    buildUrl: links.buildUrl || state.buildUrl || "",
    wakeAt: "",
    completedAt,
    updatedAt: completedAt,
  };
  return { kind: "complete", message, state: next, outputs: { status, url: next.url, qrUrl: next.qrUrl } };
}

function failedResult(state, nowMs, message) {
  const completed = completeResult(state, nowMs, "ERROR", message);
  return { ...completed, kind: "failed" };
}

function invokeFailure(state, nowMs, config, response, fallback) {
  const errors = Number(state.consecutiveErrors || 0) + 1;
  const message = safeText(response?.safe_summary || response?.blocked_reason || fallback || "Jenkins request failed");
  const next = { ...state, consecutiveErrors: errors, lastError: message };
  if (errors >= 3) return failedResult(next, nowMs, message);
  return waitResult(next, nowMs, config.pollIntervalMs, `Jenkins 暂时不可用，稍后重试 (${errors}/3)`);
}

/**
 * Advances exactly one Jenkins remote operation. Long waits are represented as
 * a wakeAt checkpoint; callers persist the returned state and let Scheduler
 * re-enter the same node.
 */
export function advanceJenkinsBuild({ state, config, invoke, persistState = () => {}, nowMs = Date.now(), cancelled = false }) {
  const nowIso = new Date(nowMs).toISOString();
  let current = state && typeof state === "object" ? { ...state } : null;
  if (cancelled) return completeResult(current || { version: 1, job: config.job, createdAt: nowIso }, nowMs, "CANCELLED", "Jenkins 构建监控已取消");
  if (current?.phase === "complete") return completeResult(current, nowMs, current.status || "ERROR", current.message || "Jenkins 构建已结束", current);

  if (!current) {
    current = {
      version: JENKINS_BUILD_STATE_VERSION,
      job: config.job,
      parametersHash: hashParameters(config.parameters),
      phase: "triggering",
      status: "QUEUED",
      createdAt: nowIso,
      startedAt: nowIso,
      deadlineAt: new Date(nowMs + config.timeoutMs).toISOString(),
      pollCount: 0,
      consecutiveErrors: 0,
      updatedAt: nowIso,
    };
    // Persist before the non-idempotent trigger. If the process dies after the
    // Jenkins request, a later resume reports an unknown outcome instead of
    // accidentally triggering a duplicate build.
    persistState(current);
    let response;
    try {
      response = invoke("trigger", { job: config.job, parameters: config.parameters });
    } catch (error) {
      return failedResult(current, nowMs, safeText(error?.message || error));
    }
    if (!response?.ok) return failedResult(current, nowMs, safeText(response?.safe_summary || response?.blocked_reason || "Jenkins trigger failed"));
    const queueId = String(response?.resource?.queue_id || response?.resource?.queueId || "").trim();
    if (!queueId) return failedResult(current, nowMs, "Jenkins trigger did not return queueId");
    current = { ...current, phase: "queued", status: "QUEUED", queueId, message: `已进入 Jenkins 队列 ${queueId}`, updatedAt: nowIso };
    return waitResult(current, nowMs, config.pollIntervalMs, current.message);
  }

  if (current.phase === "triggering") {
    return failedResult(current, nowMs, "Jenkins 触发结果未知，为避免重复构建未自动重试");
  }
  if (current.deadlineAt && Date.parse(current.deadlineAt) <= nowMs) {
    return completeResult(current, nowMs, "TIMEOUT", "等待 Jenkins 构建超时");
  }

  if (current.phase === "queued") {
    let response;
    try {
      response = invoke("queue", { queueId: current.queueId });
    } catch (error) {
      response = { ok: false, safe_summary: error?.message || String(error) };
    }
    if (!response?.ok) return invokeFailure(current, nowMs, config, response, "Jenkins queue lookup failed");
    const item = response?.resource?.item || {};
    const executable = item.executable || {};
    if (item.cancelled) return completeResult(current, nowMs, "ABORTED", "Jenkins 队列任务已取消");
    if (executable.number != null) {
      const buildNumber = String(executable.number);
      const buildUrl = trimUrl(executable.url);
      const next = {
        ...current,
        phase: "running",
        status: "RUNNING",
        buildNumber,
        buildUrl,
        pollCount: Number(current.pollCount || 0) + 1,
        consecutiveErrors: 0,
      };
      return waitResult(next, nowMs, config.pollIntervalMs, `Jenkins 构建中 · #${buildNumber}`);
    }
    const next = {
      ...current,
      pollCount: Number(current.pollCount || 0) + 1,
      consecutiveErrors: 0,
      queueReason: safeText(item.why || ""),
    };
    return waitResult(next, nowMs, config.pollIntervalMs, next.queueReason || `Jenkins 排队中 · ${current.queueId}`);
  }

  if (current.phase === "running") {
    let response;
    try {
      response = invoke("build", { job: config.job, buildNumber: current.buildNumber });
    } catch (error) {
      response = { ok: false, safe_summary: error?.message || String(error) };
    }
    if (!response?.ok) return invokeFailure(current, nowMs, config, response, "Jenkins build lookup failed");
    const build = response?.resource?.build || {};
    const links = collectBuildLinks(build);
    if (build.building || !build.result) {
      const next = {
        ...current,
        status: "RUNNING",
        buildUrl: links.buildUrl || current.buildUrl || "",
        pollCount: Number(current.pollCount || 0) + 1,
        consecutiveErrors: 0,
      };
      return waitResult(next, nowMs, config.pollIntervalMs, `Jenkins 构建中 · #${current.buildNumber}`);
    }
    const status = String(build.result || "ERROR").trim().toUpperCase();
    return completeResult(
      { ...current, buildNumber: String(build.number ?? current.buildNumber ?? "") },
      nowMs,
      status,
      `Jenkins ${status}${current.buildNumber ? ` · #${current.buildNumber}` : ""}`,
      links,
    );
  }

  return failedResult(current, nowMs, `Unknown Jenkins phase: ${safeText(current.phase)}`);
}

export function readJenkinsBuildState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeJenkinsBuildState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(temp, filePath);
}
