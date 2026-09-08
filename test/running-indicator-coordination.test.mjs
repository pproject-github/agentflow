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

// 同一时刻 node 回 2.6ms，而经由前置 nginx 的同一个请求测到过 6.7 秒。这种停顿下一次
// 就恢复了，不是「运行状态同步不了」。以前 8 秒判失败、第一次失败就弹横幅、首档退避
// 直接 10 秒——一次抖动既报警又把刷新率砍成三分之一，横幅上「最近成功」越拖越久，
// 看起来远比实际严重。报警要么是真的，要么就别出现。
test("单次网络抖动不报警", async () => {
  const source = await readFile(runningIndicatorPath, "utf8");

  const timeout = Number(/const REQUEST_TIMEOUT_MS = ([\d_]+);/.exec(source)?.[1]?.replace(/_/g, ""));
  assert.ok(timeout >= 12_000, `判失败的门槛要高过实测到的停顿，现在是 ${timeout}ms`);

  const threshold = Number(/const DELAYED_AFTER_FAILURES = (\d+);/.exec(source)?.[1]);
  assert.ok(threshold >= 2, "第一次失败不该弹横幅");

  assert.match(
    source,
    /status: failureCount >= DELAYED_AFTER_FAILURES \? "delayed" : "ok"/,
    "没到门槛前状态必须还是 ok",
  );

  const firstBackoff = Number(
    /const FAILURE_BACKOFF_MS = \[([\d_]+)/.exec(source)?.[1]?.replace(/_/g, ""),
  );
  assert.ok(firstBackoff <= 5_000, `一次抖动不该把刷新率砍太狠，首档现在是 ${firstBackoff}ms`);
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
