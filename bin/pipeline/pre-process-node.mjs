#!/usr/bin/env node
/**
 * 统一预处理入口：对当前节点做 ${} 替换并生成 prompt.md；读取 role / model 并计算 subagent。
 * 用法：node pre-process-node.mjs <workspaceRoot> <flowName> <uuid> <instanceId>
 * 输出（stdout JSON）：{ "ok": true, "promptPath": "...", "optionalPromptPath"?: "...", "directCommand"?: "...", "subagent": "...", "definitionId": "...", "role"?: "...", "model"?: "..." }
 * definitionId 供 CLI 做 LOCAL_ONLY 判断；directCommand 供 CLI 直接执行并跳过 agent（与 optionalPromptPath 语义一致，仅 CLI 使用）。
 *
 * 当前 pre-process 流程与 cache 的关系：
 *
 * 1) 公共开头：从 memory 加载 execId（+1 作为本轮），得到 runDir、resultPathRel；读 flow.json 得 definitionId。
 *
 * 2) 分支 A（definitionId === "control_if"）：
 *    - 用 getResolvedValues + 第一个 bool 槽取值 → parseBool → branch；
 *    - writeResult(success, branch)；
 *    - buildNodePrompt → writeCacheJsonForNode（统一写 .cache.json）→ 写 noop prompt，设 optionalPromptPath，return。
 *
 * 3) 分支 B（普通节点，含 control_toBool 走 tool_nodejs 同路径）：
 *    - buildNodePrompt → writeResult("running") → writeCacheJsonForNode（统一写 .cache.json）；
 *    - 若有 tool_load_key/tool_save_key/tool_get_env/control_anyOne 再设 optionalPromptPath，并视情况输出 directCommand 供 CLI 执行；
 *    - 返回 promptPath、resultPath、execId、subagent 等。
 *
 * cache.json 流程已统一：control_if 与普通节点均通过 writeCacheJsonForNode 在「prompt 已存在」的前提下执行 computeCacheMd5 并写入 intermediate/<instanceId>/<instanceId>.cache.json，结构一致（含 cacheMd5、cacheInputInfo、execId、inputHandlerExecIds、payload）。
 */

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { loadFlowDefinition } from "./parse-flow.mjs";
import { buildNodePrompt } from "./build-node-prompt.mjs";
import { snapshotPriorRoundIfNeeded } from "./snapshot-prior-round.mjs";
import { computeCacheMd5 } from "./compute-cache-md5.mjs";
import { getResolvedValues } from "./get-resolved-values.mjs";
import { parseBool, getFirstBoolInputValue } from "./parse-bool.mjs";
import { writeResult } from "./write-result.mjs";
import { intermediateResultBasename, intermediateCacheBasename, intermediateDirForNode, outputNodeBasename, outputDirForNode } from "./get-exec-id.mjs";
import { logToRunTag } from "./run-log.mjs";
import { getRunDir } from "../lib/paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROLE_TO_SUBAGENT = {
  requirement: "agentflow-node-executor-requirement",
  planning: "agentflow-node-executor-planning",
  code: "agentflow-node-executor-code",
  test: "agentflow-node-executor-test",
  normal: "agentflow-node-executor",
  求拆解: "agentflow-node-executor-requirement",
  技术规划: "agentflow-node-executor-planning",
  代码执行: "agentflow-node-executor-code",
  测试回归: "agentflow-node-executor-test",
  普通: "agentflow-node-executor",
};

function readFlowJson(workspaceRoot, flowName, uuid) {
  const flowJsonPath = path.join(getRunDir(workspaceRoot, flowName, uuid), "intermediate", "flow.json");
  if (!fs.existsSync(flowJsonPath)) return null;
  try {
    const flow = JSON.parse(fs.readFileSync(flowJsonPath, "utf-8"));
    return flow?.ok && Array.isArray(flow.nodes) ? flow : null;
  } catch {
    return null;
  }
}

function getRoleAndModelFromFlowJson(workspaceRoot, flowName, uuid, instanceId) {
  const flow = readFlowJson(workspaceRoot, flowName, uuid);
  if (!flow || !Array.isArray(flow.nodes)) {
    return { role: "普通", model: null };
  }
  const node = flow.nodes.find((n) => n.id === instanceId) || null;
  const roleRaw = node && node.role != null ? String(node.role).trim() : "";
  const modelRaw = node && node.model != null ? String(node.model).trim() : "";
  const role = roleRaw || "普通";
  const model = modelRaw || null;
  return { role, model };
}

/** 从 flow.json 读取节点 definitionId，优先 node.definitionId，回退 nodeDefinitions[instanceId]（start/end 等可据此做本地跳过） */
function getDefinitionIdFromFlowJson(workspaceRoot, flowName, uuid, instanceId) {
  const flow = readFlowJson(workspaceRoot, flowName, uuid);
  if (!flow) return null;
  const node = flow.nodes.find((n) => n.id === instanceId);
  return node?.definitionId ?? flow.nodeDefinitions?.[instanceId] ?? null;
}

/**
 * 统一：根据当前 prompt 文件 + resolvedInputs + 上游 cache 算 MD5 并写 intermediate/<instanceId>/<instanceId>.cache.json。
 * 调用前需保证 buildNodePrompt 已执行（prompt 文件已存在）。control_if 与普通节点共用此流程。
 */
function writeCacheJsonForNode(workspaceRoot, flowName, uuid, instanceId, execId) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const cache = computeCacheMd5(workspaceRoot, flowName, uuid, instanceId, execId);
  if (!cache.ok || (!cache.cacheMd5 && !cache.cacheInputInfo)) return;
  const nodeIntermediateDir = path.join(runDir, intermediateDirForNode(instanceId));
  fs.mkdirSync(nodeIntermediateDir, { recursive: true });
  const cachePath = path.join(nodeIntermediateDir, intermediateCacheBasename(instanceId, execId));
  const cacheObj = {
    cacheMd5: cache.cacheMd5,
    cacheInputInfo: cache.cacheInputInfo,
    execId,
  };
  if (cache.inputHandlerExecIds != null && Object.keys(cache.inputHandlerExecIds).length > 0) {
    cacheObj.inputHandlerExecIds = cache.inputHandlerExecIds;
  }
  if (cache.payload !== undefined) cacheObj.payload = cache.payload;
  // 备份由 snapshotPriorRoundIfNeeded 统一在 pre-process 入口完成；此处只管写新 cache。
  fs.writeFileSync(cachePath, JSON.stringify(cacheObj, null, 0), "utf-8");
  logToRunTag(workspaceRoot, flowName, uuid, "pre-process", {
    event: "cache-written",
    instanceId,
    cacheMd5: cache.cacheMd5,
    cachePath: path.join(intermediateDirForNode(instanceId), intermediateCacheBasename(instanceId, execId)),
  });
}

/**
 * Bash 单引号包裹任意参数：单引号内无命令替换/变量展开，避免 save_key 的 value 含反引号、`$()`、换行时把整段当 shell 执行。
 * 用法：'it'\''s' 表示 it's
 */
function bashSingleQuote(s) {
  if (s == null) return "''";
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function parseDurationMs(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("duration is required");
  const m = text.match(/^(\d+(?:\.\d+)?)\s*(ms|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)$/i);
  if (!m) throw new Error(`Invalid duration: ${text}`);
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid duration: ${text}`);
  const unit = m[2].toLowerCase();
  const mult =
    unit === "ms" || unit.startsWith("millisecond") ? 1 :
    unit === "s" || unit === "sec" || unit === "secs" || unit.startsWith("second") ? 1000 :
    unit === "m" || unit === "min" || unit === "mins" || unit.startsWith("minute") ? 60_000 :
    unit === "h" || unit === "hr" || unit.startsWith("hour") ? 3_600_000 :
    86_400_000;
  return Math.round(n * mult);
}

function zonedDateTimeToUtc(year, month, day, hour, minute, second, timezone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(guess)).reduce((acc, p) => {
    if (p.type !== "literal") acc[p.type] = Number(p.value);
    return acc;
  }, {});
  if (parts.hour === 24) parts.hour = 0;
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return new Date(guess - (asIfUtc - guess));
}

function parseDateTime(raw, timezone = "Asia/Shanghai") {
  const text = String(raw || "").trim();
  if (!text) throw new Error("until/deadlineAt is required");
  const ymd = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (ymd) {
    return zonedDateTimeToUtc(
      Number(ymd[1]),
      Number(ymd[2]),
      Number(ymd[3]),
      Number(ymd[4] || 0),
      Number(ymd[5] || 0),
      Number(ymd[6] || 0),
      timezone,
    );
  }
  const direct = Date.parse(text);
  if (Number.isFinite(direct)) return new Date(direct);

  const hm = text.match(/^(tomorrow\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/i);
  if (hm) {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now).reduce((acc, p) => {
      if (p.type !== "literal") acc[p.type] = Number(p.value);
      return acc;
    }, {});
    const date = zonedDateTimeToUtc(parts.year, parts.month, parts.day, Number(hm[2]), Number(hm[3]), Number(hm[4] || 0), timezone);
    if (hm[1]) date.setUTCDate(date.getUTCDate() + 1);
    return date;
  }

  throw new Error(`Invalid datetime: ${text}`);
}

function outputPathAbs(runDir, instanceId, execId, slotName) {
  return path.join(runDir, outputDirForNode(instanceId), outputNodeBasename(instanceId, execId, slotName));
}

function writeOutputSlot(runDir, instanceId, execId, slotName, value) {
  const p = outputPathAbs(runDir, instanceId, execId, slotName);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(value ?? "") + "\n", "utf-8");
}

function writeWaitState(runDir, state) {
  const legacyPath = path.join(runDir, "wait-state.json");
  const registryPath = path.join(runDir, "wait-states.json");
  let registry = { version: 1, flowName: state.flowName, uuid: state.uuid, waits: [] };
  if (fs.existsSync(registryPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.waits)) registry = parsed;
    } catch (_) {}
  }
  const waits = registry.waits.filter((w) => w && w.instanceId !== state.instanceId);
  const wait = { ...state, id: state.id || state.instanceId };
  waits.push(wait);
  registry = {
    ...registry,
    version: 1,
    flowName: state.flowName,
    uuid: state.uuid,
    updatedAt: new Date().toISOString(),
    waits,
  };
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf-8");
  fs.writeFileSync(legacyPath, JSON.stringify(wait, null, 2) + "\n", "utf-8");
}

function readCancelFlag(runDir) {
  for (const name of ["cancelled", "cancelled.json", "wait-cancelled.json"]) {
    const p = path.join(runDir, name);
    if (!fs.existsSync(p)) continue;
    if (name.endsWith(".json")) {
      try {
        const data = JSON.parse(fs.readFileSync(p, "utf-8"));
        if (data && (data.cancelled === true || data.status === "cancelled")) return true;
      } catch (_) {}
    } else {
      return true;
    }
  }
  return false;
}

function boolish(v) {
  if (v == null || String(v).trim() === "") return false;
  const s = String(v).trim();
  if (fs.existsSync(s)) {
    try {
      return parseBool(fs.readFileSync(s, "utf-8").trim());
    } catch (_) {
      return false;
    }
  }
  return parseBool(s);
}

function emitLocalNoopPrompt(workspaceRoot, runDir, instanceId, suffix, content) {
  const nodeIntermediateDir = path.join(runDir, intermediateDirForNode(instanceId));
  fs.mkdirSync(nodeIntermediateDir, { recursive: true });
  const promptPath = path.join(nodeIntermediateDir, `${instanceId}.${suffix}.prompt.md`);
  fs.writeFileSync(promptPath, content, "utf-8");
  return path.relative(workspaceRoot, promptPath).replace(/\\/g, "/");
}

/**
 * 若为 tool_load_key / tool_save_key / tool_get_env，写入「直接执行 agentflow apply -ai run-tool-nodejs + 对应脚本」的 prompt，
 * key/value 从 getResolvedValues 的 resolvedInputs 读取并拼入命令。
 * 返回 { optionalPromptPath, directCommand }，供 AI 用 optionalPromptPath、CLI 用 directCommand 执行。
 * @param {number} execId - 本轮 execId，传入 run-tool-nodejs 以写对 result 文件（第二轮起必须）
 */
function emitLoadSaveKeyOptionalPrompt(workspaceRoot, flowName, uuid, instanceId, definitionId, execId) {
  if (definitionId !== "tool_load_key" && definitionId !== "tool_save_key" && definitionId !== "tool_get_env") return null;
  const scriptName =
    definitionId === "tool_load_key" ? "load-key.mjs"
    : definitionId === "tool_save_key" ? "save-key.mjs"
    : "get-env.mjs";
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const nodeIntermediateDir = path.join(runDir, intermediateDirForNode(instanceId));
  const promptFileName = `${instanceId}.run-key.prompt.md`;
  const promptPath = path.join(nodeIntermediateDir, promptFileName);

  let key = "";
  let value = "";
  const data = getResolvedValues(workspaceRoot, flowName, uuid, instanceId);
  if (data.ok && data.resolvedInputs) {
    const inputs = data.resolvedInputs;
    key = inputs.key != null ? String(inputs.key).trim() : "";
    value = inputs.value != null ? String(inputs.value).trim() : "";
  }

  const rootArg = workspaceRoot;
  const q = bashSingleQuote;
  const keyQ = q(key);
  const directCommand =
    definitionId === "tool_get_env"
      ? `agentflow apply -ai get-env ${q(rootArg)} ${q(flowName)} ${q(uuid)} ${q(instanceId)} ${q(String(execId))} ${keyQ}`
      : (() => {
          const scriptArgs =
            definitionId === "tool_load_key"
              ? `${q(rootArg)} ${q(flowName)} ${q(uuid)} ${keyQ}`
              : `${q(rootArg)} ${q(flowName)} ${q(uuid)} ${keyQ} ${q(value)}`;
          const scriptPath = path.join(__dirname, definitionId === "tool_load_key" ? "load-key.mjs" : "save-key.mjs");
          return `agentflow apply -ai run-tool-nodejs ${q(rootArg)} ${q(flowName)} ${q(uuid)} ${q(instanceId)} ${q(String(execId))} -- node ${q(scriptPath)} ${scriptArgs}`;
        })();
  const content = `此节点不调用 subagent，请主 agent 在工作区根目录直接执行以下命令完成该节点。

\`\`\`bash
${directCommand}
\`\`\`
`;

  try {
    fs.mkdirSync(nodeIntermediateDir, { recursive: true });
    // 备份由 snapshotPriorRoundIfNeeded 统一处理
    fs.writeFileSync(promptPath, content, "utf-8");
  } catch (e) {
    return null;
  }
  const relativePath = path.relative(workspaceRoot, promptPath);
  return { optionalPromptPath: relativePath.replace(/\\/g, "/"), directCommand };
}

/**
 * 若为 tool_nodejs 且 buildNodePrompt 返回了非空 script（来自 flow.yaml instance.script 字段），
 * 生成 directCommand 直接通过 run-tool-nodejs 执行脚本，不调用 subagent。
 * @param {string} resolvedScript - 已解析占位符且各参数已 shell-quote 的命令（run-tool-nodejs -- 之后的部分）
 * @returns {{ optionalPromptPath: string, directCommand: string } | null}
 */
function emitToolNodejsDirectCommand(workspaceRoot, flowName, uuid, instanceId, resolvedScript, execId) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const nodeIntermediateDir = path.join(runDir, intermediateDirForNode(instanceId));
  const promptFileName = `${instanceId}.tool-nodejs-direct.prompt.md`;
  const promptPath = path.join(nodeIntermediateDir, promptFileName);

  const q = bashSingleQuote;
  const directCommand = `agentflow apply -ai run-tool-nodejs ${q(workspaceRoot)} ${q(flowName)} ${q(uuid)} ${q(instanceId)} ${q(String(execId))} -- ${resolvedScript}`;
  const content = `此节点为 tool_nodejs（直接执行模式），不调用 subagent，由流水线直接执行以下命令。

\`\`\`bash
${directCommand}
\`\`\`
`;

  try {
    fs.mkdirSync(nodeIntermediateDir, { recursive: true });
    // 备份由 snapshotPriorRoundIfNeeded 统一处理
    fs.writeFileSync(promptPath, content, "utf-8");
  } catch (e) {
    return null;
  }
  const relativePath = path.relative(workspaceRoot, promptPath);
  return { optionalPromptPath: relativePath.replace(/\\/g, "/"), directCommand };
}

/**
 * 若为 control_anyOne，写入「直接执行 write-result 将该节点标为 success」的 prompt，不调用 subagent。
 * 返回 { optionalPromptPath, directCommand }，供 AI 用 optionalPromptPath、CLI 用 directCommand 执行。
 */
function emitAnyOneOptionalPrompt(workspaceRoot, flowName, uuid, instanceId, execId) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const nodeIntermediateDir = path.join(runDir, intermediateDirForNode(instanceId));
  const promptFileName = `${instanceId}.anyOne.prompt.md`;
  const promptPath = path.join(nodeIntermediateDir, promptFileName);

  const jsonPayload = JSON.stringify({
    status: "success",
    message: "任一前驱已就绪，直接通过",
    execId,
  });
  const directCommand = `agentflow apply -ai write-result ${bashSingleQuote(workspaceRoot)} ${bashSingleQuote(flowName)} ${bashSingleQuote(uuid)} ${bashSingleQuote(instanceId)} --json ${bashSingleQuote(jsonPayload)}`;
  const content = `此节点为 control_anyOne，不调用 subagent。请主 agent 在工作区根目录直接执行以下命令将该节点标记为 success。

\`\`\`bash
${directCommand}
\`\`\`
`;

  try {
    fs.mkdirSync(nodeIntermediateDir, { recursive: true });
    // 备份由 snapshotPriorRoundIfNeeded 统一处理
    fs.writeFileSync(promptPath, content, "utf-8");
  } catch (e) {
    return null;
  }
  const relativePath = path.relative(workspaceRoot, promptPath);
  return { optionalPromptPath: relativePath.replace(/\\/g, "/"), directCommand };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 4) {
    console.error(
      JSON.stringify({
        ok: false,
        error:
          "Usage: node pre-process-node.mjs <workspaceRoot> <flowName> <uuid> <instanceId>",
      }),
    );
    process.exit(1);
  }

  const [root, flowName, uuid, instanceId] = args;
  const workspaceRoot = path.resolve(root);

  let execId = 1;
  let priorExecId = 0;
  const loadKeyPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "load-key.mjs");
  const execIdKey = "execId_" + instanceId;
  // load-key.mjs 参数约定：<workspaceRoot> <flowName> <uuid> <key>。
  // 缺 flowName 会导致 getRunDir 拼成错误路径，memory 永远读不到 → execId 每轮都回到 1，
  // snapshotPriorRoundIfNeeded 也永远 no-op，loop 跑多少轮 sidebar 都只有 #1/#2。
  const loadResult = spawnSync(process.execPath, [loadKeyPath, workspaceRoot, flowName, uuid, execIdKey], {
    cwd: workspaceRoot,
    encoding: "utf-8",
  });
  if (loadResult.stdout) {
    try {
      const out = JSON.parse(loadResult.stdout.trim());
      const result = out?.message?.result;
      if (result !== undefined && result !== "") {
        const current = parseInt(String(result), 10) || 0;
        priorExecId = current;
        execId = current + 1;
      }
    } catch (_) {}
  }

  const runDir = getRunDir(workspaceRoot, flowName, uuid);

  // 唯一备份入口：把上一轮的 intermediate/output 文件统一 rename 为 _<priorExecId>。
  // 之后任何 writer（write-result / build-node-prompt / run-tool-nodejs / get-env 等）
  // 都不再负责备份，只管对 current 路径写入新内容。
  snapshotPriorRoundIfNeeded(runDir, instanceId, priorExecId);

  const resultPathRel = `${intermediateDirForNode(instanceId)}/${intermediateResultBasename(instanceId, execId)}`;

  /** control_if：不执行 subagent，根据第一个 bool 类型输入直接写 result 并返回 optionalPromptPath */
  const definitionId = getDefinitionIdFromFlowJson(workspaceRoot, flowName, uuid, instanceId);
  if (definitionId === "control_if") {
    const flow = readFlowJson(workspaceRoot, flowName, uuid);
    const inputSlotTypes = (flow?.inputSlotTypes && flow.inputSlotTypes[instanceId]) || null;
    const data = getResolvedValues(workspaceRoot, flowName, uuid, instanceId);
    if (!data.ok || !data.resolvedInputs) {
      console.error(JSON.stringify({ ok: false, error: "control_if: getResolvedValues failed or no resolvedInputs" }));
      process.exit(1);
    }
    const rawVal = getFirstBoolInputValue(data.resolvedInputs, inputSlotTypes);
    if (rawVal == null) {
      console.error(JSON.stringify({ ok: false, error: "control_if: no bool-type input slot found" }));
      process.exit(1);
    }
    let boolValue;
    let filePath = null;
    if (rawVal.startsWith("output/") || rawVal.startsWith("intermediate/")) {
      filePath = path.join(runDir, rawVal);
    } else if (path.isAbsolute(rawVal)) {
      filePath = rawVal;
    }
    if (filePath) {
      if (fs.existsSync(filePath)) {
        boolValue = parseBool(fs.readFileSync(filePath, "utf-8").trim());
      } else {
        // 查找 snapshotPriorRoundIfNeeded 创建的 _N 备份文件
        const dir = path.dirname(filePath);
        const ext = path.extname(filePath);
        const base = path.basename(filePath, ext);
        let found = false;
        try {
          if (fs.existsSync(dir)) {
            const candidates = fs.readdirSync(dir).filter(f =>
              f.startsWith(base + "_") && f.endsWith(ext) &&
              /^\d+$/.test(f.slice(base.length + 1, -ext.length))
            );
            if (candidates.length > 0) {
              candidates.sort((a, b) => {
                const na = parseInt(a.slice(base.length + 1, -ext.length), 10);
                const nb = parseInt(b.slice(base.length + 1, -ext.length), 10);
                return nb - na;
              });
              boolValue = parseBool(fs.readFileSync(path.join(dir, candidates[0]), "utf-8").trim());
              found = true;
            }
          }
        } catch (_) {}
        if (!found) {
          console.error(JSON.stringify({ ok: false, error: `control_if: bool input file not found: ${rawVal}` }));
          process.exit(1);
        }
      }
    } else {
      boolValue = parseBool(rawVal);
    }
    const branch = boolValue ? "true" : "false";
    writeResult(workspaceRoot, flowName, uuid, instanceId, { status: "success", message: `分支 ${branch}`, branch }, { execId });
    const nodeIntermediateDir = path.join(runDir, intermediateDirForNode(instanceId));
    fs.mkdirSync(nodeIntermediateDir, { recursive: true });
    const build = buildNodePrompt(workspaceRoot, flowName, uuid, instanceId, execId);
    if (build.ok) writeCacheJsonForNode(workspaceRoot, flowName, uuid, instanceId, execId);
    const noopPromptPath = path.join(nodeIntermediateDir, `${instanceId}.control_if_noop.prompt.md`);
    // 备份由 snapshotPriorRoundIfNeeded 统一处理
    fs.writeFileSync(
      noopPromptPath,
      "此节点为 **control_if**，已由预处理根据 bool 输入直接写入 result，无需执行任何操作。",
      "utf-8",
    );
    const optionalPromptPath = path.relative(workspaceRoot, noopPromptPath).replace(/\\/g, "/");
    const output = {
      ok: true,
      promptPath: optionalPromptPath,
      resultPath: resultPathRel,
      execId,
      subagent: "agentflow-node-executor",
      optionalPromptPath,
      definitionId,
    };
    logToRunTag(workspaceRoot, flowName, uuid, "pre-process", { event: "control_if-direct-write", instanceId, branch });
    console.log(JSON.stringify(output));
    return;
  }

  if (definitionId === "control_delay" || definitionId === "control_wait_until") {
    const data = getResolvedValues(workspaceRoot, flowName, uuid, instanceId);
    if (!data.ok) {
      console.error(JSON.stringify({ ok: false, error: `${definitionId}: getResolvedValues failed` }));
      process.exit(1);
    }
    const inputs = data.resolvedInputs || {};
    let wakeAt;
    try {
      if (definitionId === "control_delay") {
        const duration = inputs.duration ?? inputs.value ?? "";
        wakeAt = new Date(Date.now() + parseDurationMs(duration)).toISOString();
      } else {
        const timezone = inputs.timezone || "Asia/Shanghai";
        wakeAt = parseDateTime(inputs.until ?? inputs.wakeAt ?? "", timezone).toISOString();
      }
    } catch (e) {
      console.error(JSON.stringify({ ok: false, error: `${definitionId}: ${e.message}` }));
      process.exit(1);
    }

    writeOutputSlot(runDir, instanceId, execId, "wakeAt", wakeAt);
    writeWaitState(runDir, {
      status: "waiting",
      reason: definitionId,
      flowName,
      uuid,
      instanceId,
      execId,
      wakeAt,
      createdAt: new Date().toISOString(),
    });
    writeResult(
      workspaceRoot,
      flowName,
      uuid,
      instanceId,
      { status: "pending", message: `等待至 ${wakeAt}` },
      { execId, preserveBody: false },
    );
    const promptPath = emitLocalNoopPrompt(
      workspaceRoot,
      runDir,
      instanceId,
      "waiting",
      `此节点为 ${definitionId}，已写入 wait-state.json，等待 scheduler 在 ${wakeAt} 唤醒。\n`,
    );
    writeCacheJsonForNode(workspaceRoot, flowName, uuid, instanceId, execId);
    logToRunTag(workspaceRoot, flowName, uuid, "pre-process", { event: "waiting", instanceId, wakeAt, definitionId });
    console.log(JSON.stringify({
      ok: true,
      promptPath,
      resultPath: resultPathRel,
      execId,
      subagent: "agentflow-node-executor",
      optionalPromptPath: promptPath,
      definitionId,
    }));
    return;
  }

  if (definitionId === "control_interval_loop") {
    const data = getResolvedValues(workspaceRoot, flowName, uuid, instanceId);
    if (!data.ok) {
      console.error(JSON.stringify({ ok: false, error: "control_interval_loop: getResolvedValues failed" }));
      process.exit(1);
    }
    const inputs = data.resolvedInputs || {};
    let branch = "continue";
    let message = "";
    let wakeAt = "";
    let expired = false;
    try {
      const timezone = inputs.timezone || "Asia/Shanghai";
      const cancelled = boolish(inputs.cancelled) || readCancelFlag(runDir);
      const done = boolish(inputs.done);
      if (cancelled) {
        branch = "cancelled";
        message = "已取消";
      } else if (done) {
        branch = "done";
        message = "已完成";
      } else {
        let deadline = null;
        if (inputs.deadlineAt) {
          deadline = parseDateTime(inputs.deadlineAt, timezone);
        } else if (inputs.duration) {
          const start = inputs.startAt ? parseDateTime(inputs.startAt, timezone) : new Date();
          deadline = new Date(start.getTime() + parseDurationMs(inputs.duration));
        }
        expired = deadline ? Date.now() >= deadline.getTime() : false;
        if (deadline) writeOutputSlot(runDir, instanceId, execId, "deadlineAt", deadline.toISOString());
        if (expired) {
          branch = "timeout";
          message = `已超过截止时间 ${deadline.toISOString()}`;
        } else {
          const interval = inputs.interval || "10m";
          wakeAt = new Date(Date.now() + parseDurationMs(interval)).toISOString();
          branch = "continue";
          message = `等待至 ${wakeAt}`;
        }
      }
    } catch (e) {
      console.error(JSON.stringify({ ok: false, error: `control_interval_loop: ${e.message}` }));
      process.exit(1);
    }
    writeOutputSlot(runDir, instanceId, execId, "expired", expired ? "true" : "false");
    if (wakeAt) writeOutputSlot(runDir, instanceId, execId, "wakeAt", wakeAt);
    const promptPath = emitLocalNoopPrompt(workspaceRoot, runDir, instanceId, "interval-loop", `此节点为 control_interval_loop，分支：${branch}。\n`);
    writeCacheJsonForNode(workspaceRoot, flowName, uuid, instanceId, execId);
    if (wakeAt) {
      writeWaitState(runDir, {
        status: "waiting",
        reason: definitionId,
        flowName,
        uuid,
        instanceId,
        execId,
        branch,
        wakeAt,
        createdAt: new Date().toISOString(),
      });
      writeResult(workspaceRoot, flowName, uuid, instanceId, { status: "pending", message, branch }, { execId, preserveBody: false });
    } else {
      writeResult(workspaceRoot, flowName, uuid, instanceId, { status: "success", message, branch }, { execId, preserveBody: false });
    }
    logToRunTag(workspaceRoot, flowName, uuid, "pre-process", { event: "interval-loop", instanceId, branch, wakeAt: wakeAt || undefined });
    console.log(JSON.stringify({
      ok: true,
      promptPath,
      resultPath: resultPathRel,
      execId,
      subagent: "agentflow-node-executor",
      optionalPromptPath: promptPath,
      definitionId,
    }));
    return;
  }

  if (definitionId === "control_deadline" || definitionId === "control_cancelled") {
    const data = getResolvedValues(workspaceRoot, flowName, uuid, instanceId);
    if (!data.ok) {
      console.error(JSON.stringify({ ok: false, error: `${definitionId}: getResolvedValues failed` }));
      process.exit(1);
    }
    const inputs = data.resolvedInputs || {};
    let boolValue = false;
    let message = "";
    try {
      if (definitionId === "control_deadline") {
        const timezone = inputs.timezone || "Asia/Shanghai";
        let deadline;
        if (inputs.deadlineAt) {
          deadline = parseDateTime(inputs.deadlineAt, timezone);
        } else {
          const start = inputs.startAt ? parseDateTime(inputs.startAt, timezone) : new Date();
          deadline = new Date(start.getTime() + parseDurationMs(inputs.duration || ""));
        }
        const deadlineAt = deadline.toISOString();
        boolValue = Date.now() >= deadline.getTime();
        writeOutputSlot(runDir, instanceId, execId, "deadlineAt", deadlineAt);
        writeOutputSlot(runDir, instanceId, execId, "expired", boolValue ? "true" : "false");
        message = boolValue ? `已超过截止时间 ${deadlineAt}` : `未超过截止时间 ${deadlineAt}`;
      } else {
        boolValue = readCancelFlag(runDir);
        writeOutputSlot(runDir, instanceId, execId, "cancelled", boolValue ? "true" : "false");
        message = boolValue ? "已取消" : "未取消";
      }
    } catch (e) {
      console.error(JSON.stringify({ ok: false, error: `${definitionId}: ${e.message}` }));
      process.exit(1);
    }
    writeResult(workspaceRoot, flowName, uuid, instanceId, { status: "success", message }, { execId, preserveBody: false });
    const promptPath = emitLocalNoopPrompt(workspaceRoot, runDir, instanceId, "local", `此节点为 ${definitionId}，已本地计算完成。\n`);
    writeCacheJsonForNode(workspaceRoot, flowName, uuid, instanceId, execId);
    logToRunTag(workspaceRoot, flowName, uuid, "pre-process", { event: "local-control", instanceId, definitionId, value: boolValue });
    console.log(JSON.stringify({
      ok: true,
      promptPath,
      resultPath: resultPathRel,
      execId,
      subagent: "agentflow-node-executor",
      optionalPromptPath: promptPath,
      definitionId,
    }));
    return;
  }

  const data = buildNodePrompt(workspaceRoot, flowName, uuid, instanceId, execId);
  if (!data.ok) {
    console.error(JSON.stringify({ ok: false, error: data.error || "build-node-prompt failed" }));
    process.exit(1);
  }

  const { role, model } = getRoleAndModelFromFlowJson(workspaceRoot, flowName, uuid, instanceId);
  const subagent = ROLE_TO_SUBAGENT[role] ?? (role && String(role).trim() ? String(role).trim() : ROLE_TO_SUBAGENT.普通);

  const intermediateDir = path.join(runDir, "intermediate");

  writeResult(workspaceRoot, flowName, uuid, instanceId, { status: "running", message: "执行中" }, { preserveBody: false, execId });
  logToRunTag(workspaceRoot, flowName, uuid, "pre-process", {
    event: "result-running",
    instanceId,
    resultPath: resultPathRel,
  });

  writeCacheJsonForNode(workspaceRoot, flowName, uuid, instanceId, execId);

  const output = {
    ok: true,
    promptPath: data.promptPath,
    nodeContext: data.nodeContext ?? "",
    taskBody: data.taskBody ?? "",
    resultPath: resultPathRel,
    execId,
    subagent,
    definitionId,
    role,
  };
  if (model) output.model = model;
  if (data.optionalPromptPath) {
    output.optionalPromptPath = data.optionalPromptPath;
  }
  const runKeyResult = emitLoadSaveKeyOptionalPrompt(workspaceRoot, flowName, uuid, instanceId, definitionId, execId);
  if (runKeyResult) {
    output.optionalPromptPath = runKeyResult.optionalPromptPath;
    output.directCommand = runKeyResult.directCommand;
  } else if (definitionId === "control_anyOne") {
    const anyOneResult = emitAnyOneOptionalPrompt(workspaceRoot, flowName, uuid, instanceId, execId);
    if (anyOneResult) {
      output.optionalPromptPath = anyOneResult.optionalPromptPath;
      output.directCommand = anyOneResult.directCommand;
    }
  } else if ((definitionId === "tool_nodejs" || definitionId === "control_toBool" || String(definitionId || "").startsWith("marketplace:")) && data.script) {
    const toolNodejsResult = emitToolNodejsDirectCommand(workspaceRoot, flowName, uuid, instanceId, data.script, execId);
    if (toolNodejsResult) {
      output.optionalPromptPath = toolNodejsResult.optionalPromptPath;
      output.directCommand = toolNodejsResult.directCommand;
      output.resolvedScript = data.script;
    }
  }
  logToRunTag(workspaceRoot, flowName, uuid, "pre-process", {
    event: "done",
    instanceId,
    promptPath: data.promptPath,
    resultPath: resultPathRel,
    subagent,
    definitionId,
    hasOptionalPrompt: !!output.optionalPromptPath,
    hasDirectCommand: !!output.directCommand,
  });
  console.log(JSON.stringify(output));
}

main();
