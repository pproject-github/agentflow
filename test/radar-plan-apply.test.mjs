import assert from "node:assert/strict";
import test from "node:test";

import { buildMonitorGraph, materializeFlow, planToPending } from "../bin/lib/radar-plan-apply.mjs";

const PLAN = {
  flows: [
    { action: "create", flowId: "repo-scan", cron: "0 9 * * *", owns: ["a", "b"], updates: ["state", "current"] },
    { action: "update", flowId: "policy-watch", cron: "0 9 * * 1", owns: ["*"], updates: ["due", "title"] },
    { action: "keep", flowId: "unchanged", owns: ["c"] },
  ],
};
const CTX = { board: "compliance", workspacePath: "/tmp/board" };

// 「有个流程要建」说了等于没说，人得知道批了之后会发生什么
test("提案正文说清楚跑多勤、认领多少、写哪些字段", () => {
  const held = planToPending(PLAN, CTX);
  assert.equal(held.length, 2, "keep 的不提案");
  assert.match(held[0].reason, /新建监控流程 repo-scan/);
  assert.match(held[0].reason, /按 0 9 \* \* \* 跑/);
  assert.match(held[0].reason, /认领 2 个条目/);
  assert.match(held[0].reason, /写 state\/current/);
  // 批准建它和让它开始烧 token 是两个决定
  assert.match(held[0].reason, /默认停用/);
  assert.match(held[1].reason, /调整监控流程 policy-watch/);
  assert.match(held[1].reason, /认领 全部条目/);
});

test("提案是 kind:flow，和字段改动分得开", () => {
  const [first] = planToPending(PLAN, CTX);
  assert.equal(first.kind, "flow");
  assert.equal(first.action, "create");
  assert.equal(first.flowSpec.board, "compliance");
});

/**
 * 授权范围要落进提示词里。只靠图的连线约束不住 agent 会写哪些字段——
 * 它拿到的是整个目录，什么都能改，得明确告诉它哪些不归它管。
 */
test("生成的提示词带上认领范围和字段边界", () => {
  const graph = buildMonitorGraph({
    flowId: "repo-scan", board: "compliance", workspacePath: "/tmp/board",
    cron: "0 9 * * *", owns: ["a", "b"], updates: ["state", "current"],
  });
  const prompt = graph.instances.work.body;
  assert.match(prompt, /你负责这些追踪项：a、b/);
  assert.match(prompt, /你只更新这几个字段：state \/ current。别的字段归别人管/);
  // 这条是整套设计的底线，模板里不能漏
  assert.match(prompt, /绝不能默认当成通过/);
  assert.match(prompt, /人写的「待确认」不要删/);
});

test("认领 * 时说「板上所有条目」，不要漏成空", () => {
  const graph = buildMonitorGraph({ flowId: "f", board: "b", workspacePath: "/w", owns: ["*"] });
  assert.match(graph.instances.work.body, /你负责这些追踪项：板上所有条目/);
});

// 建好就自动开跑的话，批准一份计划等于同时批了往后每天的开销
test("建出来的流程默认停用", () => {
  const graph = buildMonitorGraph({ flowId: "f", board: "b", workspacePath: "/w", cron: "0 9 * * *" });
  assert.deepEqual(JSON.parse(graph.instances.entry.body), {
    cron: "0 9 * * *", timezone: "Asia/Shanghai", enabled: false,
  });
});

test("sync 节点带 --gate 和 --flow-ref", () => {
  const graph = buildMonitorGraph({ flowId: "repo-scan", board: "compliance", workspacePath: "/w" });
  const script = graph.instances.sync.script;
  assert.match(script, /--gate/, "生成的流程必须开门禁，否则它写什么都直接落地");
  assert.match(script, /--flow-ref=repo-scan/, "分片名和流程同名时也要带，协作视图才认得出");
});

test("图是连通的：定时 → cd → skills → agent → sync", () => {
  const { edges } = buildMonitorGraph({ flowId: "f", board: "b", workspacePath: "/w" });
  const chain = edges.filter((e) => e.sourceHandle === "next").map((e) => `${e.source}->${e.target}`);
  assert.deepEqual(chain, ["run->entry", "entry->cd", "cd->skills", "skills->work", "work->sync"]);
  // 上下文也要接上，否则 agent 拿不到 workspace 和 skill
  assert.ok(edges.some((e) => e.sourceHandle === "skillsContext" && e.target === "work"));
  assert.ok(edges.some((e) => e.sourceHandle === "workspaceContext" && e.target === "work"));
});

// 计划可能是基于稍旧的板算的，重复建一次不该让整批卡住
test("流程已存在时不当成失败", () => {
  const result = materializeFlow({ flowId: "f", action: "create", board: "b", workspacePath: "/w" }, {
    workspaceRoot: "/root",
    resolveFlowDirForWrite: () => ({ flowDir: "/root/f" }),
    createEmptyFlow: () => ({ success: false, error: "流程已存在" }),
    writeWorkspaceGraph: () => ({ format: "dsl" }),
  });
  assert.equal(result.ok, true);
});

test("图写不成代码时如实报错，不假装建好了", () => {
  const result = materializeFlow({ flowId: "f", action: "create", board: "b", workspacePath: "/w" }, {
    workspaceRoot: "/root",
    resolveFlowDirForWrite: () => ({ flowDir: "/root/f" }),
    createEmptyFlow: () => ({ success: true }),
    writeWorkspaceGraph: () => ({ format: "json", degradedReason: "有节点表达不了" }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /有节点表达不了/);
});
