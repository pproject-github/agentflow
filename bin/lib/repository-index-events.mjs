const runFinishedListeners = new Set();

export function onRepositoryRunFinished(listener) {
  if (typeof listener !== "function") return () => {};
  runFinishedListeners.add(listener);
  return () => runFinishedListeners.delete(listener);
}

export function emitRepositoryRunFinished(workspaceRoot, run, status) {
  for (const listener of runFinishedListeners) {
    try {
      listener(workspaceRoot, run, status);
    } catch {
      // Derived repository updates must never break the authoritative run ledger.
    }
  }
}
