import { agent, control, display, file, flow, provide, tool, workspace } from "agentflow/flow";

const issueIn = flow.input("issue", "text");

const inspect = agent.subAgent("分析单个 Issue", {
  issue: issueIn.value,
}, "只分析本次输入的一个 Issue，给出目标、风险和下一步。不要处理其它 Issue。");

const normalize = tool.nodejs("规范化交付摘要", {
  analysis: inspect.result,
}, `node -e 'process.stdout.write(process.argv[1])' \${analysis}`);

export const inspectIssue = flow.subflow("Issue 单项分析", { issue: issueIn }, flow(inspect, normalize), { summary: normalize.result, raw: inspect.result });

export const request = provide.str("待分析 Issue", {
  value: "LIKEE-1842 · Android 评论气泡样式需要统一",
});

const callInspect = flow.call("调用 Issue 分析子流程", inspectIssue, {
  issue: request.value,
});

const { summary, raw } = callInspect;

const preview = display.markdown("父流程收到的结果", {
  content: summary,
});

export const run = flow("运行案例", callInspect, preview);
