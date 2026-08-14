import { agent, control, display, flow, provide, tool } from "agentflow/flow";

// ── 输入 ────────────────────────────────────────────────────────────
const requirement = provide.str("需求描述", {
  value: "把每天早上的三份数据源汇总成一份日报",
});
const flowId = provide.str("新流程 ID", {
  value: "my-new-flow",
});

// 规划和落地都得照 DSL 语法写，技能直接注入，不再单独跑一个收集节点
const skills = control.loadSkills("加载 DSL 技能", {
  skillKeys: "agentflow-flow-dsl,agentflow-node-reference",
});

// ── ① 规划 ──────────────────────────────────────────────────────────
const plan = agent.subAgent("规划节点图", {
  skillsContext: skills.skillsContext,
}, `需求：${requirement.value}

按 agentflow-flow-dsl 技能里的写法，为流程 ${flowId.value} 规划一张 Workspace 图。**只出方案，不写任何文件。**

逐条列出：
1. 每个节点的变量名、节点类型（agent.subAgent / tool.nodejs / display.* / provide.* …）、做什么
2. 控制流顺序，分支怎么走
3. 数据边：谁的哪个输出接到谁的哪个引脚
4. 需要哪些脚本文件，各自的输入输出

把下面这几条约束在方案里逐条对照一遍，方便当场否掉不可行的设计：
- 不能有环。「改到通过为止」只能展开成固定轮次的嵌套 gate
- 一个输入只能接一条边，两条分支不能汇合
- provide.* 没有 prev/next，不要放进 flow(...) 链，被谁引用就跟谁跑`);

const showPlan = display.markdown("方案预览", { content: plan.result });

export const planRun = flow("① 规划", skills, plan, showPlan);

// ── ② 生成并校验 ────────────────────────────────────────────────────
const write = agent.subAgent("写 workspace.flow.js", {
  skillsContext: skills.skillsContext,
}, `照方案落地。

方案：${plan.result}

在 \`~/agentflow/pipelines/${flowId.value}/\` 下写出 \`workspace.flow.js\`；方案里提到的脚本放同目录 \`scripts/\`，代码节点写成 \`nodes/<name>/index.mjs\`。

**不要写 workspace.graph.json，也不要写 flow.yaml。** 前者是只读的遗留格式，后者的执行栈已经退休。

写完自己跑一遍 \`agentflow flow dsl lint ~/agentflow/pipelines/${flowId.value}\`，明显的错先改掉，改动说明作为回复正文。`);

const lint = tool.nodejs("lint 校验", {
  flowId: flowId.value,
}, `node ${flowDir}/scripts/lint-flow.mjs ${flowId} ${ok} ${report}`);
const { ok, report } = lint;

const passed = display.markdown("校验通过", { content: report });

const fix = agent.subAgent("按 lint 报告修", {
  skillsContext: skills.skillsContext,
}, `\`agentflow flow dsl lint\` 没过。报告：

${report}

逐条修 \`~/agentflow/pipelines/${flowId.value}/workspace.flow.js\`。高频原因：
- 结构文件里写了 if / for / 箭头函数 —— 逻辑要挪进 nodes/<name>/index.mjs
- 引脚名不在该节点类型的定义表里
- provide.* 被放进了 flow(...) 链（它没有 prev/next 槽）
- fan-in：同一个输入接了两条边`);

const lintAgain = tool.nodejs("重新 lint", {
  flowId: flowId.value,
}, `node ${flowDir}/scripts/lint-flow.mjs ${flowId} ${ok} ${report}`);
const { ok: ok2, report: report2 } = lintAgain;

const passedAfterFix = display.markdown("修一轮后通过", { content: report2 });
const stillFailing = display.markdown("两轮仍未通过，需要人工介入", { content: report2 });

// 没有循环原语，「修到过为止」展开成两轮固定 gate
const gate2 = control.if("第二轮过了吗", { prediction: ok2 },
  flow(passedAfterFix),
  flow(stillFailing),
);
const gate1 = control.if("第一轮过了吗", { prediction: ok },
  flow(passed),
  flow(fix, lintAgain, gate2),
);

export const buildRun = flow("② 生成并校验", write, lint, gate1);

// 人工闸门：方案在画布上看完，点「② 生成并校验」才继续
flow.resume(showPlan, buildRun);
