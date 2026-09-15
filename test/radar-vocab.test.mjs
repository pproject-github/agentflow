/**
 * 大组和标签是两套词典。
 *
 * 这块之前没有任何约束，结果是：建板的 AI 把三个大组 key 同时写进了 tags，
 * 于是每条流程都没法判断该写 `theme` 还是 `tags`——两个都写。板上每个子行
 * 都把父行的大组又抄了一遍，而那份副本在政策改挂大组的那天开始撒谎。
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

const SPEC = {
  themes: [{ key: "android16", label: "Android 16 适配" }, { key: "aep", label: "账号与权限" }],
  tags: ["native", "manifest", "console"],
};

test("标签词典减掉大组 key——两套词典按定义不相交", () => withTrackHome(({ radar }) => {
  radar.createRadarBoard("gp", { title: "词典", spec: { ...SPEC, tags: [...SPEC.tags, "android16", "aep"] } });
  const spec = radar.readRadarBoard("gp")?.spec;
  assert.deepEqual(spec.tags, ["native", "manifest", "console"]);
  const themeKeys = spec.themes.map((item) => item.key);
  assert.equal(spec.tags.filter((tag) => themeKeys.includes(tag)).length, 0);
}));

test("归一发生在写这一侧：_board.json 里躺着的就是不相交的那份", () => withTrackHome(({ radar, tempRoot }) => {
  radar.createRadarBoard("gp", { title: "词典" });
  radar.writeRadarBoardMeta("gp", { title: "词典", spec: { ...SPEC, tags: ["native", "android16"] } });
  const raw = JSON.parse(fs.readFileSync(path.join(tempRoot, "data", "radar", "boards", "gp", "_board.json"), "utf-8"));
  assert.deepEqual(raw.spec.tags, ["native"], "文件里不该留着一份自相矛盾的词典");
}));

test("子行不准自己写 theme——归属顺着 parent 推得出来", () => withTrackHome(({ radar }) => {
  const bad = radar.vocabViolations(
    [{ id: "p", theme: "android16" }, { id: "p@likee", parent: "p", theme: "android16" }],
    SPEC,
  );
  assert.equal(bad.length, 1);
  assert.match(bad[0], /p@likee/);
  assert.match(bad[0], /子行不要写 theme/);
}));

test("大组当标签用，报的是「这是大组」而不是「词典里没有」", () => withTrackHome(({ radar }) => {
  const bad = radar.vocabViolations([{ id: "p@likee", parent: "p", tags: ["android16"] }], SPEC);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /是大组，不是标签/);
}));

test("词典里没有的标签照样拦，不静默留下", () => withTrackHome(({ radar }) => {
  const bad = radar.vocabViolations([{ id: "x", tags: ["native", "自造的"] }], SPEC);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /不在板的标签词典里/);
}));

test("板没申明过词典就不校验——空词典是「还没定规矩」，不是「什么都不许写」", () => withTrackHome(({ radar }) => {
  assert.deepEqual(radar.vocabViolations([{ id: "x", tags: ["随便什么"], theme: "随便" }], {}), []);
}));

test("树顶写 theme 合法，取值不在大组里则拦", () => withTrackHome(({ radar }) => {
  assert.deepEqual(radar.vocabViolations([{ id: "p", theme: "aep" }], SPEC), []);
  const bad = radar.vocabViolations([{ id: "p", theme: "nope" }], SPEC);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /不在板的大组里/);
}));

test("大组顺着 parent 往下淌，深度不限，并记下是从哪继承的", () => withTrackHome(({ radar }) => {
  radar.createRadarBoard("gp", { title: "继承", spec: SPEC });
  radar.writeRadarShard("gp", "watch", { rows: [{ id: "req", title: "一条政策", theme: "android16" }] });
  radar.writeRadarShard("gp", "likee", {
    rows: [
      { id: "req@likee", title: "Likee 的结论", parent: "req", kind: "verdict", tags: ["native"] },
      { id: "req@likee-1", title: "要做的事", parent: "req@likee", kind: "task", tags: ["native"] },
    ],
  });
  const byId = new Map(radar.readRadarBoard("gp", { scope: "all" }).rows.map((row) => [row.id, row]));
  assert.equal(byId.get("req@likee").theme, "android16");
  assert.equal(byId.get("req@likee").themeFrom, "req");
  assert.equal(byId.get("req@likee-1").theme, "android16", "隔一层也要继承到");
  assert.equal(byId.get("req@likee-1").themeFrom, "req");
  assert.equal(byId.get("req").themeFrom, undefined, "树顶是自己写的，不是继承的");
}));

test("父子成环时继承不死循环", () => withTrackHome(({ radar }) => {
  radar.createRadarBoard("gp", { title: "环", spec: SPEC });
  radar.writeRadarShard("gp", "f", {
    rows: [{ id: "a", title: "a", parent: "b" }, { id: "b", title: "b", parent: "a" }],
  });
  const rows = radar.readRadarBoard("gp", { scope: "all" }).rows;
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.theme, undefined);
}));

test("commit 整次拒收：一条行说错词，其余合法的也不写进去", () => withTrackHome(({ cli, radar }) => {
  radar.createRadarBoard("gp", { title: "契约", spec: SPEC });
  radar.writeRadarShard("gp", "watch", { rows: [{ id: "req", title: "一条政策", theme: "android16" }] });
  assert.throws(
    () => cli.commitTrack({
      board: "gp",
      flowId: "likee",
      owns: ["*@likee"],
      rows: [
        { id: "ok@likee", title: "合法的一条", parent: "req", kind: "verdict", tags: ["native"] },
        { id: "bad@likee", title: "把大组当标签", parent: "req", kind: "verdict", tags: ["android16"] },
      ],
    }),
    /是大组，不是标签/,
  );
  assert.equal(radar.readRadarShard("gp", "likee"), null, "整次拒收，合法的那条也不该落盘");
}));
