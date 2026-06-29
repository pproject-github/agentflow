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
import os from "os";
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
import { getRunDir, sanitizeAgentflowUserId } from "../lib/paths.mjs";
import {
  buildSkillsContext,
  buildSkillsContextFromRegistry,
  buildDefaultWorkspaceContext,
  expandRuntimePlaceholders,
  normalizeSkillsContext,
  normalizeWorkspaceContext,
  parseSkillKeyList,
  resolveWorkspaceTarget,
} from "../lib/runtime-context.mjs";
import { buildGitContext, inferGitRepoRootFromWorktree, loadGitWorktree, normalizeGitContext, unloadGitWorktree } from "../lib/git-worktree.mjs";
import { createGitLabMergeRequest } from "../lib/gitlab-mr.mjs";

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

function agentflowCommand() {
  const userId = sanitizeAgentflowUserId(process.env.AGENTFLOW_USER_ID);
  if (!userId) return "agentflow";
  return `AGENTFLOW_USER_ID=${bashSingleQuote(userId)} agentflow`;
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

function readFlowJsonObject(workspaceRoot, flowName, uuid) {
  const flowJsonPath = path.join(getRunDir(workspaceRoot, flowName, uuid), "intermediate", "flow.json");
  if (!fs.existsSync(flowJsonPath)) return null;
  try {
    const flow = JSON.parse(fs.readFileSync(flowJsonPath, "utf-8"));
    return flow && typeof flow === "object" ? flow : null;
  } catch {
    return null;
  }
}

function resolveNodeRuntimeContexts(workspaceRoot, flowName, uuid, instanceId) {
  const flowJson = readFlowJsonObject(workspaceRoot, flowName, uuid);
  const data = getResolvedValues(workspaceRoot, flowName, uuid, instanceId);
  const inputs = data.ok ? (data.resolvedInputs || {}) : {};
  const workspaceContext = normalizeWorkspaceContext(inputs.workspaceContext, workspaceRoot, flowName, flowJson);
  const skillsContext = normalizeSkillsContext(inputs.skillsContext);
  return { inputs, workspaceContext, skillsContext, flowJson };
}

function sanitizeRepoDirName(repoUrl) {
  const raw = String(repoUrl || "").trim().replace(/\.git$/i, "");
  const last = raw.split(/[/:]/).filter(Boolean).pop() || "repo";
  return last.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

function runGit(args, cwd) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function isTruthyInput(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes" || text === "y" || text === "on";
}

function resolveMaybeWorkspacePath(raw, workspaceContext, extra = {}) {
  const text = String(raw || "").trim();
  if (!text) return "";
  return resolveWorkspaceTarget(text, workspaceContext, extra);
}

function emitGitCheckoutNode(workspaceRoot, flowName, uuid, instanceId, execId, resultPathRel) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const { inputs, workspaceContext } = resolveNodeRuntimeContexts(workspaceRoot, flowName, uuid, instanceId);
  const repoUrl = String(inputs.repoUrl || inputs.url || "").trim();
  if (!repoUrl) throw new Error("tool_git_checkout: repoUrl is required");
  const branch = String(inputs.branch || "").trim();
  const pullIfExists = String(inputs.pullIfExists ?? "true").trim().toLowerCase() !== "false";
  const includeSubmodules = isTruthyInput(inputs.includeSubmodules ?? inputs.submodules ?? inputs.pullSubmodules);
  const defaultDir = path.join(workspaceContext.pipelineWorkspace || workspaceRoot, ".workspace", "agentflow", "git-repos", sanitizeRepoDirName(repoUrl));
  const targetRaw = String(inputs.targetDir || "").trim();
  const targetDir = targetRaw
    ? resolveWorkspaceTarget(targetRaw, workspaceContext, { repoName: sanitizeRepoDirName(repoUrl) })
    : defaultDir;

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  let changed = false;
  let action = "clone";
  if (fs.existsSync(path.join(targetDir, ".git"))) {
    action = pullIfExists ? "pull" : "exists";
    if (pullIfExists) {
      const fetch = runGit(["fetch", "--all", "--prune"], targetDir);
      if (fetch.status !== 0) throw new Error(`git fetch failed: ${fetch.stderr || fetch.stdout}`);
      if (branch) {
        const checkout = runGit(["checkout", branch], targetDir);
        if (checkout.status !== 0) throw new Error(`git checkout failed: ${checkout.stderr || checkout.stdout}`);
      }
      const before = runGit(["rev-parse", "HEAD"], targetDir).stdout.trim();
      const pull = runGit(["pull", "--ff-only"], targetDir);
      if (pull.status !== 0) throw new Error(`git pull failed: ${pull.stderr || pull.stdout}`);
      const after = runGit(["rev-parse", "HEAD"], targetDir).stdout.trim();
      changed = before !== after;
    }
  } else {
    const args = ["clone"];
    if (includeSubmodules) args.push("--recurse-submodules");
    if (branch) args.push("--branch", branch);
    args.push(repoUrl, targetDir);
    const clone = runGit(args, workspaceContext.cwd || workspaceRoot);
    if (clone.status !== 0) throw new Error(`git clone failed: ${clone.stderr || clone.stdout}`);
    changed = true;
  }
  if (includeSubmodules) {
    const submodule = runGit(["submodule", "update", "--init", "--recursive"], targetDir);
    if (submodule.status !== 0) throw new Error(`git submodule update failed: ${submodule.stderr || submodule.stdout}`);
  }

  const currentBranch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], targetDir).stdout.trim();
  const commit = runGit(["rev-parse", "HEAD"], targetDir).stdout.trim();
  const gitContext = buildGitContext({
    repoPath: targetDir,
    branch: currentBranch === "HEAD" ? "DETACHED" : currentBranch,
    commit,
    remote: String(inputs.remote || "origin").trim() || "origin",
  });
  const outWorkspaceContext = {
    version: 1,
    label: inputs.label || sanitizeRepoDirName(repoUrl),
    cwd: path.resolve(targetDir),
    workspaceRoot: path.resolve(targetDir),
    pipelineWorkspace: workspaceContext.pipelineWorkspace || path.resolve(workspaceRoot),
    flowDir: workspaceContext.flowDir,
    previous: workspaceContext,
  };
  writeOutputSlot(runDir, instanceId, execId, "repoPath", targetDir);
  writeOutputSlot(runDir, instanceId, execId, "branch", currentBranch);
  writeOutputSlot(runDir, instanceId, execId, "commit", commit);
  writeOutputSlot(runDir, instanceId, execId, "changed", changed ? "true" : "false");
  writeOutputSlot(runDir, instanceId, execId, "workspaceContext", JSON.stringify(outWorkspaceContext));
  writeOutputSlot(runDir, instanceId, execId, "gitContext", JSON.stringify(gitContext));
  writeResult(workspaceRoot, flowName, uuid, instanceId, { status: "success", message: `git ${action}: ${currentBranch}@${commit.slice(0, 8)}` }, { execId });
  return emitLocalNoopPrompt(workspaceRoot, runDir, instanceId, "git-checkout", `Git checkout completed: ${targetDir}\n`);
}

function requireWorkspaceContextInput(inputs, definitionId) {
  if (!String(inputs?.workspaceContext || "").trim()) {
    throw new Error(`${definitionId}: workspaceContext is required`);
  }
}

function emitGitWorktreeLoadNode(workspaceRoot, flowName, uuid, instanceId, execId) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const { inputs, workspaceContext } = resolveNodeRuntimeContexts(workspaceRoot, flowName, uuid, instanceId);
  requireWorkspaceContextInput(inputs, "tool_git_worktree_load");
  const gitContext = normalizeGitContext(inputs.gitContext);
  const repoPath = resolveMaybeWorkspacePath(inputs.repoPath, workspaceContext) ||
    (gitContext?.repoPath ? path.resolve(gitContext.repoPath) : "");
  if (!repoPath) throw new Error("tool_git_worktree_load: repoPath or gitContext.repoPath is required");
  const branch = String(inputs.branch || "").trim();
  const worktreePath = resolveMaybeWorkspacePath(inputs.worktreePath, workspaceContext, { branch }) ||
    (gitContext?.worktreePath ? path.resolve(gitContext.worktreePath) : "");
  const force = isTruthyInput(inputs.force);
  const pruneMissing = String(inputs.pruneMissing ?? "true").trim().toLowerCase() !== "false";
  const result = loadGitWorktree({
    repoPath,
    branch,
    worktreePath,
    pipelineWorkspace: workspaceContext.pipelineWorkspace || path.resolve(workspaceRoot),
    force,
    pruneMissing,
  });
  const outWorkspaceContext = {
    version: 1,
    label: result.branch === "DETACHED" ? `worktree:${result.commit.slice(0, 8)}` : `worktree:${result.branch}`,
    cwd: result.worktreePath,
    workspaceRoot: result.worktreePath,
    pipelineWorkspace: workspaceContext.pipelineWorkspace || path.resolve(workspaceRoot),
    flowDir: workspaceContext.flowDir,
    previous: workspaceContext,
  };
  const outGitContext = buildGitContext({
    repoPath: result.repoRoot,
    worktreePath: result.worktreePath,
    branch: result.branch,
    commit: result.commit,
    remote: gitContext?.remote || "origin",
    remoteUrl: gitContext?.remoteUrl || "",
  });
  writeOutputSlot(runDir, instanceId, execId, "worktreePath", result.worktreePath);
  writeOutputSlot(runDir, instanceId, execId, "branch", result.branch);
  writeOutputSlot(runDir, instanceId, execId, "commit", result.commit);
  writeOutputSlot(runDir, instanceId, execId, "workspaceContext", JSON.stringify(outWorkspaceContext));
  writeOutputSlot(runDir, instanceId, execId, "gitContext", JSON.stringify(outGitContext));
  writeResult(workspaceRoot, flowName, uuid, instanceId, {
    status: "success",
    message: `worktree loaded: ${result.worktreePath} (${result.branch}@${result.commit.slice(0, 8)})`,
  }, { execId });
  return emitLocalNoopPrompt(workspaceRoot, runDir, instanceId, "git-worktree-load", `Git worktree loaded: ${result.worktreePath}\n`);
}

function emitGitWorktreeUnloadNode(workspaceRoot, flowName, uuid, instanceId, execId) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const { inputs, workspaceContext, flowJson } = resolveNodeRuntimeContexts(workspaceRoot, flowName, uuid, instanceId);
  requireWorkspaceContextInput(inputs, "tool_git_worktree_unload");
  const gitContext = normalizeGitContext(inputs.gitContext);
  const worktreePath = resolveMaybeWorkspacePath(inputs.worktreePath, workspaceContext) ||
    (gitContext?.worktreePath ? path.resolve(gitContext.worktreePath) : "") ||
    (workspaceContext.cwd ? path.resolve(workspaceContext.cwd) : "") ||
    (workspaceContext.workspaceRoot ? path.resolve(workspaceContext.workspaceRoot) : "");
  if (!worktreePath) throw new Error("tool_git_worktree_unload: workspaceContext.cwd or worktreePath is required");
  const repoPath = resolveMaybeWorkspacePath(inputs.repoPath, workspaceContext) ||
    (gitContext?.repoPath ? path.resolve(gitContext.repoPath) : "") ||
    inferGitRepoRootFromWorktree(worktreePath) ||
    (workspaceContext.previous?.cwd ? path.resolve(workspaceContext.previous.cwd) : "") ||
    (workspaceContext.previous?.workspaceRoot ? path.resolve(workspaceContext.previous.workspaceRoot) : "");
  const force = isTruthyInput(inputs.force);
  const prune = String(inputs.prune ?? "true").trim().toLowerCase() !== "false";
  const result = unloadGitWorktree({ repoPath, worktreePath, force, prune });
  const nextWorkspaceContext = workspaceContext.previous
    ? normalizeWorkspaceContext(workspaceContext.previous, workspaceRoot, flowName, flowJson)
    : buildDefaultWorkspaceContext(workspaceRoot, flowName, flowJson);
  writeOutputSlot(runDir, instanceId, execId, "removed", "true");
  writeOutputSlot(runDir, instanceId, execId, "message", result.message);
  writeOutputSlot(runDir, instanceId, execId, "workspaceContext", JSON.stringify(nextWorkspaceContext));
  writeResult(workspaceRoot, flowName, uuid, instanceId, {
    status: "success",
    message: result.message,
  }, { execId });
  return emitLocalNoopPrompt(workspaceRoot, runDir, instanceId, "git-worktree-unload", `${result.message}\n`);
}

async function emitGitLabCreateMrNode(workspaceRoot, flowName, uuid, instanceId, execId) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const { inputs, workspaceContext } = resolveNodeRuntimeContexts(workspaceRoot, flowName, uuid, instanceId);
  const repoPath = resolveMaybeWorkspacePath(inputs.repoPath, workspaceContext);
  const result = await createGitLabMergeRequest({
    gitContext: inputs.gitContext,
    workspaceCwd: workspaceContext.cwd,
    repoPath,
    sourceBranch: inputs.sourceBranch,
    targetBranch: inputs.targetBranch,
    title: inputs.title,
    description: inputs.description,
    draft: inputs.draft,
    labels: inputs.labels,
    push: inputs.push,
    remote: inputs.remote,
    tokenEnv: inputs.tokenEnv,
    gitlabApiBase: inputs.gitlabApiBase,
    removeSourceBranch: inputs.removeSourceBranch,
    squash: inputs.squash,
  }, process.env);
  writeOutputSlot(runDir, instanceId, execId, "mrUrl", result.mrUrl);
  writeOutputSlot(runDir, instanceId, execId, "created", result.created ? "true" : "false");
  writeOutputSlot(runDir, instanceId, execId, "mrIid", result.mrIid ?? "");
  writeOutputSlot(runDir, instanceId, execId, "projectId", result.projectId ?? "");
  writeOutputSlot(runDir, instanceId, execId, "sourceBranch", result.sourceBranch ?? "");
  writeOutputSlot(runDir, instanceId, execId, "targetBranch", result.targetBranch ?? "");
  writeOutputSlot(runDir, instanceId, execId, "title", result.title ?? "");
  writeOutputSlot(runDir, instanceId, execId, "message", result.message ?? "");
  writeResult(workspaceRoot, flowName, uuid, instanceId, {
    status: "success",
    message: result.message || result.mrUrl,
    body: result.mrUrl,
  }, { execId });
  return emitLocalNoopPrompt(workspaceRoot, runDir, instanceId, "gitlab-create-mr", `${result.message || "GitLab MR ready"}\n${result.mrUrl}\n`);
}

function emitCdWorkspaceNode(workspaceRoot, flowName, uuid, instanceId, execId) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const { inputs, workspaceContext } = resolveNodeRuntimeContexts(workspaceRoot, flowName, uuid, instanceId);
  const mode = String(inputs.mode || "set").trim().toLowerCase();
  let next;
  if (mode === "pop") {
    next = normalizeWorkspaceContext(workspaceContext.previous, workspaceRoot, flowName);
  } else {
    const target = resolveWorkspaceTarget(inputs.path || inputs.target || inputs.repoPath || "", workspaceContext);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      throw new Error(`control_cd_workspace: path directory not found: ${target}`);
    }
    next = {
      version: 1,
      label: String(inputs.label || path.basename(target) || "workspace").trim(),
      cwd: path.resolve(target),
      workspaceRoot: path.resolve(target),
      pipelineWorkspace: workspaceContext.pipelineWorkspace || path.resolve(workspaceRoot),
      flowDir: workspaceContext.flowDir,
      previous: mode === "push" ? workspaceContext : workspaceContext.previous || null,
    };
  }
  writeOutputSlot(runDir, instanceId, execId, "workspaceContext", JSON.stringify(next));
  writeOutputSlot(runDir, instanceId, execId, "cwd", next.cwd);
  writeOutputSlot(runDir, instanceId, execId, "previous", next.previous ? JSON.stringify(next.previous) : "");
  writeResult(workspaceRoot, flowName, uuid, instanceId, { status: "success", message: `cwd=${next.cwd}` }, { execId });
  return emitLocalNoopPrompt(workspaceRoot, runDir, instanceId, "cd-workspace", `Workspace context switched to: ${next.cwd}\n`);
}

function emitUserWorkspaceNode(workspaceRoot, flowName, uuid, instanceId, execId) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const { workspaceContext } = resolveNodeRuntimeContexts(workspaceRoot, flowName, uuid, instanceId);
  const homeDir = path.resolve(os.homedir());
  const next = {
    version: 1,
    label: "home",
    cwd: homeDir,
    workspaceRoot: homeDir,
    pipelineWorkspace: workspaceContext.pipelineWorkspace || path.resolve(workspaceRoot),
    flowDir: workspaceContext.flowDir,
    previous: workspaceContext,
  };
  writeOutputSlot(runDir, instanceId, execId, "workspaceContext", JSON.stringify(next));
  writeOutputSlot(runDir, instanceId, execId, "cwd", next.cwd);
  writeResult(workspaceRoot, flowName, uuid, instanceId, { status: "success", message: `user workspace: ${homeDir}` }, { execId });
  return emitLocalNoopPrompt(workspaceRoot, runDir, instanceId, "user-workspace", `Workspace context switched to user home: ${homeDir}\n`);
}

function emitLoadSkillsNode(workspaceRoot, flowName, uuid, instanceId, execId) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const { inputs, workspaceContext, skillsContext: existingSkills } = resolveNodeRuntimeContexts(workspaceRoot, flowName, uuid, instanceId);
  const mergeMode = String(inputs.mergeMode || "replace").trim();
  const skillKeys = parseSkillKeyList(inputs.skillKeys || inputs.skills || inputs.keys || "");
  let source = "public-registry";
  let loaded;
  if (skillKeys.length > 0) {
    loaded = buildSkillsContextFromRegistry({ workspaceContext, skillKeys, mergeMode });
  } else {
    source = String(inputs.source || "current-workspace").trim();
    const paths = String(inputs.paths || "")
      .split(/\r?\n|,/)
      .map((x) => expandRuntimePlaceholders(x, workspaceContext).trim())
      .filter(Boolean);
    const include = String(inputs.include || "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    const exclude = String(inputs.exclude || "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    loaded = buildSkillsContext({ workspaceContext, source, paths, include, exclude, mergeMode });
  }
  let next = loaded;
  if (existingSkills && mergeMode !== "replace") {
    const existingBodies = Array.isArray(existingSkills.skillBodies) ? existingSkills.skillBodies : [];
    const loadedBodies = Array.isArray(loaded.skillBodies) ? loaded.skillBodies : [];
    const skillBodies = mergeMode === "prepend" ? [...loadedBodies, ...existingBodies] : [...existingBodies, ...loadedBodies];
    const seen = new Set();
    next = {
      ...loaded,
      skillBodies: skillBodies.filter((s) => {
        const key = s.key || s.name;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    };
    next.skills = next.skillBodies.map(({ body, ...meta }) => meta);
    next.skillKeys = next.skills.map((s) => s.key);
    next.loadedCount = next.skills.length;
  }
  writeOutputSlot(runDir, instanceId, execId, "skillsContext", JSON.stringify(next));
  writeOutputSlot(runDir, instanceId, execId, "loadedCount", String(next.loadedCount || 0));
  writeOutputSlot(runDir, instanceId, execId, "summary", `${next.loadedCount || 0} skills loaded from ${source}`);
  writeResult(workspaceRoot, flowName, uuid, instanceId, { status: "success", message: `加载 ${next.loadedCount || 0} 个 skills` }, { execId });
  return emitLocalNoopPrompt(workspaceRoot, runDir, instanceId, "load-skills", `Loaded ${next.loadedCount || 0} skills.\n`);
}

function readPrintableValue(value, runDir) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const candidates = [];
  if (path.isAbsolute(text)) candidates.push(text);
  candidates.push(path.join(runDir, text));
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
      const stat = fs.statSync(candidate);
      if (stat.size > 1024 * 1024) {
        return fs.readFileSync(candidate, "utf-8").slice(0, 1024 * 1024) + "\n\n[内容超过 1MB，已截断]";
      }
      return fs.readFileSync(candidate, "utf-8").trim();
    } catch (_) {}
  }
  return text;
}

function readResultBody(runDir, sourceInstanceId) {
  const id = String(sourceInstanceId || "").trim();
  if (!id) return "";
  const resultPath = path.join(runDir, intermediateDirForNode(id), intermediateResultBasename(id, 1));
  try {
    if (!fs.existsSync(resultPath)) return "";
    const raw = fs.readFileSync(resultPath, "utf-8");
    const match = raw.match(/---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n([\s\S]*)$/);
    return (match ? match[1] : raw).trim();
  } catch (_) {
    return "";
  }
}

function emitToolPrintNode(workspaceRoot, flowName, uuid, instanceId, execId) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const flowJson = readFlowJsonObject(workspaceRoot, flowName, uuid);
  const data = getResolvedValues(workspaceRoot, flowName, uuid, instanceId);
  const inputs = data.ok ? (data.resolvedInputs || {}) : {};
  const skipNames = new Set(["prev", "next", "workspaceContext", "gitContext", "skillsContext", "workspaceRoot", "pipelineWorkspace", "flowName", "runDir", "flowDir", "cwd"]);

  let content = readPrintableValue(inputs.content, runDir);
  if (!content) {
    const parts = [];
    for (const [name, value] of Object.entries(inputs)) {
      if (skipNames.has(name)) continue;
      const v = readPrintableValue(value, runDir);
      if (!v) continue;
      parts.push(name === "content" ? v : `## ${name}\n\n${v}`);
    }
    content = parts.join("\n\n").trim();
  }
  if (!content && inputs.prev) {
    content = readResultBody(runDir, inputs.prev);
  }
  if (!content && flowJson?.nodes) {
    const node = flowJson.nodes.find((n) => n.id === instanceId);
    content = String(node?.body || "").trim();
  }
  if (!content) content = "(tool_print 没有可展示内容：请填写 content 输入，或连接上游输出到 content。)";

  writeResult(
    workspaceRoot,
    flowName,
    uuid,
    instanceId,
    { status: "success", message: "Print 输出" },
    { execId, preserveBody: false, body: content },
  );
  return emitLocalNoopPrompt(workspaceRoot, runDir, instanceId, "tool-print", `Printed content for ${instanceId}.\n`);
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
  const waitId = String(state.waitId || state.id || `${state.instanceId}:${state.execId || 1}`).trim();
  const waits = registry.waits.filter((w) => {
    if (!w) return false;
    const key = String(w.waitId || w.id || "").trim();
    if (key && key === waitId) return false;
    return !(w.instanceId === state.instanceId && String(w.execId || 1) === String(state.execId || 1));
  });
  const wait = { ...state, waitId, id: state.id || waitId };
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

function buildWaitId(uuid, instanceId, execId, explicit = "") {
  const text = String(explicit || "").trim();
  if (text) return text;
  return `${uuid}:${instanceId}:${execId || 1}`;
}

function readWaitStateById(runDir, waitId) {
  const text = String(waitId || "").trim();
  if (!text) return null;
  const registryPath = path.join(runDir, "wait-states.json");
  if (fs.existsSync(registryPath)) {
    try {
      const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
      const waits = Array.isArray(registry?.waits) ? registry.waits : [];
      const found = waits.find((w) => {
        const key = String(w?.waitId || w?.id || "").trim();
        return key === text;
      });
      if (found) return found;
    } catch (_) {}
  }
  const legacyPath = path.join(runDir, "wait-state.json");
  if (fs.existsSync(legacyPath)) {
    try {
      const state = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
      const key = String(state?.waitId || state?.id || "").trim();
      if (key === text) return state;
    } catch (_) {}
  }
  return null;
}

function readCancelFlagForWait(runDir, waitId) {
  const state = readWaitStateById(runDir, waitId);
  if (state && (state.cancelled === true || state.status === "cancelled" || state.branch === "cancelled")) return true;
  return readCancelFlag(runDir);
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
  const af = agentflowCommand();
  const directCommand =
    definitionId === "tool_get_env"
      ? `${af} apply -ai get-env ${q(rootArg)} ${q(flowName)} ${q(uuid)} ${q(instanceId)} ${q(String(execId))} ${keyQ}`
      : (() => {
          const scriptArgs =
            definitionId === "tool_load_key"
              ? `${q(rootArg)} ${q(flowName)} ${q(uuid)} ${keyQ}`
              : `${q(rootArg)} ${q(flowName)} ${q(uuid)} ${keyQ} ${q(value)}`;
          const scriptPath = path.join(__dirname, definitionId === "tool_load_key" ? "load-key.mjs" : "save-key.mjs");
          return `${af} apply -ai run-tool-nodejs ${q(rootArg)} ${q(flowName)} ${q(uuid)} ${q(instanceId)} ${q(String(execId))} -- node ${q(scriptPath)} ${scriptArgs}`;
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
  const directCommand = `${agentflowCommand()} apply -ai run-tool-nodejs ${q(workspaceRoot)} ${q(flowName)} ${q(uuid)} ${q(instanceId)} ${q(String(execId))} -- ${resolvedScript}`;
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
  const directCommand = `${agentflowCommand()} apply -ai write-result ${bashSingleQuote(workspaceRoot)} ${bashSingleQuote(flowName)} ${bashSingleQuote(uuid)} ${bashSingleQuote(instanceId)} --json ${bashSingleQuote(jsonPayload)}`;
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

async function main() {
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

    const waitId = buildWaitId(uuid, instanceId, execId, inputs.waitId || inputs.watchId);
    writeOutputSlot(runDir, instanceId, execId, "waitId", waitId);
    writeOutputSlot(runDir, instanceId, execId, "wakeAt", wakeAt);
    writeWaitState(runDir, {
      waitId,
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
    logToRunTag(workspaceRoot, flowName, uuid, "pre-process", { event: "waiting", instanceId, waitId, wakeAt, definitionId });
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

  if (definitionId === "control_cancelled") {
    const data = getResolvedValues(workspaceRoot, flowName, uuid, instanceId);
    if (!data.ok) {
      console.error(JSON.stringify({ ok: false, error: "control_cancelled: getResolvedValues failed" }));
      process.exit(1);
    }
    let boolValue;
    let message;
    try {
      const inputs = data.resolvedInputs || {};
      const waitId = String(inputs.waitId || inputs.watchId || "").trim();
      boolValue = waitId ? readCancelFlagForWait(runDir, waitId) : readCancelFlag(runDir);
      writeOutputSlot(runDir, instanceId, execId, "cancelled", boolValue ? "true" : "false");
      message = boolValue ? "已取消" : "未取消";
    } catch (e) {
      console.error(JSON.stringify({ ok: false, error: `control_cancelled: ${e.message}` }));
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

  if (definitionId === "tool_git_checkout" || definitionId === "tool_git_worktree_load" || definitionId === "tool_git_worktree_unload" || definitionId === "tool_gitlab_create_mr" || definitionId === "control_cd_workspace" || definitionId === "control_user_workspace" || definitionId === "control_load_skills" || definitionId === "tool_print") {
    try {
      const promptPath =
        definitionId === "tool_git_checkout"
          ? emitGitCheckoutNode(workspaceRoot, flowName, uuid, instanceId, execId, resultPathRel)
          : definitionId === "tool_git_worktree_load"
            ? emitGitWorktreeLoadNode(workspaceRoot, flowName, uuid, instanceId, execId)
            : definitionId === "tool_git_worktree_unload"
              ? emitGitWorktreeUnloadNode(workspaceRoot, flowName, uuid, instanceId, execId)
              : definitionId === "tool_gitlab_create_mr"
                ? await emitGitLabCreateMrNode(workspaceRoot, flowName, uuid, instanceId, execId)
                : definitionId === "control_cd_workspace"
                  ? emitCdWorkspaceNode(workspaceRoot, flowName, uuid, instanceId, execId)
                  : definitionId === "control_user_workspace"
                    ? emitUserWorkspaceNode(workspaceRoot, flowName, uuid, instanceId, execId)
                    : definitionId === "control_load_skills"
                      ? emitLoadSkillsNode(workspaceRoot, flowName, uuid, instanceId, execId)
                      : emitToolPrintNode(workspaceRoot, flowName, uuid, instanceId, execId);
      writeCacheJsonForNode(workspaceRoot, flowName, uuid, instanceId, execId);
      logToRunTag(workspaceRoot, flowName, uuid, "pre-process", { event: "runtime-context-node", instanceId, definitionId });
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
    } catch (e) {
      console.error(JSON.stringify({ ok: false, error: `${definitionId}: ${e.message || e}` }));
      process.exit(1);
    }
  }

  const runtimeContexts = resolveNodeRuntimeContexts(workspaceRoot, flowName, uuid, instanceId);
  const data = buildNodePrompt(workspaceRoot, flowName, uuid, instanceId, execId, {
    workspaceContext: runtimeContexts.workspaceContext,
    skillsContext: runtimeContexts.skillsContext,
  });
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
  if (data.workspaceContext) output.workspaceContext = data.workspaceContext;
  if (data.skillsContext) output.skillsContext = data.skillsContext;
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

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message || String(e) }));
  process.exit(1);
});
