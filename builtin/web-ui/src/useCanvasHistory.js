import { useCallback, useEffect, useRef, useState } from "react";

const HISTORY_LIMIT = 80;
const CAPTURE_DELAY_MS = 220;

function stripNodeVolatileState(node) {
  if (!node || typeof node !== "object") return node;
  const {
    selected,
    dragging,
    resizing,
    className,
    positionAbsolute,
    measured,
    internals,
    ...rest
  } = node;
  return rest;
}

function stripEdgeVolatileState(edge) {
  if (!edge || typeof edge !== "object") return edge;
  const { selected, className, ...rest } = edge;
  return rest;
}

function stableSnapshot(nodes, edges, extra) {
  const snapshot = {
    nodes: Array.isArray(nodes) ? nodes.map(stripNodeVolatileState) : [],
    edges: Array.isArray(edges) ? edges.map(stripEdgeVolatileState) : [],
    extra: extra && typeof extra === "object" ? extra : {},
  };
  const signature = JSON.stringify(snapshot);
  return {
    value: JSON.parse(signature),
    signature,
  };
}

function pushLimited(stack, item) {
  const next = [...stack, item];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

export function useCanvasHistory({
  nodes,
  edges,
  extra,
  enabled = true,
  onRestore,
}) {
  const [version, setVersion] = useState(0);
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  const lastSnapshotRef = useRef(null);
  const pendingBeforeRef = useRef(null);
  const pendingNextRef = useRef(null);
  const timerRef = useRef(null);
  const restoringRef = useRef(false);

  const bump = useCallback(() => setVersion((current) => current + 1), []);

  const clearPendingTimer = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const flushPending = useCallback(() => {
    clearPendingTimer();
    const before = pendingBeforeRef.current;
    const next = pendingNextRef.current;
    pendingBeforeRef.current = null;
    pendingNextRef.current = null;
    if (!before || !next || before.signature === next.signature) {
      if (next) lastSnapshotRef.current = next;
      return false;
    }
    undoStackRef.current = pushLimited(undoStackRef.current, before);
    redoStackRef.current = [];
    lastSnapshotRef.current = next;
    bump();
    return true;
  }, [bump, clearPendingTimer]);

  const resetHistory = useCallback((nextNodes = [], nextEdges = [], nextExtra = {}) => {
    clearPendingTimer();
    undoStackRef.current = [];
    redoStackRef.current = [];
    pendingBeforeRef.current = null;
    pendingNextRef.current = null;
    lastSnapshotRef.current = stableSnapshot(nextNodes, nextEdges, nextExtra);
    restoringRef.current = false;
    bump();
  }, [bump, clearPendingTimer]);

  const restoreSnapshot = useCallback((snapshot) => {
    restoringRef.current = true;
    lastSnapshotRef.current = snapshot;
    pendingBeforeRef.current = null;
    pendingNextRef.current = null;
    clearPendingTimer();
    onRestore?.(snapshot.value);
    bump();
  }, [bump, clearPendingTimer, onRestore]);

  const undo = useCallback(() => {
    flushPending();
    const current = lastSnapshotRef.current || stableSnapshot(nodes, edges, extra);
    const previous = undoStackRef.current.pop();
    if (!previous) {
      bump();
      return false;
    }
    redoStackRef.current = pushLimited(redoStackRef.current, current);
    restoreSnapshot(previous);
    return true;
  }, [bump, edges, extra, flushPending, nodes, restoreSnapshot]);

  const redo = useCallback(() => {
    flushPending();
    const current = lastSnapshotRef.current || stableSnapshot(nodes, edges, extra);
    const next = redoStackRef.current.pop();
    if (!next) {
      bump();
      return false;
    }
    undoStackRef.current = pushLimited(undoStackRef.current, current);
    restoreSnapshot(next);
    return true;
  }, [bump, edges, extra, flushPending, nodes, restoreSnapshot]);

  useEffect(() => {
    return () => clearPendingTimer();
  }, [clearPendingTimer]);

  useEffect(() => {
    if (!enabled) return;
    const current = stableSnapshot(nodes, edges, extra);
    if (!lastSnapshotRef.current) {
      lastSnapshotRef.current = current;
      return;
    }
    if (restoringRef.current) {
      restoringRef.current = false;
      lastSnapshotRef.current = current;
      return;
    }
    if (current.signature === lastSnapshotRef.current.signature) return;
    if (!pendingBeforeRef.current) pendingBeforeRef.current = lastSnapshotRef.current;
    pendingNextRef.current = current;
    clearPendingTimer();
    timerRef.current = window.setTimeout(() => {
      flushPending();
    }, CAPTURE_DELAY_MS);
  }, [clearPendingTimer, edges, enabled, extra, flushPending, nodes]);

  return {
    canUndo: undoStackRef.current.length > 0 || Boolean(pendingBeforeRef.current),
    canRedo: redoStackRef.current.length > 0,
    resetHistory,
    undo,
    redo,
    version,
  };
}
