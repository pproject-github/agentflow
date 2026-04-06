import chalk from "chalk";
import { log } from "./log.mjs";
import { runNodeScript } from "./pipeline-scripts.mjs";
import { Table } from "./table.mjs";

/** 开始时：入口信息（仅流程名称与 uuid） */
export function printEntryAndFlowFiles(workspaceRoot, flowName, uuid) {
  const entryTable = new Table({
    head: [chalk.cyan("项目"), chalk.cyan("值")],
    colWidths: [18, 24],
    style: { head: [], border: ["grey"] },
  });
  entryTable.push(["流程名称", flowName], ["本次运行 uuid", uuid]);
  log.info("\n" + chalk.bold("入口信息"));
  log.info(entryTable.toString());
}

export function styleStatus(s) {
  if (s === "success") return chalk.green("success");
  if (s === "pending") return chalk.yellow("pending");
  if (s === "running") return chalk.cyan("running");
  if (s === "condition_not_met") return chalk.dim("condition_not_met");
  return chalk.dim(s || "-");
}

/** 仅打印全量节点状态表（应用进入时展示一次用）。输出到 stderr。 */
export function printNodeStatusTable(instanceStatus, nodes, execIdMap = {}) {
  const idToLabel = new Map();
  const idToType = new Map();
  if (Array.isArray(nodes)) {
    for (const n of nodes) {
      idToLabel.set(n.id, n.label || n.id);
      idToType.set(n.id, n.type || "-");
    }
  }
  const order = Array.isArray(nodes) ? nodes.map((n) => n.id) : Object.keys(instanceStatus || {});
  if (order.length === 0) return;
  const statusTable = new Table({
    head: [chalk.cyan("标签"), chalk.cyan("类型"), chalk.cyan("状态"), chalk.cyan("execId")],
    colWidths: [20, 10, 16, 8],
    style: { head: [], border: ["grey"] },
  });
  for (const id of order) {
    const label = idToLabel.get(id) || id;
    const type = idToType.get(id) || "-";
    const status = (instanceStatus && instanceStatus[id]) || "-";
    const execId = execIdMap[id] != null ? String(execIdMap[id]) : "-";
    statusTable.push([label, type, styleStatus(status), execId]);
  }
  process.stderr.write("\n" + chalk.bold("节点状态") + "\n");
  process.stderr.write(statusTable.toString() + "\n");
}

/**
 * apply 启动时执行 validate-flow（统一校验）；errors 则退出，仅 warnings 则提示后继续。
 */
export function runValidateFlowAndExitIfInvalid(workspaceRoot, flowName, flowDir) {
  const result = runNodeScript(workspaceRoot, "validate-flow.mjs", [workspaceRoot, flowName, flowDir], {
    captureStdout: true,
  });
  const stdout = (result.stdout || "").trim();
  if (!stdout) return;
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return;
  }
  const errors = Array.isArray(data.errors) ? data.errors : [];
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];

  if (errors.length > 0) {
    process.stderr.write("\n" + chalk.bold.red("流程校验未通过，请修正后再执行 apply：") + "\n\n");
    for (const err of errors) {
      process.stderr.write("  " + chalk.red("• ") + err + "\n");
    }
    if (warnings.length > 0) {
      process.stderr.write("\n" + chalk.yellow("警告：") + "\n");
      for (const w of warnings) {
        process.stderr.write("  " + chalk.yellow("• ") + w + "\n");
      }
    }
    process.stderr.write("\n" + chalk.dim("校验命令: agentflow validate " + flowName) + "\n");
    process.exit(1);
  }

  if (warnings.length > 0) {
    process.stderr.write("\n" + chalk.yellow("校验警告：") + "\n");
    for (const w of warnings) {
      process.stderr.write("  " + chalk.yellow("• ") + w + "\n");
    }
    process.stderr.write("\n");
  }
}
