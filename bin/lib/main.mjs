import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import chalk from "chalk";
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
import { printHelp } from "./help.mjs";
import { LOG_LEVELS, log, setLogLevel, setMachineReadable } from "./log.mjs";
import { updateModelLists } from "./model-lists.mjs";
import { LEGACY_PIPELINES_DIR, PIPELINES_DIR, USER_AGENTFLOW_PIPELINES_LABEL } from "./paths.mjs";
import { isValidUuid, runNodeScript } from "./pipeline-scripts.mjs";
import { Table } from "./table.mjs";
import { ensureReference, findFlowNameByUuid, getFlowDir, listRunsWithLogs } from "./workspace.mjs";
import { startUiServer } from "./ui-server.mjs";
import { listMarketplacePackages, publishNodePackage } from "./marketplace.mjs";
import { startMcpServer } from "./mcp-server.mjs";
import { LEGACY_FLOW_EXECUTION_DISABLED, LEGACY_FLOW_EXECUTION_MESSAGE } from "./legacy-flow-execution.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * 把 yaml 迁移的损耗清单打到 stderr。
 *
 * 迁移唯一的卖点就是「丢了什么当场说清楚」，所以这段在成功和拒绝两种结局下都要打——
 * `--allow-loss` 迁过去了不代表没丢东西，只代表用户认了。
 */
function writeMigrationLoss(result) {
  for (const r of result.remapped || []) {
    process.stderr.write(`${chalk.cyan("换词")}   ${r.id}: ${r.from} -> ${r.to}\n`);
    for (const rn of r.renamedSlots || []) process.stderr.write(`         槽位 ${rn}\n`);
    for (const f of r.droppedFields || []) {
      // 原文照打——新节点装不下，用户得能直接捡走贴到别处
      process.stderr.write(`         ${chalk.yellow("丢")} ${f.field}: ${JSON.stringify(f.text)}\n`);
    }
    if (r.caveat) process.stderr.write(`         ${chalk.yellow("!")} ${r.caveat}\n`);
  }
  for (const d of result.dropped || []) {
    process.stderr.write(`${chalk.red("丢节点")} ${d.id} (${d.definitionId})：${d.reason}\n`);
  }
  for (const e of result.droppedEdges || []) {
    process.stderr.write(`${chalk.red("丢边")}   ${e.source} -> ${e.target}：${e.reason}\n`);
  }
  for (const w of result.warnings || []) process.stderr.write(`${chalk.yellow("warn")}   ${w}\n`);
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
  if (argv.includes("--dry-run")) argv.splice(argv.indexOf("--dry-run"), 1);
  if (argv.includes("--debug")) {
    setLogLevel(LOG_LEVELS.debug);
    argv.splice(argv.indexOf("--debug"), 1);
  }
  // 以下开关只服务已下线的 Start/End 执行，保留解析以免旧脚本把它们当成子命令。
  for (const legacyFlag of ["--no-force", "--force", "--yolo", "--parallel", "--no-parallel"]) {
    while (argv.includes(legacyFlag)) argv.splice(argv.indexOf(legacyFlag), 1);
  }
  if (argv.includes("--machine-readable")) {
    setMachineReadable(true);
    argv.splice(argv.indexOf("--machine-readable"), 1);
  }
  const jsonMode = argv.includes("--json");
  while (argv.includes("--input")) {
    const idx = argv.indexOf("--input");
    const pair = argv[idx + 1];
    if (!pair || !pair.includes("=")) {
      throw new Error("Invalid --input format. Use: --input name=value");
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
  if (sub === "mcp") {
    await startMcpServer();
    return;
  }
  const jsonOnlySubs = [
    "list-flows",
    "list-nodes",
    "read-flow",
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
  const modelIdx = argv.indexOf("--model");
  if (modelIdx >= 0 && argv[modelIdx + 1]) argv.splice(modelIdx, 2);
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
  if (sub === "marketplace") {
    const action = shift();
    if (action === "list") {
      const result = listMarketplacePackages(workspaceRoot);
      if (jsonMode) {
        process.stdout.write(JSON.stringify(result) + "\n");
      } else {
        const table = new Table({ head: ["type", "id", "version", "name", "path"], style: { head: [] } });
        for (const n of result.nodes) table.push(["node", n.id, n.version, n.displayName || "", n.packageDir]);
        for (const c of result.collections) table.push(["collection", c.id, c.version, c.displayName || "", c.packageDir]);
        process.stdout.write(table.toString() + "\n");
      }
      process.exit(0);
    }
    if (action === "publish-node") {
      const sourceDir = shift();
      if (!sourceDir) throw new Error("Usage: agentflow marketplace publish-node <packageDir> [--json]");
      const result = publishNodePackage(workspaceRoot, sourceDir);
      if (jsonMode) process.stdout.write(JSON.stringify(result) + "\n");
      else if (result.ok) process.stdout.write(`Published node ${result.id}@${result.version}: ${result.definitionId}\n`);
      else throw new Error(result.error || "publish-node failed");
      process.exit(result.ok ? 0 : 1);
    }
    throw new Error("Usage: agentflow marketplace <list|publish-node> [--json]");
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
  if (sub === "flow" && argv[0] === "dsl") {
    shift();
    const action = shift();
    const target = shift();
    const usage = "Usage: agentflow flow dsl <export|import|lint|layout|migrate> <FlowName|dir> [--out <dir>] [--allow-loss] [--all]";
    if (!action || !target) throw new Error(usage);
    let outDir = "";
    const outIdx = argv.indexOf("--out");
    if (outIdx >= 0 && argv[outIdx + 1]) {
      outDir = path.resolve(workspaceRoot, argv[outIdx + 1]);
      argv.splice(outIdx, 2);
    }
    // 不叫 --force：那个名字在上面被当成已下线执行栈的遗留开关提前吃掉了
    const lossIdx = argv.indexOf("--allow-loss");
    const force = lossIdx >= 0;
    if (force) argv.splice(lossIdx, 1);
    const allIdx = argv.indexOf("--all");
    const all = allIdx >= 0;
    if (all) argv.splice(allIdx, 1);
    if (argv.length > 0) throw new Error(`Unknown flow dsl option: ${argv[0]}`);
    if (all && action !== "layout") throw new Error("--all 只用于 flow dsl layout");

    const direct = path.resolve(workspaceRoot, target);
    const dir = fs.existsSync(direct) && fs.statSync(direct).isDirectory()
      ? direct
      : getFlowDir(workspaceRoot, target);
    if (!dir || !fs.existsSync(dir)) throw new Error(`Flow not found: ${target}`);

    const { exportFlowDsl, importFlowDsl, layoutWorkspaceFlowDir, lintFlowDir, migrateFlowDirToDsl } = await import("./flow-dsl/cli.mjs");

    if (action === "migrate") {
      const result = migrateFlowDirToDsl(dir, { force, marketplaceRoot: workspaceRoot });
      if (jsonMode) { process.stdout.write(JSON.stringify(result) + "\n"); return; }
      if (result.format === "empty") process.stderr.write(`${chalk.yellow("skip")}   ${dir}：没有图\n`);
      else if (!result.migrated && result.format === "dsl") process.stderr.write(`${chalk.green("ok")}     ${dir}：已经是代码形态\n`);
      else if (result.migrated) {
        process.stderr.write(`${chalk.green("ok")}     ${dir} -> workspace.flow.js（来自 ${result.source}）\n`);
        for (const rel of result.externals) process.stderr.write(`         ${rel}\n`);
      } else if (result.leftYaml) {
        // 够不着代码形态，但已经离开 yaml——图从此读得出、画得出、跑得动
        process.stderr.write(`${chalk.green("ok")}     ${dir} -> workspace.graph.json（来自 flow.yaml）\n`);
        process.stderr.write(`         ${chalk.dim(`还差一步到代码：${result.degradedReason}`)}\n`);
      } else if (result.format === "yaml") {
        process.stderr.write(`${chalk.red("keep")}   ${dir}：${result.degradedReason}\n`);
      } else {
        process.stderr.write(`${chalk.red("keep")}   ${dir}：${result.degradedReason}，保留 workspace.graph.json\n`);
        process.exitCode = 1;
      }
      // 损耗清单在成功和拒绝两种结局下都要打出来——`--allow-loss` 迁过去了不代表没丢东西
      writeMigrationLoss(result);
      if (result.format === "yaml" && !result.migrated) process.exitCode = 1;
      return;
    }

    if (action === "export") {
      const result = exportFlowDsl(dir, outDir);
      if (jsonMode) { process.stdout.write(JSON.stringify(result) + "\n"); return; }
      else {
        process.stderr.write(`Exported to ${result.outDir}\n`);
        for (const rel of result.written) process.stderr.write(`  ${rel}\n`);
      }
      return;
    }
    if (action === "import") {
      const result = importFlowDsl(dir, outDir);
      if (jsonMode) { process.stdout.write(JSON.stringify(result) + "\n"); return; }
      else {
        process.stderr.write(`Wrote ${result.graphPath}\n  ${result.nodeCount} 节点 / ${result.edgeCount} 边\n`);
        for (const w of result.warnings) process.stderr.write(`  warning: ${w}\n`);
      }
      return;
    }
    if (action === "lint") {
      const result = lintFlowDir(dir, { workspaceRoot });
      if (jsonMode) process.stdout.write(JSON.stringify({ errors: result.errors, warnings: result.warnings }) + "\n");
      else {
        for (const e of result.errors) process.stderr.write(`${chalk.red("error")}  ${e}\n`);
        for (const w of result.warnings) process.stderr.write(`${chalk.yellow("warn")}   ${w}\n`);
        if (!result.errors.length) process.stderr.write(`${chalk.green("ok")}     lint 通过\n`);
      }
      if (result.errors.length) process.exitCode = 1;
      return;
    }
    if (action === "layout") {
      const result = layoutWorkspaceFlowDir(dir, { all, workspaceRoot });
      if (jsonMode) process.stdout.write(JSON.stringify(result) + "\n");
      else process.stderr.write(`${chalk.green("ok")}     ${result.positioned}/${result.nodeCount} 个节点已${all ? "重新" : "补充"}排版\n  ${result.layoutPath}\n`);
      return;
    }
    throw new Error(usage);
  }
  if (sub === "flow") {
    // `flow preview` 曾经在这儿。它把 flow.yaml 原文塞进页面，代码化流程没有 yaml 可塞；
    // Web 的 /api/workspace/preview 接的是图对象，本来就通用，所以删掉而不是重写。
    throw new Error("Usage: agentflow flow dsl <export|import|lint|layout|migrate> <FlowName|dir> [--out <dir>] [--all]");
  }
  if (sub === "ui") {
    let port = 8765;
    let host = process.env.AGENTFLOW_UI_HOST || "127.0.0.1";
    let hideCommunityLinks = /^(1|true|yes|on)$/i.test(String(process.env.AGENTFLOW_HIDE_COMMUNITY_LINKS || ""));
    const portIdx = argv.indexOf("--port");
    if (portIdx >= 0 && argv[portIdx + 1]) {
      port = parseInt(argv[portIdx + 1], 10);
      argv.splice(portIdx, 2);
    }
    const hostIdx = argv.indexOf("--host");
    if (hostIdx >= 0 && argv[hostIdx + 1]) {
      host = argv[hostIdx + 1];
      argv.splice(hostIdx, 2);
    }
    const noOpen = argv.includes("--no-open");
    if (noOpen) argv.splice(argv.indexOf("--no-open"), 1);
    if (argv.includes("--hide-community-links")) {
      hideCommunityLinks = true;
      argv.splice(argv.indexOf("--hide-community-links"), 1);
    }
    if (Number.isNaN(port) || port <= 0 || port > 65535) {
      throw new Error("Invalid --port (use 1–65535)");
    }
    if (!host) {
      throw new Error("Invalid --host");
    }
    await startUiServer({ workspaceRoot, port, host, hideCommunityLinks });
    const browserHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    const url = "http://" + (browserHost.includes(":") ? `[${browserHost}]` : browserHost) + ":" + port;
    process.stderr.write("AgentFlow UI: " + url + (browserHost === host ? "" : ` (listening on ${host}:${port})`) + "\n");
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
  // ──── Hub commands ────
  // ──── Local commands ────
  if (sub === "list") {
    listPipelines(workspaceRoot);
  } else if (sub === "apply" || sub === "resume" || sub === "replay") {
    throw new Error(LEGACY_FLOW_EXECUTION_MESSAGE);
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
    // Workspace 图归 flow dsl lint 管。validate-flow.mjs 校验的是 flow.yaml，而 Workspace
    // 流程的 flow.yaml 只是个空壳，让它去校验只会得到「必须包含 instances 且至少一个节点」
    // 这种必然失败的结论。
    const { lintWorkspaceFlowDir } = await import("./flow-dsl/cli.mjs");
    const workspaceLint = lintWorkspaceFlowDir(flowDir);
    if (workspaceLint.format !== "empty") {
      if (wantJson || process.stdout.isTTY !== true) {
        process.stdout.write(JSON.stringify({
          ok: workspaceLint.errors.length === 0,
          target: "workspace",
          errors: workspaceLint.errors,
          warnings: workspaceLint.warnings,
        }) + "\n");
      } else {
        process.stdout.write(`\n${chalk.bold("校验: ")}${flowName}  ${
          workspaceLint.errors.length ? chalk.red("✗ 未通过") : chalk.green("✓ 通过")
        }\n`);
        for (const e of workspaceLint.errors) process.stdout.write(`${chalk.red("  • ")}${e}\n`);
        for (const w of workspaceLint.warnings) process.stdout.write(`${chalk.yellow("  ! ")}${w}\n`);
        if (workspaceLint.format === "json") {
          process.stdout.write(chalk.dim("  （这张图还是 workspace.graph.json；跑 agentflow flow dsl migrate 转成代码）\n"));
        }
      }
      process.exit(workspaceLint.errors.length ? 1 : 0);
      return;
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
        ". Use list, ui, validate, run-status, extract-thinking, flow, marketplace, mcp.",
    );
  }
}
