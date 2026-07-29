import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runningIndicatorPath = new URL(
  "../builtin/web-ui/src/RunningIndicator.jsx",
  import.meta.url,
);
const workspacePagePath = new URL(
  "../builtin/web-ui/src/pages/WorkspacePage.jsx",
  import.meta.url,
);

test("recent-run polling is coordinated across tabs and never overlaps", async () => {
  const source = await readFile(runningIndicatorPath, "utf8");

  assert.match(
    source,
    /new BroadcastChannel\(RECENT_RUNS_CHANNEL\)/,
    "running state must be shared with sibling AgentFlow tabs",
  );
  assert.match(
    source,
    /navigator\.locks\.request\(\s*RECENT_RUNS_LOCK,/s,
    "only one AgentFlow tab may own the recent-runs poller",
  );
  assert.match(
    source,
    /document\.hidden \|\| activeRequest/,
    "hidden tabs and an in-flight request must block another poll",
  );
  assert.match(
    source,
    /request\.abort\(\)/,
    "slow or backgrounded requests must be abortable",
  );
  assert.doesNotMatch(
    source,
    /setInterval\(load,\s*3000\)/,
    "fixed intervals must not create overlapping recent-runs requests",
  );
  assert.match(
    source,
    /if \(runs\.length === 0 && !delayed\) return null;/,
    "healthy multi-tab coordination must stay silent when nothing is running",
  );
});

test("Workflow event streams disconnect in background tabs", async () => {
  const source = await readFile(workspacePagePath, "utf8");

  assert.match(
    source,
    /if \(!flowParams\.flowId \|\| isWorkflowMode\) return undefined;/,
    "Workflow mode must not open the unrelated workspace event stream",
  );
  assert.match(
    source,
    /if \(document\.hidden\) \{\s*closeEvents\(\);/s,
    "event streams must close when their tab becomes hidden",
  );
  assert.match(
    source,
    /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/,
    "visible tabs must reconnect and refresh after returning to the foreground",
  );
});
