import crypto from "node:crypto";

const DECISIONS = new Set(["continue", "wait", "done", "fail"]);
const STEP_RESULT_KEYS = new Set(["decision", "state", "summary"]);

export const DEFAULT_CONTROL_WHILE_MAX_ITERATIONS = 20;
export const DEFAULT_CONTROL_WHILE_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_CONTROL_WHILE_ITERATIONS = 1000;
export const MAX_CONTROL_WHILE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_CONTROL_WHILE_STEP_STDOUT_BYTES = 1024 * 1024;
export const MAX_CONTROL_WHILE_STEP_STDERR_BYTES = 256 * 1024;
export const MAX_CONTROL_WHILE_SUMMARY_LENGTH = 4000;
export const MAX_CONTROL_WHILE_STATE_BYTES = 1024 * 1024;

export function parseControlWhileDurationMs(raw, fallback = DEFAULT_CONTROL_WHILE_TIMEOUT_MS) {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text) return fallback;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
  if (!match) throw new Error(`control.while invalid timeout: ${raw}`);
  const value = Number(match[1]);
  const unit = match[2] || "s";
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const result = Math.round(value * factor);
  if (!Number.isFinite(result) || result <= 0) throw new Error(`control.while timeout must be greater than zero: ${raw}`);
  if (result > MAX_CONTROL_WHILE_TIMEOUT_MS) throw new Error("control.while timeout must not exceed 7d");
  return result;
}

export function normalizeControlWhileConfig(inputs = {}) {
  const rawMax = String(inputs.maxIterations ?? "").trim();
  const maxIterations = rawMax ? Number(rawMax) : DEFAULT_CONTROL_WHILE_MAX_ITERATIONS;
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > MAX_CONTROL_WHILE_ITERATIONS) {
    throw new Error(`control.while maxIterations must be an integer between 1 and ${MAX_CONTROL_WHILE_ITERATIONS}`);
  }
  return {
    maxIterations,
    timeoutMs: parseControlWhileDurationMs(inputs.timeout, DEFAULT_CONTROL_WHILE_TIMEOUT_MS),
  };
}

export function normalizeControlWhileInitialState(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  if (typeof raw === "object") {
    assertControlWhileStateSize(raw);
    return raw;
  }
  try {
    const parsed = JSON.parse(String(raw));
    assertControlWhileStateSize(parsed);
    return parsed;
  } catch (error) {
    if (String(error?.message || "").startsWith("control.while state")) throw error;
    throw new Error(`control.while state must be valid JSON: ${error.message}`);
  }
}

export function serializeControlWhileState(value) {
  const serialized = JSON.stringify(value ?? null);
  if (serialized === undefined) throw new Error("control.while state must be JSON serializable");
  if (Buffer.byteLength(serialized, "utf-8") > MAX_CONTROL_WHILE_STATE_BYTES) {
    throw new Error(`control.while state must not exceed ${MAX_CONTROL_WHILE_STATE_BYTES} bytes`);
  }
  return serialized;
}

function assertControlWhileStateSize(value) {
  serializeControlWhileState(value);
}

export function parseControlWhileStepResult(raw, currentState = null) {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("control.while step returned empty stdout; expected one JSON object");
  if (Buffer.byteLength(text, "utf-8") > MAX_CONTROL_WHILE_STEP_STDOUT_BYTES) {
    throw new Error(`control.while step stdout must not exceed ${MAX_CONTROL_WHILE_STEP_STDOUT_BYTES} bytes`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`control.while step stdout must be exactly one JSON object: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("control.while step stdout must be a JSON object");
  }
  const unknownKeys = Object.keys(parsed).filter((key) => !STEP_RESULT_KEYS.has(key));
  if (unknownKeys.length) {
    throw new Error(`control.while step result contains unsupported fields: ${unknownKeys.join(", ")}`);
  }
  if (typeof parsed.decision !== "string") {
    throw new Error("control.while decision must be a string");
  }
  const decision = parsed.decision;
  if (!DECISIONS.has(decision)) {
    throw new Error(`control.while decision must be continue, wait, done, or fail; received ${JSON.stringify(parsed.decision)}`);
  }
  if (parsed.summary != null && typeof parsed.summary !== "string") {
    throw new Error("control.while summary must be a string");
  }
  const summary = parsed.summary || "";
  if (summary.length > MAX_CONTROL_WHILE_SUMMARY_LENGTH) {
    throw new Error(`control.while summary must not exceed ${MAX_CONTROL_WHILE_SUMMARY_LENGTH} characters`);
  }
  const state = Object.prototype.hasOwnProperty.call(parsed, "state") ? parsed.state : currentState;
  assertControlWhileStateSize(state);
  return {
    decision,
    state,
    summary,
  };
}

export function normalizeControlWhileHistory(raw) {
  if (raw == null || String(raw).trim() === "") return [];
  let parsed = raw;
  if (!Array.isArray(raw)) {
    try {
      parsed = JSON.parse(String(raw));
    } catch (error) {
      throw new Error(`control.while checkpoint history must be valid JSON: ${error.message}`);
    }
  }
  if (!Array.isArray(parsed)) throw new Error("control.while checkpoint history must be an array");
  if (parsed.length > MAX_CONTROL_WHILE_ITERATIONS) {
    throw new Error(`control.while checkpoint history must not exceed ${MAX_CONTROL_WHILE_ITERATIONS} entries`);
  }
  let previousIteration = 0;
  return parsed.map((rawEntry, index) => {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      throw new Error(`control.while checkpoint history entry ${index + 1} must be an object`);
    }
    const iteration = Number(rawEntry.iteration);
    if (!Number.isInteger(iteration) || iteration < 1 || iteration <= previousIteration) {
      throw new Error("control.while checkpoint iterations must be positive and strictly increasing");
    }
    const decision = rawEntry.decision;
    if (typeof decision !== "string" || !DECISIONS.has(decision)) {
      throw new Error(`control.while checkpoint entry ${iteration} has an invalid decision`);
    }
    if (rawEntry.summary != null && typeof rawEntry.summary !== "string") {
      throw new Error(`control.while checkpoint entry ${iteration} has an invalid summary`);
    }
    const elapsedMs = Number(rawEntry.elapsedMs ?? 0);
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
      throw new Error(`control.while checkpoint entry ${iteration} has an invalid elapsedMs`);
    }
    const idempotencyKey = rawEntry.idempotencyKey == null ? "" : String(rawEntry.idempotencyKey);
    if (idempotencyKey.length > 128) {
      throw new Error(`control.while checkpoint entry ${iteration} has an invalid idempotencyKey`);
    }
    previousIteration = iteration;
    return {
      iteration,
      decision,
      summary: rawEntry.summary || "",
      elapsedMs: Math.round(elapsedMs),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
  });
}

export function resolveControlWhileCheckpoint({
  previousDecision = "",
  state = "",
  history = "",
  iterations = "",
  fingerprint = "",
  expectedFingerprint = "",
  allowResume = true,
} = {}) {
  if (String(previousDecision || "") !== "wait") return { resumable: false, reason: "not_waiting" };
  if (!allowResume) return { resumable: false, reason: "resume_disabled" };
  if (!fingerprint || fingerprint !== expectedFingerprint) return { resumable: false, reason: "fingerprint_mismatch" };

  const parsedHistory = normalizeControlWhileHistory(history);
  const last = parsedHistory[parsedHistory.length - 1];
  const recordedIterations = Number(iterations);
  if (!last || last.decision !== "wait") {
    throw new Error("control.while waiting checkpoint is corrupt: history must end with wait");
  }
  if (!Number.isInteger(recordedIterations) || recordedIterations !== last.iteration) {
    throw new Error("control.while waiting checkpoint is corrupt: iterations do not match history");
  }
  return {
    resumable: true,
    reason: "waiting_checkpoint",
    state: normalizeControlWhileInitialState(state),
    history: parsedHistory,
    nextIteration: last.iteration + 1,
    elapsedMs: parsedHistory.reduce((total, entry) => total + entry.elapsedMs, 0),
  };
}

export function controlWhileCheckpointFingerprint({ inputFingerprint = "", initialState = null } = {}) {
  return crypto.createHash("sha256")
    .update(`${String(inputFingerprint || "")}\u0000${serializeControlWhileState(initialState)}`)
    .digest("hex")
    .slice(0, 24);
}

export function controlWhileIdempotencyKey({ checkpointFingerprint = "", nodeId = "", iteration = 1 } = {}) {
  const absoluteIteration = Number(iteration);
  if (!checkpointFingerprint || !nodeId || !Number.isInteger(absoluteIteration) || absoluteIteration < 1) {
    throw new Error("control.while cannot create idempotency key without checkpoint fingerprint, nodeId, and iteration");
  }
  const digest = crypto.createHash("sha256")
    .update(`${checkpointFingerprint}\u0000${nodeId}\u0000${absoluteIteration}`)
    .digest("hex")
    .slice(0, 32);
  return `afw_${digest}`;
}

function controlWhileTimeoutError(timeoutMs) {
  const error = new Error(`control.while timed out after ${timeoutMs}ms`);
  error.code = "CONTROL_WHILE_TIMEOUT";
  return error;
}

/**
 * Execute one deterministic step repeatedly. The graph stays acyclic: iteration is entirely
 * represented by this state machine and its per-iteration events.
 */
export async function runControlWhile({
  initialState = null,
  initialHistory = [],
  initialElapsedMs = 0,
  startIteration = null,
  maxIterations = DEFAULT_CONTROL_WHILE_MAX_ITERATIONS,
  timeoutMs = DEFAULT_CONTROL_WHILE_TIMEOUT_MS,
  executeStep,
  idempotencyKeyForIteration = null,
  signal = null,
  onIterationStart = null,
  onIterationDone = null,
  now = () => Date.now(),
} = {}) {
  if (typeof executeStep !== "function") throw new Error("control.while executeStep is required");
  const history = normalizeControlWhileHistory(initialHistory);
  const inferredStartIteration = history.length ? history[history.length - 1].iteration + 1 : 1;
  const firstIteration = startIteration == null ? inferredStartIteration : Number(startIteration);
  if (!Number.isInteger(firstIteration) || firstIteration < 1 || firstIteration !== inferredStartIteration) {
    throw new Error("control.while startIteration must continue directly after checkpoint history");
  }
  const elapsedBeforeRun = Number(initialElapsedMs);
  if (!Number.isFinite(elapsedBeforeRun) || elapsedBeforeRun < 0) {
    throw new Error("control.while initialElapsedMs must be a non-negative number");
  }
  const startedAt = now();
  let state = initialState;

  for (let iteration = firstIteration; iteration <= maxIterations; iteration += 1) {
    if (signal?.aborted) {
      const error = new Error("Workspace run stopped");
      error.code = "WORKSPACE_RUN_ABORTED";
      throw error;
    }
    const elapsedBefore = elapsedBeforeRun + Math.max(0, now() - startedAt);
    const remainingMs = timeoutMs - elapsedBefore;
    if (remainingMs <= 0) return {
      decision: "fail",
      state,
      summary: `Reached timeout after ${timeoutMs}ms`,
      iterations: history.length ? history[history.length - 1].iteration : firstIteration - 1,
      history,
      reason: "timeout",
    };

    const idempotencyKey = typeof idempotencyKeyForIteration === "function"
      ? String(idempotencyKeyForIteration({ iteration, state }) || "")
      : "";
    onIterationStart?.({ iteration, state, elapsedMs: elapsedBefore, remainingMs, idempotencyKey });
    const iterationStartedAt = now();
    const controller = new AbortController();
    let timedOut = false;
    const abortFromParent = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(controlWhileTimeoutError(timeoutMs));
    }, remainingMs);

    let raw;
    try {
      raw = await executeStep({ iteration, state, remainingMs, signal: controller.signal, idempotencyKey });
    } catch (error) {
      if (signal?.aborted) {
        const stopped = new Error("Workspace run stopped");
        stopped.code = "WORKSPACE_RUN_ABORTED";
        throw stopped;
      }
      if (timedOut) return {
        decision: "fail",
        state,
        summary: `Reached timeout after ${timeoutMs}ms`,
        iterations: history.length ? history[history.length - 1].iteration : firstIteration - 1,
        history,
        reason: "timeout",
      };
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromParent);
    }

    const step = parseControlWhileStepResult(raw, state);
    state = step.state;
    const entry = {
      iteration,
      decision: step.decision,
      summary: step.summary,
      elapsedMs: Math.max(0, now() - iterationStartedAt),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    history.push(entry);
    onIterationDone?.({ ...entry, state });

    if (step.decision !== "continue") {
      return {
        decision: step.decision,
        state,
        summary: step.summary,
        iterations: iteration,
        history,
        reason: step.decision,
      };
    }
  }

  return {
    decision: "fail",
    state,
    summary: `Reached maxIterations (${maxIterations}) without done or wait`,
    iterations: maxIterations,
    history,
    reason: "max_iterations",
  };
}
