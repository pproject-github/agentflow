import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFINITIONS,
  apiName,
  definitionIdFromApi,
  flowFilesToGraph,
  graphToFlowFiles,
  graphToIr,
} from "../bin/lib/flow-dsl/index.mjs";
import { lintFlowDir } from "../bin/lib/flow-dsl/lint.mjs";
import { exportFlowDsl, importFlowDsl } from "../bin/lib/flow-dsl/cli.mjs";
import { splitWorkspaceGraph } from "../bin/lib/workspace-state.mjs";

/** 边身份：按槽名比，不按句柄下标——下标由 pinOrder 决定，不是语义。 */
function edgeIdentity(graph) {
  const idx = (h) => Number(/-(\d+)$/.exec(String(h || ""))?.[1] ?? 0);
  return new Set((graph.edges || []).map((e) => {
    const from = graph.instances[e.source]?.output?.[idx(e.sourceHandle)]?.name;
    const to = graph.instances[e.target]?.input?.[idx(e.targetHandle)]?.name;
    return `${e.source}|${from}|${e.target}|${to}`;
  }));
}

function assertGraphRoundTrip(graph, label) {
  const out = graphToFlowFiles(graph);
  const back = flowFilesToGraph(out);
  const design = splitWorkspaceGraph(graph).design;

  assert.deepEqual(
    Object.keys(back.instances).sort(),
    Object.keys(design.instances).sort(),
    `${label}: 节点集合不一致`,
  );

  const before = edgeIdentity(design);
  const after = edgeIdentity(back);
  assert.deepEqual([...after].sort(), [...before].sort(), `${label}: 边身份不一致`);

  // 幂等：把还原出来的图再生成一次，源码必须逐字相同
  assert.equal(graphToFlowFiles(back).source, out.source, `${label}: 代码生成不幂等`);
  return { out, back, design };
}

test("definitionId 与 DSL 调用名是双射", () => {
  const ids = Object.keys(DEFINITIONS);
  assert.ok(ids.length >= 46, `只加载到 ${ids.length} 个定义`);
  const seen = new Map();
  for (const id of ids) {
    const name = apiName(id);
    assert.equal(definitionIdFromApi(name), id, `${id} -> ${name} 反解不回来`);
    assert.equal(seen.has(name), false, `调用名 ${name} 被 ${seen.get(name)} 和 ${id} 同时占用`);
    seen.set(name, id);
  }
});

test("节点 id 与 DSL API 保留名冲突时给 import 起别名，实例 id 保持不变", () => {
  const long = "冲突名流程仍要代码化。".repeat(400);
  const provided = (value) => ({
    definitionId: "provide_str",
    input: [],
    output: [{ type: "text", name: "value", value }],
  });
  const graph = {
    version: 1,
    instances: {
      flow: {
        definitionId: "workspace_run",
        label: "Run",
        input: [{ type: "node", name: "prev" }],
        output: [{ type: "node", name: "next" }],
      },
      display: {
        definitionId: "display_markdown",
        label: "展示",
        body: long,
        input: [{ type: "node", name: "prev" }, { type: "text", name: "content", value: long }],
        output: [{ type: "text", name: "content" }, { type: "node", name: "next" }],
      },
      agent: provided("agent"),
      control: provided("control"),
      file: provided("file"),
      provide: provided("provide"),
      tool: provided("tool"),
      workspace: provided("workspace"),
    },
    edges: [{ source: "flow", target: "display", sourceHandle: "output-0", targetHandle: "input-0" }],
    ui: { nodePositions: {} },
  };

  const { out, back } = assertGraphRoundTrip(graph, "DSL API 保留名");
  for (const name of ["agent", "control", "display", "file", "flow", "provide", "tool", "workspace"]) {
    assert.match(out.source, new RegExp(`\\b${name} as ${name}Api\\b`), `${name} import 没有避让同名节点`);
  }
  assert.match(out.source, /const display = displayApi\.markdown/);
  assert.match(out.source, /export const flow = flowApi\("Run", display\)/);
  assert.match(out.source, /fileApi\("docs\/display\.content\.md"\)/);
  assert.equal(back.instances.display.body, long);
  assert.equal(back.instances.display.input.find((slot) => slot.name === "content")?.value, long);
});

test("线性流程往返：节点、边、幂等", () => {
  const graph = {
    version: 1,
    instances: {
      run_1: {
        definitionId: "workspace_run",
        label: "Run",
        input: [{ type: "node", name: "prev" }],
        output: [{ type: "node", name: "next" }],
      },
      str_1: {
        definitionId: "provide_str",
        label: "日期",
        input: [{ type: "node", name: "prev" }],
        output: [{ type: "node", name: "next" }, { type: "text", name: "value", value: "2026-08-07" }],
      },
      agent_1: {
        definitionId: "agent_subAgent",
        label: "分析",
        body: "读日期然后分析",
        input: [
          { type: "node", name: "prev" },
          { type: "text", name: "workspaceContext" },
          { type: "text", name: "skillsContext" },
          { type: "text", name: "mcpContext" },
          { type: "text", name: "knowledgeContext" },
          { type: "text", name: "date" },
        ],
        output: [{ type: "node", name: "next" }, { type: "text", name: "result" }],
      },
      md_1: {
        definitionId: "display_markdown",
        label: "展示",
        input: [{ type: "node", name: "prev" }, { type: "text", name: "content" }],
        output: [{ type: "node", name: "next" }],
      },
    },
    edges: [
      { source: "run_1", target: "agent_1", sourceHandle: "output-0", targetHandle: "input-0" },
      { source: "str_1", target: "agent_1", sourceHandle: "output-1", targetHandle: "input-5" },
      { source: "agent_1", target: "md_1", sourceHandle: "output-0", targetHandle: "input-0" },
      { source: "agent_1", target: "md_1", sourceHandle: "output-1", targetHandle: "input-1" },
    ],
    ui: { nodePositions: { run_1: { x: 0, y: 0 } } },
  };
  const { out } = assertGraphRoundTrip(graph, "线性流程");

  assert.match(out.source, /export const run_1 = flow\("Run", agent_1, md_1\)/);
  assert.match(out.source, /agent\.subAgent\("分析"/);
  assert.match(out.source, /date: str_1\.value/);
  assert.match(out.source, /content: agent_1\.result/);
});

test("control.if 的分支进第 3、4 个参数，不被拍平成串行", () => {
  const slots = (extra = []) => ({
    input: [{ type: "node", name: "prev" }, ...extra],
    output: [{ type: "node", name: "next" }],
  });
  const graph = {
    version: 1,
    instances: {
      run_1: { definitionId: "workspace_run", ...slots() },
      b_1: {
        definitionId: "provide_bool",
        input: [{ type: "node", name: "prev" }],
        output: [{ type: "node", name: "next" }, { type: "bool", name: "value", value: "true" }],
      },
      if_1: {
        definitionId: "control_if",
        input: [{ type: "node", name: "prev" }, { type: "bool", name: "prediction" }],
        output: [{ type: "node", name: "next1" }, { type: "node", name: "next2" }],
      },
      yes_1: { definitionId: "display_markdown", ...slots([{ type: "text", name: "content" }]) },
      no_1: { definitionId: "display_markdown", ...slots([{ type: "text", name: "content" }]) },
    },
    edges: [
      { source: "run_1", target: "if_1", sourceHandle: "output-0", targetHandle: "input-0" },
      { source: "b_1", target: "if_1", sourceHandle: "output-1", targetHandle: "input-1" },
      { source: "if_1", target: "yes_1", sourceHandle: "output-0", targetHandle: "input-0" },
      { source: "if_1", target: "no_1", sourceHandle: "output-1", targetHandle: "input-0" },
    ],
    ui: { nodePositions: {} },
  };
  const { out } = assertGraphRoundTrip(graph, "分支");
  assert.match(out.source, /control\.if\(\{[\s\S]*?prediction: b_1\.value,[\s\S]*?\}, flow\(yes_1\), flow\(no_1\)\)/);
});

test("控制流分叉走 flow.fork，不被串行化", () => {
  const disp = () => ({
    definitionId: "display_markdown",
    input: [{ type: "node", name: "prev" }, { type: "text", name: "content" }],
    output: [{ type: "node", name: "next" }],
  });
  const graph = {
    version: 1,
    instances: {
      run_1: {
        definitionId: "workspace_run",
        input: [{ type: "node", name: "prev" }],
        output: [{ type: "node", name: "next" }],
      },
      a_1: disp(),
      b_1: disp(),
    },
    edges: [
      { source: "run_1", target: "a_1", sourceHandle: "output-0", targetHandle: "input-0" },
      { source: "run_1", target: "b_1", sourceHandle: "output-0", targetHandle: "input-0" },
    ],
    ui: { nodePositions: {} },
  };
  const { out } = assertGraphRoundTrip(graph, "分叉");
  assert.match(out.source, /flow\.fork\(flow\(a_1\), flow\(b_1\)\)/);
});

test("排程配置进 flow.schedule 的第二个参数", () => {
  const cron = '{"enabled":true,"cron":"0 9 * * *","timezone":"Asia/Shanghai"}';
  const graph = {
    version: 1,
    instances: {
      sched_1: {
        definitionId: "workspace_scheduled_run",
        label: "每日",
        body: cron,
        input: [{ type: "node", name: "prev" }],
        output: [{ type: "node", name: "next" }],
      },
      md_1: {
        definitionId: "display_markdown",
        body: "手写文档",
        input: [{ type: "node", name: "prev" }, { type: "text", name: "content" }],
        output: [{ type: "node", name: "next" }],
      },
    },
    edges: [{ source: "sched_1", target: "md_1", sourceHandle: "output-0", targetHandle: "input-0" }],
    ui: { nodePositions: {} },
  };
  const { out, back } = assertGraphRoundTrip(graph, "排程");
  assert.match(out.source, /flow\.schedule\("每日", `?\{"enabled":true/);
  assert.equal(back.instances.sched_1.body, cron, "cron 配置没还原");
  assert.equal(back.instances.md_1.body, "手写文档", "无内容入边的展示节点正文丢了");
});

test("自定义输出槽用解构声明，并能还原成边", () => {
  const graph = {
    version: 1,
    instances: {
      run_1: {
        definitionId: "workspace_run",
        input: [{ type: "node", name: "prev" }],
        output: [{ type: "node", name: "next" }],
      },
      agent_1: {
        definitionId: "agent_subAgent",
        body: "产出 storyId",
        input: [{ type: "node", name: "prev" }],
        output: [
          { type: "node", name: "next" },
          { type: "text", name: "result" },
          { type: "text", name: "storyId" },
        ],
      },
      agent_2: {
        definitionId: "agent_subAgent",
        body: "用 storyId",
        input: [{ type: "node", name: "prev" }, { type: "text", name: "storyId" }],
        output: [{ type: "node", name: "next" }, { type: "text", name: "result" }],
      },
    },
    edges: [
      { source: "run_1", target: "agent_1", sourceHandle: "output-0", targetHandle: "input-0" },
      { source: "agent_1", target: "agent_2", sourceHandle: "output-0", targetHandle: "input-0" },
      { source: "agent_1", target: "agent_2", sourceHandle: "output-2", targetHandle: "input-1" },
    ],
    ui: { nodePositions: {} },
  };
  const { out } = assertGraphRoundTrip(graph, "自定义输出槽");
  assert.match(out.source, /const \{ storyId \} = agent_1;/);
  assert.match(out.source, /storyId: storyId/);
});

test("超长文本外置成文件，代码里写 file()", () => {
  const long = "很长的提示词。".repeat(600);
  assert.ok(long.length > 3000);
  const graph = {
    version: 1,
    instances: {
      run_1: {
        definitionId: "workspace_run",
        input: [{ type: "node", name: "prev" }],
        output: [{ type: "node", name: "next" }],
      },
      agent_1: {
        definitionId: "agent_subAgent",
        body: long,
        input: [{ type: "node", name: "prev" }],
        output: [{ type: "node", name: "next" }, { type: "text", name: "result" }],
      },
    },
    edges: [{ source: "run_1", target: "agent_1", sourceHandle: "output-0", targetHandle: "input-0" }],
    ui: { nodePositions: {} },
  };
  const { out, back } = assertGraphRoundTrip(graph, "外置长文本");
  assert.match(out.source, /file\("prompts\/agent_1\.md"\)/);
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].text, long);
  assert.equal(back.instances.agent_1.body, long, "外置后正文没还原");
});

test("非规范槽序由 layout.pinOrder 保留，句柄下标能还原", () => {
  const graph = {
    version: 1,
    instances: {
      run_1: {
        definitionId: "workspace_run",
        input: [{ type: "node", name: "prev" }],
        output: [{ type: "node", name: "next" }],
      },
      md_1: {
        definitionId: "display_markdown",
        // content 在前、prev 在后：偏离定义表顺序
        input: [{ type: "text", name: "content" }, { type: "node", name: "prev" }],
        output: [{ type: "node", name: "next" }],
      },
    },
    edges: [{ source: "run_1", target: "md_1", sourceHandle: "output-0", targetHandle: "input-1" }],
    ui: { nodePositions: {} },
  };
  const { out, back } = assertGraphRoundTrip(graph, "非规范槽序");
  assert.deepEqual(out.layout.nodes.md_1.pinOrder.in, ["content", "prev"]);
  assert.deepEqual(back.instances.md_1.input.map((s) => s.name), ["content", "prev"]);
  assert.equal(back.edges[0].targetHandle, "input-1", "句柄下标没按 pinOrder 还原");
});

test("图片与机器管理属性进 nodes.json，不进代码", () => {
  const graph = {
    version: 1,
    instances: {
      agent_1: {
        definitionId: "agent_subAgent",
        body: "看图",
        model: "claude-opus-5",
        images: [{ dataUrl: "data:image/png;base64,AAAA" }],
        input: [{ type: "node", name: "prev" }],
        output: [{ type: "node", name: "next" }, { type: "text", name: "result" }],
      },
    },
    edges: [],
    ui: { nodePositions: {} },
  };
  const { out, back } = assertGraphRoundTrip(graph, "节点元数据");
  assert.equal(out.source.includes("base64"), false, "图片数据不该出现在代码里");
  assert.equal(out.source.includes("claude-opus-5"), false, "model 不该出现在代码里");
  assert.deepEqual(out.nodeMeta.nodes.agent_1.images, graph.instances.agent_1.images);
  assert.equal(out.nodeMeta.nodes.agent_1.model, "claude-opus-5");
  assert.deepEqual(back.instances.agent_1.images, graph.instances.agent_1.images);
  assert.equal(back.instances.agent_1.model, "claude-opus-5");
});

test("ui.groups 这类未知 ui 键原样透传", () => {
  const graph = {
    version: 1,
    instances: {},
    edges: [],
    ui: { nodePositions: {}, groups: [], displayPage: { mode: "grid" } },
  };
  const out = graphToFlowFiles(graph);
  assert.deepEqual(out.layout.groups, []);
  assert.deepEqual(out.layout.displayPage, { mode: "grid" });
  const back = flowFilesToGraph(out);
  assert.deepEqual(back.ui.groups, []);
  assert.deepEqual(back.ui.displayPage, { mode: "grid" });
});

function writeFlowDir(source, extra = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-dsl-lint-")));
  fs.writeFileSync(path.join(dir, "workspace.flow.js"), source, "utf-8");
  for (const [rel, text] of Object.entries(extra)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf-8");
  }
  return dir;
}

test("lint 拒绝结构文件里的控制流", () => {
  const dir = writeFlowDir(`import { agent, flow } from "agentflow/flow";
for (const i of [1, 2]) {}
export const run = flow();
`);
  try {
    const { errors } = lintFlowDir(dir);
    assert.ok(errors.some((e) => e.includes("for-of")), `没报出 for-of：${errors.join(" / ")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lint 报出运行时无实现的节点类型", () => {
  const dir = writeFlowDir(`import { control, flow, tool } from "agentflow/flow";
const p1 = tool.print({});
export const run = flow(p1);
`);
  try {
    const { errors } = lintFlowDir(dir);
    assert.ok(
      errors.some((e) => e.includes("tool_print") && e.includes("没有 Workspace 运行时实现")),
      `没报出 tool_print：${errors.join(" / ")}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lint 报出 fan-in 与不存在的槽", () => {
  const dir = writeFlowDir(`import { agent, display, flow } from "agentflow/flow";
const a1 = agent.subAgent({}, "一");
const a2 = agent.subAgent({}, "二");
const d1 = display.markdown({ content: a1.result });
const d2 = display.markdown({ content: a2.result, nosuch: a1.result });
export const run = flow(a1, a2, d1, d2);
`);
  try {
    const { errors } = lintFlowDir(dir);
    assert.ok(errors.some((e) => e.includes("不存在的输入槽")), `没报出不存在的槽：${errors.join(" / ")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lint 要求 control.if 的 prediction 接 bool", () => {
  const dir = writeFlowDir(`import { agent, control, display, flow } from "agentflow/flow";
const a1 = agent.subAgent({}, "判断");
const yes = display.markdown({});
const if1 = control.if({ prediction: a1.result }, flow(yes), flow());
export const run = flow(a1, if1);
`);
  try {
    const { errors } = lintFlowDir(dir);
    assert.ok(
      errors.some((e) => e.includes("prediction 只能接 bool")),
      `没报出类型不符：${errors.join(" / ")}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lint 报出环", () => {
  const dir = writeFlowDir(`import { agent, flow } from "agentflow/flow";
const a1 = agent.subAgent({ x: a2.result }, "一");
const a2 = agent.subAgent({ x: a1.result }, "二");
export const run = flow(a1, a2);
`);
  try {
    const { errors } = lintFlowDir(dir);
    assert.ok(errors.some((e) => e.includes("存在环")), `没报出环：${errors.join(" / ")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lint 报出 file() 指向的文件不存在", () => {
  const dir = writeFlowDir(`import { agent, file, flow } from "agentflow/flow";
const a1 = agent.subAgent({}, file("prompts/missing.md"));
export const run = flow(a1);
`);
  try {
    const { errors } = lintFlowDir(dir);
    assert.ok(errors.some((e) => e.includes("指向的文件不存在")), `没报出缺文件：${errors.join(" / ")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("干净的流程 lint 零错误", () => {
  const dir = writeFlowDir(`import { agent, display, flow, provide } from "agentflow/flow";

export const str_1 = provide.str("日期", {
  value: "2026-08-07",
});

const agent_1 = agent.subAgent("分析", {
  date: str_1.value,
}, "按日期分析");

const md_1 = display.markdown("展示", {
  content: agent_1.result,
});

export const run_1 = flow("Run", agent_1, md_1);
`);
  try {
    const { errors } = lintFlowDir(dir);
    assert.deepEqual(errors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI export/import 往返，运行态不受影响", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-dsl-cli-")));
  try {
    const flowDir = path.join(root, "flow");
    fs.mkdirSync(flowDir, { recursive: true });
    const graph = {
      version: 1,
      instances: {
        run_1: {
          definitionId: "workspace_run",
          label: "Run",
          input: [{ type: "node", name: "prev" }],
          output: [{ type: "node", name: "next" }],
        },
        agent_1: {
          definitionId: "agent_subAgent",
          label: "干活",
          body: "写点东西",
          input: [{ type: "node", name: "prev" }],
          output: [
            { type: "node", name: "next" },
            { type: "text", name: "result", value: "上次跑出来的产出" },
          ],
        },
      },
      edges: [{ source: "run_1", target: "agent_1", sourceHandle: "output-0", targetHandle: "input-0" }],
      ui: { nodePositions: { agent_1: { x: 10, y: 20 } } },
    };
    const { design, state } = splitWorkspaceGraph(graph);
    fs.writeFileSync(path.join(flowDir, "workspace.graph.json"), JSON.stringify(design, null, 2), "utf-8");
    fs.writeFileSync(path.join(flowDir, "workspace.state.json"), JSON.stringify(state, null, 2), "utf-8");

    const exported = exportFlowDsl(flowDir, path.join(root, "dsl"));
    assert.ok(exported.written.includes("workspace.flow.js"));
    const source = fs.readFileSync(path.join(exported.outDir, "workspace.flow.js"), "utf-8");
    assert.equal(source.includes("上次跑出来的产出"), false, "运行产出不该进代码");

    const imported = importFlowDsl(exported.outDir, path.join(root, "back"));
    const back = JSON.parse(fs.readFileSync(imported.graphPath, "utf-8"));
    assert.deepEqual(Object.keys(back.instances).sort(), ["agent_1", "run_1"]);
    assert.equal(back.instances.agent_1.body, "写点东西");
    assert.deepEqual(back.ui.nodePositions.agent_1, { x: 10, y: 20 });
    // 运行态文件没被导入流程碰过
    const keptState = JSON.parse(fs.readFileSync(path.join(flowDir, "workspace.state.json"), "utf-8"));
    assert.equal(keptState.outputs.agent_1.result.value, "上次跑出来的产出");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lint 不过时 import 直接拒绝，不写出半张图", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-dsl-reject-")));
  try {
    const dir = path.join(root, "dsl");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "workspace.flow.js"),
      `import { flow, tool } from "agentflow/flow";\nconst p = tool.print({});\nexport const run = flow(p);\n`,
      "utf-8",
    );
    assert.throws(() => importFlowDsl(dir, path.join(root, "out")), /lint 未通过/);
    assert.equal(fs.existsSync(path.join(root, "out", "workspace.graph.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("IR 的边按槽名而不是句柄下标记录", () => {
  const graph = {
    version: 1,
    instances: {
      a: {
        definitionId: "agent_subAgent",
        input: [{ type: "node", name: "prev" }],
        output: [{ type: "node", name: "next" }, { type: "text", name: "result" }],
      },
      b: {
        definitionId: "display_markdown",
        input: [{ type: "node", name: "prev" }, { type: "text", name: "content" }],
        output: [{ type: "node", name: "next" }],
      },
    },
    edges: [{ source: "a", target: "b", sourceHandle: "output-1", targetHandle: "input-1" }],
    ui: { nodePositions: {} },
  };
  const ir = graphToIr(graph);
  assert.deepEqual(ir.edges, ["a|result|b|content"]);
});
