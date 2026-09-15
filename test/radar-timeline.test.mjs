/**
 * 单条目的经过。
 *
 * 事件不是流程上报的，是 `diffRows()` 推导出来的，所以它天然按 id 分好了组——
 * 缺的一直只是「按 id 读」这一层。而这一层唯一会做错的地方就是过滤和截断的先后。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 每个用例一个临时数据根。
 *
 * 数据根在模块加载时就定了，所以必须先改 `AGENTFLOW_HOME` 再带 nonce 重新 import——
 * 直接 import 的话模块已经被缓存，板会落到**真实**数据目录里去。
 */
async function withTrackHome(run) {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-vocab-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  try {
    const nonce = crypto.randomUUID();
    const [cli, radar] = await Promise.all([
      import(`../bin/lib/radar-cli.mjs?vocab=${nonce}`),
      import(`../bin/lib/radar.mjs?vocab=${nonce}`),
    ]);
    await run({ cli, radar, tempRoot });
  } finally {
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

/**
 * 单条目的经过：过滤必须在截断**之前**。
 *
 * 原来的 readRadarEvents 是先 `slice(-limit)` 再解析。套上 id 过滤如果沿用那个顺序，
 * 就变成「在最近 N 行里找这一条」——一条三个月没动过的条目会显示「没有经过」，
 * 而它明明有。这是这个功能唯一会做错、而且做错了不会报错的地方。
 */
test("安静的条目：五百条噪音之后仍读得到它自己的经过", () => withTrackHome(({ radar }) => {
  radar.createRadarBoard("gp", { title: "经过" });
  radar.appendRadarEvent("gp", { kind: "added", id: "quiet", title: "很久没动的一条", state: "warn" });
  radar.appendRadarEvent("gp", { kind: "state", id: "quiet", from: "warn", to: "risk" });
  for (let i = 0; i < 500; i += 1) {
    radar.appendRadarEvent("gp", { kind: "state", id: `noise-${i}`, from: "idle", to: "warn" });
  }
  const mine = radar.readRadarEvents("gp", { id: "quiet" });
  assert.equal(mine.length, 2, "被五百条噪音挤出窗口就说明过滤放在截断之后了");
  assert.equal(mine[0].kind, "state", "从新到旧");
  assert.equal(mine[1].kind, "added");
  assert.ok(mine.every((event) => event.id === "quiet"));
}));

test("limit 的语义是「这个 id 返回多少条」，不是「读多少行」", () => withTrackHome(({ radar }) => {
  radar.createRadarBoard("gp", { title: "经过" });
  for (let i = 0; i < 20; i += 1) {
    radar.appendRadarEvent("gp", { kind: "state", id: "x", from: "idle", to: "warn" });
    radar.appendRadarEvent("gp", { kind: "state", id: "y", from: "idle", to: "warn" });
  }
  assert.equal(radar.readRadarEvents("gp", { id: "x", limit: 5 }).length, 5);
  assert.equal(radar.readRadarEvents("gp", { id: "x" }).length, 20);
}));

test("不传 id 时行为不变：整块板、从新到旧", () => withTrackHome(({ radar }) => {
  radar.createRadarBoard("gp", { title: "经过" });
  radar.appendRadarEvent("gp", { kind: "added", id: "a", title: "第一条" });
  radar.appendRadarEvent("gp", { kind: "added", id: "b", title: "第二条" });
  const all = radar.readRadarEvents("gp");
  assert.deepEqual(all.map((event) => event.id), ["b", "a"]);
}));

test("坏掉的一行不该让整条经过消失", () => withTrackHome(({ radar, tempRoot }) => {
  radar.createRadarBoard("gp", { title: "经过" });
  radar.appendRadarEvent("gp", { kind: "added", id: "a", title: "好的" });
  fs.appendFileSync(path.join(tempRoot, "data", "radar", "events", "gp.jsonl"), "{坏掉的\n");
  radar.appendRadarEvent("gp", { kind: "state", id: "a", from: "idle", to: "ok" });
  assert.equal(radar.readRadarEvents("gp", { id: "a" }).length, 2);
}));
