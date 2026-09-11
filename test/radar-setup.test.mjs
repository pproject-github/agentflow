import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { boardWorkspacePath, renderBoardDoc, renderTrackerDoc, setupBoard } from "../bin/lib/radar-setup.mjs";

const PLAN = {
  summary: "抓政策和扫现状拆两条",
  items: [
    { id: "play-target-36", title: "目标 API 36", due: "2026-10-31", required: "targetSdk 36",
      tasks: ["升 compileSdk", "升 targetSdk"], unknowns: ["前台服务类型要不要声明"] },
    { id: "edge-to-edge", title: "边到边", due: "", required: "全页面适配" },
  ],
  flows: [
    { action: "create", flowId: "policy-watch", cron: "0 9 * * 1", owns: ["*"], updates: ["due", "title"] },
    { action: "keep", flowId: "old-one", owns: [] },
  ],
};

// board.md 是这块板的宪法：写得含糊的话，三个月后会混进各种最佳实践建议
test("board.md 带上 topic、边界和更新方式", () => {
  const doc = renderBoardDoc({ board: "android-policy", title: "Android 政策追踪", topic: "盯 Play 商店强制要求", summary: "拆两条" });
  assert.match(doc, /^---\n[\s\S]*board: android-policy/);
  assert.match(doc, /盯 Play 商店强制要求/);
  assert.match(doc, /拆两条/);
  assert.match(doc, /绝不默认当成通过/);
  assert.match(doc, /frontmatter.*告警按 `state` 触发/);
});

/**
 * 规划这一刻还没扫过任何东西。文件里写一个 state，人打开就会以为已经查过了。
 */
test("条目文件不写 state，只写人填的那些", () => {
  const doc = renderTrackerDoc(PLAN.items[0]);
  assert.doesNotMatch(doc, /^state:/m);
  assert.match(doc, /id: play-target-36/);
  assert.match(doc, /due: '2026-10-31'/);
  assert.match(doc, /- \[ \] 升 compileSdk/);
  // 「还不知道」要摆在明面上，藏起来的话下一个人会以为已经查清楚了
  assert.match(doc, /## 待确认[\s\S]*前台服务类型要不要声明/);
});

test("没有任务和待确认时留一句提示，而不是空白", () => {
  const doc = renderTrackerDoc({ id: "a", title: "A" });
  assert.match(doc, /agent 和人都可以改/);
  // 空字段不写进 frontmatter，免得一堆 due: '' 的噪音
  assert.doesNotMatch(doc, /^due:/m);
});

function harness() {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "radar-setup-")));
  const calls = { commits: [], flows: [], autoCommits: [] };
  return {
    tempRoot,
    calls,
    deps: {
      createRadarBoard: () => ({ ok: true }),
      commitTrack: (args) => { calls.commits.push(args); return { ok: true }; },
      materializeFlow: (spec) => { calls.flows.push(spec); return { ok: true, flowId: spec.flowId }; },
      autoCommit: (dir, msg) => { calls.autoCommits.push(msg); },
    },
  };
}

test("建出完整的板目录：board.md + trackers + evidence + runtime", () => {
  const h = harness();
  const result = setupBoard({
    board: "b", title: "T", topic: "盯点什么", plan: PLAN, dataRoot: h.tempRoot, createdBy: "wangfang1",
  }, h.deps);
  assert.equal(result.ok, true);
  const ws = boardWorkspacePath(h.tempRoot, "b");
  assert.ok(fs.existsSync(path.join(ws, "board.md")));
  assert.ok(fs.existsSync(path.join(ws, "evidence")));
  assert.ok(fs.existsSync(path.join(ws, "runtime")));
  assert.deepEqual(fs.readdirSync(path.join(ws, "trackers")).sort(), ["edge-to-edge.md", "play-target-36.md"]);
  fs.rmSync(h.tempRoot, { recursive: true, force: true });
});

// 流程建出来就会认领条目；条目还不存在的话，它第一轮会把「认领的条目不存在」记成一堆告警
test("先把条目写进板，再建流程", () => {
  const h = harness();
  setupBoard({ board: "b", title: "T", topic: "x", plan: PLAN, dataRoot: h.tempRoot, createdBy: "w" }, h.deps);
  assert.equal(h.calls.commits.length, 1, "条目进了板");
  assert.equal(h.calls.commits[0].rows.length, 2);
  // 写进将来认领它们的那条流程的分片，而不是另开一个 seed 片（会撞成重复认领）
  assert.equal(h.calls.commits[0].flowId, "policy-watch");
  // 还没扫过就是 unknown，不是 idle——后者是「查过了没事」
  assert.ok(h.calls.commits[0].rows.every((row) => row.state === "unknown"));
  assert.deepEqual(h.calls.flows.map((f) => f.flowId), ["policy-watch"], "keep 的不建");
  fs.rmSync(h.tempRoot, { recursive: true, force: true });
});

test("建流程时把板目录传下去，agent 才能 cd 进来", () => {
  const h = harness();
  setupBoard({ board: "b", title: "T", topic: "x", plan: PLAN, dataRoot: h.tempRoot, createdBy: "w" }, h.deps);
  assert.equal(h.calls.flows[0].workspacePath, boardWorkspacePath(h.tempRoot, "b"));
  assert.equal(h.calls.flows[0].board, "b");
  fs.rmSync(h.tempRoot, { recursive: true, force: true });
});

test("板 id 已存在时不覆盖，如实报错", () => {
  const h = harness();
  h.deps.createRadarBoard = () => ({ ok: false, error: "b 已经存在" });
  const result = setupBoard({ board: "b", title: "T", topic: "x", plan: PLAN, dataRoot: h.tempRoot }, h.deps);
  assert.equal(result.ok, false);
  assert.match(result.error, /已经存在/);
  fs.rmSync(h.tempRoot, { recursive: true, force: true });
});
