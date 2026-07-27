function childHasExited(child) {
  return !child || child.exitCode != null || child.signalCode != null;
}

function waitForPromise(promise, timeoutMs) {
  const ms = Math.max(0, Number(timeoutMs) || 0);
  if (ms === 0) return Promise.resolve({ timedOut: true });
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, ms);
    Promise.resolve(promise).then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, value });
    });
  });
}

export function terminateWorkspaceChild(child, options = {}) {
  if (childHasExited(child)) return false;
  const signal = String(options.signal || "SIGTERM");
  const processGroup = options.processGroup === true && process.platform !== "win32";
  const pid = Number(child?.pid || 0);
  if (processGroup && pid > 0) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // The group may already be gone. Fall back to the direct child.
    }
  }
  try {
    return child.kill(signal) !== false;
  } catch {
    return false;
  }
}

export function createWorkspaceRunController(options = {}) {
  const abortController = options.abortController || new AbortController();
  const gracefulTimeoutMs = Math.max(0, Number(options.gracefulTimeoutMs ?? 3_000));
  const forceTimeoutMs = Math.max(0, Number(options.forceTimeoutMs ?? 1_000));
  let activeChild = null;
  let activeChildProcessGroup = false;
  let state = "running";
  let finished = false;
  let finishResult = null;
  let resolveDone;
  let stopPromise = null;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const setChild = (child, childOptions = {}) => {
    activeChild = child || null;
    activeChildProcessGroup = Boolean(child && childOptions.processGroup === true);
    if (state === "stopping" && activeChild) {
      terminateWorkspaceChild(activeChild, {
        signal: "SIGTERM",
        processGroup: activeChildProcessGroup,
      });
    }
  };

  const finish = (status = "finished") => {
    if (finished) return finishResult;
    finished = true;
    state = state === "stopping" ? "stopped" : String(status || "finished");
    finishResult = { status: state };
    activeChild = null;
    activeChildProcessGroup = false;
    resolveDone(finishResult);
    return finishResult;
  };

  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (finished) return { stopped: true, alreadyFinished: true, status: state };
      state = "stopping";
      try {
        abortController.abort();
      } catch {
        // Best effort; process termination below is authoritative.
      }
      terminateWorkspaceChild(activeChild, {
        signal: "SIGTERM",
        processGroup: activeChildProcessGroup,
      });
      let waited = await waitForPromise(done, gracefulTimeoutMs);
      if (!waited.timedOut) return { stopped: true, forced: false, status: waited.value?.status || state };

      terminateWorkspaceChild(activeChild, {
        signal: "SIGKILL",
        processGroup: activeChildProcessGroup,
      });
      waited = await waitForPromise(done, forceTimeoutMs);
      if (!waited.timedOut) return { stopped: true, forced: true, status: waited.value?.status || state };
      return { stopped: false, forced: true, timedOut: true, status: state };
    })();
    return stopPromise;
  };

  return {
    abortController,
    done,
    finish,
    setChild,
    stop,
    get child() {
      return activeChild;
    },
    get state() {
      return state;
    },
    get finished() {
      return finished;
    },
  };
}
