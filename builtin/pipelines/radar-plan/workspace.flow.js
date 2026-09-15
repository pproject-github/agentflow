/**
 * 规划一块雷达板。
 *
 * 这条流程是**指挥官自己的脑子**。在它之前，规划是服务端一个裸 prompt——spawn 一个
 * agent 进程、转发 stdout、解析不出来就整轮白跑。于是它造出来的东西是流程，它自己不是：
 * 没有 run 记录、没有节点级重试、没有执行面、规划过程本身也改不了。
 *
 * 现在它和 `new`（新建流程）同构：规划 → 校验 → 没过就让它重发一遍 → 再校验。
 * 「解析不出来」不再是死路，是图上的一条边。
 *
 * 输入由调用方把值写进 provide 节点再运行——ask 是人说的那句话，board 为空就是新板。
 */
import { agent, control, display, flow, provide, tool } from "agentflow/flow";

const ask = provide.str("要盯什么", {
  value: "盯 Google Play 与 Android 平台的强制要求，凡是有截止日、不做会被拒审或下架的都要追。",
});
const boardId = provide.str("板 id（留空就是新板）", {
  value: "",
});

// 规划要照着追踪项的写法出 id 和字段，技能直接注入
const skills = control.loadSkills("载入追踪规范", {
  skillKeys: "agentflow-tracking",
});

// 板的现状每次都不一样（几条流程、谁哑了、哪些条目没人认领），写死在图里就永远是旧的
const spec = tool.nodejs("组装规划提示词", {
  ask: ask.value,
  board: boardId.value,
}, `agentflow track plan prompt --board=${board} --ask=${ask} --out=${prompt}`);
const { prompt } = spec;

const plan = agent.subAgent("规划这块板", {
  skillsContext: skills.skillsContext,
}, `${prompt}`);

const check = tool.nodejs("校验计划", {
  raw: plan.result,
  board: boardId.value,
}, `agentflow track plan check --board=${board} --ok=${ok} --report=${report} --plan=${planJson}`);
const { ok, report, planJson } = check;

const ready = display.markdown("计划已就绪", { content: report });

// 只让它重发，不让它重新规划：第二轮凭印象重编一份，条目会和第一轮对不上
const resend = agent.subAgent("只重发一遍 JSON", {
  skillsContext: skills.skillsContext,
}, `上一轮的回复里没有可解析的 JSON 计划。

校验报告：

${report}

**只输出那一段 JSON**：不要解释、不要示例、不要第二段 JSON、不要在 JSON 之后再补话。
内容和上一轮应当一致——这一轮只是重新输出，不是重新规划。

原任务：

${prompt}`);

const recheck = tool.nodejs("再校验一遍", {
  raw: resend.result,
  board: boardId.value,
}, `agentflow track plan check --board=${board} --ok=${ok} --report=${report} --plan=${planJson}`);
const { ok: ok2, report: report2, planJson: planJson2 } = recheck;

const readyAfterResend = display.markdown("重发一轮后就绪", { content: report2 });
const stillBad = display.markdown("两轮都没给出可用计划", { content: report2 });

// 没有循环原语，「重发到能用为止」展开成两轮固定 gate
const gate2 = control.if("第二轮成了吗", { prediction: ok2 },
  flow(readyAfterResend),
  flow(stillBad),
);
const gate1 = control.if("第一轮成了吗", { prediction: ok },
  flow(ready),
  flow(resend, recheck, gate2),
);

export const run = flow("规划雷达板", skills, spec, plan, check, gate1);
