import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";

import {
  boardCounts,
  decorateRow,
  effectiveCutoff,
  isValidBoardId,
  rowsForActor,
  spareFields,
} from "../bin/lib/radar.mjs";

const NOW = Date.parse("2026-09-11T00:00:00+08:00");

// 日期一律按**当地**解释：toISOString() 是 UTC，东八区的当地零点一转就退到前一天
function localDay(time) {
  const date = new Date(time);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
const TRAINS = [
  { version: "v42.0", cutoff: "2026-09-25" },
  { version: "v43.0", cutoff: "2026-10-25" },
  { version: "v44.0", cutoff: "2026-11-25" },
];

// 用户需求点：政策写 11 月 1 日，可 v43 在 10 月 25 日封包——10 月 25 日才是真正的墙。
// 这一步算错，整块板的排序和提醒阈值就全是错的，所以它不交给写板的流程，统一在这里算。
test("有效截止日取最后一班赶得上的车，不是政策日期", () => {
  const hit = effectiveCutoff("2026-11-01", TRAINS, NOW);
  assert.equal(localDay(hit.at), "2026-10-25");
  assert.equal(hit.train, "v43.0");
  assert.equal(hit.reason, "train");
});

test("正好压在封包日上时，这班车还算赶得上", () => {
  const hit = effectiveCutoff("2026-10-25", TRAINS, NOW);
  assert.equal(hit.train, "v43.0");
  assert.equal(localDay(hit.at), "2026-10-25");
});

// 「赶不上任何一班车」和「压根没有车」要分开讲，否则页面没法解释为什么没有封包标记
test("赶不上任何一班车时退回政策日期，并说明原因", () => {
  const tooSoon = effectiveCutoff("2026-09-15", TRAINS, NOW);
  assert.equal(localDay(tooSoon.at), "2026-09-15");
  assert.equal(tooSoon.train, "");
  assert.equal(tooSoon.reason, "no_train_in_reach");

  const noTrains = effectiveCutoff("2026-11-01", [], NOW);
  assert.equal(localDay(noTrains.at), "2026-11-01");
  assert.equal(noTrains.reason, "no_trains");
});

// 版本车表是有限的。截止日落在已知最后一班之后时，硬挑「我恰好知道的最后一班」会把紧迫度
// 凭空夸大——真实截止在 2027-04，报成 2026-12，差了四个月。老实退回政策日期。
test("截止日超出已知排期时退回政策日期，不硬挑最后一班车", () => {
  const beyond = effectiveCutoff("2027-04-30", TRAINS, NOW);
  assert.equal(localDay(beyond.at), "2027-04-30");
  assert.equal(beyond.train, "");
  assert.equal(beyond.reason, "beyond_known_trains");

  // 正好压在最后一班上仍然算挂得上
  const onLast = effectiveCutoff("2026-11-25", TRAINS, NOW);
  assert.equal(onLast.train, "v44.0");
  assert.equal(onLast.reason, "train");
});

// 没挂上车就没有「封包日」，跑道上不该画一个骗人的标记
test("没挂上车时不给封包标记", () => {
  const caught = decorateRow({ due: "2026-11-01", state: "warn" }, TRAINS, NOW);
  assert.equal(caught.effectiveTrain, "v43.0");
  assert.ok(caught.cutoffDate);

  const beyond = decorateRow({ due: "2027-04-30", state: "warn" }, TRAINS, NOW);
  assert.equal(beyond.cutoffDate, "");
  const noTrains = decorateRow({ due: "2026-11-01", state: "warn" }, [], NOW);
  assert.equal(noTrains.cutoffDate, "");
});

test("已经发过车的班次不算数", () => {
  // v42 在 9-25 封包；把「现在」推到 10-01，它就不该再被选中
  const later = effectiveCutoff("2026-10-20", TRAINS, Date.parse("2026-10-01T00:00:00+08:00"));
  assert.equal(later.train, "");
  assert.equal(later.reason, "no_train_in_reach");
});

test("没有截止日期的行不硬凑一个出来", () => {
  const none = effectiveCutoff("", TRAINS, NOW);
  assert.equal(Number.isFinite(none.at), false);
  assert.equal(none.reason, "no_due");

  const row = decorateRow({ title: "没有终点的事", state: "warn" }, TRAINS, NOW);
  assert.equal(row.effectiveDue, "");
  assert.equal(row.daysLeft, null);
  assert.equal(row.done, false);
});

// 只写日期时按当地 00:00 解释。按 UTC 解释的话东八区会整体偏一天，倒计时天数全错
test("只写日期按当地零点算，不偏一天", () => {
  const row = decorateRow({ due: "2026-11-01", state: "warn" }, [], NOW);
  assert.equal(row.daysLeft, 51);
  assert.equal(localDay(row.effectiveDue), "2026-11-01");
});

// 早先把「墙已经过去」也算进 done，结果是过期未完成的条目被排到最后、变灰，
// 跟已满足待遇一样。它恰恰是最该被看见的那一种
test("过期未完成不是完成，是 overdue，而且排最前", () => {
  const overdue = decorateRow({ due: "2025-11-01", state: "warn" }, TRAINS, NOW);
  assert.equal(overdue.done, false);
  assert.equal(overdue.overdue, true);
  assert.ok(overdue.daysLeft < 0);

  // 真的满足了才算完成，哪怕截止日早就过了
  const satisfied = decorateRow({ due: "2025-11-01", state: "ok" }, TRAINS, NOW);
  assert.equal(satisfied.done, true);
  assert.equal(satisfied.overdue, false);

  const future = decorateRow({ due: "2027-01-01", state: "ok" }, TRAINS, NOW);
  assert.equal(future.done, true);
});

// 人明确说过不用再盯了：不催、不算陈旧，但**不是删除**——政策改期还要能重新亮起来
test("封存的条目沉下去但留着，也不再被算成待办", () => {
  const settled = decorateRow({ due: "2026-11-01", state: "warn", settled: true }, TRAINS, NOW);
  assert.equal(settled.settled, true);
  assert.equal(boardCounts([settled]).pending, 0);
  assert.equal(boardCounts([settled]).settled, 1);
  assert.equal(boardCounts([settled]).total, 1);
});

// 分片新鲜 ≠ 条目新鲜：流程还在跑，但某个条目已经不在它的输出里了。
// 「从输出里消失」不等于「这条没了」，等于「没人再更新它了」
test("条目级陈旧：分片还在更新，这一条却没再被写过", () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const fresh = decorateRow(
    { due: "2026-11-01", state: "warn", lastSeenAt: new Date(now - day).toISOString() },
    TRAINS, now, { staleAfterMs: 3 * day },
  );
  assert.equal(fresh.staleItem, false);

  const gone = decorateRow(
    { due: "2026-11-01", state: "warn", lastSeenAt: new Date(now - 9 * day).toISOString() },
    TRAINS, now, { staleAfterMs: 3 * day },
  );
  assert.equal(gone.staleItem, true);

  // 封存过的本来就不指望它更新，不该被算成陈旧
  const settled = decorateRow(
    { due: "2026-11-01", state: "warn", settled: true, lastSeenAt: new Date(now - 9 * day).toISOString() },
    TRAINS, now, { staleAfterMs: 3 * day },
  );
  assert.equal(settled.staleItem, false);
});

test("状态取值收敛：认不出来的当待确认，不当成已满足", () => {
  for (const bad of ["", "done", "完成", null, undefined, 42]) {
    assert.equal(decorateRow({ state: bad }, [], NOW).state, "idle", `state=${String(bad)}`);
  }
});

// 无人认领是最危险的状态。把它藏在「全部」里，就等于没人会看见它
test("「我的」视角带上无人认领的行", () => {
  const rows = [
    { title: "我的", owner: "wangfang1" },
    { title: "别人的", owner: "hesiqi" },
    { title: "没人管的", owner: "" },
  ];
  const mine = rowsForActor(rows, { scope: "mine", username: "wangfang1" });
  assert.deepEqual(mine.map((row) => row.title), ["我的", "没人管的"]);
  assert.equal(rowsForActor(rows, { scope: "all", username: "wangfang1" }).length, 3);
});

test("角标只数要人管的：已满足和已封存的不催人点进去", () => {
  const counts = boardCounts([
    { state: "risk", done: false },
    { state: "warn", done: false },
    { state: "warn", done: false },
    { state: "ok", done: true },
    // 过期未完成**仍然要人管**，它比没过期的更该数进去
    { state: "warn", done: false, overdue: true },
    // 封存的不数
    { state: "warn", done: false, settled: true },
  ]);
  assert.equal(counts.risk, 1);
  assert.equal(counts.warn, 3);
  assert.equal(counts.ok, 1);
  assert.equal(counts.overdue, 1);
  assert.equal(counts.settled, 1);
  assert.equal(counts.pending, 4);
  assert.equal(counts.total, 6);
});

// 编排面板要列出「还没上主图的字段」，所以已经被通道用掉的和算出来的都得排除
test("剩余字段排除已占用的通道和算出来的字段", () => {
  const rows = [{
    title: "t", state: "warn", owner: "me", platform: "Android",
    due: "2026-11-01", effectiveDue: "x", daysLeft: 1, done: false,
    current: "targetSdk 35", evidence: [], source: {},
  }];
  const spare = spareFields(rows, {
    lane: "title", end: "effectiveDue", color: "state",
    value: "daysLeft", group: "platform", badges: ["owner"],
  });
  assert.deepEqual(spare, ["current", "due", "evidence", "source"]);
});

test("通道写成对象形式时也认得出用了哪个字段", () => {
  const spare = spareFields(
    [{ title: "t", state: "warn", owner: "me" }],
    { lane: "title", color: { field: "state", scale: "status" }, badges: [] },
  );
  assert.deepEqual(spare, ["owner"]);
});

// board id 直接拼进文件名
test("board id 挡住路径穿越", () => {
  for (const bad of ["../etc", "a/b", "", ".hidden", "a".repeat(65), "x..y"]) {
    assert.equal(isValidBoardId(bad), false, `${bad} 不该通过`);
  }
  for (const good of ["compliance", "cert-expiry", "a.b_c-1"]) {
    assert.equal(isValidBoardId(good), true, `${good} 应该通过`);
  }
});

async function withRadarHome(run) {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-radar-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  try {
    await run(await import(`../bin/lib/radar.mjs?radar-io=${crypto.randomUUID()}`), tempRoot);
  } finally {
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test("读写一块板：算出来的字段落在读的那一侧，不落盘", async () => {
  await withRadarHome(async (radar, tempRoot) => {
    radar.writeRadarBoardMeta("compliance", { title: "发版合规", trains: TRAINS });
    const written = radar.writeRadarShard("compliance", "play-policy-watch", {
      flow: { flowSource: "user", scheduleNodeId: "daily" },
      fetchFailures: 0,
      spec: { view: "runway", encode: { lane: "title", end: "effectiveDue", color: "state", badges: ["owner"] } },
      rows: [
        { id: "a", title: "目标 API 36", owner: "xingqiwei", due: "2026-11-01", state: "warn", platform: "Android" },
        { id: "b", title: "边到边", owner: "", due: "2026-11-01", state: "risk", platform: "Android" },
        { id: "c", title: "隐私清单", owner: "linguanhong", due: "2026-06-30", state: "ok", platform: "iOS" },
      ],
    });
    assert.equal(written.ok, true);
    // 落盘的是原始事实，推导出来的字段不写进文件——否则它会随时间变陈旧
    const raw = JSON.parse(fs.readFileSync(written.path, "utf-8"));
    assert.equal(raw.rows[0].effectiveDue, undefined);
    assert.equal(raw.rows[0].daysLeft, undefined);
    assert.ok(written.path.includes(path.join("boards", "compliance")));

    const board = radar.readRadarBoard("compliance", { scope: "mine", username: "xingqiwei", now: NOW });
    assert.equal(board.totalRows, 3);
    assert.deepEqual(board.rows.map((row) => row.id), ["b", "a"]);
    assert.equal(board.rows[0].effectiveTrain, "v43.0");
    assert.equal(board.rows[0].daysLeft, 44);
    assert.equal(board.counts.pending, 2);
    assert.ok(board.spareFields.includes("platform"));

    const all = radar.readRadarBoard("compliance", { scope: "all", now: NOW });
    assert.equal(all.rows[all.rows.length - 1].id, "c");

    const boards = radar.listRadarBoards({ scope: "all", now: NOW });
    assert.equal(boards.length, 1);
    assert.equal(boards[0].worst, "risk");
    assert.equal(boards[0].soonestDays, 44);

    assert.equal(radar.readRadarBoard("missing-board", {}), null);
    assert.deepEqual(radar.readRadarEvents("compliance"), []);

    radar.appendRadarEvent("compliance", { kind: "moved", item: "a", text: "宽限期推到 11 月 1 日" });
    radar.appendRadarEvent("compliance", { kind: "better", item: "a", text: "targetSdk 34 → 35" });
    const events = radar.readRadarEvents("compliance");
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, "better");
    assert.ok(events[0].at);
  });
});

// 这是选 B 的全部理由：整份覆盖时，后跑的流程会把先跑的条目静默抹掉，而且一点报错都没有
test("两条流程喂同一块板，各写各的片，互不覆盖", async () => {
  await withRadarHome(async (radar) => {
    radar.writeRadarBoardMeta("compliance", { title: "发版合规", trains: TRAINS });
    radar.writeRadarShard("compliance", "play-policy-watch", {
      rows: [{ id: "a", title: "目标 API 36", owner: "xingqiwei", due: "2026-11-01", state: "warn" }],
    });
    radar.writeRadarShard("compliance", "appstore-policy-watch", {
      rows: [{ id: "x", title: "隐私清单", owner: "linguanhong", due: "2026-11-20", state: "risk" }],
    });

    const board = radar.readRadarBoard("compliance", { scope: "all", now: NOW });
    assert.deepEqual(board.rows.map((row) => row.id).sort(), ["a", "x"]);
    // 每行记得自己是哪条流程写的：抽屉里要能追回源头
    assert.equal(board.rows.find((row) => row.id === "a").flowId, "play-policy-watch");
    assert.deepEqual(board.flows.map((flow) => flow.flowId), ["appstore-policy-watch", "play-policy-watch"]);
    assert.equal(board.conflicts.length, 0);
  });
});

// 一片多久没更新 = 那条流程是不是哑了。整份覆盖看不出这件事：哑掉和「这次没条目」长得一样
test("某条流程哑了要能看出来，而不是悄悄少了几条", async () => {
  await withRadarHome(async (radar) => {
    const now = Date.now();
    radar.writeRadarShard("compliance", "fresh-flow", {
      rows: [{ id: "a", due: "2026-11-01", state: "warn" }],
      updatedAt: new Date(now - 60 * 60 * 1000).toISOString(),
    });
    radar.writeRadarShard("compliance", "dead-flow", {
      rows: [{ id: "b", due: "2026-11-01", state: "warn" }],
      updatedAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const board = radar.readRadarBoard("compliance", { scope: "all", now });
    assert.deepEqual(board.staleFlows, ["dead-flow"]);
    // 哑掉的那片数据还在，只是被标出来了——直接丢掉等于帮着掩盖问题
    assert.equal(board.rows.length, 2);
    assert.equal(radar.listRadarBoards({ scope: "all", now })[0].staleFlows, 1);

    // 流程自己知道 cron，可以放宽判定：每周跑一次的不该 36 小时就被说成哑了
    radar.writeRadarShard("compliance", "weekly-flow", {
      rows: [{ id: "c", due: "2026-11-01", state: "warn" }],
      updatedAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
      staleAfterMs: 14 * 24 * 60 * 60 * 1000,
    });
    assert.deepEqual(
      radar.readRadarBoard("compliance", { scope: "all", now }).staleFlows,
      ["dead-flow"],
    );
  });
});

// 两条流程都声称负责同一条，是配置错了。静默挑一个，是让人不再相信这块板的最快方式
test("同一条目被两片认领时取较新的那份，并把冲突记下来", async () => {
  await withRadarHome(async (radar) => {
    const now = Date.now();
    radar.writeRadarShard("compliance", "old-flow", {
      rows: [{ id: "dup", title: "旧的说法", due: "2026-11-01", state: "ok" }],
      updatedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
    });
    radar.writeRadarShard("compliance", "new-flow", {
      rows: [{ id: "dup", title: "新的说法", due: "2026-11-01", state: "risk" }],
      updatedAt: new Date(now - 60 * 1000).toISOString(),
    });

    const board = radar.readRadarBoard("compliance", { scope: "all", now });
    assert.equal(board.rows.length, 1);
    assert.equal(board.rows[0].title, "新的说法");
    assert.deepEqual(board.conflicts, [{ id: "dup", flows: ["new-flow", "old-flow"] }]);
  });
});

test("没写板级元信息时，spec 和版本车从流程分片里取", async () => {
  await withRadarHome(async (radar) => {
    radar.writeRadarShard("solo", "only-flow", {
      trains: TRAINS,
      spec: { view: "table", views: ["table"], encode: { lane: "title" } },
      rows: [{ id: "a", title: "一条", due: "2026-11-01", state: "warn" }],
    });
    const board = radar.readRadarBoard("solo", { scope: "all", now: NOW });
    assert.equal(board.title, "solo");
    assert.equal(board.spec.view, "table");
    assert.equal(board.rows[0].effectiveTrain, "v43.0");
  });
});

test("抓取失败数是各片相加，不是某一片的", async () => {
  await withRadarHome(async (radar) => {
    radar.writeRadarShard("compliance", "a-flow", { fetchFailures: 2, rows: [] });
    radar.writeRadarShard("compliance", "b-flow", { fetchFailures: 3, rows: [] });
    assert.equal(radar.readRadarBoard("compliance", { scope: "all" }).fetchFailures, 5);
    assert.equal(radar.listRadarBoards({ scope: "all" })[0].fetchFailures, 5);
  });
});

test("flowId 也挡住路径穿越", async () => {
  await withRadarHome(async (radar) => {
    assert.equal(radar.writeRadarShard("compliance", "../evil", { rows: [] }).ok, false);
    assert.equal(radar.writeRadarShard("../evil", "flow", { rows: [] }).ok, false);
  });
});
