import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRadarPlanPrompt,
  buildRadarPlanRepairPrompt,
  describeBoardState,
  normalizeRadarItems,
  normalizeRadarPlan,
  parseRadarPlan,
} from "../bin/lib/radar-planner.mjs";

function boardFixture(overrides = {}) {
  return {
    board: "compliance",
    title: "发版合规",
    flows: [
      { flowId: "play-policy-watch", rows: 3, stale: false, fetchFailures: 0, flow: { scheduleNodeId: "daily" } },
      { flowId: "appstore-policy-watch", rows: 2, stale: true, fetchFailures: 2, flow: { scheduleNodeId: "weekly" } },
    ],
    rows: [
      { id: "play-target-36", state: "warn", owner: "xingqiwei", flowId: "play-policy-watch" },
      { id: "android16-edge", state: "risk", owner: "", flowId: "play-policy-watch" },
      { id: "ios-sdk", state: "risk", owner: "linguanhong", flowId: "appstore-policy-watch" },
    ],
    conflicts: [],
    ...overrides,
  };
}

// 模型要能提出「改」，而不是每次从零重搭。所以现状必须是事实，不是叙述。
test("现状里点名哑掉的流程和无人认领的条目", () => {
  const text = describeBoardState(boardFixture());
  assert.match(text, /play-policy-watch，写入 3 条/);
  assert.match(text, /appstore-policy-watch.*已经哑了/s);
  assert.match(text, /2 次抓取失败/);
  assert.match(text, /android16-edge（risk，\*\*无人认领\*\*，来自 play-policy-watch）/);
});

test("板不存在时说清楚是从零开始", () => {
  assert.match(describeBoardState(null), /还不存在/);
});

test("条目很多时截断，但要说还有多少条没列", () => {
  const rows = Array.from({ length: 47 }, (_, index) => ({ id: `item-${index}`, state: "warn", owner: "me" }));
  const text = describeBoardState(boardFixture({ rows }));
  assert.match(text, /另有 7 条/);
  assert.equal(text.includes("item-45"), false);
});

// 这几条约束不写进提示词，模型会给出「每天让模型读一遍政策页写段总结」的方案
test("提示词带上按节奏拆流程、一条目一主、unknown 不当通过这几条硬约束", () => {
  const prompt = buildRadarPlanPrompt({ board: boardFixture(), ask: "盯 Android 和 iOS 的商店政策" });
  assert.match(prompt, /按变化节奏拆流程/);
  assert.match(prompt, /一个追踪项只能由一条流程负责写/);
  assert.match(prompt, /返回 unknown/);
  assert.match(prompt, /抓取失败要和「没有变化」分开记/);
  assert.match(prompt, /盯 Android 和 iOS 的商店政策/);
  assert.match(prompt, /板 id 是 compliance/);
});

test("模型把 JSON 裹在代码块里也认得出来", () => {
  const wrapped = '好的，我的计划如下：\n```json\n{"summary":"拆两条","flows":[]}\n```\n有问题再说。';
  const parsed = parseRadarPlan(wrapped);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan.summary, "拆两条");

  const bare = parseRadarPlan('前面有废话 {"summary":"裸的","flows":[]} 后面也有');
  assert.equal(bare.ok, true);
  assert.equal(bare.plan.summary, "裸的");

  assert.equal(parseRadarPlan("我觉得可以这样做，但我不打算给你 JSON").ok, false);
  assert.equal(parseRadarPlan("").ok, false);
});

// 计划是待审草案，不能直接落地。检查的重点就是它会不会造出我们刚防住的那些问题
test("同一条目被两条流程认领要报出来", () => {
  const result = normalizeRadarPlan({
    flows: [
      { action: "create", flowId: "policy-watch", owns: ["play-target-36"] },
      { action: "create", flowId: "another-watch", owns: ["play-target-36"] },
    ],
  }, boardFixture());
  assert.ok(result.warnings.some((warning) => /play-target-36 被 policy-watch 和 another-watch 同时认领/.test(warning)));
});

test("通配符表示全部条目，不算和别人抢", () => {
  const result = normalizeRadarPlan({
    flows: [
      { action: "create", flowId: "policy-watch", owns: ["play-target-36"] },
      { action: "create", flowId: "repo-state-scan", owns: ["*"], updates: ["state", "current", "evidence"] },
    ],
  }, boardFixture());
  assert.equal(result.warnings.some((warning) => /同时认领/.test(warning)), false);
  assert.deepEqual(result.flows[1].updates, ["state", "current", "evidence"]);
});

test("动作和板上现状对不上时自动纠正，并说明", () => {
  const result = normalizeRadarPlan({
    flows: [
      { action: "create", flowId: "play-policy-watch", owns: [] },
      { action: "update", flowId: "brand-new-flow", owns: [] },
    ],
  }, boardFixture());
  assert.equal(result.flows[0].action, "update");
  assert.equal(result.flows[1].action, "create");
  assert.ok(result.warnings.some((warning) => /play-policy-watch 已经存在/.test(warning)));
  assert.ok(result.warnings.some((warning) => /brand-new-flow 目前不存在/.test(warning)));
});

test("流程名不合法的直接丢掉，不让它流到建流程那步", () => {
  const result = normalizeRadarPlan({
    flows: [
      { action: "create", flowId: "Play Policy Watch", owns: [] },
      { action: "create", flowId: "../evil", owns: [] },
      { action: "create", flowId: "ok-flow", owns: [] },
    ],
  }, boardFixture());
  assert.deepEqual(result.flows.map((flow) => flow.flowId), ["ok-flow"]);
  assert.equal(result.warnings.filter((warning) => /流程名不合法/.test(warning)).length, 2);
});

test("cron 不合法要报，但不丢掉这条流程", () => {
  const result = normalizeRadarPlan({
    flows: [{ action: "create", flowId: "ok-flow", cron: "每天九点", owns: ["*"] }],
  }, boardFixture());
  assert.equal(result.flows.length, 1);
  assert.ok(result.warnings.some((warning) => /cron 看起来不对/.test(warning)));
});

// 板上已有、计划里没人管的条目最容易被漏掉：它会一直停在那儿，再也不更新
test("计划漏掉的已有条目要点名", () => {
  const result = normalizeRadarPlan({
    flows: [{ action: "create", flowId: "only-one", owns: ["play-target-36"] }],
  }, boardFixture());
  assert.ok(result.warnings.some((warning) => /计划没有覆盖这些已有条目/.test(warning)));
  assert.ok(result.warnings.some((warning) => /android16-edge/.test(warning)));
});

test("引用了板上不存在的条目要报", () => {
  const result = normalizeRadarPlan({
    flows: [{ action: "create", flowId: "ok-flow", owns: ["*", "made-up-item"] }],
  }, boardFixture());
  assert.ok(result.warnings.some((warning) => /声称负责 made-up-item/.test(warning)));
});

test("一条可用流程都没有时要说出来", () => {
  assert.ok(normalizeRadarPlan({ flows: [] }, boardFixture()).warnings.includes("这份计划里没有一条可用的流程"));
  assert.ok(normalizeRadarPlan(null, null).warnings.includes("这份计划里没有一条可用的流程"));
});

test("updates 只留认识的字段，别让模型发明字段", () => {
  const result = normalizeRadarPlan({
    flows: [{ action: "create", flowId: "ok-flow", owns: ["*"], updates: ["state", "颜色", "evidence", "__proto__"] }],
  }, boardFixture());
  assert.deepEqual(result.flows[0].updates, ["state", "evidence"]);
});

// 路由守卫：这两条是在装流程、起 run **之前**就该拦掉的，所以单独钉住
test("规划接口先挡住坏输入，再谈装流程", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-radar-plan-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?radar-plan=${nonce}`),
      import(`../bin/lib/ui-server.mjs?radar-plan=${nonce}`),
    ]);
    const user = loginOrCreateUser("wangfang1", "radar-plan-pw");
    server = await startUiServer({
      workspaceRoot: path.join(tempRoot, "workspace"),
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
      enableWorkspaceScheduler: false,
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (body) => {
      const res = await fetch(`${base}/api/radar/plan/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.token}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };

    // 没说要盯什么就调模型，是白花钱
    const empty = await post({ board: "compliance", ask: "   " });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /想盯什么/);

    // board 会被拿去读文件，先验格式
    const traversal = await post({ board: "../etc", ask: "盯点什么" });
    assert.equal(traversal.status, 400);
    assert.match(traversal.body.error, /board 参数不合法/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

/**
 * 规划这一刻还没扫过任何东西。写进去的任何 state 都是编的，
 * 而板上一条绿色的 ok 会让人以为已经查过了。
 */
test("条目的初始 state 一概不收", () => {
  const { items } = normalizeRadarItems([
    { id: "a", title: "A", state: "ok", current: "已满足" },
  ]);
  assert.equal(items[0].state, undefined);
  assert.equal(items[0].current, undefined);
});

test("条目 id 不合法或重复的丢掉并点名", () => {
  const { items, warnings } = normalizeRadarItems([
    { id: "Play Target", title: "空格" },
    { id: "../evil", title: "穿越" },
    { id: "ok-one", title: "行" },
    { id: "ok-one", title: "重复" },
  ]);
  assert.deepEqual(items.map((item) => item.id), ["ok-one"]);
  assert.equal(warnings.filter((w) => /不合法/.test(w)).length, 2);
  assert.ok(warnings.some((w) => /重复/.test(w)));
});

test("和板上已有条目撞 id 的也丢掉", () => {
  const { items, warnings } = normalizeRadarItems([{ id: "已有", title: "x" }, { id: "new-one", title: "y" }], new Set(["new-one"]));
  assert.deepEqual(items.map((item) => item.id), []);
  assert.ok(warnings.some((w) => /new-one 重复/.test(w)));
});

// 截止日写错格式比没有截止日更糟：它会被解析成别的日子，倒计时全是错的
test("截止日格式不对就留空并报出来，不猜", () => {
  const { items, warnings } = normalizeRadarItems([{ id: "a", title: "A", due: "2026年10月" }]);
  assert.equal(items[0].due, "");
  assert.ok(warnings.some((w) => /不是 YYYY-MM-DD/.test(w)));
});

test("tasks 和 unknowns 收进来，供细化那一步给人看", () => {
  const { items } = normalizeRadarItems([
    { id: "a", title: "A", tasks: ["升 compileSdk", "", "回归"], unknowns: ["要不要声明前台服务类型"] },
  ]);
  assert.deepEqual(items[0].tasks, ["升 compileSdk", "回归"]);
  assert.deepEqual(items[0].unknowns, ["要不要声明前台服务类型"]);
});

// 新提的条目和新建的流程是一起提交的，流程认领它们天经地义
test("流程可以认领这一轮新提的条目，不算引用不存在", () => {
  const result = normalizeRadarPlan({
    items: [{ id: "brand-new", title: "新的" }],
    flows: [{ action: "create", flowId: "watch", owns: ["brand-new"] }],
  }, null);
  assert.equal(result.items.length, 1);
  assert.equal(result.warnings.some((w) => /声称负责 brand-new/.test(w)), false);
});

// 人只该回答「要盯什么」。板叫什么是规划的产出，问他等于把内部字段摊在他脸上
test("新板时提示词要求规划自己给板名和板 id", () => {
  const prompt = buildRadarPlanPrompt({ board: null, ask: "盯三方 SDK 合规" });
  assert.match(prompt, /"board": \{ "title"/);
  assert.match(prompt, /id 会进深链/);
});

test("板已经存在时不再问板名——id 定了就不改", () => {
  const prompt = buildRadarPlanPrompt({ board: boardFixture(), ask: "再加一条" });
  assert.equal(/"board": \{ "title"/.test(prompt), false);
  assert.match(prompt, /板 id 是 compliance/);
});

test("收下规划取的板名和板 id", () => {
  const result = normalizeRadarPlan({
    board: { title: "三方 SDK 合规", id: "SDK-Compliance" },
    items: [{ id: "privacy-manifest", title: "隐私清单" }],
    flows: [{ action: "create", flowId: "watch", owns: ["privacy-manifest"] }],
  }, null);
  assert.equal(result.board.title, "三方 SDK 合规");
  // 大小写不该成为建板失败的理由，但落盘前必须归一
  assert.equal(result.board.id, "sdk-compliance");
});

// 板 id 会进文件名、深链和 `--board=`，拿一个带斜杠的进去就是路径穿越
test("板 id 不合法就丢掉并点名，不静默改写", () => {
  const result = normalizeRadarPlan({
    board: { title: "坏板", id: "../etc/passwd" },
    items: [{ id: "x-one", title: "一条" }],
    flows: [{ action: "create", flowId: "watch", owns: ["x-one"] }],
  }, null);
  assert.equal(result.board.id, "");
  assert.ok(result.warnings.some((w) => /板 id 不合法/.test(w)));
});

test("规划没给 board 时不炸，给空字符串让面板自己兜底", () => {
  const result = normalizeRadarPlan({ items: [], flows: [] }, null);
  assert.deepEqual(result.board, { title: "", id: "" });
});

// ── 解析容错 ──────────────────────────────────────────────────────────
// 规划一次要跑一两分钟。为了一个尾逗号让人从头再来，比多写几十行解析贵得多

test("尾逗号不该让一份计划作废", () => {
  const result = parseRadarPlan('{"summary":"a","items":[],}');
  assert.equal(result.ok, true);
  assert.equal(result.plan.summary, "a");
});

// 「第一个 { 到最后一个 }」会被 JSON 后面那句带括号的话切歪
test("JSON 后面还有话时，只取那段 JSON", () => {
  const result = parseRadarPlan('{"summary":"x","flows":[{"flowId":"watch"}]} 备注：{待确认}');
  assert.equal(result.ok, true);
  assert.equal(result.plan.summary, "x");
});

test("模型先给示例再给真计划时，挑更像计划的那份", () => {
  const result = parseRadarPlan([
    "举个例子：", "```json", '{"summary":"示例"}', "```",
    "真正的计划：", "```json",
    '{"summary":"真的","items":[{"id":"a"}],"flows":[{"flowId":"watch"}]}', "```",
  ].join("\n"));
  assert.equal(result.ok, true);
  assert.equal(result.plan.summary, "真的");
});

test("整行 // 注释也收", () => {
  const result = parseRadarPlan('{\n  // 这条先不加\n  "summary":"y","items":[]\n}');
  assert.equal(result.ok, true);
  assert.equal(result.plan.summary, "y");
});

// 字符串里的括号不算边界，不然一句带 { 的文案就把结构切断了
test("字符串里的大括号不当成结构", () => {
  const result = parseRadarPlan('{"summary":"见附录 { 三 }","items":[]}');
  assert.equal(result.ok, true);
  assert.equal(result.plan.summary, "见附录 { 三 }");
});

test("真的没有 JSON 时照样报错，不编一份出来", () => {
  const result = parseRadarPlan("我想了想，还是写成文字吧");
  assert.equal(result.ok, false);
  assert.match(result.error, /不是可解析的 JSON/);
});

// 第二轮看不到第一轮的上下文，只说「重发」的结果是它凭印象重编一份
test("重发提示词要把原任务整段带上", () => {
  const prompt = buildRadarPlanRepairPrompt("原来的任务正文", "上一轮乱七八糟的输出");
  assert.match(prompt, /原来的任务正文/);
  assert.match(prompt, /上一轮乱七八糟的输出/);
  assert.match(prompt, /只是重新输出，不是重新规划/);
});
