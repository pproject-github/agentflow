import { agent, control, display, file, flow, provide, tool, workspace } from "agentflow/flow";

const bodyState = flow.input("state", "json");

const bodyIteration = flow.input("iteration", "text");

const bodyIdempotencyKey = flow.input("idempotencyKey", "text");

const selectIssue = tool.nodejs("选择本轮 Issue", {
  state: bodyState.value,
  iteration: bodyIteration.value,
}, `node -e 'const i=JSON.parse(process.env.AGENTFLOW_INPUTS_JSON||"{}");const s=JSON.parse(i.state||"{}");const issues=["LIKEE-1842 · Android 评论气泡样式","LIKEE-1843 · iOS 评论气泡样式"];process.stdout.write(issues[s.cursor]||"无待处理 Issue")'`);

const advanceIssue = tool.nodejs("推进一个研发动作", {
  issue: selectIssue.result,
  idempotencyKey: bodyIdempotencyKey.value,
}, `node -e 'const i=JSON.parse(process.env.AGENTFLOW_INPUTS_JSON||"{}");process.stdout.write("已模拟推进："+i.issue+"（幂等键 "+String(i.idempotencyKey||"").slice(0,12)+"…）")'`);

const saveState = tool.nodejs("归并下一轮状态", {
  previousState: bodyState.value,
  action: advanceIssue.result,
}, `node -e 'const i=JSON.parse(process.env.AGENTFLOW_INPUTS_JSON||"{}");const s=JSON.parse(i.previousState||"{}");s.cursor=Number(s.cursor||0)+1;s.status="advanced";s.lastAction=i.action;process.stdout.write(JSON.stringify(s))'`);

const validateNextState = control.parseJson("验证下一轮状态", {
  value: saveState.result,
});

export const bodyFlow = flow.subflow("执行一轮推进", { state: bodyState, iteration: bodyIteration, idempotencyKey: bodyIdempotencyKey }, flow(selectIssue, advanceIssue, saveState, validateNextState), { state: validateNextState.result, summary: advanceIssue.result });

const conditionState = flow.input("state", "json");

const conditionIteration = flow.input("iteration", "text");

const checkBoundary = tool.nodejs("检查人工边界", {
  state: conditionState.value,
  iteration: conditionIteration.value,
}, `node -e 'const i=JSON.parse(process.env.AGENTFLOW_INPUTS_JSON||"{}");const s=JSON.parse(i.state||"{}");process.stdout.write(Number(s.cursor||0)>=2?"done":"continue")'`);

export const conditionFlow = flow.subflow("是否继续推进", { state: conditionState, iteration: conditionIteration }, flow(checkBoundary), { decision: checkBoundary.result, summary: checkBoundary.result });

export const initialState = provide.json("初始 PRD 状态", {
  value: `{"prdId":"TAPD-1010475","cursor":0,"status":"ready"}`,
});

const advanceUntilBoundary = control.while("推进到下一个人工边界 · 设计预览", {
  state: initialState.value,
  maxIterations: "20",
  timeout: "30m",
}, conditionFlow, bodyFlow);

const result = display.markdown("While 最终结果", {
  content: advanceUntilBoundary.result,
});

export const run = flow("运行设计预览", advanceUntilBoundary, result);
