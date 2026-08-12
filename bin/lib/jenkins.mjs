import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Jenkins parameters must be a JSON object");
    }
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
    baseUrl: String(pick("BASE_URL") || "").trim().replace(/\/+$/, ""),
    username: String(pick("USERNAME") || "").trim(),
    token: String(pick("TOKEN") || "").trim(),
  };
}

function trimUrl(url) {
  return String(url || "").trim().replace(/[.,;:!?\])}]+$/, "");
}

function jobPath(job) {
  const parts = String(job || "").split("/").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error("Jenkins job is required");
  return parts.map((part) => `job/${encodeURIComponent(part)}`).join("/");
}

function absoluteUrl(baseUrl, candidate) {
  const value = String(candidate || "").trim();
  if (!value) return "";
  return new URL(value, `${baseUrl}/`).toString();
}

async function responseBody(response) {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Native Jenkins Remote API client. Credentials never leave the request headers. */
export function createJenkinsHttpInvoker({ credentialRef = "", env = process.env, fetchImpl = globalThis.fetch, signal = null, requestTimeoutMs = 30_000 } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("global fetch is not available in this Node.js runtime");
  const credentials = jenkinsCredentialEnv(env, credentialRef);
  if (!credentials.baseUrl) {
    const suffix = credentialRef ? ` for credentialRef ${credentialRef}` : "";
    throw new Error(`JENKINS_BASE_URL is required${suffix}`);
  }
  const headers = { Accept: "application/json" };
  if (credentials.username || credentials.token) {
    headers.Authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.token}`).toString("base64")}`;
  }

  const request = async (url, options = {}) => {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Jenkins request timed out")), Math.max(1_000, Number(requestTimeoutMs) || 30_000));
    try {
      const response = await fetchImpl(url, {
        ...options,
        headers: { ...headers, ...(options.headers || {}) },
        signal: controller.signal,
      });
      const body = await responseBody(response);
      if (!response.ok) {
        return { ok: false, status: response.status, safe_summary: `Jenkins HTTP ${response.status}: ${safeText(body?.message || body?.raw || response.statusText)}` };
      }
      return { ok: true, response, body };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  };

  return async (operation, args = {}) => {
    if (operation === "trigger") {
      const configuredParameters = args.parameters || {};
      let parameterized = Object.keys(configuredParameters).length > 0;
      if (!parameterized) {
        const metadataUrl = `${credentials.baseUrl}/${jobPath(args.job)}/api/json?tree=actions[parameterDefinitions[name]]`;
        const metadata = await request(metadataUrl);
        if (!metadata.ok) return metadata;
        parameterized = (Array.isArray(metadata.body?.actions) ? metadata.body.actions : [])
          .some((action) => Array.isArray(action?.parameterDefinitions) && action.parameterDefinitions.length > 0);
      }
      const endpoint = `${credentials.baseUrl}/${jobPath(args.job)}/${parameterized ? "buildWithParameters" : "build"}`;
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(configuredParameters)) {
        form.set(key, value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));
      }
      const result = await request(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        redirect: "manual",
      });
      if (!result.ok) return result;
      const location = result.response.headers.get("location") || "";
      const queueUrl = absoluteUrl(credentials.baseUrl, location);
      const queueId = queueUrl.match(/\/queue\/item\/([^/?#]+)/)?.[1] || "";
      return queueId
        ? { ok: true, resource: { queue_id: decodeURIComponent(queueId), queue_url: queueUrl } }
        : { ok: false, safe_summary: "Jenkins trigger did not return a queue Location header" };
    }
    if (operation === "queue") {
      const url = `${credentials.baseUrl}/queue/item/${encodeURIComponent(String(args.queueId))}/api/json`;
      const result = await request(url);
      return result.ok ? { ok: true, resource: { item: result.body } } : result;
    }
    if (operation === "build") {
      const url = `${credentials.baseUrl}/${jobPath(args.job)}/${encodeURIComponent(String(args.buildNumber))}/api/json`;
      const result = await request(url);
      return result.ok ? { ok: true, resource: { build: result.body } } : result;
    }
    throw new Error(`unsupported Jenkins operation: ${operation}`);
  };
}

function hashParameters(parameters) {
  return crypto.createHash("sha256").update(JSON.stringify(parameters || {})).digest("hex").slice(0, 16);
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
    } else if (Array.isArray(value)) {
      for (const item of value) scan(item, context, depth + 1);
    } else if (typeof value === "object") {
      for (const [key, item] of Object.entries(value)) scan(item, `${context} ${key}`, depth + 1);
    }
  };
  scan(build.description || "", "description");
  scan(build.actions || [], "actions");
  return { buildUrl, url: packageUrls[0] || buildUrl, qrUrl: qrUrls[0] || "" };
}

function waitResult(state, nowMs, pollIntervalMs, message) {
  const wakeAt = new Date(nowMs + pollIntervalMs).toISOString();
  return { kind: "waiting", message, wakeAt, state: { ...state, wakeAt, message, updatedAt: new Date(nowMs).toISOString() } };
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
  return { ...completeResult(state, nowMs, "ERROR", message), kind: "failed" };
}

function blockedTriggerResult(state, nowMs, message) {
  const updatedAt = new Date(nowMs).toISOString();
  return {
    kind: "failed",
    message,
    state: { ...state, phase: "triggering", status: "ERROR", message, wakeAt: "", updatedAt },
    outputs: { status: "ERROR", url: state.url || state.buildUrl || "", qrUrl: state.qrUrl || "" },
  };
}

function invokeFailure(state, nowMs, config, response, fallback) {
  const errors = Number(state.consecutiveErrors || 0) + 1;
  const message = safeText(response?.safe_summary || response?.blocked_reason || fallback || "Jenkins request failed");
  const next = { ...state, consecutiveErrors: errors, lastError: message };
  if ([401, 403].includes(Number(response?.status)) || errors >= 3) return failedResult(next, nowMs, message);
  return waitResult(next, nowMs, config.pollIntervalMs, `Jenkins 暂时不可用，稍后重试 (${errors}/3)`);
}

/** Advances exactly one remote operation and returns a durable checkpoint. */
export async function advanceJenkinsBuild({ state, config, invoke, persistState = () => {}, nowMs = Date.now(), cancelled = false, runId = "" }) {
  const nowIso = new Date(nowMs).toISOString();
  let current = state && typeof state === "object" ? { ...state } : null;
  if (cancelled) return completeResult(current || { version: 1, job: config.job, createdAt: nowIso }, nowMs, "CANCELLED", "Jenkins 构建监控已取消");
  if (current?.phase === "complete") return completeResult(current, nowMs, current.status || "ERROR", current.message || "Jenkins 构建已结束", current);

  if (!current) {
    current = {
      version: JENKINS_BUILD_STATE_VERSION,
      runId: String(runId || ""),
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
    // Persist before the non-idempotent trigger. A crash must never trigger a duplicate build.
    persistState(current);
    let response;
    try {
      response = await invoke("trigger", { job: config.job, parameters: config.parameters });
    } catch (error) {
      return blockedTriggerResult(current, nowMs, `Jenkins 触发结果未知，为避免重复构建未自动重试：${safeText(error?.message || error)}`);
    }
    if (!response?.ok) return failedResult(current, nowMs, safeText(response?.safe_summary || response?.blocked_reason || "Jenkins trigger failed"));
    const queueId = String(response?.resource?.queue_id || response?.resource?.queueId || "").trim();
    if (!queueId) return failedResult(current, nowMs, "Jenkins trigger did not return queueId");
    current = { ...current, phase: "queued", status: "QUEUED", queueId, queueUrl: response?.resource?.queue_url || "", message: `已进入 Jenkins 队列 ${queueId}`, updatedAt: nowIso };
    return waitResult(current, nowMs, config.pollIntervalMs, current.message);
  }

  if (current.job !== config.job || current.parametersHash !== hashParameters(config.parameters)) {
    return failedResult(current, nowMs, "Jenkins checkpoint does not match the current job or parameters");
  }
  if (current.phase === "triggering") return blockedTriggerResult(current, nowMs, "Jenkins 触发结果未知，为避免重复构建未自动重试");
  if (current.deadlineAt && Date.parse(current.deadlineAt) <= nowMs) return completeResult(current, nowMs, "TIMEOUT", "等待 Jenkins 构建超时");

  if (current.phase === "queued") {
    let response;
    try {
      response = await invoke("queue", { queueId: current.queueId });
    } catch (error) {
      response = { ok: false, safe_summary: error?.message || String(error) };
    }
    if (!response?.ok) return invokeFailure(current, nowMs, config, response, "Jenkins queue lookup failed");
    const item = response?.resource?.item || {};
    const executable = item.executable || {};
    if (item.cancelled) return completeResult(current, nowMs, "ABORTED", "Jenkins 队列任务已取消");
    if (executable.number != null) {
      const buildNumber = String(executable.number);
      const next = { ...current, phase: "running", status: "RUNNING", buildNumber, buildUrl: trimUrl(executable.url), pollCount: Number(current.pollCount || 0) + 1, consecutiveErrors: 0 };
      return waitResult(next, nowMs, config.pollIntervalMs, `Jenkins 构建中 · #${buildNumber}`);
    }
    const next = { ...current, pollCount: Number(current.pollCount || 0) + 1, consecutiveErrors: 0, queueReason: safeText(item.why || "") };
    return waitResult(next, nowMs, config.pollIntervalMs, next.queueReason || `Jenkins 排队中 · ${current.queueId}`);
  }

  if (current.phase === "running") {
    let response;
    try {
      response = await invoke("build", { job: config.job, buildNumber: current.buildNumber });
    } catch (error) {
      response = { ok: false, safe_summary: error?.message || String(error) };
    }
    if (!response?.ok) return invokeFailure(current, nowMs, config, response, "Jenkins build lookup failed");
    const build = response?.resource?.build || {};
    const links = collectBuildLinks(build);
    if (build.building || !build.result) {
      const next = { ...current, status: "RUNNING", buildUrl: links.buildUrl || current.buildUrl || "", pollCount: Number(current.pollCount || 0) + 1, consecutiveErrors: 0 };
      return waitResult(next, nowMs, config.pollIntervalMs, `Jenkins 构建中 · #${current.buildNumber}`);
    }
    const status = String(build.result || "ERROR").trim().toUpperCase();
    return completeResult({ ...current, buildNumber: String(build.number ?? current.buildNumber ?? "") }, nowMs, status, `Jenkins ${status}${current.buildNumber ? ` · #${current.buildNumber}` : ""}`, links);
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
  const temp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(temp, filePath);
}

export function jenkinsBuildStatePath(workspaceRoot, nodeId) {
  const safeNodeId = String(nodeId || "jenkins").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "jenkins";
  return path.join(path.resolve(workspaceRoot), ".workspace", "agentflow", "jenkins", `${safeNodeId}.json`);
}
