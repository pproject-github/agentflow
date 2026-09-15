import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PLAN_FLOW_ID,
  ensurePlanFlow,
  planTemplateFile,
  readPlanResult,
  withPlanInputs,
} from "../bin/lib/radar-plan-flow.mjs";

function withTemp(run) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-plan-flow-")));
  try { return run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

/** 把 flow-write 那两个依赖换成最小实现，用例只关心装没装、覆没覆盖 */
function deps(root, template = "export const a = 1;\n") {
  return {
    resolveFlowDirForWrite: (_root, flowId) => ({ flowDir: path.join(root, "pipelines", flowId) }),
    createEmptyFlow: (_root, flowId) => {
      fs.mkdirSync(path.join(root, "pipelines", flowId), { recursive: true });
      return { success: true };
    },
    readTemplate: () => template,
  };
}

const graph = () => ({
  instances: {
    ask: { definitionId: "provide_str", output: [{ name: "value", value: "默认那句话" }] },
    boardId: { definitionId: "provide_str", output: [{ name: "value", value: "" }] },
    run: { definitionId: "workspace_run" },
  },
});

test("包里那份模板是存在的——它是这条路的起点", () => {
  assert.ok(fs.existsSync(planTemplateFile()));
  assert.match(fs.readFileSync(planTemplateFile(), "utf-8"), /agentflow\/flow/);
});

test("没装过就装一份", () => {
  withTemp((root) => {
    const result = ensurePlanFlow({ workspaceRoot: root, userId: "u", deps: deps(root) });
    assert.equal(result.ok, true);
    assert.equal(result.installed, "created");
    assert.equal(fs.readFileSync(path.join(result.flowDir, "workspace.flow.js"), "utf-8"), "export const a = 1;\n");
  });
});

test("已经是最新模板就什么都不做", () => {
  withTemp((root) => {
    ensurePlanFlow({ workspaceRoot: root, userId: "u", deps: deps(root) });
    const again = ensurePlanFlow({ workspaceRoot: root, userId: "u", deps: deps(root) });
    assert.equal(again.installed, "current");
  });
});

test("装进去之后没人动过，模板更新时跟着换", () => {
  withTemp((root) => {
    ensurePlanFlow({ workspaceRoot: root, userId: "u", deps: deps(root, "旧模板\n") });
    const refreshed = ensurePlanFlow({ workspaceRoot: root, userId: "u", deps: deps(root, "新模板\n") });
    assert.equal(refreshed.installed, "refreshed");
    assert.equal(fs.readFileSync(path.join(refreshed.flowDir, "workspace.flow.js"), "utf-8"), "新模板\n");
  });
});

// 能改规划过程，是把规划做成流程的理由之一。一次刷新不该把人的改动抹掉
test("人改过就不再覆盖，哪怕模板更新了", () => {
  withTemp((root) => {
    const first = ensurePlanFlow({ workspaceRoot: root, userId: "u", deps: deps(root, "旧模板\n") });
    fs.writeFileSync(path.join(first.flowDir, "workspace.flow.js"), "我改过了\n", "utf-8");
    const kept = ensurePlanFlow({ workspaceRoot: root, userId: "u", deps: deps(root, "新模板\n") });
    assert.equal(kept.installed, "kept-local-edits");
    assert.equal(fs.readFileSync(path.join(kept.flowDir, "workspace.flow.js"), "utf-8"), "我改过了\n");
  });
});

test("把这次要问的话写进 provide 节点，不碰磁盘上的图", () => {
  const source = graph();
  const { ok, graph: next } = withPlanInputs(source, { ask: "盯三方 SDK 合规", board: "sdk" });
  assert.equal(ok, true);
  assert.equal(next.instances.ask.output[0].value, "盯三方 SDK 合规");
  assert.equal(next.instances.boardId.output[0].value, "sdk");
  // 原图不动：它还要留给下一次准备
  assert.equal(source.instances.ask.output[0].value, "默认那句话");
});

/**
 * 拿默认值跑下去，结果是它照着模板里那句话去规划，而人问的是别的——
 * 一份看起来正常、实际答非所问的计划，比一个报错难发现得多。
 */
test("图被改得找不到输入节点时拒绝放行，而不是拿默认值去跑", () => {
  const broken = { instances: { somethingElse: { definitionId: "provide_str", output: [] } } };
  const result = withPlanInputs(broken, { ask: "盯什么" });
  assert.equal(result.ok, false);
  assert.match(result.error, /ask/);
  assert.match(result.error, /boardId/);
});

/** 计划存在雷达自己的数据目录，一次运行一份。用例里把定位函数换掉就行 */
function planAt(root) {
  return { radarPlanFile: (runId) => (runId ? `${root}/plans/${runId}.json` : "") };
}

test("取计划：没 runId 就说取不了，不去猜哪份是你的", () => {
  withTemp((root) => {
    const result = readPlanResult({ runId: "", deps: planAt(root) });
    assert.equal(result.ok, false);
    assert.match(result.error, /runId/);
  });
});

test("取计划：这次没留下东西就说没留下", () => {
  withTemp((root) => {
    assert.equal(readPlanResult({ runId: "r1", deps: planAt(root) }).ok, false);
  });
});

test("取计划：正常取回", () => {
  withTemp((root) => {
    fs.mkdirSync(path.join(root, "plans"), { recursive: true });
    fs.writeFileSync(path.join(root, "plans", "r1.json"),
      JSON.stringify({ runId: "r1", ok: true, plan: { summary: "s" } }), "utf-8");
    const result = readPlanResult({ runId: "r1", deps: planAt(root) });
    assert.equal(result.ok, true);
    assert.equal(result.plan.summary, "s");
  });
});

// 并行规划时，按 runId 分文件本身就挡住了「拿到别人那份计划」
test("取计划：别人那次的 runId 落在另一个文件上，取不到你的", () => {
  withTemp((root) => {
    fs.mkdirSync(path.join(root, "plans"), { recursive: true });
    fs.writeFileSync(path.join(root, "plans", "别人的.json"),
      JSON.stringify({ runId: "别人的", ok: true, plan: { summary: "不是你的" } }), "utf-8");
    assert.equal(readPlanResult({ runId: "我的", deps: planAt(root) }).ok, false);
  });
});

test("取计划：两轮都没成时把报告带回去，人才知道卡在哪", () => {
  withTemp((root) => {
    fs.mkdirSync(path.join(root, "plans"), { recursive: true });
    fs.writeFileSync(path.join(root, "plans", "r1.json"),
      JSON.stringify({ runId: "r1", ok: false, error: "没解析出来", report: "# 报告" }), "utf-8");
    const result = readPlanResult({ runId: "r1", deps: planAt(root) });
    assert.equal(result.ok, false);
    assert.equal(result.error, "没解析出来");
    assert.match(result.report, /报告/);
  });
});

test("PLAN_FLOW_ID 是 radar-plan——它会进用户的流程目录和运行记录", () => {
  assert.equal(PLAN_FLOW_ID, "radar-plan");
});
