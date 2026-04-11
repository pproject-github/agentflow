import { spawn } from "child_process";
import path from "path";
import chalk from "chalk";
import { apply, replay, resume } from "./apply.mjs";
import {
  addRoleJson,
  copyBuiltinAgentJson,
  copyBuiltinJson,
  listAgentsJson,
  listAgentsTable,
  readAgentJson,
} from "./catalog-agents.mjs";
import {
  listFlowsJson,
  listNodesJson,
  listPipelines,
  printNodesTable,
  readFlowJson,
  readNodeJson,
} from "./catalog-flows.mjs";
import { writeFlowYaml } from "./flow-write.mjs";
import { printHelp } from "./help.mjs";
import { LOG_LEVELS, log, setLogLevel, setMachineReadable } from "./log.mjs";
import { updateModelLists } from "./model-lists.mjs";
import { APPLY_AI_STEPS, LEGACY_PIPELINES_DIR, PIPELINES_DIR, USER_AGENTFLOW_PIPELINES_LABEL } from "./paths.mjs";
import { isValidUuid, runNodeScript } from "./pipeline-scripts.mjs";
import { Table } from "./table.mjs";
import { ensureReference, findFlowNameByUuid, getFlowDir, listRunsWithLogs } from "./workspace.mjs";
import { startUiServer } from "./ui-server.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main() {
  const argv = process.argv.slice(2);
  let workspaceRoot = process.cwd();
  const shift = () => argv.shift();
  const wrIdx = argv.indexOf("--workspace-root");
  if (wrIdx >= 0 && argv[wrIdx + 1]) {
    workspaceRoot = path.resolve(argv[wrIdx + 1]);
    argv.splice(wrIdx, 2);
  }
  while (argv[0] === "--workspace-root") {
    shift();
    workspaceRoot = path.resolve(shift() || "");
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  const dryRun = argv.includes("--dry-run");
  if (dryRun) argv.splice(argv.indexOf("--dry-run"), 1);
  if (argv.includes("--debug")) {
    setLogLevel(LOG_LEVELS.debug);
    argv.splice(argv.indexOf("--debug"), 1);
  }
  let force = true;
  if (argv.includes("--no-force")) {
    force = false;
    argv.splice(argv.indexOf("--no-force"), 1);
  }
  if (argv.includes("--force")) {
    force = true;
    argv.splice(argv.indexOf("--force"), 1);
  }
  if (argv.includes("--yolo")) {
    force = true;
    argv.splice(argv.indexOf("--yolo"), 1);
  }
  let parallel = false;
  if (argv.includes("--parallel")) {
    parallel = true;
    argv.splice(argv.indexOf("--parallel"), 1);
  }
  if (argv.includes("--no-parallel")) {
    parallel = false;
    argv.splice(argv.indexOf("--no-parallel"), 1);
  }
  if (argv.includes("--machine-readable")) {
    setMachineReadable(true);
    argv.splice(argv.indexOf("--machine-readable"), 1);
  }
  const jsonMode = argv.includes("--json");
  const cliInputs = {};
  while (argv.includes("--input")) {
    const idx = argv.indexOf("--input");
    const pair = argv[idx + 1];
    if (!pair || !pair.includes("=")) {
      throw new Error("Invalid --input format. Use: --input name=value");
    }
    const eqIdx = pair.indexOf("=");
    const name = pair.slice(0, eqIdx);
    const value = pair.slice(eqIdx + 1);
    if (value.startsWith("file:")) {
      cliInputs[name] = { type: "file", path: value.slice(5) };
    } else {
      cliInputs[name] = { type: "str", value };
    }
    argv.splice(idx, 2);
  }
  const sub = shift();
  if (!sub) {
    printHelp();
    process.exit(1);
  }
  if (sub === "update-model-lists") {
    const result = await updateModelLists(workspaceRoot);
    if (jsonMode) process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(0);
  }
  const jsonOnlySubs = [
    "list-flows",
    "list-nodes",
    "read-flow",
    "write-flow",
    "read-node",
    "copy-builtin",
    "list-agents",
    "copy-builtin-agent",
    "read-agent",
    "add-role",
  ];
  if (jsonMode && jsonOnlySubs.includes(sub)) {
    argv.splice(argv.indexOf("--json"), 1);
  }
  let agentModel = process.env.CURSOR_AGENT_MODEL || null;
  const modelIdx = argv.indexOf("--model");
  if (modelIdx >= 0 && argv[modelIdx + 1]) {
    agentModel = argv[modelIdx + 1];
    argv.splice(modelIdx, 2);
  }
  if (sub === "list-flows" && jsonMode) {
    const list = listFlowsJson(workspaceRoot);
    process.stdout.write(JSON.stringify(list) + "\n");
    process.exit(0);
  }
  if (sub === "list-nodes" && jsonMode) {
    let flowId, flowSource;
    const flowIdIdx = argv.indexOf("--flow-id");
    if (flowIdIdx >= 0 && argv[flowIdIdx + 1]) {
      flowId = argv[flowIdIdx + 1];
      argv.splice(flowIdIdx, 2);
    }
    const flowSourceIdx = argv.indexOf("--flow-source");
    if (flowSourceIdx >= 0 && argv[flowSourceIdx + 1]) {
      flowSource = argv[flowSourceIdx + 1];
      argv.splice(flowSourceIdx, 2);
    }
    const list = listNodesJson(workspaceRoot, flowId, flowSource);
    process.stdout.write(JSON.stringify(list) + "\n");
    process.exit(0);
  }
  if (sub === "list-nodes" && !jsonMode) {
    let flowId, flowSource;
    const flowIdIdx = argv.indexOf("--flow-id");
    if (flowIdIdx >= 0 && argv[flowIdIdx + 1]) {
      flowId = argv[flowIdIdx + 1];
      argv.splice(flowIdIdx, 2);
    }
    const flowSourceIdx = argv.indexOf("--flow-source");
    if (flowSourceIdx >= 0 && argv[flowSourceIdx + 1]) {
      flowSource = argv[flowSourceIdx + 1];
      argv.splice(flowSourceIdx, 2);
    }
    const list = listNodesJson(workspaceRoot, flowId, flowSource);
    printNodesTable(list);
    process.exit(0);
  }
  if (sub === "read-flow" && jsonMode) {
    let flowSource = "user";
    const flowSourceIdx = argv.indexOf("--flow-source");
    if (flowSourceIdx >= 0 && argv[flowSourceIdx + 1]) {
      flowSource = argv[flowSourceIdx + 1];
      argv.splice(flowSourceIdx, 2);
    }
    const flowId = argv.find((a) => !a.startsWith("--"));
    if (!flowId) {
      process.stdout.write(JSON.stringify({ error: "Missing flowId" }) + "\n");
      process.exit(1);
    }
    const result = readFlowJson(workspaceRoot, flowId, flowSource);
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(result.error ? 1 : 0);
  }
  if (sub === "read-node" && jsonMode) {
    let flowId, flowSource;
    const flowIdIdx = argv.indexOf("--flow-id");
    if (flowIdIdx >= 0 && argv[flowIdIdx + 1]) {
      flowId = argv[flowIdIdx + 1];
      argv.splice(flowIdIdx, 2);
    }
    const flowSourceIdx = argv.indexOf("--flow-source");
    if (flowSourceIdx >= 0 && argv[flowSourceIdx + 1]) {
      flowSource = argv[flowSourceIdx + 1];
      argv.splice(flowSourceIdx, 2);
    }
    const nodeId = argv.find((a) => !a.startsWith("--"));
    if (!nodeId) {
      process.stdout.write(JSON.stringify({ error: "Missing nodeId" }) + "\n");
      process.exit(1);
    }
    const result = readNodeJson(workspaceRoot, nodeId, flowId, flowSource);
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(result.error ? 1 : 0);
  }
  if (sub === "copy-builtin" && jsonMode) {
    const flowId = shift();
    let targetFlowId;
    const targetIdx = argv.indexOf("--target");
    if (targetIdx >= 0 && argv[targetIdx + 1]) targetFlowId = argv[targetIdx + 1];
    if (!flowId) {
      process.stdout.write(JSON.stringify({ success: false, error: "Missing flowId" }) + "\n");
      process.exit(1);
    }
    const result = copyBuiltinJson(workspaceRoot, flowId, targetFlowId);
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(result.success ? 0 : 1);
  }
  if (sub === "list-agents" && jsonMode) {
    const list = listAgentsJson(workspaceRoot);
    process.stdout.write(JSON.stringify(list) + "\n");
    process.exit(0);
  }
  if (sub === "list-agents") {
    listAgentsTable(workspaceRoot);
    process.exit(0);
  }
  if (sub === "copy-builtin-agent" && jsonMode) {
    const builtinAgentId = shift();
    let targetId;
    const targetIdx = argv.indexOf("--target");
    if (targetIdx >= 0 && argv[targetIdx + 1]) targetId = argv[targetIdx + 1];
    if (!builtinAgentId) {
      process.stdout.write(JSON.stringify({ success: false, error: "Missing builtinAgentId" }) + "\n");
      process.exit(1);
    }
    const result = copyBuiltinAgentJson(workspaceRoot, builtinAgentId, targetId);
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(result.success ? 0 : 1);
  }
  if (sub === "read-agent" && jsonMode) {
    const agentId = argv.find((a) => !a.startsWith("--"));
    if (!agentId) {
      process.stdout.write(JSON.stringify({ error: "Missing agentId" }) + "\n");
      process.exit(1);
    }
    const result = readAgentJson(workspaceRoot, agentId);
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(result.error ? 1 : 0);
  }
  if (sub === "add-role" && jsonMode) {
    let id, name, description, builtin = false, contentPath;
    const idIdx = argv.indexOf("--id");
    if (idIdx >= 0 && argv[idIdx + 1]) id = argv[idIdx + 1];
    const nameIdx = argv.indexOf("--name");
    if (nameIdx >= 0 && argv[nameIdx + 1]) name = argv[nameIdx + 1];
    const descIdx = argv.indexOf("--description");
    if (descIdx >= 0 && argv[descIdx + 1]) description = argv[descIdx + 1];
    if (argv.includes("--builtin")) builtin = true;
    const contentIdx = argv.indexOf("--content");
    if (contentIdx >= 0 && argv[contentIdx + 1]) contentPath = argv[contentIdx + 1];
    if (!id) {
      process.stdout.write(JSON.stringify({ success: false, error: "Missing --id" }) + "\n");
      process.exit(1);
    }
    const result = addRoleJson(workspaceRoot, { builtin, id, name, description, contentPath });
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(result.success ? 0 : 1);
  }
  if (sub === "write-flow" && jsonMode) {
    let flowSource = "user";
    const flowSourceIdx = argv.indexOf("--flow-source");
    if (flowSourceIdx >= 0 && argv[flowSourceIdx + 1]) {
      flowSource = argv[flowSourceIdx + 1];
      argv.splice(flowSourceIdx, 2);
    }
    if (flowSource === "builtin") {
      process.stderr.write(
        "agentflow: --flow-source builtin 已弃用（包内 builtin 不可写）；已按 workspace 写入 .workspace/agentflow/pipelines。\n",
      );
      flowSource = "workspace";
    }
    if (flowSource !== "user" && flowSource !== "workspace") {
      process.stdout.write(
        JSON.stringify({ success: false, error: "Invalid --flow-source (use user or workspace)" }) + "\n",
      );
      process.exit(1);
    }
    const flowId = argv.find((a) => !a.startsWith("--"));
    if (!flowId) {
      process.stdout.write(JSON.stringify({ success: false, error: "Missing flowId" }) + "\n");
      process.exit(1);
    }
    const flowYaml = await readStdin();
    const result = writeFlowYaml(workspaceRoot, flowId, flowSource, flowYaml);
    process.stdout.write(JSON.stringify(result.success ? { success: true } : result) + "\n");
    process.exit(result.success ? 0 : 1);
  }
  if (sub === "ui") {
    let port = 8765;
    const portIdx = argv.indexOf("--port");
    if (portIdx >= 0 && argv[portIdx + 1]) {
      port = parseInt(argv[portIdx + 1], 10);
      argv.splice(portIdx, 2);
    }
    const noOpen = argv.includes("--no-open");
    if (noOpen) argv.splice(argv.indexOf("--no-open"), 1);
    if (Number.isNaN(port) || port <= 0 || port > 65535) {
      throw new Error("Invalid --port (use 1–65535)");
    }
    await startUiServer({ workspaceRoot, port });
    const url = "http://127.0.0.1:" + port;
    process.stderr.write("AgentFlow UI: " + url + "\n");
    if (!noOpen) {
      if (process.platform === "win32") {
        const child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
        child.unref();
      } else if (process.platform === "darwin") {
        const child = spawn("open", [url], { detached: true, stdio: "ignore" });
        child.unref();
      } else {
        const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
        child.unref();
      }
    }
    await new Promise(() => {});
  }
  if (sub === "list") {
    listPipelines(workspaceRoot);
  } else if (sub === "apply") {
    const aiMode = argv[0] === "-ai" || argv[0] === "--ai";
    if (aiMode) {
      argv.shift();
      const step = argv.shift();
      if (!step || !APPLY_AI_STEPS.includes(step)) {
        throw new Error(
          "Missing or invalid step. Usage: agentflow apply -ai <step> <args...>. Steps: " + APPLY_AI_STEPS.join(", "),
        );
      }
      if (argv.length === 0) {
        throw new Error("Missing args for step " + step + ". Example: agentflow apply -ai ensure-run-dir <workspaceRoot> [uuid] <flowName>");
      }
      const stepWorkspaceRoot = path.resolve(argv[0]);
      ensureReference(stepWorkspaceRoot);
      const scriptName = step + ".mjs";
      const result = runNodeScript(stepWorkspaceRoot, scriptName, argv, { captureStdout: false });
      process.exit(result.status ?? 0);
    }
    const first = shift();
    if (!first) throw new Error("Missing FlowName or uuid. Usage: agentflow apply <FlowName> [uuid] | agentflow apply <uuid>");
    let flowName, uuidArg;
    if (isValidUuid(first)) {
      flowName = findFlowNameByUuid(workspaceRoot, first);
      if (!flowName) throw new Error("No run found for uuid " + first + ". Run apply with FlowName first (e.g. agentflow apply <FlowName>).");
      uuidArg = first;
    } else {
      flowName = first;
      uuidArg = isValidUuid(argv[0]) ? shift() : undefined;
    }
    await apply(workspaceRoot, flowName, uuidArg, dryRun, agentModel, force, parallel, cliInputs);
  } else if (sub === "resume") {
    const flowName = shift();
    const uuidArg = shift();
    if (!flowName || !uuidArg) throw new Error("Usage: agentflow resume <FlowName> <uuid> [instanceId]");
    const instanceIdOpt = argv.length > 0 && !argv[0].startsWith("--") ? shift() : undefined;
    await resume(workspaceRoot, flowName, uuidArg, instanceIdOpt, agentModel, force, parallel);
  } else if (sub === "replay") {
    const a = shift(),
      b = shift(),
      c = shift();
    if (!a || !b) throw new Error("Usage: agentflow replay <uuid> <instanceId> or agentflow replay <flowName> <uuid> <instanceId>");
    await replay(workspaceRoot, a, b, c, agentModel, force);
  } else if (sub === "run-status") {
    const flowName = shift();
    const uuidArg = shift();
    if (!flowName || !uuidArg) throw new Error("Usage: agentflow run-status <flowName> <uuid>");
    const result = runNodeScript(workspaceRoot, "get-ready-nodes.mjs", [workspaceRoot, flowName, uuidArg], { captureStdout: true });
    if (result.stdout) process.stdout.write(result.stdout);
    process.exit(result.status === 0 ? 0 : 1);
  } else if (sub === "extract-thinking") {
    const first = argv[0];
    if (first === "-list" || first === "--list") {
      shift();
      const list = listRunsWithLogs(workspaceRoot);
      const wantJson = argv.includes("--json");
      if (wantJson) {
        process.stdout.write(
          JSON.stringify({ ok: true, runs: list.map((r) => ({ flowName: r.flowName, uuid: r.uuid, logPath: r.logPath, size: r.size, lines: r.lines })) }) + "\n",
        );
      } else {
        if (list.length === 0) {
          log.info("没有找到带 logs/log.txt 的 run。先执行 apply 产生日志后再用 extract-thinking <flowName> <uuid> 提取。");
        } else {
          const table = new Table({ head: ["flowName", "uuid", "lines", "size"], style: { head: [] } });
          for (const r of list) {
            table.push([r.flowName, r.uuid, String(r.lines), r.size >= 1024 ? (r.size / 1024).toFixed(1) + " KB" : r.size + " B"]);
          }
          log.info("\n" + chalk.bold("可提取 thinking 的 run（logs/log.txt 存在）\n"));
          log.info(table.toString());
          log.info("\n提取: agentflow extract-thinking <flowName> <uuid>");
        }
      }
      process.exit(0);
      return;
    }
    const flowName = shift();
    const uuidArg = shift();
    if (!flowName || !uuidArg) throw new Error("Usage: agentflow extract-thinking <flowName> <uuid> 或 agentflow extract-thinking -list");
    const result = runNodeScript(workspaceRoot, "extract-thinking.mjs", [workspaceRoot, flowName, uuidArg], { captureStdout: false });
    process.exit(result.status === 0 ? 0 : 1);
  } else if (sub === "validate") {
    const flowName = shift();
    if (!flowName) throw new Error("Usage: agentflow validate <FlowName> [uuid]");
    const wantJson = argv.includes("--json");
    if (wantJson) argv.splice(argv.indexOf("--json"), 1);
    const uuidArg = argv.length > 0 && !argv[0].startsWith("--") && isValidUuid(argv[0]) ? shift() : null;
    const flowDir = getFlowDir(workspaceRoot, flowName);
    if (!flowDir) {
      throw new Error(
        "Flow not found: " +
          flowName +
          " (no flow.yaml under " +
          USER_AGENTFLOW_PIPELINES_LABEL +
          "/" +
          flowName +
          ", " +
          PIPELINES_DIR +
          "/" +
          flowName +
          ", " +
          LEGACY_PIPELINES_DIR +
          "/" +
          flowName +
          ", or builtin)",
      );
    }
    const args = [workspaceRoot, flowName, flowDir];
    if (uuidArg) args.push(uuidArg);
    const result = runNodeScript(workspaceRoot, "validate-flow.mjs", args, { captureStdout: true });
    if (!result.stdout) {
      process.exit(result.status ?? 1);
      return;
    }
    const isTTY = process.stdout.isTTY === true;
    if (wantJson || !isTTY) {
      process.stdout.write(result.stdout);
      process.exit(result.status ?? 0);
      return;
    }
    let data;
    try {
      data = JSON.parse(result.stdout);
    } catch {
      process.stdout.write(result.stdout);
      process.exit(result.status ?? 0);
      return;
    }
    if (data.error) {
      process.stderr.write(chalk.red("Error: ") + data.error + "\n");
      process.exit(1);
      return;
    }
    const ok = data.ok === true;
    const errs = Array.isArray(data.errors) ? data.errors : [];
    const warns = Array.isArray(data.warnings) ? data.warnings : [];
    const v = data.validation || {};
    const edgeErr = Array.isArray(v.edgeTypeMismatch) ? v.edgeTypeMismatch : [];
    const roleErr = Array.isArray(v.nodeRoleMissing) ? v.nodeRoleMissing : [];
    const modelErr = Array.isArray(v.nodeModelMissing) ? v.nodeModelMissing : [];
    process.stdout.write("\n");
    process.stdout.write(chalk.bold("校验: ") + flowName + "  ");
    process.stdout.write(ok ? chalk.green("✓ 通过") + "\n" : chalk.red("✗ 未通过") + "\n");
    if (!ok || errs.length > 0) {
      for (const e of errs) {
        process.stdout.write(chalk.red("  • ") + e + "\n");
      }
    }
    if (edgeErr.length) {
      process.stdout.write(chalk.yellow("  边类型不匹配: ") + edgeErr.join(", ") + "\n");
    }
    if (roleErr.length) {
      process.stdout.write(chalk.yellow("  节点角色缺失/无效: ") + roleErr.join(", ") + "\n");
    }
    if (modelErr.length) {
      process.stdout.write(chalk.yellow("  节点模型缺失/无效: ") + modelErr.join(", ") + "\n");
    }
    if (warns.length > 0) {
      process.stdout.write(chalk.dim("  警告: ") + "\n");
      for (const w of warns) {
        process.stdout.write(chalk.dim("    • ") + w + "\n");
      }
    }
    if (!ok || errs.length > 0 || warns.length > 0) process.stdout.write("\n");
    process.exit(result.status ?? 0);
  } else if (
    sub === "list-flows" ||
    sub === "read-flow" ||
    sub === "write-flow" ||
    sub === "read-node" ||
    sub === "copy-builtin" ||
    sub === "copy-builtin-agent" ||
    sub === "read-agent" ||
    sub === "add-role"
  ) {
    throw new Error("Use --json with " + sub + ". Example: agentflow list-flows --json --workspace-root <path>");
  } else {
    throw new Error(
      "Unknown command: " +
        sub +
        ". Use list, ui, list-flows --json, list-nodes --json, read-flow --json, write-flow --json, read-node --json, copy-builtin --json, list-agents --json, copy-builtin-agent --json, read-agent --json, add-role --json, update-model-lists, apply, validate, resume, replay, run-status, extract-thinking, extract-thinking -list.",
    );
  }
}
