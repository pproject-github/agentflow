import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { diffRows, inheritSettled, normalizeCommitRows, parseTrackArgs } from "../bin/lib/radar-cli.mjs";

/**
 * 每个用例一个数据根。`radar.mjs` 在模块作用域缓存路径，所以要连模块一起重新 import，
 * 否则第二个用例还在往第一个的临时目录里写。
 */
async function withTrackHome(run) {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-track-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  try {
    const nonce = crypto.randomUUID();
    const [cli, radar] = await Promise.all([
      import(`../bin/lib/radar-cli.mjs?track=${nonce}`),
      import(`../bin/lib/radar.mjs?track=${nonce}`),
    ]);
    await run({ cli, radar, tempRoot });
  } finally {
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

const DAY = 24 * 60 * 60 * 1000;
const ROW = { id: "play-target-36", title: "Play 目标 API 36", state: "warn", owner: "xingqiwei", due: "2026-10-24" };

test("--board=x 和 --board x 都收，布尔位给 true", () => {
  const { flags, positional } = parseTrackArgs(["commit", "--board=c", "--flow", "f", "--force", "--rows=/tmp/r.json"]);
  assert.equal(positional[0], "commit");
  assert.deepEqual(flags, { board: "c", flow: "f", force: true, rows: "/tmp/r.json" });
});

// 这是整条链上唯一挡得住模型自由发挥的地方
test("拼错的 state 报错，而不是静默变成 idle", () => {
  const { rows, errors } = normalizeCommitRows([{ id: "x", title: "拼错", state: "warning" }]);
  assert.equal(rows.length, 0);
  assert.match(errors[0], /state 不认识：warning/);
});

// 规划提示词明确要求「脚本匹配不到时返回 unknown，绝不能默认当成通过」
test("unknown 是合法输入，落到 idle", () => {
  const { rows, errors } = normalizeCommitRows([{ ...ROW, state: "unknown" }]);
  assert.deepEqual(errors, []);
  assert.equal(rows[0].state, "unknown");
});

test("缺 id、缺 title、id 重复都报出来", () => {
  const { errors } = normalizeCommitRows([
    { title: "没 id" },
    { id: "a", title: "" },
    { id: "b", title: "第一个 b" },
    { id: "b", title: "第二个 b" },
  ]);
  assert.equal(errors.length, 3);
  assert.match(errors.join("\n"), /缺 id/);
  assert.match(errors.join("\n"), /缺 title/);
  assert.match(errors.join("\n"), /id 重复：b/);
});

// 多出来的字段是特性：spareFields() 靠它们做多维展示，剥掉就把板锁死成固定几列
test("不认识的字段原样留着，不做白名单", () => {
  const { rows } = normalizeCommitRows([{ ...ROW, platform: "Android", 政策链接: "https://x" }]);
  assert.equal(rows[0].platform, "Android");
  assert.equal(rows[0]["政策链接"], "https://x");
});

test("state 不是数组也不是 {rows:[]} 时直接拒绝", () => {
  assert.match(normalizeCommitRows("play-target-36").errors[0], /rows 必须是数组/);
  assert.match(normalizeCommitRows(null).errors[0], /rows 必须是数组/);
});

// 人标的「已封存」存在条目上，整片重写会抹掉它 —— 流程作者不该需要知道这件事
test("整片重写时继承上一片的 settled", () => {
  const previous = { rows: [{ id: "play-target-36", settled: true }, { id: "other", settled: false }] };
  const kept = inheritSettled([{ ...ROW }, { id: "other", title: "另一条" }], previous);
  assert.equal(kept[0].settled, true);
  assert.equal(kept[1].settled, undefined);
});

// 政策改期让条目重新亮起来，是流程该有的权力
test("这一次显式写了 settled 就听流程的", () => {
  const previous = { rows: [{ id: "play-target-36", settled: true }] };
  assert.equal(inheritSettled([{ ...ROW, settled: false }], previous)[0].settled, false);
});

test("diff 出新增、状态翻转、日期改期、现状推进", () => {
  const previous = { rows: [{ id: "play-target-36", state: "warn", due: "2026-10-24", current: "targetSdk 35" }] };
  const events = diffRows(previous, [
    { id: "play-target-36", title: "T", state: "risk", due: "2026-11-01", current: "targetSdk 36" },
    { id: "fresh", title: "新的", state: "warn" },
  ]);
  const kinds = events.map((event) => event.kind).sort();
  assert.deepEqual(kinds, ["added", "current", "due", "state"]);
  assert.deepEqual(
    events.find((event) => event.kind === "state"),
    { kind: "state", id: "play-target-36", title: "T", from: "warn", to: "risk" },
  );
});

// 「条目从输出里消失」不等于「这条没了」，等于「没人再更新它了」——
// 这个事件是唯一能解释它为什么开始发灰的线索
test("上一片有、这一片没有，记一条 dropped", () => {
  const events = diffRows({ rows: [{ id: "gone", title: "消失的" }] }, []);
  assert.deepEqual(events, [{ kind: "dropped", id: "gone", title: "消失的" }]);
});

test("没变化时不产事件，变更抽屉不该被噪音淹掉", () => {
  const rows = [{ id: "play-target-36", title: "T", state: "warn", due: "2026-10-24", current: "a" }];
  assert.deepEqual(diffRows({ rows }, rows), []);
});

test("写一片：落盘、盖 writtenBy、事件进变更流", async () => {
  await withTrackHome(async ({ cli, radar }) => {
    const result = cli.commitTrack({ board: "compliance", flowId: "play-policy-watch", rows: [ROW], actor: "wangfang1" });
    assert.equal(result.ok, true);
    assert.equal(result.rows, 1);
    assert.deepEqual(result.events.map((event) => event.kind), ["added"]);

    const shard = radar.readRadarShard("compliance", "play-policy-watch");
    assert.equal(shard.writtenBy, "wangfang1");
    assert.equal(shard.rows[0].id, "play-target-36");
    // 出现在这次输出里的条目盖上时间戳，陈旧判定靠它
    assert.ok(shard.rows[0].lastSeenAt);

    assert.equal(radar.readRadarEvents("compliance")[0].kind, "added");
  });
});

// 两条流程写同一片会互相覆盖，板上开始自相矛盾，而看的人只会得出「这面板不准」
test("换个人写同一片被拒，--force 才放行", async () => {
  await withTrackHome(async ({ cli, radar }) => {
    cli.commitTrack({ board: "compliance", flowId: "shared", rows: [ROW], actor: "wangfang1" });
    assert.throws(
      () => cli.commitTrack({ board: "compliance", flowId: "shared", rows: [ROW], actor: "hesiqi" }),
      /上次是 wangfang1 写的，你是 hesiqi/,
    );
    cli.commitTrack({ board: "compliance", flowId: "shared", rows: [ROW], actor: "hesiqi", force: true });
    assert.equal(radar.readRadarShard("compliance", "shared").writtenBy, "hesiqi");
  });
});

// 手工跑 CLI 时没有 AGENTFLOW_USER_ID，不该被自己流程的历史记录挡住
test("不知道是谁在写时不拦", async () => {
  await withTrackHome(async ({ cli }) => {
    cli.commitTrack({ board: "compliance", flowId: "f", rows: [ROW], actor: "wangfang1" });
    assert.equal(cli.commitTrack({ board: "compliance", flowId: "f", rows: [ROW], actor: "" }).ok, true);
  });
});

test("坏条目一条都不写，不是写一半", async () => {
  await withTrackHome(async ({ cli, radar }) => {
    assert.throws(
      () => cli.commitTrack({
        board: "compliance",
        flowId: "half",
        rows: [ROW, { id: "bad", title: "坏的", state: "nope" }],
        actor: "wangfang1",
      }),
      /state 不认识：nope/,
    );
    assert.equal(radar.readRadarShard("compliance", "half"), null);
  });
});

test("board / flow 名字会进文件名，穿越要挡住", async () => {
  await withTrackHome(async ({ cli }) => {
    assert.throws(() => cli.commitTrack({ board: "../evil", flowId: "f", rows: [ROW] }), /board 不合法/);
    assert.throws(() => cli.commitTrack({ board: "compliance", flowId: "../evil", rows: [ROW] }), /flow 不合法/);
  });
});

// 误删再重建时，清掉告警状态会把已经提醒过的档位全部重放一遍
test("删一片不动告警状态，删整块板才连告警一起走", async () => {
  await withTrackHome(async ({ cli, radar }) => {
    cli.commitTrack({ board: "compliance", flowId: "one", rows: [ROW], actor: "wangfang1" });
    radar.writeRadarAlertStates("compliance", { "play-target-36": { lastKind: "threshold", sentThresholds: [90] } });

    radar.rmRadarShard("compliance", "one");
    assert.equal(radar.readRadarShard("compliance", "one"), null);
    assert.deepEqual(radar.readRadarAlertStates("compliance")["play-target-36"].sentThresholds, [90]);

    radar.rmRadarBoard("compliance");
    assert.deepEqual(radar.readRadarAlertStates("compliance"), {});
    // 变更流留着：误删之后它是唯一能说清丢了什么的东西
    assert.ok(radar.readRadarEvents("compliance").length > 0);
  });
});

// 整片不写的话，板看起来一切正常，而监控其实已经静默死掉了
test("抓取失败且一条没拿到时，保留上一片而不是抹成空", async () => {
  await withTrackHome(async ({ cli, radar }) => {
    cli.commitTrack({ board: "compliance", flowId: "watch", rows: [ROW], actor: "wangfang1" });
    const before = radar.readRadarShard("compliance", "watch").rows[0].lastSeenAt;

    const result = cli.commitTrack({
      board: "compliance", flowId: "watch", rows: [], actor: "wangfang1", fetchFailures: 2, now: Date.now() + 60_000,
    });
    assert.equal(result.salvaged, true);
    assert.equal(result.rows, 1);
    // 什么都没变，变更流不该出现一次抓取失败留下的假动静
    assert.deepEqual(result.events, []);

    const shard = radar.readRadarShard("compliance", "watch");
    assert.equal(shard.rows[0].id, "play-target-36");
    assert.equal(shard.fetchFailures, 2);
    // 这次并没有真的看见它们：刷新时间戳等于把「已经几天没更新了」抹掉，陈旧告警就永不会响
    assert.equal(shard.rows[0].lastSeenAt, before);
  });
});

// 抓取成功而结果确实为空，那就是真的空
test("没有抓取失败时，空结果就是空结果", async () => {
  await withTrackHome(async ({ cli, radar }) => {
    cli.commitTrack({ board: "compliance", flowId: "watch", rows: [ROW], actor: "wangfang1" });
    const result = cli.commitTrack({ board: "compliance", flowId: "watch", rows: [], actor: "wangfang1" });
    assert.equal(result.salvaged, false);
    assert.deepEqual(result.events.map((event) => event.kind), ["dropped"]);
    assert.deepEqual(radar.readRadarShard("compliance", "watch").rows, []);
  });
});

// 抓取失败但**部分**拿到了，是真结果，不该走保留分支
test("抓取失败但拿到了条目时，照常按新结果写", async () => {
  await withTrackHome(async ({ cli }) => {
    cli.commitTrack({ board: "compliance", flowId: "watch", rows: [ROW, { id: "b", title: "B" }], actor: "wangfang1" });
    const result = cli.commitTrack({
      board: "compliance", flowId: "watch", rows: [ROW], actor: "wangfang1", fetchFailures: 1,
    });
    assert.equal(result.salvaged, false);
    assert.deepEqual(result.events.map((event) => event.kind), ["dropped"]);
  });
});

// 第一次跑就失败：没有上一片可保留，只能是空板 + 失败计数
test("第一次跑就抓取失败时不炸，如实记成空板", async () => {
  await withTrackHome(async ({ cli, radar }) => {
    const result = cli.commitTrack({ board: "compliance", flowId: "watch", rows: [], fetchFailures: 3 });
    assert.equal(result.salvaged, false);
    assert.equal(radar.readRadarShard("compliance", "watch").fetchFailures, 3);
  });
});

test("建板：空板也能立起来，重复建被拒", async () => {
  await withTrackHome(async ({ radar }) => {
    assert.equal(radar.createRadarBoard("compliance", { title: "发版合规", createdBy: "wangfang1" }).ok, true);
    // 静默覆盖会把一块攒了半年的板清成新的
    assert.match(radar.createRadarBoard("compliance", { title: "另一个" }).error, /已经存在/);
    assert.match(radar.createRadarBoard("../evil", {}).error, /board id 不合法/);

    const listed = radar.listRadarBoards({ scope: "all" });
    assert.deepEqual(listed.map((item) => item.board), ["compliance"]);
    assert.equal(listed[0].title, "发版合规");
    // 空板：没有流程喂它，但它存在
    assert.deepEqual(listed[0].flows, []);
  });
});

// 归档不是删除：数据全留着，取消归档就完整回来
test("归档只是从列表里消失，分片和告警状态原样留着", async () => {
  await withTrackHome(async ({ cli, radar }) => {
    radar.createRadarBoard("compliance", { title: "发版合规" });
    cli.commitTrack({ board: "compliance", flowId: "watch", rows: [ROW], actor: "wangfang1" });
    radar.writeRadarAlertStates("compliance", { "play-target-36": { lastKind: "threshold", sentThresholds: [90] } });

    assert.equal(radar.setRadarBoardArchived("compliance", true).ok, true);
    assert.deepEqual(radar.listRadarBoards({ scope: "all" }).map((item) => item.board), []);
    // 要恢复就得能翻出来
    assert.deepEqual(
      radar.listRadarBoards({ scope: "all", includeArchived: true }).map((item) => [item.board, item.archived]),
      [["compliance", true]],
    );
    // 数据一点没动
    assert.equal(radar.readRadarShard("compliance", "watch").rows.length, 1);
    assert.deepEqual(radar.readRadarAlertStates("compliance")["play-target-36"].sentThresholds, [90]);

    radar.setRadarBoardArchived("compliance", false);
    const back = radar.readRadarBoard("compliance", { scope: "all" });
    assert.equal(back.archived, false);
    assert.equal(back.rows.length, 1);
  });
});

// 分片先建、板级元信息还没写过的板也要能归档
test("没有 _board.json 的板也能归档", async () => {
  await withTrackHome(async ({ cli, radar }) => {
    cli.commitTrack({ board: "compliance", flowId: "watch", rows: [ROW], actor: "wangfang1" });
    assert.equal(radar.setRadarBoardArchived("compliance", true).ok, true);
    assert.deepEqual(radar.listRadarBoards({ scope: "all" }).map((item) => item.board), []);
  });
});

test("归档不存在的板要报错，不要静默造一块出来", async () => {
  await withTrackHome(async ({ radar }) => {
    assert.match(radar.setRadarBoardArchived("nope", true).error, /没有这块板/);
  });
});

/**
 * 定时任务那一侧不存雷达归属，每次从板目录反查。
 * 存一个 `track:` 字段等于开第二个真相源：流程改成写另一块板之后那个字段不会自己变。
 */
test("反查：哪条流程在喂哪块板", async () => {
  await withTrackHome(async ({ cli, radar }) => {
    cli.commitTrack({ board: "compliance", flowId: "play-watch", rows: [ROW], actor: "wangfang1" });
    cli.commitTrack({ board: "perf", flowId: "play-watch", rows: [{ id: "p", title: "P" }], actor: "wangfang1" });
    cli.commitTrack({ board: "compliance", flowId: "ios-watch", rows: [{ id: "i", title: "I" }], actor: "wangfang1" });

    const index = radar.boardsByFlow();
    // 一条流程可以喂多块板——单个字段装不下，这正是不存归属的理由之一
    assert.deepEqual(index.get("play-watch").map((item) => item.board).sort(), ["compliance", "perf"]);
    assert.deepEqual(index.get("ios-watch").map((item) => item.board), ["compliance"]);
    assert.equal(index.get("nobody"), undefined);

    const entry = index.get("ios-watch")[0];
    assert.equal(entry.rows, 1);
    assert.equal(entry.stale, false);
    assert.ok(entry.updatedAt);
  });
});

// 「定时任务跑成功了」和「真的写进板了」是两回事，只看 schedule 那一侧永远发现不了空转
test("反查带出哑掉的分片", async () => {
  await withTrackHome(async ({ cli, radar }) => {
    const longAgo = Date.now() - 30 * DAY;
    cli.commitTrack({ board: "compliance", flowId: "dead", rows: [ROW], actor: "wangfang1", now: longAgo, staleAfterMs: DAY });
    assert.equal(radar.boardsByFlow().get("dead")[0].stale, true);
  });
});

// 分片里记着的 flow.flowId 才是真正的绑定，分片名只是退路
test("反查优先用分片里记着的 flowId", async () => {
  await withTrackHome(async ({ cli, radar }) => {
    cli.commitTrack({
      board: "compliance",
      flowId: "shard-name",
      rows: [ROW],
      actor: "wangfang1",
      flow: { flowId: "real-flow-id", flowSource: "user", scheduleNodeId: "daily" },
    });
    const index = radar.boardsByFlow();
    assert.equal(index.get("real-flow-id")[0].board, "compliance");
    // 分片名也认，手工 commit 时它是唯一线索
    assert.equal(index.get("shard-name")[0].board, "compliance");
  });
});

// 实测新建 Android 政策追踪板时发现的：真实政策条目常常没有截止日期
test("没有截止日的条目：不算过期，也不按天数告警", async () => {
  await withTrackHome(async ({ cli, radar }) => {
    cli.commitTrack({
      board: "android-policy",
      flowId: "play-watch",
      rows: [{ id: "photo-perms", title: "照片与视频权限政策", state: "unknown", due: "" }],
      actor: "wangfang1",
    });
    const [row] = radar.readRadarBoard("android-policy", { scope: "all" }).rows;
    assert.equal(row.daysLeft, null);
    // Number(null) 是 0 而 0 是有限数——不显式挡掉就会被当成「剩 0 天」立刻触发 T-7
    assert.equal(row.overdue, false);
    assert.equal(row.effectiveReason, "no_due");
  });
})

/** 跑一条 track 子命令，顺带把 stdout 收起来——用例只关心落盘结果 */
async function runTrack(cli, argv) {
  const original = console.log;
  const out = [];
  console.log = (...args) => out.push(args.join(" "));
  try {
    await cli.runTrackCommand(argv);
  } finally {
    console.log = original;
  }
  return out.join("\n");
}

async function withHeld(run) {
  await withTrackHome(async (ctx) => {
    const { cli, radar } = ctx;
    cli.commitTrack({
      board: "b", flowId: "f", actor: "wangfang1",
      rows: [{ id: "a", title: "A", state: "risk", due: "2026-12-01" }],
    });
    // 门禁拦下「改成 ok」，值回退，待审批落盘
    const held = cli.commitTrack({
      board: "b", flowId: "f", actor: "wangfang1", gate: true,
      rows: [{ id: "a", title: "A", state: "ok", due: "2026-12-01" }],
    });
    assert.equal(held.held.length, 1, "该被拦下一条");
    assert.equal(radar.readRadarShard("b", "f").rows[0].state, "risk", "拦下时值不变");
    await run(ctx);
  });
}

test("批准把目标值真的写进分片，待审批随之清空", async () => {
  await withHeld(async ({ cli, radar, tempRoot }) => {
    // sync 才会落 _pending，这里直接按它的格式写一份
    const dir = path.join(process.env.AGENTFLOW_HOME, "radar", "boards", "b");
    fs.writeFileSync(path.join(dir, "_pending.json"), JSON.stringify({
      f: { at: new Date().toISOString(), held: [{ kind: "state", id: "a", from: "risk", to: "ok", reason: "会关掉告警" }] },
    }));

    await runTrack(cli, ["approve", "--board=b", "--flow=f"]);
    assert.equal(radar.readRadarShard("b", "f").rows[0].state, "ok", "批准之后目标值落盘");
    assert.equal(fs.existsSync(path.join(dir, "_pending.json")), false, "清空后把文件删掉，而不是留个空壳");
    assert.equal(radar.readRadarEvents("b")[0].kind, "approved");
  });
});

// 一次只批一条时，其余的必须还在——否则人会以为自己批了全部
test("按 --id 只处理一条，其余留着", async () => {
  await withHeld(async ({ cli, radar }) => {
    const dir = path.join(process.env.AGENTFLOW_HOME, "radar", "boards", "b");
    fs.writeFileSync(path.join(dir, "_pending.json"), JSON.stringify({
      f: { at: new Date().toISOString(), held: [
        { kind: "state", id: "a", from: "risk", to: "ok", reason: "x" },
        { kind: "due", id: "a", from: "2026-12-01", to: "2027-06-01", reason: "y" },
      ] },
    }));
    const out = await runTrack(cli, ["approve", "--board=b", "--flow=f", "--id=a"]);
    // 同一条目的两处都属于 id=a，所以两条一起批了
    assert.match(out, /已批准并写入 2 处/);
    assert.equal(radar.readRadarShard("b", "f").rows[0].state, "ok");
  });
});

test("没有待审批时报错，不假装批过了", async () => {
  await withHeld(async ({ cli }) => {
    await assert.rejects(() => runTrack(cli, ["approve", "--board=b", "--flow=f"]), /没有待审批的改动/);
  });
});

test("门禁拦下的值保持原样，直到有人点头", async () => {
  await withHeld(async ({ radar }) => {
    assert.equal(radar.readRadarShard("b", "f").rows[0].state, "risk");
  });
});

// 驳回本身是信息：连着三轮想改成 ok 都被驳回，说明判定规则该改了
test("驳回不写值，但在变更流里留一条", async () => {
  await withTrackHome(async ({ cli, radar }) => {
    cli.commitTrack({ board: "b", flowId: "f", actor: "w", rows: [{ id: "a", title: "A", state: "risk" }] });
    const before = radar.readRadarEvents("b").length;
    radar.appendRadarEvent("b", { kind: "rejected", id: "a", field: "state", from: "risk", to: "ok", by: "w" });
    const events = radar.readRadarEvents("b");
    assert.equal(events.length, before + 1);
    assert.equal(events[0].kind, "rejected");
    assert.equal(radar.readRadarShard("b", "f").rows[0].state, "risk", "驳回之后值不变");
  });
});

// ── track plan check ──────────────────────────────────────────────────
// 这几条都是实跑 radar-plan 流程时踩出来的，不是想出来的

test("plan check：模型先给示例再给真计划，挑真的那份", async () => {
  await withTrackHome(async ({ cli, tempRoot }) => {
    const out = (name) => path.join(tempRoot, name);
    await runTrack(cli, ["plan", "check",
      `--raw=举个例子：\n\`\`\`json\n{"summary":"示例"}\n\`\`\`\n真正的计划：\n\`\`\`json\n{"summary":"真的","items":[{"id":"a-one","title":"甲"}],"flows":[{"action":"create","flowId":"watch","owns":["a-one"]}]}\n\`\`\``,
      `--ok=${out("ok")}`, `--report=${out("rep.md")}`, `--plan=${out("plan.json")}`,
    ]);
    assert.equal(fs.readFileSync(out("ok"), "utf-8"), "true");
    const plan = JSON.parse(fs.readFileSync(out("plan.json"), "utf-8"));
    assert.equal(plan.summary, "真的");
  });
});

/**
 * 运行时把超过阈值的输入物化成 `inputs/<槽>/<槽>.json`，值就变成路径——短的时候还是原文。
 * 不认这一层，校验节点会拿着一行路径去解析 JSON，然后把运行时的行为诬赖给模型。
 */
test("plan check：槽值是路径时读文件，不是把路径当 JSON 解析", async () => {
  await withTrackHome(async ({ cli, tempRoot }) => {
    const out = (name) => path.join(tempRoot, name);
    const mounted = path.join(tempRoot, "inputs", "raw", "raw.json");
    fs.mkdirSync(path.dirname(mounted), { recursive: true });
    fs.writeFileSync(mounted, '{"summary":"从文件读到的","items":[],"flows":[{"action":"create","flowId":"watch","owns":["*"]}]}', "utf-8");
    const previousCwd = process.cwd();
    process.chdir(tempRoot);
    try {
      await runTrack(cli, ["plan", "check", "--raw=inputs/raw/raw.json",
        `--ok=${out("ok")}`, `--report=${out("rep.md")}`, `--plan=${out("plan.json")}`,
      ]);
    } finally {
      process.chdir(previousCwd);
    }
    assert.equal(fs.readFileSync(out("ok"), "utf-8"), "true");
    assert.equal(JSON.parse(fs.readFileSync(out("plan.json"), "utf-8")).summary, "从文件读到的");
  });
});

// 解析不出来不是这一步失败，是下一步该让它重发——和 `new` 流程里的 lint 节点同一个契约
test("plan check：解析不出来写 false 而不是抛，报告里带上原文", async () => {
  await withTrackHome(async ({ cli, tempRoot }) => {
    const out = (name) => path.join(tempRoot, name);
    const code = await runTrack(cli, ["plan", "check", "--raw=我想了想，还是写成文字吧",
      `--ok=${out("ok")}`, `--report=${out("rep.md")}`, `--plan=${out("plan.json")}`,
    ]);
    assert.match(code, /计划未通过/);
    assert.equal(fs.readFileSync(out("ok"), "utf-8"), "false");
    assert.match(fs.readFileSync(out("rep.md"), "utf-8"), /我想了想/);
  });
});

// 一次运行一份，不是「最新那份」：并行规划时人会拿到别人那份计划，而且看不出来
test("plan check：结果按 runId 存进雷达数据目录，服务端照 runId 取", async () => {
  await withTrackHome(async ({ cli, radar, tempRoot }) => {
    const out = (name) => path.join(tempRoot, name);
    await runTrack(cli, ["plan", "check", "--run-id=run-abc",
      '--raw={"summary":"s","items":[],"flows":[{"action":"create","flowId":"watch","owns":["*"]}]}',
      `--ok=${out("ok")}`, `--report=${out("rep.md")}`, `--plan=${out("plan.json")}`,
    ]);
    const saved = JSON.parse(fs.readFileSync(radar.radarPlanFile("run-abc"), "utf-8"));
    assert.equal(saved.runId, "run-abc");
    assert.equal(saved.ok, true);
    assert.equal(saved.plan.flows[0].flowId, "watch");
    // 别人那次的 runId 不该也指到这份上
    assert.equal(fs.existsSync(radar.radarPlanFile("run-xyz")), false);
  });
});

test("plan prompt：新板时写出的提示词里要有 board 那一段", async () => {
  await withTrackHome(async ({ cli, tempRoot }) => {
    const outPath = path.join(tempRoot, "prompt.md");
    await runTrack(cli, ["plan", "prompt", `--out=${outPath}`, "--ask=盯三方 SDK 合规"]);
    const prompt = fs.readFileSync(outPath, "utf-8");
    assert.match(prompt, /盯三方 SDK 合规/);
    assert.match(prompt, /"board": \{ "title"/);
  });
});
