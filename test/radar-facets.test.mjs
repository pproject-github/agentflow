import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 分面（一条政策 × 每个 app 一条子行）和 owns 契约。
 *
 * 这两件事必须一起测：分面把「多条流程写同一块板」从例外变成常态，而 owns 是让它
 * 不至于互相覆盖的唯一约束。分开测的话，很容易做出一个「分面能显示、但谁都能写谁」
 * 的版本——那正是加分面之前板上会红一片的原因。
 */
async function withTrackHome(run) {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-facet-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  try {
    const nonce = crypto.randomUUID();
    const [cli, radar] = await Promise.all([
      import(`../bin/lib/radar-cli.mjs?facet=${nonce}`),
      import(`../bin/lib/radar.mjs?facet=${nonce}`),
    ]);
    await run({ cli, radar, tempRoot });
  } finally {
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

/** 一块建好的板 + 政策片 + 两个 app 的分面片 */
function seed({ cli, radar }) {
  radar.createRadarBoard("gp", { title: "政策雷达" });
  cli.commitTrack({
    board: "gp",
    flowId: "policy-watch",
    owns: ["pol-*"],
    rows: [{ id: "pol-16kb", title: "16KB 对齐", due: "2027-01-31", state: "idle" }],
  });
  cli.commitTrack({
    board: "gp",
    flowId: "likee",
    owns: ["*@likee"],
    covers: ["pol-*"],
    rows: [{
      id: "pol-16kb@likee", parent: "pol-16kb", app: "likee",
      title: "Likee 16KB", state: "risk", due: "2026-12-03", train: "v4.94",
    }],
  });
  cli.commitTrack({
    board: "gp",
    flowId: "bigolive",
    owns: ["*@bigolive"],
    covers: ["pol-*"],
    rows: [{
      id: "pol-16kb@bigolive", parent: "pol-16kb", app: "bigolive",
      title: "BigoLive 16KB", state: "warn", due: "2026-10-15", train: "v6.31",
    }],
  });
}

const NOW = Date.parse("2026-09-14T00:00:00");

test("owns 是契约不是提示词：越界的条目整次拒收，一条都不写", async () => {
  await withTrackHome(({ cli, radar }) => {
    seed({ cli, radar });
    const before = radar.readRadarShard("gp", "likee");

    assert.throws(
      () => cli.commitTrack({
        board: "gp",
        flowId: "likee",
        rows: [
          { id: "pol-16kb@likee", title: "本来就是我的", state: "ok" },
          { id: "pol-16kb@bigolive", title: "抢别人的", state: "ok" },
        ],
      }),
      /越界/,
    );

    // 「整次拒收」不是说法：合法的那一条也不能落地，否则一次越界会留下半份写入
    const after = radar.readRadarShard("gp", "likee");
    assert.deepEqual(after.rows.map((row) => row.state), before.rows.map((row) => row.state));
  });
});

test("owns 不传时沿用上一片声明的，忘带参数不会把契约悄悄卸掉", async () => {
  await withTrackHome(({ cli, radar }) => {
    seed({ cli, radar });
    cli.commitTrack({
      board: "gp",
      flowId: "likee",
      rows: [{ id: "pol-16kb@likee", parent: "pol-16kb", app: "likee", title: "Likee 16KB", state: "warn" }],
    });
    assert.deepEqual(radar.readRadarShard("gp", "likee").owns, ["*@likee"]);
    assert.throws(
      () => cli.commitTrack({ board: "gp", flowId: "likee", rows: [{ id: "pol-16kb", title: "越界", state: "ok" }] }),
      /越界/,
    );
  });
});

test("没声明 owns 的老分片不受限制", async () => {
  await withTrackHome(({ cli, radar }) => {
    radar.createRadarBoard("legacy", { title: "老板子" });
    const done = cli.commitTrack({
      board: "legacy",
      flowId: "whatever",
      rows: [{ id: "a", title: "A" }, { id: "b@x", title: "B" }],
    });
    assert.equal(done.rows, 2);
    assert.deepEqual(done.owns, []);
  });
});

test("父行由子行推：状态取最差，截止日取最早，原政策日留在 policyDue", async () => {
  await withTrackHome(({ cli, radar }) => {
    seed({ cli, radar });
    const board = radar.readRadarBoard("gp", { scope: "all", now: NOW });
    const parent = board.rows.find((row) => row.id === "pol-16kb");

    assert.equal(parent.state, "risk", "Likee 是 risk，父行不该显示成 warn");
    assert.equal(parent.rolledUp, true);
    assert.deepEqual(parent.children.sort(), ["pol-16kb@bigolive", "pol-16kb@likee"]);
    assert.equal(String(parent.policyDue).slice(0, 4), "2027", "政策截止日要留着给跑道画虚线");
    // 最早的那班车是 BigoLive 的 10-15，父行的紧迫度就该是它——
    // 按政策日 2027-01-31 画的话，条会比最紧的子行长一倍，读成「还早」
    assert.equal(parent.daysLeft, 31);
  });
});

test("缺席由分片的 covers 反推：声明替这条父项作答，却一条子项都没写", async () => {
  await withTrackHome(({ cli, radar }) => {
    seed({ cli, radar });
    // 第三条流程声明它也负责 pol-*，但一条都没写——这正是「没人查过」
    cli.commitTrack({
      board: "gp",
      flowId: "imo",
      owns: ["*@imo"],
      covers: ["pol-*"],
      rows: [{ id: "unrelated@imo", title: "跟 pol- 无关的一条", state: "idle" }],
    });
    const board = radar.readRadarBoard("gp", { scope: "all", now: NOW });
    const parent = board.rows.find((row) => row.id === "pol-16kb");
    assert.deepEqual(parent.missingFacets, ["imo"], "likee 和 bigolive 都写了，只有 imo 缺席");
    // 板上不该有任何业务维度的声明——缺席完全从分片契约推出来
    assert.equal(board.apps, undefined);
  });
});

test("没有分片声明 covers 时不报缺席：没人认领 ≠ 缺席", async () => {
  await withTrackHome(({ cli, radar }) => {
    radar.createRadarBoard("q", { title: "无契约" });
    cli.commitTrack({ board: "q", flowId: "a", rows: [{ id: "p1", title: "父" }] });
    cli.commitTrack({ board: "q", flowId: "b", rows: [{ id: "p1@x", parent: "p1", title: "子" }] });
    const board = radar.readRadarBoard("q", { scope: "all", now: NOW });
    assert.equal(board.rows.find((row) => row.id === "p1").missingFacets, undefined);
  });
});

test("孤儿分面：parent 指向不存在的条目时标出来，不静默挂在根上", async () => {
  await withTrackHome(({ cli, radar }) => {
    seed({ cli, radar });
    cli.commitTrack({
      board: "gp",
      flowId: "likee",
      owns: ["*@likee"],
      rows: [{ id: "pol-typo@likee", parent: "pol-typo", app: "likee", title: "拼错了的 parent", state: "warn" }],
    });
    const board = radar.readRadarBoard("gp", { scope: "all", now: NOW });
    const orphan = board.rows.find((row) => row.id === "pol-typo@likee");
    assert.equal(orphan.orphan, true);
  });
});

test("版本车按分片限定：别的流程的封包日不该算进这一片的条目", async () => {
  await withTrackHome(({ cli, radar }) => {
    radar.createRadarBoard("t", {
      title: "车",
      trains: [
        { version: "v4.94", cutoff: "2026-12-03", scope: "likee" },
        { version: "v6.31", cutoff: "2026-10-15", scope: "bigolive" },
        { version: "hotfix", cutoff: "2026-11-01" },
      ],
    });
    cli.commitTrack({ board: "t", flowId: "likee", rows: [{ id: "a@likee", title: "L", due: "2026-12-03", state: "warn" }] });
    cli.commitTrack({ board: "t", flowId: "bigolive", rows: [{ id: "a@bigolive", title: "B", due: "2026-12-03", state: "warn" }] });

    const board = radar.readRadarBoard("t", { scope: "all", now: NOW });
    const likeeRow = board.rows.find((row) => row.id === "a@likee");
    const bigoRow = board.rows.find((row) => row.id === "a@bigolive");
    // likee 那一片的车表排到 12-03，正好有一班赶得上
    assert.equal(likeeRow.effectiveTrain, "v4.94");
    assert.equal(likeeRow.effectiveReason, "train");
    // bigolive 那一片看得见的只有自己的 v6.31（10-15）和通用的 hotfix（11-01），
    // 都排不到 12-03——老实退回原截止日，而不是把别人那班车算成自己的
    assert.equal(bigoRow.effectiveTrain, "");
    assert.equal(bigoRow.effectiveReason, "beyond_known_trains");
  });
});

test("一条父项可以拆出多条子任务：子流程自己决定怎么梳理", async () => {
  await withTrackHome(({ cli, radar }) => {
    seed({ cli, radar });
    cli.commitTrack({
      board: "gp",
      flowId: "likee",
      owns: ["*@likee"],
      covers: ["pol-*"],
      rows: [
        { id: "pol-16kb-ndk@likee", parent: "pol-16kb", title: "升 NDK 到 r28", state: "risk", due: "2026-11-01" },
        { id: "pol-16kb-deps@likee", parent: "pol-16kb", title: "切 EffectOne 依赖", state: "warn", due: "2026-12-03" },
        { id: "pol-16kb-regress@likee", parent: "pol-16kb", title: "全量 .so 回归", state: "idle", due: "2026-12-20" },
      ],
    });
    const board = radar.readRadarBoard("gp", { scope: "all", now: NOW });
    const parent = board.rows.find((row) => row.id === "pol-16kb");
    // 三条 likee 子任务 + bigolive 那条，父行照样汇总
    assert.equal(parent.children.length, 4);
    assert.equal(parent.state, "risk", "最差的那条是 risk");
    // 最早的截止日来自 bigolive 的 10-15，不是 likee 最早那条 11-01
    assert.equal(parent.daysLeft, 31);
    assert.equal(parent.missingFacets, undefined, "两片都写了，没有缺席");
  });
});

test("三条流程各写各的片，板上没有冲突", async () => {
  await withTrackHome(({ cli, radar }) => {
    seed({ cli, radar });
    const board = radar.readRadarBoard("gp", { scope: "all", now: NOW });
    assert.deepEqual(board.conflicts, []);
    assert.equal(board.flows.length, 3);
    const likee = board.flows.find((flow) => flow.flowId === "likee");
    assert.deepEqual(likee.declaredOwns, ["*@likee"]);
  });
});

test("track trains 只换这一片的车，别的片和通用车留着", async () => {
  await withTrackHome(async ({ cli, radar, tempRoot }) => {
    radar.createRadarBoard("t", {
      title: "车",
      trains: [
        { version: "v6.31", cutoff: "2026-10-15", scope: "bigolive" },
        { version: "hotfix", cutoff: "2026-11-01" },
        { version: "v4.90", cutoff: "2026-09-20", scope: "likee" },
      ],
    });
    const file = path.join(tempRoot, "trains.json");
    fs.writeFileSync(file, JSON.stringify([{ version: "v4.94", cutoff: "2026-12-03" }]), "utf-8");
    await cli.runTrackCommand(["trains", "--board=t", "--scope=likee", `--file=${file}`]);

    const board = radar.readRadarBoard("t", { scope: "all", now: NOW });
    const versions = board.trains.map((train) => train.version).sort();
    assert.deepEqual(versions, ["hotfix", "v4.94", "v6.31"], "只有 likee 那一片的车被换掉");
    assert.equal(board.trains.find((train) => train.version === "v4.94").scope, "likee");
  });
});

test("track trains 拒收日期不合法的班次，一班都不写", async () => {
  await withTrackHome(async ({ cli, radar, tempRoot }) => {
    radar.createRadarBoard("t", { title: "车", trains: [{ version: "old", cutoff: "2026-10-01", scope: "likee" }] });
    const file = path.join(tempRoot, "bad.json");
    fs.writeFileSync(file, JSON.stringify([{ version: "v1", cutoff: "下周" }]), "utf-8");
    await assert.rejects(
      () => cli.runTrackCommand(["trains", "--board=t", "--scope=likee", `--file=${file}`]),
      /cutoff 不是日期/,
    );
    const board = radar.readRadarBoard("t", { scope: "all", now: NOW });
    assert.deepEqual(board.trains.map((train) => train.version), ["old"]);
  });
});

test("tag 归一：逗号串和数组都收，空值和重复不进", async () => {
  await withTrackHome(({ radar }) => {
    assert.deepEqual(radar.normalizeTags("aep, android16 ，  aep "), ["aep", "android16"]);
    assert.deepEqual(radar.normalizeTags(["aep", "", "aep", " x "]), ["aep", "x"]);
    assert.deepEqual(radar.normalizeTags(undefined), []);
  });
});

test("tag 是并集：流程发现的和人贴的都算，人删掉的记进 tagsRemoved", async () => {
  await withTrackHome(({ cli, radar }) => {
    seed({ cli, radar });
    cli.commitTrack({
      board: "gp",
      flowId: "likee",
      owns: ["*@likee"],
      covers: ["pol-*"],
      rows: [{
        id: "pol-16kb@likee", parent: "pol-16kb", app: "likee",
        title: "Likee 16KB", state: "risk", tags: "android16, native",
      }],
    });
    radar.setRadarItemOverride("gp", "pol-16kb@likee", { addTags: ["aep"], by: "wangfang1" });
    let row = radar.readRadarBoard("gp", { scope: "all", now: NOW }).rows.find((x) => x.id === "pol-16kb@likee");
    assert.deepEqual(row.tags.sort(), ["aep", "android16", "native"]);
    // 贴标签不算「和扫描结果矛盾」——只有人改了状态才算
    assert.equal(row.overrideConflict, false);

    // 人删掉流程加的那个：要记下来，否则下一轮流程又写回来
    radar.setRadarItemOverride("gp", "pol-16kb@likee", { removeTags: ["native"], by: "wangfang1" });
    cli.commitTrack({
      board: "gp",
      flowId: "likee",
      owns: ["*@likee"],
      covers: ["pol-*"],
      rows: [{
        id: "pol-16kb@likee", parent: "pol-16kb", app: "likee",
        title: "Likee 16KB", state: "risk", tags: ["android16", "native"],
      }],
    });
    row = radar.readRadarBoard("gp", { scope: "all", now: NOW }).rows.find((x) => x.id === "pol-16kb@likee");
    assert.deepEqual(row.tags.sort(), ["aep", "android16"], "流程重写之后，人删掉的那个不该复活");
    assert.deepEqual(row.override.tagsRemoved, ["native"]);
  });
});

test("owner 只有人写：流程重写整片也冲不掉认领", async () => {
  await withTrackHome(({ cli, radar }) => {
    seed({ cli, radar });
    radar.setRadarItemOverride("gp", "pol-16kb@likee", { owner: "wangfang1", by: "wangfang1" });
    cli.commitTrack({
      board: "gp",
      flowId: "likee",
      owns: ["*@likee"],
      covers: ["pol-*"],
      rows: [{ id: "pol-16kb@likee", parent: "pol-16kb", app: "likee", title: "Likee 16KB", state: "warn" }],
    });
    const row = radar.readRadarBoard("gp", { scope: "all", now: NOW }).rows.find((x) => x.id === "pol-16kb@likee");
    assert.equal(row.owner, "wangfang1");
    assert.equal(row.state, "warn", "状态照样跟着流程走");
  });
});

test("取消认领是一次明确的「没人」，要盖住流程写的 owner", async () => {
  await withTrackHome(({ cli, radar }) => {
    radar.createRadarBoard("o", { title: "认领" });
    // 流程自己写了 owner（规划出来的条目常带），人要能把它清掉
    cli.commitTrack({ board: "o", flowId: "f", rows: [{ id: "a", title: "A", owner: "someone" }] });
    assert.equal(radar.readRadarBoard("o", { scope: "all", now: NOW }).rows[0].owner, "someone");

    radar.setRadarItemOverride("o", "a", { owner: "", by: "me" });
    const row = radar.readRadarBoard("o", { scope: "all", now: NOW }).rows[0];
    assert.equal(row.owner, "", "空 owner 是一次明确的判断，不能退回流程写的值");
    assert.equal(row.override.owner, "");
  });
});

test("只贴又只撤，覆盖层整条消失，不留一条只有记账字段的空壳", async () => {
  await withTrackHome(({ cli, radar }) => {
    seed({ cli, radar });
    radar.setRadarItemOverride("gp", "pol-16kb", { addTags: ["aep"], by: "me" });
    radar.setRadarItemOverride("gp", "pol-16kb", { removeTags: ["aep"], by: "me" });
    // 撤掉的标签本来就不是流程给的，tagsRemoved 里留着它没有意义——但留着也无害，
    // 关键是不能出现一条 state/owner/tags 全空、只有 by/at 的覆盖
    const row = radar.readRadarBoard("gp", { scope: "all", now: NOW }).rows.find((x) => x.id === "pol-16kb");
    assert.equal(row.overrideConflict, false);
    assert.deepEqual(row.tags, undefined);
  });
});

test("人工覆盖过的父行不被推导盖回去", async () => {
  await withTrackHome(({ cli, radar }) => {
    seed({ cli, radar });
    radar.setRadarItemState("gp", "pol-16kb", { state: "ok", by: "wangfang1", note: "已确认豁免" });
    const board = radar.readRadarBoard("gp", { scope: "all", now: NOW });
    const parent = board.rows.find((row) => row.id === "pol-16kb");
    assert.equal(parent.state, "ok", "人说了算");
    assert.equal(parent.rolledUp, undefined, "有覆盖就不推导");
  });
});

/** 只写日期的字段按当地 00:00 存，所以断言也得按当地读，不能切 ISO 字符串 */
function day(iso) {
  const date = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 人手改的字段（标题、截止、任务起止）。
 *
 * 这些和状态不一样：状态只有四个取值，改错了一眼看得出来；日期改错了看起来完全正常，
 * 只是跑道上的条画在了别的地方。所以校验和「原值留着」这两条必须有测试盯住。
 */
test("人手改标题和日期落在覆盖层，原值留着", async () => {
  await withTrackHome(({ cli, radar }) => {
    seed({ cli, radar });
    const saved = radar.setRadarItemOverride("gp", "pol-16kb@likee", {
      title: "16KB 内存页对齐（我改的）",
      due: "2027-03-31",
      startAt: "2026-10-01",
      endAt: "2026-12-15",
      by: "wangfang1",
    });
    assert.equal(saved.ok, true);

    const row = radar.readRadarBoard("gp", { scope: "all", now: NOW }).rows.find((x) => x.id === "pol-16kb@likee");
    assert.equal(row.title, "16KB 内存页对齐（我改的）");
    assert.equal(day(row.due), "2027-03-31");
    assert.equal(day(row.startAt), "2026-10-01");
    assert.equal(day(row.endAt), "2026-12-15");
    // 流程原本写的那个截止日不能丢：面板要能说「你改了，它原来是 1-31」
    assert.equal(day(row.override.was.due), "2026-12-03");
    // 标题流程也写过，所以同样记着原值
    assert.equal(row.override.was.title, "Likee 16KB");
    // 起止是人凭空加的，流程没写过，没有原值可留
    assert.equal(row.override.was.startAt, undefined);
  });
});

test("空串是撤销，撤销后回到流程写的值", async () => {
  await withTrackHome(({ cli, radar }) => {
    seed({ cli, radar });
    radar.setRadarItemOverride("gp", "pol-16kb@likee", { due: "2027-03-31", by: "me" });
    radar.setRadarItemOverride("gp", "pol-16kb@likee", { due: "", by: "me" });
    const row = radar.readRadarBoard("gp", { scope: "all", now: NOW }).rows.find((x) => x.id === "pol-16kb@likee");
    assert.equal(day(row.due), "2026-12-03", "回到流程写的");
    assert.equal(row.override?.due, undefined, "撤销干净，不留一条只有 by/at 的空覆盖");
  });
});

test("日期写歪了整次不写，而不是静默变成空", async () => {
  await withTrackHome(({ cli, radar }) => {
    seed({ cli, radar });
    const bad = radar.setRadarItemOverride("gp", "pol-16kb@likee", { due: "下周三", by: "me" });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /日期/);

    const notReal = radar.setRadarItemOverride("gp", "pol-16kb@likee", { due: "2026-02-31", by: "me" });
    assert.equal(notReal.ok, false);

    const backwards = radar.setRadarItemOverride("gp", "pol-16kb@likee", {
      startAt: "2026-12-01", endAt: "2026-10-01", by: "me",
    });
    assert.equal(backwards.ok, false);
    assert.match(backwards.error, /晚于/);

    const row = radar.readRadarBoard("gp", { scope: "all", now: NOW }).rows.find((x) => x.id === "pol-16kb@likee");
    assert.equal(day(row.due), "2026-12-03", "一个都没落地");
  });
});

test("入库时间只认第一次，重跑不刷新", async () => {
  await withTrackHome(({ cli, radar }) => {
    seed({ cli, radar });
    const first = radar.readRadarShard("gp", "policy-watch").rows[0].firstSeenAt;
    assert.ok(first, "第一次写就该有入库时间");

    // 同一条重写一遍：lastSeenAt 会刷新，firstSeenAt 不该动
    cli.commitTrack({
      board: "gp",
      flowId: "policy-watch",
      owns: ["pol-*"],
      rows: [{ id: "pol-16kb", title: "16KB 对齐", due: "2027-01-31", state: "warn" }],
    });
    const again = radar.readRadarShard("gp", "policy-watch").rows[0];
    assert.equal(again.firstSeenAt, first, "入库时间被重置的话「盯了多久」就永远答不出来");
  });
});

/**
 * 条目级归档。
 *
 * 和 `settled`（留在板上但不出声）是两件事：归档是把这一条从板上拿走。
 * 父行归档要连带分面——否则父行走了，九条子行留在顶层变成孤儿，比不归档还乱。
 */
test("归档把条目从板上拿走，归档页单独回它", async () => {
  await withTrackHome(({ cli, radar }) => {
    seed({ cli, radar });
    radar.setRadarItemOverride("gp", "pol-16kb@likee", { archived: true, by: "me" });

    const shelf = radar.readRadarBoard("gp", { scope: "all", now: NOW });
    assert.equal(shelf.rows.some((row) => row.id === "pol-16kb@likee"), false, "架上看不到");
    assert.equal(shelf.archivedCount, 1);

    const box = radar.readRadarBoard("gp", { scope: "all", now: NOW, archived: true });
    assert.deepEqual(box.rows.map((row) => row.id), ["pol-16kb@likee"], "归档页只回归档的");
    // 两摞互补，不是包含关系——「全部」里混着归档的等于归档白做
    assert.equal(box.rows.length + shelf.rows.length, shelf.totalRows + box.totalRows);
  });
});

test("父行归档连带分面，取消归档一起回来", async () => {
  await withTrackHome(({ cli, radar }) => {
    seed({ cli, radar });
    radar.setRadarItemOverride("gp", "pol-16kb", { archived: true, by: "me" });

    const box = radar.readRadarBoard("gp", { scope: "all", now: NOW, archived: true });
    const ids = box.rows.map((row) => row.id).sort();
    assert.deepEqual(ids, ["pol-16kb", "pol-16kb@bigolive", "pol-16kb@likee"], "父行带走两条分面");
    // 页面要说得出「它是被上面那条带走的」，而不是「有人单独归档了它」
    const kid = box.rows.find((row) => row.id === "pol-16kb@likee");
    assert.equal(kid.archivedBy, "pol-16kb");
    assert.equal(kid.override?.archived, undefined, "子行身上不该留覆盖");

    assert.equal(radar.readRadarBoard("gp", { scope: "all", now: NOW }).rows.length, 0);

    // 取消归档：只撤父行那一条覆盖，三条一起回来
    radar.setRadarItemOverride("gp", "pol-16kb", { archived: false, by: "me" });
    const back = radar.readRadarBoard("gp", { scope: "all", now: NOW });
    assert.equal(back.rows.length, 3);
    assert.equal(back.archivedCount, 0);
  });
});

test("归档掉的分面不再把父行拖成未开始", async () => {
  await withTrackHome(({ cli, radar }) => {
    seed({ cli, radar });
    // seed 里 likee 是 risk、bigolive 是 warn，汇总出来父行是 risk（最坏的那个）
    const before = radar.readRadarBoard("gp", { scope: "all", now: NOW });
    assert.equal(before.rows.find((row) => row.id === "pol-16kb").state, "risk");

    radar.setRadarItemOverride("gp", "pol-16kb@likee", { archived: true, by: "me" });
    const after = radar.readRadarBoard("gp", { scope: "all", now: NOW });
    const parent = after.rows.find((row) => row.id === "pol-16kb");
    assert.equal(parent.state, "warn", "已经翻篇的那条不该继续报警");
    assert.equal(parent.facetCount, 1);
  });
});

/**
 * 父行不能在「有人没查」的时候显示已满足。
 *
 * 这是这块板最不能出的错：绿得越笃定，越没人去看那个没查的端。
 */
test("一个端满足、另一个端缺席，父行不是已满足", async () => {
  await withTrackHome(({ cli, radar }) => {
    radar.createRadarBoard("gp", { title: "政策雷达" });
    cli.commitTrack({
      board: "gp", flowId: "policy-watch", owns: ["pol-*"],
      rows: [{ id: "pol-16kb", title: "16KB 对齐", state: "idle" }],
    });
    // 两条流程都声明替政策作答，但只有 likee 真的写了
    cli.commitTrack({
      board: "gp", flowId: "likee", owns: ["*@likee"], covers: ["pol-*"],
      rows: [{ id: "pol-16kb@likee", parent: "pol-16kb", title: "Likee", state: "ok" }],
    });
    cli.commitTrack({
      board: "gp", flowId: "bigolive", owns: ["*@bigolive"], covers: ["pol-*"], rows: [],
    });

    const parent = radar.readRadarBoard("gp", { scope: "all", now: NOW }).rows
      .find((row) => row.id === "pol-16kb");
    assert.notEqual(parent.state, "ok", "有人没查就不能绿");
    assert.equal(parent.state, "idle");
    assert.deepEqual(parent.missingFacets, ["bigolive"]);
    assert.deepEqual(parent.coverage, { expected: 2, answered: 1, ok: 1 });
  });
});

test("两个端都答了且都满足，父行才是已满足", async () => {
  await withTrackHome(({ cli, radar }) => {
    radar.createRadarBoard("gp", { title: "政策雷达" });
    cli.commitTrack({
      board: "gp", flowId: "policy-watch", owns: ["pol-*"],
      rows: [{ id: "pol-16kb", title: "16KB 对齐", state: "idle" }],
    });
    for (const app of ["likee", "bigolive"]) {
      cli.commitTrack({
        board: "gp", flowId: app, owns: [`*@${app}`], covers: ["pol-*"],
        rows: [{ id: `pol-16kb@${app}`, parent: "pol-16kb", title: app, state: "ok" }],
      });
    }
    const parent = radar.readRadarBoard("gp", { scope: "all", now: NOW }).rows
      .find((row) => row.id === "pol-16kb");
    assert.equal(parent.state, "ok");
    assert.equal(parent.missingFacets, undefined);
    assert.deepEqual(parent.coverage, { expected: 2, answered: 2, ok: 2 });
  });
});

test("覆盖度按端数，不按行数", async () => {
  await withTrackHome(({ cli, radar }) => {
    radar.createRadarBoard("gp", { title: "政策雷达" });
    cli.commitTrack({
      board: "gp", flowId: "policy-watch", owns: ["pol-*"],
      rows: [{ id: "pol-del", title: "账号删除", state: "idle" }],
    });
    // 同一条流程给同一条政策写了两行（应用内入口 + Web 落地页）
    cli.commitTrack({
      board: "gp", flowId: "likee", owns: ["*@likee"], covers: ["pol-*"],
      rows: [
        { id: "pol-del-inapp@likee", parent: "pol-del", title: "应用内入口", state: "ok" },
        { id: "pol-del-web@likee", parent: "pol-del", title: "Web 落地页", state: "ok" },
      ],
    });
    const read = () => radar.readRadarBoard("gp", { scope: "all", now: NOW }).rows
      .find((row) => row.id === "pol-del");
    // 数行的话这里会是 2/1——一个读不通的分数
    assert.deepEqual(read().coverage, { expected: 1, answered: 1, ok: 1 });

    // 一个端要**每一行都满足**才算满足
    cli.commitTrack({
      board: "gp", flowId: "likee", owns: ["*@likee"], covers: ["pol-*"],
      rows: [
        { id: "pol-del-inapp@likee", parent: "pol-del", title: "应用内入口", state: "ok" },
        { id: "pol-del-web@likee", parent: "pol-del", title: "Web 落地页", state: "warn" },
      ],
      gate: false,
    });
    assert.deepEqual(read().coverage, { expected: 1, answered: 1, ok: 0 });
  });
});

/**
 * 板自己的词典。
 *
 * 状态怎么念、有哪几个大组——这些是业务，不是内核。写死在代码里，
 * 这套东西就只能跑合规板。
 */
test("spec 带词典：状态说法、大组、标签、字段名", async () => {
  await withTrackHome(({ radar }) => {
    radar.createRadarBoard("gp", {
      title: "线上问题",
      spec: {
        states: { ok: "已恢复", warn: "处理中", risk: "未响应", idle: "待定级", bogus: "" },
        themes: [{ key: "sla", label: "SLA 事故" }, "hotfix", { key: "sla", label: "重复的" }],
        tags: ["android", "ios", "android"],
        fields: { current: "现场", evidence: "证据" },
      },
    });
    const spec = radar.readRadarBoard("gp", { scope: "all", now: NOW }).spec;
    assert.equal(spec.states.ok, "已恢复", "ok 在这块板上念「已恢复」");
    assert.equal(spec.states.bogus, undefined, "空标签丢掉");
    // 只给 key 的补成 key 自己当名字；重复的 key 只留第一个；顺序就是页面上的顺序
    assert.deepEqual(spec.themes, [{ key: "sla", label: "SLA 事故" }, { key: "hotfix", label: "hotfix" }]);
    assert.deepEqual(spec.tags, ["android", "ios"]);
    assert.equal(spec.fields.current, "现场");
  });
});

test("没配词典的板照样能读，页面自己兜底", async () => {
  await withTrackHome(({ cli, radar }) => {
    seed({ cli, radar });
    const spec = radar.readRadarBoard("gp", { scope: "all", now: NOW }).spec;
    assert.deepEqual(spec.states, {});
    assert.deepEqual(spec.themes, []);
    assert.deepEqual(spec.tags, []);
  });
});
