/**
 * 自定义输入槽的类型：随连它的那个上游输出槽走。
 *
 * 代码里 `{ sample: count.sample }` 只说了「接哪」，说不出这个槽是什么类型。以前一律建成
 * `text`，而运行时 `workspaceLinkedOutputShouldStayPath` 看的正是**目标槽**的 type——`file`
 * 才保留路径，否则把文件内容读出来内联。于是一个 `file` 输出接过去，`tool_nodejs` 的脚本
 * 拿到的是整个文件内容，还被 shell 引号包住：
 *
 *     wc -l < '2026-08-10 row-1
 *     2026-08-10 row-2'          →  No such file or directory
 *
 * 唯一能救的是名字启发式（`xxxPath` / `xxxFile` 结尾）——对不对全看作者怎么起名。
 *
 * 改成随上游走之后要守两条：新写的代码类型是对的；**存量图一个字都不能变**——线上 21 个
 * 流程里有槽是 `text` 却接着非 text 输出的，推断值和实际值不一致，必须由 layout 记一条偏离
 * 兜住，否则保存时往返对不上，整张图退回 workspace.graph.json。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { flowFilesToGraph, graphToFlowFiles } from "../bin/lib/flow-dsl/index.mjs";

const parse = (source) => flowFilesToGraph({ source, layout: {}, nodeMeta: {}, files: {} });
const inputType = (graph, nodeId, slotName) => (
  (graph.instances[nodeId].input || []).find((s) => s.name === slotName)?.type
);

test("自定义输入槽的类型随上游输出槽走", () => {
  // gitCheckout 的 repoPath 是 file、branch 是 text，一个节点上两种都有，正好对照
  const graph = parse(`import { flow, tool } from "agentflow/flow";

const co = tool.gitCheckout("拉代码", { repoUrl: "https://example.com/x.git" });
const use = tool.nodejs("用", { where: co.repoPath, which: co.branch }, \`ls \${where}\`);

export const run = flow("Run", co, use);
`);
  assert.equal(inputType(graph, "use", "where"), "file", "接 file 输出的槽必须是 file，否则运行时会把文件内容灌进来");
  assert.equal(inputType(graph, "use", "which"), "text");
});

test("没接线的自定义槽还是 text，bool 字面量仍由代码自己带回来", () => {
  const graph = parse(`import { flow, tool } from "agentflow/flow";

const a = tool.nodejs("A", { plain: "hi", flag: true }, \`echo \${plain}\`);

export const run = flow("Run", a);
`);
  assert.equal(inputType(graph, "a", "plain"), "text");
  assert.equal(inputType(graph, "a", "flag"), "bool", "bool 从字面量看得出来，不该被推断成 text");
});

test("上游是自定义输出槽（解构出来的）时退回 text", () => {
  // 解构声明的输出槽在定义表里查不到类型，推断无从下手，text 是安全默认
  const graph = parse(`import { agent, flow, tool } from "agentflow/flow";

const judge = agent.subAgent("判断", {}, \`回一个信封\`);
const { verdict } = judge;
const use = tool.nodejs("用", { got: verdict }, \`echo \${got}\`);

export const run = flow("Run", judge, use);
`);
  assert.equal(inputType(graph, "use", "got"), "text");
});

test("存量图里偏离推断的类型记进 layout，往返一个字不变", () => {
  // 手工构造一张「text 槽接着 file 输出」的历史图：推断说 file，实际是 text
  const graph = {
    version: 1,
    instances: {
      run: { definitionId: "workspace_run", output: [{ type: "node", name: "next" }] },
      co: {
        definitionId: "tool_git_checkout",
        input: [{ type: "node", name: "prev" }, { type: "text", name: "repoUrl", value: "https://example.com/x.git" }],
        output: [{ type: "node", name: "next" }, { type: "file", name: "repoPath", value: "" }],
      },
      use: {
        definitionId: "tool_nodejs",
        script: "ls ${where}",
        input: [{ type: "node", name: "prev" }, { type: "text", name: "where", value: "" }],
        output: [{ type: "node", name: "next" }, { type: "text", name: "result", value: "" }],
      },
    },
    edges: [
      { source: "run", target: "co", sourceHandle: "output-0", targetHandle: "input-0" },
      { source: "co", target: "use", sourceHandle: "output-0", targetHandle: "input-0" },
      { source: "co", target: "use", sourceHandle: "output-1", targetHandle: "input-1" },
    ],
    ui: { nodePositions: {} },
  };
  const out = graphToFlowFiles(graph);
  assert.equal(
    out.layout.nodes?.use?.pins?.in?.where?.type, "text",
    "推断值和实际值不一致时必须记一条偏离，否则历史图往返就变了",
  );
  const back = flowFilesToGraph(out);
  assert.equal(inputType(back, "use", "where"), "text", "记了偏离就该原样还原");
  // 幂等：再走一圈，layout 和源码都不能变
  const again = graphToFlowFiles(back);
  assert.equal(again.source, out.source);
  assert.deepEqual(again.layout, out.layout);
});

test("推断对得上时不记偏离——不给 layout 添无用条目", () => {
  const out = graphToFlowFiles(parse(`import { flow, tool } from "agentflow/flow";

const co = tool.gitCheckout("拉代码", { repoUrl: "https://example.com/x.git" });
const use = tool.nodejs("用", { where: co.repoPath }, \`ls \${where}\`);

export const run = flow("Run", co, use);
`));
  assert.equal(out.layout.nodes?.use?.pins, undefined, "类型和推断一致就不该出现在 layout 里");
});
