#!/usr/bin/env node
/**
 * 跑 `agentflow flow dsl lint`，把结果拆成两个输出槽。
 *
 * 用法（由 tool_nodejs 的 script 调用）：
 *   node lint-flow.mjs <flowName|flowDir> <okPath> <reportPath>
 *
 * - `<okPath>` 写 `true` / `false`，接到 `control.if` 的 prediction
 * - `<reportPath>` 写完整报告，接到修复节点和展示节点
 *
 * **本节点总是 exit 0**：lint 没过不是这一步失败，是下一步要修的事。真正的失败只有
 * 「命令跑不起来」。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const [target, okPath, reportPath] = process.argv.slice(2);

if (!target || !okPath || !reportPath) {
  console.error("用法: node lint-flow.mjs <flowName|flowDir> <okPath> <reportPath>");
  process.exit(1);
}

const r = spawnSync("agentflow", ["flow", "dsl", "lint", target], { encoding: "utf-8" });

if (r.error) {
  // 命令根本没跑起来（多半是 agentflow 不在 PATH 上）——这是真失败，别伪装成 lint 未通过
  console.error(`执行 agentflow 失败：${r.error.message}`);
  process.exit(1);
}

const output = `${r.stdout || ""}${r.stderr || ""}`.trim() || "(lint 无输出)";
const ok = r.status === 0;

fs.writeFileSync(reportPath, `# lint ${target}\n\n退出码 ${r.status}\n\n\`\`\`\n${output}\n\`\`\`\n`, "utf-8");
fs.writeFileSync(okPath, ok ? "true" : "false", "utf-8");

console.log(ok ? `lint 通过：${target}` : `lint 未通过（退出码 ${r.status}），交给下游修`);
