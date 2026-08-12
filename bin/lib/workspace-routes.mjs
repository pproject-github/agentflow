/**
 * Workspace 的 HTTP 路由。
 *
 * 31 条路由从 `startUiServer` 那个七千行的请求回调里原样搬出来——**路由体一行没改**。
 * 两个约定让这件事成立：
 *
 * 1. **命中与否看 `res.headersSent`。** 路由体里的 `return;` 保持原样（它们在原地就是
 *    「已经回过响应，别再往下走」的意思），外层据此判断要不要继续 ui-server 的后续路由。
 *    改成 `return true` 就得逐个甄别哪些 `return` 在嵌套回调里，那正是搬运出错的地方。
 * 2. **闭包变量在函数头部从 ctx 解构回同名标识符。** `url` / `userCtx` / `root` 这些原本
 *    是请求回调的闭包，解构之后路由体里的写法完全不变。
 */

import { listNodesJson, readNodeDetailJson, readNodeFilePreview } from "./catalog-flows.mjs";
import { startComposerAgent } from "./composer-agent.mjs";
import { buildSkillCompactInjectionBlock, loadResourcesForSkillKeys } from "./composer-skill-router.mjs";
import { execFileBuffered } from "./exec-buffered.mjs";
import { runGit } from "./git-worktree.mjs";
import {
  listMarketplacePackages,
  nodePackageArchive,
  publishNodePackage,
  publishNodePackageArchive,
  resolveMarketplaceNodePackage,
} from "./marketplace.mjs";
import { NODE_PACKAGE_ENTRY, nodePackageExportsRun, readNodePackageManifest } from "./node-package-manifest.mjs";
import { inspectNodePackageDirectory } from "./node-package-archive.mjs";
import { json, readBody } from "./http-util.mjs";
import { log } from "./log.mjs";
import { PACKAGE_ROOT, getAgentflowUserDataRoot } from "./paths.mjs";
import { runLedgerId } from "./run-ledger.mjs";
import { getTeamById, getTeamForUser } from "./teams.mjs";
import { readMergedEnvObject, runtimeEnvForUser } from "./user-env.mjs";
import { acceptWorkspaceCollaborationInvite, addWorkspaceCollaborationMember, ensureWorkspaceCollaboration, getWorkspaceCollaborationForProject, listWorkspaceCollaborationsForUser, removeWorkspaceCollaborationMember, removeWorkspaceCollaborationTeamShare, setWorkspaceCollaborationTeamShare, workspaceCollaborationAccess } from "./workspace-collaboration.mjs";
import { WorkspaceFlowParseError } from "./workspace-flow-store.mjs";
import { mergeWorkspaceGraphs, workspaceDesignRevision, workspaceRuntimeRevision } from "./workspace-graph-merge.mjs";
import { DEFAULT_WORKSPACE_PREVIEW_TTL_MS, createWorkspacePreviewId, normalizeWorkspacePreviewTtlMs, readWorkspacePreviewMetadata, workspaceSharedPreviewFlowDir, writeWorkspacePreviewMetadata } from "./workspace-preview.mjs";
import { appendWorkspaceRunLogEvent, createWorkspaceRunLogSession, finishWorkspaceRunLogSession, listWorkspaceRunLogs, readWorkspaceRunLogEvents } from "./workspace-run-logs.mjs";
import { activeWorkspaceRuns, appendWorkspaceRunFinished, appendWorkspaceRunStarted, hydrateWorkspaceGraphForRuntime, isReadonlyBuiltinFlowSource, isTransientAgentNetworkError, isValidFlowSourceRead, isWorkspaceRunAbortError, listWorkspaceScheduleStatusesForFlow, mergeWorkspacePersistentNodeRefs, mergeWorkspaceRunGraph, normalizeWorkspaceEntry, readWorkspaceConversations, readWorkspaceFiles, readWorkspaceGraph, resolveWorkspaceFilePath, resolveWorkspaceScopeRoot, runWorkspaceGraph, sleepMs, syncWorkspaceSchedulesForGraph, workspaceActiveRunsForScope, workspaceCollaborationEventKey, workspaceCollaborationSequences, workspaceCollaborationSubscribers, workspaceCollaborationSummaryWithUsers, workspaceDesignPath, workspaceDownloadContentDisposition, workspaceFindActiveRunConflict, workspaceGraphAsSource, workspaceOptimizeRunImplementations, workspaceRepoUrlWithCredential, workspaceRunControl, workspaceRunEntryKey, workspaceRunKey, workspaceRunPlan, workspaceRunPlanNodeIds, workspaceRunTouchedNodeIds, workspaceRuntimeNodeLabel, workspaceScopedUserContext, workspaceSearchGuardrailsBlock, workspaceUnwrapOutputEnvelopeForDisplay, workspacesPath, writeWorkspaceConversations, writeWorkspaceGraph } from "./workspace-server.mjs";
import { getWorkspaceTree } from "./workspace-tree.mjs";
import busboy from "busboy";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import { pathToFileURL } from "url";

function sanitizeWorkspaceUploadName(filename) {
  const parsed = path.parse(String(filename || "image").replace(/\\/g, "/").split("/").pop() || "image");
  const stem = (parsed.name || "image")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "image";
  const ext = String(parsed.ext || "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "")
    .slice(0, 24);
  return `${stem}${ext}`;
}

function uniqueWorkspaceRelPath(workspaceRoot, relPath) {
  let { abs, rel } = resolveWorkspaceFilePath(workspaceRoot, relPath);
  if (!fs.existsSync(abs)) return { abs, rel };
  const parsed = path.parse(rel);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.posix.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
    const resolved = resolveWorkspaceFilePath(workspaceRoot, candidate);
    if (!fs.existsSync(resolved.abs)) return resolved;
  }
  return { abs, rel };
}

function fileUrlFromPath(absPath) {
  return pathToFileURL(path.resolve(absPath)).href;
}

function injectHtmlBaseHref(html, baseHref) {
  const raw = String(html || "");
  const base = `<base href="${htmlEscapeAttribute(baseHref)}">`;
  if (/<base\b/i.test(raw)) return raw;
  if (/<head\b[^>]*>/i.test(raw)) return raw.replace(/<head\b([^>]*)>/i, `<head$1>${base}`);
  if (/<html\b[^>]*>/i.test(raw)) return raw.replace(/<html\b([^>]*)>/i, `<html$1><head>${base}</head>`);
  return `<!doctype html><html><head>${base}</head><body>${raw}</body></html>`;
}

function chromeScreenshotCandidates() {
  const candidates = [];
  if (process.env.AGENTFLOW_CHROME_PATH) candidates.push(process.env.AGENTFLOW_CHROME_PATH);
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else if (process.platform === "win32") {
    candidates.push(
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    );
  }
  candidates.push("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "msedge");
  return candidates.filter(Boolean);
}

async function renderHtmlScreenshotWithChrome({ html, workspaceRoot, baseDir, width, height }) {
  const w = Math.max(240, Math.min(4096, Math.round(Number(width) || 390)));
  const h = Math.max(240, Math.min(12000, Math.round(Number(height) || 844)));
  const debug = {
    requestedWidth: Number(width) || null,
    requestedHeight: Number(height) || null,
    viewportWidth: w,
    viewportHeight: h,
    htmlChars: String(html || "").length,
    baseDir: path.resolve(baseDir || workspaceRoot),
    tried: [],
    usedCommand: "",
    pngBytes: 0,
    pngWidth: null,
    pngHeight: null,
  };
  const tmpDir = path.join(path.resolve(workspaceRoot), ".workspace", "agentflow", "tmp", `html-screenshot-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const htmlPath = path.join(tmpDir, "snapshot.html");
  const pngPath = path.join(tmpDir, "snapshot.png");
  const baseHref = `${fileUrlFromPath(baseDir || workspaceRoot).replace(/\/?$/, "/")}`;
  fs.writeFileSync(htmlPath, injectHtmlBaseHref(html, baseHref), "utf-8");
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--allow-file-access-from-files",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${w},${h}`,
    `--screenshot=${pngPath}`,
    fileUrlFromPath(htmlPath),
  ];
  let lastError = null;
  try {
    for (const command of chromeScreenshotCandidates()) {
      if (path.isAbsolute(command) && !fs.existsSync(command)) continue;
      debug.tried.push(command);
      try {
        await execFileBuffered(command, args, { timeout: 45000, cwd: workspaceRoot });
        if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 0) {
          const png = fs.readFileSync(pngPath);
          debug.usedCommand = command;
          debug.pngBytes = png.length;
          try {
            const meta = await sharp(png).metadata();
            debug.pngWidth = meta.width || null;
            debug.pngHeight = meta.height || null;
          } catch (_) {}
          return { png, debug };
        }
        lastError = new Error(`${command} did not produce a screenshot`);
      } catch (error) {
        lastError = error;
        debug.lastError = String(error?.message || error);
      }
    }
    throw new Error(`无法使用 Chrome 生成截图${lastError?.message ? `：${lastError.message}` : ""}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * 落盘并给出**磁盘上那张图**的版本号。
 *
 * 存图必须走这里，不能自己 `writeWorkspaceGraph` 完拿手里那张图去算 revision：代码化会
 * 做规范化，两者对不上，客户端就会攥着一个磁盘上不存在的版本号，下一次保存直接被判成
 * 「基线不匹配」。协作场景里这意味着谁都存不进去。
 *
 * @returns {{ graph: object, path: string, revision: string, runtimeRevision: string, result: object }}
 */
function commitWorkspaceGraph(workspaceRoot, scoped, graph, userCtx) {
  const result = writeWorkspaceGraph(scoped.root, graph, workspaceRoot);
  const persisted = hydrateWorkspaceGraphForRuntime(workspaceRoot, scoped, result.graph, userCtx);
  return {
    graph: persisted,
    path: workspaceDesignPath(scoped.root),
    revision: workspaceDesignRevision(persisted),
    runtimeRevision: workspaceRuntimeRevision(persisted),
    result,
  };
}

function missingWorkspaceGraphNodePackages(workspaceRoot, scoped, graph, userCtx) {
  const missing = new Set();
  for (const instance of Object.values(graph?.instances || {})) {
    const ref = String(instance?.marketplaceRef || instance?.definitionId || "").trim();
    if (!ref.startsWith("marketplace:")) continue;
    const resolved = resolveMarketplaceNodePackage(
      workspaceRoot,
      scoped.root,
      ref,
      null,
      { ...userCtx, marketplaceScope: "all" },
    );
    if (!resolved) missing.add(ref);
  }
  return [...missing].sort();
}

const NODE_STUDIO_DRAFTS_DIRNAME = "node-studio/drafts";

function writeUserWorkspaces(userCtx = {}, entries = []) {
  const seen = new Set();
  const workspaces = (Array.isArray(entries) ? entries : [])
    .map((entry, index) => normalizeWorkspaceEntry(entry, index, userCtx))
    .filter(Boolean)
    .filter((entry) => {
      const key = entry.id || entry.path;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const p = workspacesPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: 1, workspaces }, null, 2) + "\n", "utf-8");
  return workspaces;
}

function redactWorkspaceSecret(text = "", secret = "") {
  let out = String(text || "");
  const raw = String(secret || "");
  if (!raw) return out;
  out = out.split(raw).join("<redacted>");
  try {
    out = out.split(encodeURIComponent(raw)).join("<redacted>");
  } catch {
    // ignore invalid encoding edge cases
  }
  return out;
}

function gitWorkspaceCommandOrThrow(args, cwd, label, secret = "") {
  const result = runGit(args, cwd);
  if (result.status !== 0) {
    const message = redactWorkspaceSecret(result.stderr || result.stdout || result.error?.message || "unknown error", secret);
    throw new Error(`${label} failed: ${message}`);
  }
  return {
    stdout: redactWorkspaceSecret(result.stdout || "", secret),
    stderr: redactWorkspaceSecret(result.stderr || "", secret),
  };
}

function syncGitWorkspace(entry = {}, userCtx = {}) {
  const workspace = normalizeWorkspaceEntry(entry, 0, userCtx);
  if (!workspace || workspace.kind !== "git") throw new Error("只能拉取 Git 工作区");
  if (!workspace.repoUrl) throw new Error("Git 工作区缺少 repoUrl");
  const env = readMergedEnvObject(userCtx.userId || "");
  const token = workspace.credentialRef ? String(env[workspace.credentialRef] || "").trim() : "";
  const repoUrl = workspaceRepoUrlWithCredential(workspace.repoUrl, token);
  const targetDir = path.resolve(workspace.path);
  const parentDir = path.dirname(targetDir);
  fs.mkdirSync(parentDir, { recursive: true });

  const lines = [];
  let changed = false;
  if (fs.existsSync(path.join(targetDir, ".git"))) {
    const originalRemote = runGit(["remote", "get-url", "origin"], targetDir).stdout.trim();
    try {
      if (token) gitWorkspaceCommandOrThrow(["remote", "set-url", "origin", repoUrl], targetDir, "git remote set-url", token);
      const before = runGit(["rev-parse", "HEAD"], targetDir).stdout.trim();
      gitWorkspaceCommandOrThrow(["fetch", "origin", "--prune"], targetDir, "git fetch", token);
      if (workspace.branch) {
        const checkout = runGit(["checkout", workspace.branch], targetDir);
        if (checkout.status !== 0) {
          gitWorkspaceCommandOrThrow(["checkout", "-b", workspace.branch, `origin/${workspace.branch}`], targetDir, "git checkout", token);
        }
        gitWorkspaceCommandOrThrow(["pull", "--ff-only", "origin", workspace.branch], targetDir, "git pull", token);
      } else {
        gitWorkspaceCommandOrThrow(["pull", "--ff-only"], targetDir, "git pull", token);
      }
      const after = runGit(["rev-parse", "HEAD"], targetDir).stdout.trim();
      changed = before !== after;
      lines.push(changed ? `updated ${before.slice(0, 8)} -> ${after.slice(0, 8)}` : `already up to date ${after.slice(0, 8)}`);
    } finally {
      if (token && originalRemote) runGit(["remote", "set-url", "origin", originalRemote], targetDir);
    }
  } else {
    if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
      throw new Error(`目标路径已存在但不是 Git 仓库：${targetDir}`);
    }
    const args = ["clone"];
    if (workspace.branch) args.push("--branch", workspace.branch);
    args.push(repoUrl, targetDir);
    gitWorkspaceCommandOrThrow(args, parentDir, "git clone", token);
    const commit = runGit(["rev-parse", "HEAD"], targetDir).stdout.trim();
    changed = true;
    lines.push(`cloned ${commit.slice(0, 8)}`);
    if (token) runGit(["remote", "set-url", "origin", workspace.repoUrl], targetDir);
  }
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], targetDir).stdout.trim();
  const commit = runGit(["rev-parse", "HEAD"], targetDir).stdout.trim();
  return {
    workspace: normalizeWorkspaceEntry({ ...workspace, path: targetDir }, 0, userCtx),
    changed,
    branch,
    commit,
    message: lines.join("\n"),
  };
}

function nodeStudioDraftsRoot(userCtx = {}) {
  return path.join(getAgentflowUserDataRoot(userCtx.userId || ""), NODE_STUDIO_DRAFTS_DIRNAME);
}

function normalizeNodeStudioDraftId(value) {
  const raw = String(value || "").trim().toLowerCase();
  const safe = raw.replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  return safe || `draft_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

function nodeStudioDraftPath(userCtx = {}, draftId = "") {
  return path.join(nodeStudioDraftsRoot(userCtx), normalizeNodeStudioDraftId(draftId), "draft.json");
}

/**
 * 草稿里那个**真的包目录**。
 *
 * 单独一层 `package/` 而不是和 `draft.json` 同级：`publishNodePackage` 是整目录 `cpSync`，
 * 同级的话草稿元数据会被一起发布出去。
 */
function nodeStudioPackageDir(userCtx = {}, draftId = "") {
  return path.join(nodeStudioDraftsRoot(userCtx), normalizeNodeStudioDraftId(draftId), "package");
}

/**
 * 把包目录静态解析回草稿的 manifest。
 *
 * 草稿里的 manifest **不是**另一份真相，而是 `index.mjs` 声明的投影——面板、画布、运行时
 * 读的都是那份声明，草稿再存一份手写的只会两边对不上。解析不出来就把错误留在草稿里，
 * 让用户看见，而不是留一个上一次的旧清单假装没事。
 */
function nodeStudioReadPackage(userCtx = {}, draftId = "") {
  const dir = nodeStudioPackageDir(userCtx, draftId);
  const entry = path.join(dir, NODE_PACKAGE_ENTRY);
  const files = {};
  const collectFiles = (current) => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const item of entries) {
      const abs = path.join(current, item.name);
      if (item.isDirectory()) collectFiles(abs);
      else if (item.isFile()) {
        const rel = path.relative(dir, abs).replace(/\\/g, "/");
        const stat = fs.statSync(abs);
        files[rel] = stat.size <= 256 * 1024 ? fs.readFileSync(abs, "utf-8") : `[binary ${stat.size} bytes]`;
      }
    }
  };
  collectFiles(dir);
  if (!fs.existsSync(entry)) return { source: "", manifest: null, error: "", files, packageDigest: "" };
  const source = fs.readFileSync(entry, "utf-8");
  try {
    const manifest = readNodePackageManifest(dir, () => null);
    if (!manifest) return { source, manifest: null, error: `${NODE_PACKAGE_ENTRY} 里没有可解析的 export default 声明`, files, packageDigest: "" };
    if (!nodePackageExportsRun(entry)) return { source, manifest, error: "缺少 `export function run`，节点无法执行", files, packageDigest: "" };
    const inspected = inspectNodePackageDirectory(dir);
    if (!inspected.ok) return { source, manifest, error: inspected.error, files, packageDigest: "" };
    return { source, manifest, error: "", files, packageDigest: inspected.contentSha256 };
  } catch (e) {
    return { source, manifest: null, error: (e && e.message) || String(e), files, packageDigest: "" };
  }
}

/** 草稿里由包声明决定的那几个字段。手写的 title/config 不在这里，不会被覆盖。 */
function nodeStudioDraftFromPackage(pkg, draftId) {
  const manifest = pkg.manifest;
  if (!manifest) {
    return { files: pkg.files || { [NODE_PACKAGE_ENTRY]: pkg.source || "" }, packageDigest: "", parseError: pkg.error || "" };
  }
  return {
    title: manifest.displayName || manifest.id || draftId,
    definitionId: manifest.definitionId || `marketplace:${manifest.id}@${manifest.version}`,
    manifest,
    files: pkg.files || { [NODE_PACKAGE_ENTRY]: pkg.source || "" },
    packageDigest: pkg.packageDigest || "",
    parseError: "",
  };
}

/**
 * 在包目录里跑一次 Agent，让它改写 `index.mjs`。
 *
 * `cliWorkspace` 就是包目录：Agent 的工作目录即它要写的地方，不用在提示里报绝对路径，
 * 也就写不到别的地方去。
 */
async function runNodeStudioAgent({ packageDir, userCtx, modelKey, prompt }) {
  const segments = [];
  let result = "";
  const handle = startComposerAgent({
    uiWorkspaceRoot: packageDir,
    cliWorkspace: packageDir,
    writableDirs: [packageDir],
    prompt,
    modelKey,
    agentflowUserId: userCtx.userId || "",
    onStreamEvent: (ev) => {
      if (ev?.type !== "natural" || typeof ev.text !== "string") return;
      const text = ev.text.trim();
      if (!text) return;
      if (ev.kind === "assistant") segments.push(text);
      else if (ev.kind === "result") result = text;
    },
  });
  await handle.finished;
  return result || segments.at(-1) || "";
}

/**
 * 用运行时那套 bootstrap 真跑一次包，而不是另写一个测试执行器。
 *
 * 走同一条路才有意义：Node Studio 里跑得过、画布上跑不过，这种测试不如没有。输出槽落在
 * 临时目录，测完连目录一起删。
 */
async function runNodeStudioPackageTest({ packageDir, manifest, inputs, userCtx }) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-node-test-"));
  const outputsDir = path.join(runDir, "outputs");
  fs.mkdirSync(outputsDir, { recursive: true });
  const outputSlots = (Array.isArray(manifest.output) ? manifest.output : [])
    .filter((slot) => String(slot?.type || "") !== "node" && slot?.name !== "next");
  const outputAbs = Object.fromEntries(outputSlots.map((slot) => [slot.name, path.join(outputsDir, `${slot.name}`)]));
  const startedAt = Date.now();
  try {
    const child = await execFileBuffered(
      process.execPath,
      [path.join(PACKAGE_ROOT, "bin", "lib", "node-package-bootstrap.mjs"), path.join(packageDir, NODE_PACKAGE_ENTRY)],
      {
        cwd: runDir,
        env: runtimeEnvForUser(userCtx, {
          AGENTFLOW_WORKSPACE_ROOT: runDir,
          AGENTFLOW_NODE_RUN_DIR: runDir,
          AGENTFLOW_NODE_TMP_DIR: runDir,
          AGENTFLOW_OUTPUTS_DIR: outputsDir,
          AGENTFLOW_INPUTS_JSON: JSON.stringify(inputs || {}),
          AGENTFLOW_OUTPUTS_ABS_JSON: JSON.stringify(outputAbs),
          AGENTFLOW_OUTPUTS_JSON: JSON.stringify(
            Object.fromEntries(outputSlots.map((slot) => [slot.name, `outputs/${slot.name}`])),
          ),
        }),
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const log = [];
    for (const line of String(child.stdout || "").split("\n")) if (line.trim()) log.push(line);
    for (const line of String(child.stderr || "").split("\n")) if (line.trim()) log.push(`[stderr] ${line}`);
    const outputs = {};
    for (const [name, abs] of Object.entries(outputAbs)) {
      if (!fs.existsSync(abs)) continue;
      const text = fs.readFileSync(abs, "utf-8");
      outputs[name] = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
      log.push(`[output] ${name} = ${outputs[name].split("\n")[0].slice(0, 120)}`);
    }
    const missing = outputSlots.map((s) => s.name).filter((name) => !(name in outputs));
    if (missing.length) log.push(`[error] 这些输出槽没有写文件：${missing.join(", ")}`);
    // 把「文件写到别处、只把路径写进槽」这种写法在测试阶段就点出来。它在这里看着能过——
    // 路径确实存在——但真实运行时那个位置是会被清理的临时目录，产物就丢了。
    const invalidFileSlots = [];
    for (const slot of outputSlots) {
      const value = String(outputs[slot.name] || "").trim();
      if (String(slot.type || "") !== "file" || !value || value.includes("\n")) continue;
      if (!path.isAbsolute(value)) continue;
      invalidFileSlots.push(slot.name);
      log.push(`[error] ${slot.name} 是 file 槽，但里面写的是一个路径而不是文件内容——请直接把内容写到 outputs.${slot.name}`);
    }
    return {
      status: missing.length || invalidFileSlots.length ? "failed" : "passed",
      durationMs: Date.now() - startedAt,
      log,
      outputs,
    };
  } catch (e) {
    const log = [];
    for (const line of String(e?.stdout || "").split("\n")) if (line.trim()) log.push(line);
    for (const line of String(e?.stderr || "").split("\n")) if (line.trim()) log.push(`[stderr] ${line}`);
    log.push(`[error] ${(e && e.message) || String(e)}`);
    return { status: "failed", durationMs: Date.now() - startedAt, log, outputs: {} };
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

function buildNodeStudioPrompt({ requirement, currentSource, parseError, history }) {
  const historyBlock = (Array.isArray(history) ? history : [])
    .slice(-8)
    .map((msg) => {
      const text = String(msg?.text || "").trim();
      return text ? `${msg?.role === "user" ? "user" : "assistant"}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  return [
    "你在为 AgentFlow 编写一个**代码节点包**。工作目录就是这个包的目录。",
    "",
    `把节点声明和统一入口写进 \`${NODE_PACKAGE_ENTRY}\`，然后回复一句话说明这次改了什么。`,
    "这是一个完整节点包目录：复杂实现可以拆到 scripts/，也可以创建 templates/、assets/ 等包内文件，并由 index.mjs 使用相对路径引用。",
    "不要写 node.yaml，不要创建 node_modules、.env、密钥、符号链接或引用包外绝对路径。",
    "",
    "## 格式",
    "",
    "```js",
    'import fs from "node:fs/promises";',
    "",
    "export default {",
    '  id: "count_lines",            // 必填，小写字母数字下划线短横',
    '  version: "1.0.0",             // 必填，完整 semver',
    '  name: "统计行数",',
    '  description: "读一个文本文件，统计行数",',
    '  inputs:  { filePath: { type: "text", description: "文件路径", required: true } },',
    '  outputs: { total: { type: "text" } },',
    "};",
    "",
    "export async function run(inputs, outputs, dirs) {",
    '  const text = await fs.readFile(inputs.filePath, "utf-8");',
    "  await fs.writeFile(outputs.total, String(text.split(\"\\n\").length));",
    "}",
    "```",
    "",
    "## 三条硬约束",
    "",
    "1. `export default` 由 acorn **静态解析，永不执行**，所以它必须是纯字面量——任何变量",
    "   引用、函数调用、展开运算都会被拒绝。`run` 里则是普通 Node 模块，随便写。",
    "2. `outputs.<name>` 是**要写入的绝对路径，不是值**。`await fs.writeFile(outputs.x, 值)`。",
    "   声明了几个输出槽就各写各的文件；第一个非控制输出槽承载结果正文。",
    "   `file` 类型的槽同理——把**文件内容本身**写到 `outputs.<name>` 上。不要另找一个地方",
    "   写完文件、再把那个路径当字符串写进槽里：槽文件才是下游拿到的产物，你自选的路径在",
    "   真实运行时位于会被清理的临时目录里。",
    "3. 槽位类型只能是 `text` `file` `bool` `node` `image` `json`。声明顺序 = 画布上的引脚顺序。",
    "",
    "失败用抛异常或非零退出表示，不要把 stdout 包成 JSON。",
    currentSource ? `\n## 当前 ${NODE_PACKAGE_ENTRY}\n\n\`\`\`js\n${currentSource}\n\`\`\`` : "",
    parseError ? `\n## 上一版解析失败，必须修掉\n\n${parseError}` : "",
    historyBlock ? `\n## 对话历史\n\n${historyBlock}` : "",
    `\n## 本次需求\n\n${String(requirement || "").trim()}`,
  ].filter((line) => line !== "").join("\n");
}

function emptyNodeStudioDraft(userCtx = {}, draftId = "") {
  const now = new Date().toISOString();
  const id = normalizeNodeStudioDraftId(draftId || "untitled_node");
  return {
    id,
    title: "Untitled Node",
    definitionId: "",
    createdAt: now,
    updatedAt: now,
    ownerUserId: String(userCtx.userId || ""),
    agentMessages: [],
    promptDraft: "",
    manifest: {
      id,
      version: "1.0.0",
      name: "Untitled Node",
      description: "",
      baseDefinitionId: "agent_subAgent",
      runtime: { type: "agent_subAgent" },
      inputs: [],
      outputs: [],
      configSchema: { fields: [] },
      ui: { card: { icon: "extension", variant: "default", actions: [] } },
    },
    config: {},
    test: { inputs: {}, log: [], status: "not run" },
    files: {},
  };
}

function isLegacyNodeStudioDemoDraft(draft) {
  return (
    String(draft?.id || "") === "daily_report_demo" &&
    String(draft?.definitionId || "") === "marketplace:daily_report@1.0.0"
  );
}

function readNodeStudioDraft(userCtx = {}, draftId = "") {
  const id = normalizeNodeStudioDraftId(draftId || "");
  const filePath = nodeStudioDraftPath(userCtx, id);
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return parsed && typeof parsed === "object" ? parsed : null;
}

function writeNodeStudioDraft(userCtx = {}, draft = {}) {
  const id = normalizeNodeStudioDraftId(draft.id || "untitled_node");
  const filePath = nodeStudioDraftPath(userCtx, id);
  const previous = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf-8"))
    : {};
  const now = new Date().toISOString();
  const next = {
    ...previous,
    ...draft,
    id,
    createdAt: previous.createdAt || draft.createdAt || now,
    updatedAt: now,
    ownerUserId: String(userCtx.userId || draft.ownerUserId || ""),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2) + "\n", "utf-8");
  return next;
}

function listNodeStudioDrafts(userCtx = {}) {
  const rootDir = nodeStudioDraftsRoot(userCtx);
  if (!fs.existsSync(rootDir)) return [];
  const rows = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(rootDir, entry.name, "draft.json");
    if (!fs.existsSync(filePath)) continue;
    try {
      const draft = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (isLegacyNodeStudioDemoDraft(draft)) continue;
      rows.push({
        id: String(draft.id || entry.name),
        title: String(draft.title || draft.manifest?.name || entry.name),
        definitionId: String(draft.definitionId || `marketplace:${draft.manifest?.id || entry.name}@${draft.manifest?.version || "1.0.0"}`),
        updatedAt: String(draft.updatedAt || ""),
      });
    } catch {
      /* ignore corrupt drafts */
    }
  }
  rows.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) || a.id.localeCompare(b.id));
  return rows;
}

function buildWorkspaceGeneratePrompt(payload) {
  const userPrompt = String(payload?.prompt || "").trim();
  const outputKind = String(payload?.outputKind || payload?.kind || "markdown").trim().toLowerCase();
  const allowFlowYaml = payload?.allowFlowYaml === true || payload?.allowFlowYaml === "1";
  const workspaceGraph = payload?.workspaceGraph && typeof payload.workspaceGraph === "object" ? payload.workspaceGraph : null;
  // 图以代码形态给模型看：同一张图 JSON 要几万 token，代码几千，而且 `output-1 -> input-2`
  // 这种下标边模型根本读不出连的是什么槽。生成失败就退回 JSON——上下文缺失比报错更糟。
  const workspaceGraphBlock = workspaceGraph ? workspaceGraphAsSource(workspaceGraph) : "";
  const selectedNodeIds = Array.isArray(payload?.selectedNodeIds)
    ? payload.selectedNodeIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const skillsBlock = typeof payload?.skillsBlock === "string" ? payload.skillsBlock.trim() : "";
  const nodeCatalogBlock = typeof payload?.nodeCatalogBlock === "string" ? payload.nodeCatalogBlock.trim() : "";
  const history = Array.isArray(payload?.messages) ? payload.messages : [];
  const historyBlock = history
    .slice(-16)
    .map((msg) => {
      const text = String(msg?.text || "").trim();
      if (!text) return "";
      const kind = String(msg?.kind || "").trim();
      if (kind === "raw" || kind === "prompt" || kind === "thinking") return "";
      const role = msg?.role === "user" ? "user" : (msg?.error ? "error" : "assistant");
      if (kind === "run-summary" || kind === "activity") return `context: ${text}`;
      return `${role}: ${text}`;
    })
    .filter(Boolean)
    .join("\n\n");
  const contexts = Array.isArray(payload?.contexts) ? payload.contexts : [];
  const contextBlocks = contexts
    .map((ctx, idx) => {
      const title = String(ctx?.title || ctx?.path || `context-${idx + 1}`).trim();
      const kind = String(ctx?.kind || "text").trim();
      const content = String(ctx?.content || "").trim();
      if (!content) return "";
      return `### ${title} (${kind})\n\n${content}`;
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
  const kindInstruction =
    outputKind === "mermaid"
      ? [
          "你是 workspace Mermaid 图节点的内容生成器。",
          "请根据用户 prompt 和上游节点/文件上下文生成 Mermaid flowchart 源码。",
          "只输出 Mermaid 源码，不要解释，不要包裹 Markdown 代码围栏。",
          "优先使用 `flowchart TD` 或 `graph TD`，节点 ID 使用简单英文/数字/下划线，节点 label 使用清晰短文本。",
        ].join("\n")
      : outputKind === "ascii"
        ? [
            "你是 workspace ASCII 图节点的内容生成器。",
            "请根据用户 prompt 和上游节点/文件上下文生成等宽字体下可读的 ASCII 图。",
            "只输出 ASCII 图正文，不要解释，不要包裹 Markdown 代码围栏。",
            "使用 +-|/\\<> 等字符表达结构，尽量保持对齐。",
          ].join("\n")
        : outputKind === "react"
          ? [
              "你是 workspace React 工程节点的内容生成器。",
              "请根据用户 prompt 和上游节点/文件上下文生成一个可预览的小型 React 工程 JSON。",
              "只输出 JSON，不要解释，不要包裹 Markdown 代码围栏。",
              "JSON 必须包含 title、entry、files；files 至少包含 src/App.jsx，可包含 src/styles.css。",
              "src/App.jsx 里定义或 export default 一个 App 组件；不要依赖未声明的外部包。",
            ].join("\n")
        : [
            "你是 AgentFlow Workspace Composer。",
            "默认以用户当前选择的 workspace 节点作为上下文范围；选中节点不是让你重建整张画布的授权。",
            "默认不要修改 workspace.flow.js，不要新增/删除/重连画布节点；只有当用户明确要求“更新画布、加节点、改连线、展示成节点、生成流程”时，才编辑 workspace.flow.js。",
            "如果用户请求生成或恢复文档/文件，可以直接在 workspace 文件系统中完成，最终只输出简短结果：改了什么、路径在哪里、是否需要下一步。",
            "不要在最终回答中列出过程性步骤，例如“先查看结构”“继续检索”“正在生成”；这些属于执行过程，不属于最终结果。",
          ].join("\n");
  return [
    "你正在 AgentFlow 的 Workspace 工作画布中执行任务。",
    "Workspace 是当前 pipeline 的临时工作区，用于分析、试验、生成中间文件和展示结果。",
    "Workspace 与 Pipeline 各自有独立的 Skill collection；此处只使用当前 Workspace Composer 选择的 collections / skills 作为本次行为规则与编辑依据。",
    "当 Skills 提到修改 flow.yaml / instances / edges / ui 时，在 Workspace 视图下应映射为修改当前工作区的 workspace.flow.js，除非用户显式勾选并要求修改正式 flow.yaml。",
    "画布就是代码：workspace.flow.js 是受限 ESM——`flow()` 是入口，一个节点是一次 `const 变量名 = 类型(\"显示名\", { 引脚 }, 正文)`，引用上游变量的引脚就是一条数据线。它永不执行，只被静态解析，所以里面禁止一切控制流（if / for / await / .map / 箭头函数 / 动态属性）。要写逻辑就建代码节点 nodes/<name>/index.mjs，那里是普通 JS。",
    "workspace.layout.json（坐标）、workspace.nodes.json（图片等机器属性）、workspace.state.json（运行产出）都由平台维护，不要手改。",
    "改完必须跑 `agentflow flow dsl lint <flowDir>` 自查；语法或引脚写错会让整张画布打不开。完整语法见 agentflow-flow-dsl skill。",
    allowFlowYaml
      ? "用户已允许你考虑正式 flow.yaml；如需修改仍必须明确说明影响。"
      : "默认不要修改正式 flow.yaml；优先在 workspace 文件、workspace.flow.js 或回复内容中完成任务。",
    workspaceSearchGuardrailsBlock(),
    workspaceGraphBlock,
    selectedNodeIds.length > 0 ? `\n## 当前用户选中的 workspace 节点\n\n${selectedNodeIds.map((id) => `- ${id}`).join("\n")}` : "",
    skillsBlock ? `\n## Selected Skills\n\n${skillsBlock}` : "",
    nodeCatalogBlock ? `\n## 当前已安装的节点包\n\n${nodeCatalogBlock}` : "",
    kindInstruction,
    contextBlocks ? `\n## 上下文\n\n${contextBlocks}` : "",
    historyBlock ? `\n## 对话历史\n\n${historyBlock}` : "",
    `\n## 用户 prompt\n\n${userPrompt}`,
  ].filter(Boolean).join("\n");
}

function workspaceNodePackageCatalogBlock(workspaceRoot, scoped, userCtx = {}) {
  const catalog = listNodesJson(workspaceRoot, scoped.flowId || "", scoped.flowSource || "user", {
    archived: scoped.archived,
    ...userCtx,
    marketplaceScope: "all",
  });
  // flow/project 本地包虽然也有 marketplaceDefinitionId，但另一个端并没有安装它，不能教 AI
  // 用 marketplace: 引用。这里只暴露已经进入 marketplace/collection 的可移植版本。
  const rows = (Array.isArray(catalog?.nodes) ? catalog.nodes : []).filter((node) =>
    ["marketplace", "collection"].includes(String(node?.source || ""))
    && String(node?.marketplaceDefinitionId || node?.id || "").startsWith("marketplace:"));
  if (!rows.length) return "";
  return rows.slice(0, 100).map((node, index) => {
    const ref = String(node.marketplaceDefinitionId || node.id);
    const binding = String(node.packageId || `nodePackage${index + 1}`)
      .replace(/[^A-Za-z0-9_$]+(.)?/g, (_, ch) => ch ? ch.toUpperCase() : "")
      .replace(/^[^A-Za-z_$]+/, "") || `nodePackage${index + 1}`;
    const slots = (kind) => (Array.isArray(node[kind]) ? node[kind] : [])
      .filter((slot) => slot?.name && !["prev", "next"].includes(slot.name))
      .map((slot) => `${slot.name}:${slot.type || "text"}${slot.required ? "!" : ""}`)
      .join(", ") || "无";
    return [
      `- ${ref} · ${node.displayName || node.label || node.packageId || ref}`,
      `  用途：${String(node.description || "未提供说明").replace(/\s+/g, " ").slice(0, 300)}`,
      `  输入：${slots("inputs")}；输出：${slots("outputs")}`,
      `  DSL：import ${binding} from ${JSON.stringify(ref)};`,
    ].join("\n");
  }).join("\n");
}

function buildWorkspaceNodeChatPrompt(payload) {
  const node = payload?.node && typeof payload.node === "object" ? payload.node : {};
  const userMessage = String(payload?.message || "").trim();
  const currentContent = String(payload?.currentContent || "").trim();
  const nodeKind = String(payload?.nodeKind || payload?.kind || "markdown").trim().toLowerCase();
  const sourceContext = String(payload?.sourceContext || "").trim();
  const targetFilePath = String(payload?.targetFilePath || "").trim();
  const directFileEdit = Boolean(targetFilePath);
  const history = Array.isArray(payload?.messages) ? payload.messages : [];
  const historyBlock = history
    .slice(-8)
    .map((msg) => {
      const role = String(msg?.role || "user").trim() === "assistant" ? "assistant" : "user";
      const text = String(msg?.text || "").trim();
      return text ? `${role}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  const outputRule = directFileEdit
    ? [
        `直接修改当前 workspace 内的文件：${targetFilePath}`,
        "必须使用可用的文件编辑工具实际写入该文件；不要只描述改法。",
        "不要把完整文件内容输出到聊天回复。",
        "完成后只输出一句简短中文确认；如果无法完成，只输出原因，且说明文件未修改。",
      ].join("\n")
    : nodeKind === "html"
      ? "只输出完整或片段 HTML，不要解释，不要包裹 Markdown 代码围栏。"
      : nodeKind === "react"
        ? "只输出 React 工程 JSON，不要解释，不要包裹 Markdown 代码围栏。JSON 必须包含 title、entry、files；files 至少包含 src/App.jsx。"
      : nodeKind === "image"
        ? "只输出新的图片 src，可以是 URL、data URL 或文件路径，不要解释。"
        : nodeKind === "mermaid"
          ? "只输出 Mermaid 源码，不要解释，不要包裹 Markdown 代码围栏。"
          : nodeKind === "ascii"
            ? "只输出 ASCII 正文，不要解释，不要包裹 Markdown 代码围栏。"
            : "只输出新的 Markdown 正文，不要解释，不要包裹 Markdown 代码围栏。";
  return [
    "你正在微调 AgentFlow Workspace 画布中的单个展示节点。",
    directFileEdit
      ? "根据用户 follow-up 直接编辑该展示节点引用的 artifact 文件。"
      : "根据用户 follow-up 和当前节点内容，生成一个可直接替换当前节点展示内容的候选版本。",
    "上下文只来自当前展示内容、直接上游节点任务和本节点对话历史；不要引用或复述 thinking、运行日志、下游展示内容。",
    outputRule,
    "",
    "## 当前节点",
    `- id: ${String(node.id || "").trim() || "(unknown)"}`,
    `- label: ${String(node.label || "").trim() || "(unnamed)"}`,
    `- definitionId: ${String(node.definitionId || "").trim() || "(unknown)"}`,
    `- kind: ${nodeKind}`,
    targetFilePath ? `- artifactFile: ${targetFilePath}` : "",
    sourceContext ? `\n## 生成该展示的直接上游上下文（不含 thinking/log）\n\n${sourceContext}` : "",
    !directFileEdit && currentContent ? `\n## 当前展示内容\n\n${currentContent}` : "",
    historyBlock ? `\n## 本节点对话历史\n\n${historyBlock}` : "",
    `\n## 用户 follow-up\n\n${userMessage}`,
  ].filter(Boolean).join("\n");
}

function parseWorkspaceUploadForm(req) {
  return new Promise((resolve, reject) => {
    const bb = busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: 10 * 1024 * 1024, parts: 32 },
    });
    const fields = {};
    const chunks = [];
    let filename = "";
    let mimeType = "";
    let gotFile = false;
    bb.on("field", (name, val) => {
      fields[String(name || "")] = String(val || "");
    });
    bb.on("file", (name, file, info) => {
      if (name !== "file") {
        file.resume();
        return;
      }
      gotFile = true;
      filename = info.filename || "";
      mimeType = info.mimeType || "";
      file.on("data", (d) => chunks.push(d));
      file.on("limit", () => {
        reject(new Error("FILE_TOO_LARGE"));
      });
    });
    bb.on("finish", () => {
      resolve({
        fields,
        file: Buffer.concat(chunks),
        filename,
        mimeType,
        gotFile,
      });
    });
    bb.on("error", reject);
    req.pipe(bb);
  });
}

/** ZIP 本地头：PK\x03\x04 / \x05\x06 / \x07\x08 */
function workspaceBufferLooksLikeZip(buf) {
  return (
    buf.length >= 4
    && buf[0] === 0x50
    && buf[1] === 0x4b
    && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)
    && (buf[3] === 0x04 || buf[3] === 0x06 || buf[3] === 0x08)
  );
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} ctx 请求上下文 + ui-server 侧的几个依赖
 */
async function workspaceRoutes(req, res, ctx) {
  const { url, authUser, userCtx, root, host, MIME, adminWorkspaceRequestedUserContext, broadcastWorkspaceCollaborationEvent, findWorkspaceShareUser, isValidFlowSourceRead, readUserWorkspaces, requestPublicBaseUrl, resolveWorkspaceScopeRoot, teamSummaryWithUsers, listConfiguredWorkspaces } = ctx;

    if (req.method === "GET" && url.pathname === "/api/node-packages") {
      try {
        const packages = listMarketplacePackages(root, { ...userCtx, marketplaceScope: "all" });
        json(res, 200, {
          nodes: packages.nodes.map((node) => ({
            id: node.id,
            version: node.version,
            definitionId: node.definitionId,
            displayName: node.displayName,
            description: node.description,
            baseDefinitionId: node.baseDefinitionId,
            inputs: node.inputs,
            outputs: node.outputs,
            ownerUserId: node.ownerUserId || node.createdBy || "",
            fileList: node.fileList || [],
            fileCount: node.fileCount || 0,
            totalBytes: node.totalBytes || 0,
            contentSha256: node.contentSha256 || "",
            archiveSha256: node.archiveSha256 || "",
            downloadPath: `/api/node-packages/${encodeURIComponent(node.id)}/${encodeURIComponent(node.version)}/archive`,
          })),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/node-packages") {
      const ct = req.headers["content-type"] || "";
      if (!ct.toLowerCase().startsWith("multipart/form-data")) {
        json(res, 415, { error: "需要 multipart/form-data" });
        return;
      }
      let parsed;
      try {
        parsed = await parseWorkspaceUploadForm(req);
      } catch (e) {
        json(res, e?.message === "FILE_TOO_LARGE" ? 413 : 400, {
          error: e?.message === "FILE_TOO_LARGE" ? "节点包 ZIP 过大（最大 10MB）" : ((e && e.message) || String(e)),
        });
        return;
      }
      if (!parsed.gotFile || !parsed.file.length || !workspaceBufferLooksLikeZip(parsed.file)) {
        json(res, 400, { error: "请上传 ZIP 节点包（字段名 file）" });
        return;
      }
      try {
        const result = publishNodePackageArchive(root, parsed.file, { ownerUserId: userCtx.userId });
        json(res, result.ok ? (result.alreadyExists ? 200 : 201) : (result.conflict ? 409 : 400), result);
      } catch (e) {
        json(res, 500, { ok: false, error: (e && e.message) || String(e) });
      }
      return;
    }

    const nodePackageDownload = url.pathname.match(/^\/api\/node-packages\/([^/]+)\/([^/]+)\/archive$/);
    if (req.method === "GET" && nodePackageDownload) {
      let id = "";
      let version = "";
      try {
        id = decodeURIComponent(nodePackageDownload[1]);
        version = decodeURIComponent(nodePackageDownload[2]);
      } catch {
        json(res, 400, { error: "Invalid node package id or version" });
        return;
      }
      try {
        const result = nodePackageArchive(root, id, version, { ...userCtx, marketplaceScope: "all" });
        if (!result.ok) {
          json(res, 404, { error: result.error || "Node package not found" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": result.archive.length,
          "Content-Disposition": `attachment; filename="${String(id).replace(/[^A-Za-z0-9_.-]/g, "-")}-${String(version).replace(/[^A-Za-z0-9_.-]/g, "-")}.zip"`,
          ETag: `"sha256-${result.archiveSha256}"`,
          "X-AgentFlow-Content-SHA256": result.contentSha256,
          "X-AgentFlow-Archive-SHA256": result.archiveSha256,
        });
        res.end(result.archive);
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace-tree") {
      try {
        json(res, 200, getWorkspaceTree(root));
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/collaboration/accept") {
      try {
        const payload = JSON.parse(await readBody(req));
        const accepted = acceptWorkspaceCollaborationInvite({
          token: payload?.token,
          userId: userCtx.userId,
        });
        if (accepted.error) {
          json(res, accepted.status || 400, { error: accepted.error });
          return;
        }
        json(res, 200, { ok: true, workspace: accepted.workspace });
      } catch (e) {
        json(res, 400, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/collaboration/share") {
      try {
        const payload = JSON.parse(await readBody(req));
        const flowId = String(payload?.flowId || "").trim();
        const flowSource = String(payload?.flowSource || "user").trim();
        const archived = payload?.archived === true || payload?.flowArchived === true;
        if (flowSource !== "workspace" && flowSource !== "user") {
          json(res, 400, { error: "当前 Project 不支持协作分享" });
          return;
        }
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId,
          flowSource,
          workspaceId: payload.workspaceId || "",
          adminOwnerId: payload.adminOwnerId || "",
          archived,
        }, userCtx);
        if (scoped.error) {
          json(res, scoped.status || 400, { error: scoped.error });
          return;
        }
        if (scoped.adminReadonly) {
          json(res, 403, { error: "Admin Workspace review is read-only" });
          return;
        }
        const ensured = ensureWorkspaceCollaboration({
          flowId,
          flowSource,
          archived,
          userId: userCtx.userId,
        });
        if (ensured.error) {
          json(res, ensured.status || 400, { error: ensured.error });
          return;
        }
        const targetUser = findWorkspaceShareUser(payload?.username || payload?.userId);
        if (!targetUser) {
          json(res, 404, { error: "未找到该用户名，请确认对方已经登录或注册 AgentFlow" });
          return;
        }
        const added = addWorkspaceCollaborationMember({
          workspaceId: ensured.workspace.id,
          userId: userCtx.userId,
          memberUserId: targetUser.userId,
          role: payload?.role,
        });
        if (added.error) {
          json(res, added.status || 400, { error: added.error });
          return;
        }
        const record = getWorkspaceCollaborationForProject({ workspaceId: ensured.workspace.id });
        broadcastWorkspaceCollaborationEvent(userCtx, flowSource, flowId, archived, {
          type: "member.added",
          actorId: userCtx.userId || "",
          memberUserId: targetUser.userId,
        });
        json(res, 200, {
          ok: true,
          workspace: workspaceCollaborationSummaryWithUsers(record, userCtx.userId),
          member: { userId: targetUser.userId, username: targetUser.username, role: "editor" },
        });
      } catch (e) {
        json(res, 400, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (url.pathname === "/api/workspace/collaboration/team-share" && (req.method === "POST" || req.method === "DELETE")) {
      try {
        const payload = JSON.parse(await readBody(req));
        const flowId = String(payload?.flowId || "").trim();
        const flowSource = String(payload?.flowSource || "user").trim();
        const archived = payload?.archived === true || payload?.flowArchived === true;
        if (!flowId || (flowSource !== "workspace" && flowSource !== "user")) {
          json(res, 400, { error: "当前 Project 不支持团队分享" });
          return;
        }
        const targetTeam = getTeamById(payload?.teamId);
        const actorTeam = getTeamForUser(userCtx.userId);
        if (!targetTeam || targetTeam.status !== "active") {
          json(res, 404, { error: "团队不存在或已停用" });
          return;
        }
        if (!authUser?.isAdmin && actorTeam?.id !== targetTeam.id) {
          json(res, 403, { error: "只能分享给自己所在的团队" });
          return;
        }
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId,
          flowSource,
          workspaceId: payload.workspaceId || "",
          archived,
        }, userCtx);
        if (scoped.error) {
          json(res, scoped.status || 400, { error: scoped.error });
          return;
        }
        const ensured = ensureWorkspaceCollaboration({
          flowId,
          flowSource,
          archived,
          userId: userCtx.userId,
        });
        if (ensured.error) {
          json(res, ensured.status || 400, { error: ensured.error });
          return;
        }
        const result = req.method === "POST"
          ? setWorkspaceCollaborationTeamShare({
              workspaceId: ensured.workspace.id,
              userId: userCtx.userId,
              teamId: targetTeam.id,
              role: payload?.role,
            })
          : removeWorkspaceCollaborationTeamShare({
              workspaceId: ensured.workspace.id,
              userId: userCtx.userId,
              teamId: targetTeam.id,
            });
        if (result.error) {
          json(res, result.status || 400, { error: result.error });
          return;
        }
        const record = getWorkspaceCollaborationForProject({ workspaceId: ensured.workspace.id });
        json(res, 200, {
          ok: true,
          workspace: workspaceCollaborationSummaryWithUsers(record, userCtx.userId),
          team: teamSummaryWithUsers(targetTeam),
        });
      } catch (e) {
        json(res, 400, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/api/workspace/collaboration/share") {
      try {
        const payload = JSON.parse(await readBody(req));
        const flowId = String(payload?.flowId || "").trim();
        const flowSource = String(payload?.flowSource || "user").trim();
        const archived = payload?.archived === true || payload?.flowArchived === true;
        if (!flowId || (flowSource !== "workspace" && flowSource !== "user")) {
          json(res, 400, { error: "Missing shared project" });
          return;
        }
        const record = getWorkspaceCollaborationForProject({
          workspaceId: payload.workspaceId || "",
          flowId,
          flowSource,
          archived,
          ownerId: userCtx.userId,
        }) || listWorkspaceCollaborationsForUser(userCtx.userId).find((item) => (
          item.flowId === flowId
          && (item.projectSource || item.flowSource || "workspace") === flowSource
          && item.archived === archived
        ));
        if (!record) {
          json(res, 404, { error: "Workspace collaboration not found" });
          return;
        }
        const requestedUser = String(payload?.username || payload?.memberUserId || "").trim();
        const targetUser = requestedUser ? findWorkspaceShareUser(requestedUser) : null;
        if (requestedUser && !targetUser) {
          json(res, 404, { error: "未找到该用户" });
          return;
        }
        const removed = removeWorkspaceCollaborationMember({
          workspaceId: record.id,
          userId: userCtx.userId,
          memberUserId: targetUser?.userId || userCtx.userId,
        });
        if (removed.error) {
          json(res, removed.status || 400, { error: removed.error });
          return;
        }
        broadcastWorkspaceCollaborationEvent(userCtx, flowSource, flowId, archived, {
          type: removed.left ? "member.left" : "member.removed",
          actorId: userCtx.userId || "",
          memberUserId: removed.removedUserId || "",
        });
        const nextRecord = getWorkspaceCollaborationForProject({ workspaceId: record.id });
        json(res, 200, {
          ok: true,
          left: removed.left === true,
          removedUserId: removed.removedUserId || "",
          workspace: removed.left ? null : workspaceCollaborationSummaryWithUsers(nextRecord, userCtx.userId),
        });
      } catch (e) {
        json(res, 400, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace/events") {
      const scoped = resolveWorkspaceScopeRoot(root, {
        flowId: url.searchParams.get("flowId") || "",
        flowSource: url.searchParams.get("flowSource") || "user",
        workspaceId: url.searchParams.get("workspaceId") || "",
        archived: url.searchParams.get("archived") === "1",
      }, userCtx);
      if (scoped.error) {
        json(res, scoped.status || 400, { error: scoped.error });
        return;
      }
      const key = workspaceCollaborationEventKey(
        workspaceScopedUserContext(scoped, userCtx),
        scoped.flowSource,
        scoped.flowId,
        scoped.archived,
      );
      let subscribers = workspaceCollaborationSubscribers.get(key);
      if (!subscribers) {
        subscribers = new Set();
        workspaceCollaborationSubscribers.set(key, subscribers);
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`event: connected\ndata: ${JSON.stringify({ seq: workspaceCollaborationSequences.get(key) || 0 })}\n\n`);
      subscribers.add(res);
      const heartbeat = setInterval(() => {
        try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch (_) {}
      }, 15_000);
      const detach = () => {
        clearInterval(heartbeat);
        subscribers.delete(res);
        if (subscribers.size === 0) workspaceCollaborationSubscribers.delete(key);
      };
      req.on("close", detach);
      res.on("close", detach);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace/files") {
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: url.searchParams.get("flowId") || "",
          flowSource: url.searchParams.get("flowSource") || "user",
          workspaceId: url.searchParams.get("workspaceId") || "",
          archived: url.searchParams.get("archived") === "1",
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        json(res, 200, { ...readWorkspaceFiles(scoped.root), flowId: scoped.flowId, flowSource: scoped.flowSource, archived: scoped.archived });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspaces") {
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: url.searchParams.get("flowId") || "",
          flowSource: url.searchParams.get("flowSource") || "user",
          workspaceId: url.searchParams.get("workspaceId") || "",
          archived: url.searchParams.get("archived") === "1",
        }, userCtx);
        const scopedRoot = scoped.error ? root : scoped.root;
        json(res, 200, {
          path: workspacesPath(),
          workspaces: listConfiguredWorkspaces(root, scopedRoot, userCtx),
          customWorkspaces: readUserWorkspaces(userCtx),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces") {
      try {
        const payload = JSON.parse(await readBody(req));
        const customWorkspaces = writeUserWorkspaces(userCtx, payload?.workspaces || payload?.customWorkspaces || []);
        json(res, 200, {
          path: workspacesPath(),
          workspaces: listConfiguredWorkspaces(root, root, userCtx),
          customWorkspaces,
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces/sync") {
      try {
        const payload = JSON.parse(await readBody(req));
        const id = String(payload?.id || "").trim();
        const workspaces = readUserWorkspaces(userCtx);
        const workspace = workspaces.find((entry) => String(entry.id || "") === id);
        if (!workspace) {
          json(res, 404, { error: "工作区不存在" });
          return;
        }
        const result = syncGitWorkspace(workspace, userCtx);
        json(res, 200, {
          ok: true,
          ...result,
          workspaces: listConfiguredWorkspaces(root, root, userCtx),
          customWorkspaces: readUserWorkspaces(userCtx),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/preview") {
      if (!authUser?.userId) {
        json(res, 401, { error: "Authentication required" });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req, 4 * 1024 * 1024));
      } catch {
        json(res, 400, { error: "Invalid JSON" });
        return;
      }
      const graph = payload?.graph;
      if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
        json(res, 400, { error: "graph must be an object" });
        return;
      }
      const instances = graph.instances && typeof graph.instances === "object" && !Array.isArray(graph.instances)
        ? graph.instances
        : {};
      if (Object.values(instances).some((item) => String(item?.definitionId || "") === "workspace_scheduled_run")) {
        json(res, 400, { error: "Temporary Workspace preview cannot contain scheduled-run nodes" });
        return;
      }
      const rawRequestedId = String(payload.previewId || "").trim();
      const flowId = rawRequestedId || createWorkspacePreviewId();
      const flowDir = workspaceSharedPreviewFlowDir(root, flowId);
      if (!flowDir) {
        json(res, 400, { error: "Invalid previewId" });
        return;
      }
      const existing = readWorkspacePreviewMetadata(flowDir);
      if (existing && existing.ownerId !== authUser.userId) {
        json(res, 403, { error: "Preview ownership denied" });
        return;
      }
      if (rawRequestedId && !existing && fs.existsSync(flowDir)) {
        json(res, 409, { error: "Preview project already exists but is not a preview" });
        return;
      }
      const now = Date.now();
      const ttlInput = payload.ttlMs != null
        ? Number(payload.ttlMs)
        : payload.ttlSeconds != null
          ? Number(payload.ttlSeconds) * 1000
          : DEFAULT_WORKSPACE_PREVIEW_TTL_MS;
      const ttlMs = normalizeWorkspacePreviewTtlMs(ttlInput);
      const metadata = {
        version: 1,
        flowId,
        ownerId: authUser.userId,
        title: String(payload.title || "Workspace Preview").trim().slice(0, 200),
        createdAt: existing?.createdAt || new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
      };
      try {
        fs.mkdirSync(flowDir, { recursive: true });
        writeWorkspaceGraph(flowDir, graph, root);
        writeWorkspacePreviewMetadata(flowDir, metadata);
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
        return;
      }
      const baseUrl = `${url.protocol}//${url.host}`;
      const workspaceUrl = `${baseUrl}/workspace?flowId=${encodeURIComponent(flowId)}&flowSource=workspace&archived=1`;
      json(res, 200, { ok: true, flowId, flowSource: "workspace", archived: true, preview: true, expiresAt: metadata.expiresAt, url: workspaceUrl });
      return;
    }

    /**
     * 把一个还停在 `flow.yaml` 的老流程迁进 Workspace。
     *
     * 平台上这类流程处在「列在列表里、点开是空图」的状态：目录哨兵认 yaml，读图那条路
     * 不认，所以既跑不了也编辑不了，里面的 body / prompt / script 只能干看着。这条路由
     * 是它们唯一的出口，也是日后能把哨兵摘掉的前提。
     *
     * 默认拒绝有损迁移，把清单原样回给调用方；`allowLoss` 才落盘。yaml 原文不删。
     */
    if (req.method === "POST" && url.pathname === "/api/workspace/migrate") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          workspaceId: payload.workspaceId || "",
          adminOwnerId: payload.adminOwnerId || "",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, scoped.status || 400, { error: scoped.error });
          return;
        }
        // 归档流程默认不写。但它们恰恰是最需要迁的一批——没人会再打开保存，所以只会
        // 一直停在老格式上；而「归档 + 仅 yaml」的流程正是摘掉 flow.yaml 哨兵时会凭空
        // 消失的那种。迁移换的是存储格式不是内容（往返比对闸门保证图等价），所以给一个
        // 显式豁免，而不是把归档流程永远锁死在死格式里。
        if (scoped.archived && payload.allowArchived !== true) {
          json(res, 400, { error: "Archived pipeline: pass allowArchived to migrate it anyway" });
          return;
        }
        if (isReadonlyBuiltinFlowSource(scoped.flowSource) || scoped.collaborationAccess?.writable === false) {
          json(res, 400, { error: "Cannot migrate a builtin or read-only pipeline" });
          return;
        }
        const { migrateFlowDirToDsl } = await import("./flow-dsl/cli.mjs");
        const result = migrateFlowDirToDsl(scoped.root, {
          force: payload.allowLoss === true,
          marketplaceRoot: root,
        });
        if (result.format === "empty") {
          json(res, 404, { error: "这个流程目录里既没有 Workspace 图，也没有 flow.yaml", ...result });
          return;
        }
        // 迁移过的图立刻广播给正在看这张画布的人——否则他们手里还是空图，
        // 下一次保存会把刚迁好的内容覆盖回去
        if (result.migrated || result.leftYaml) {
          const { graph } = readWorkspaceGraph(scoped.root, root);
          broadcastWorkspaceCollaborationEvent(
            userCtx,
            scoped.flowSource,
            scoped.flowId,
            scoped.archived,
            { type: "graph.committed", revision: workspaceDesignRevision(graph), actorId: userCtx.userId || "" },
          );
        }
        json(res, 200, { ok: true, ...result });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace/graph") {
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: url.searchParams.get("flowId") || "",
          flowSource: url.searchParams.get("flowSource") || "user",
          workspaceId: url.searchParams.get("workspaceId") || "",
          archived: url.searchParams.get("archived") === "1",
        }, userCtx);
        if (scoped.error) {
          json(res, scoped.status || 400, { error: scoped.error });
          return;
        }
        const { path: graphPath, graph } = readWorkspaceGraph(scoped.root, root);
        const scopedUserCtx = workspaceScopedUserContext(scoped, userCtx);
        const hydratedGraph = hydrateWorkspaceGraphForRuntime(root, scoped, graph, scopedUserCtx);
        const collaborationAccess = scoped.collaborationAccess || workspaceCollaborationAccess(null, userCtx.userId);
        json(res, 200, {
          ok: true,
          graph: hydratedGraph,
          revision: workspaceDesignRevision(hydratedGraph),
          designRevision: workspaceDesignRevision(hydratedGraph),
          runtimeRevision: workspaceRuntimeRevision(hydratedGraph),
          path: graphPath,
          root: scoped.root,
          flowId: scoped.flowId,
          flowSource: scoped.flowSource,
          archived: scoped.archived,
          writable: !(scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource))
            && scoped.adminReadonly !== true
            && collaborationAccess.writable !== false,
          collaboration: workspaceCollaborationSummaryWithUsers(scoped.collaboration, userCtx.userId),
          adminReview: scoped.adminReadonly ? {
            readonly: true,
            ownerUserId: scoped.ownerUserId,
            ownerUsername: scoped.ownerUsername,
          } : null,
          workspaceSchedules: listWorkspaceScheduleStatusesForFlow(scopedUserCtx, scoped.flowSource || "user", scoped.flowId || ""),
        });
      } catch (e) {
        // 流程文件语法错时给出可修的定位，而不是一句 500——这条路径就是手改 / AI 改
        // workspace.flow.js 之后最常撞上的
        if (e instanceof WorkspaceFlowParseError) {
          json(res, 422, { error: e.message, path: e.filePath, kind: "flow_source_parse_error" });
          return;
        }
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/graph") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          workspaceId: payload.workspaceId || "",
          adminOwnerId: payload.adminOwnerId || "",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, scoped.status || 400, { error: scoped.error });
          return;
        }
        if (
          scoped.archived
          || isReadonlyBuiltinFlowSource(scoped.flowSource)
          || scoped.collaborationAccess?.writable === false
        ) {
          json(res, 400, { error: "Cannot write workspace graph for builtin or archived pipeline" });
          return;
        }
        const submittedDesign = payload.graph || payload;
        const submittedMissingPackages = missingWorkspaceGraphNodePackages(root, scoped, submittedDesign, userCtx);
        if (submittedMissingPackages.length) {
          json(res, 422, {
            error: `服务端缺少节点包：${submittedMissingPackages.join(", ")}；请先上传这些精确版本`,
            kind: "node_packages_missing",
            missingNodePackages: submittedMissingPackages,
          });
          return;
        }
        const submittedGraph = hydrateWorkspaceGraphForRuntime(root, scoped, submittedDesign, userCtx);
        const currentStoredGraph = readWorkspaceGraph(scoped.root, root).graph;
        const currentGraph = hydrateWorkspaceGraphForRuntime(root, scoped, currentStoredGraph, userCtx);
        const currentRevision = workspaceDesignRevision(currentGraph);
        const baseRevision = String(payload.baseRevision || "").trim();
        if (scoped.collaboration && !baseRevision) {
          json(res, 428, {
            error: "Shared workspace save requires baseRevision",
            currentRevision,
          });
          return;
        }
        let nextGraph = submittedGraph;
        let merged = false;
        const baseGraph = payload.baseGraph;
        if (baseRevision && baseGraph && typeof baseGraph === "object") {
          const actualBaseRevision = workspaceDesignRevision(baseGraph);
          if (actualBaseRevision !== baseRevision) {
            json(res, 400, {
              error: "Workspace 合并基线与 baseRevision 不匹配",
              conflict: "invalid-merge-base",
              expectedRevision: baseRevision,
              actualBaseRevision,
              currentRevision,
            });
            return;
          }
          const mergeResult = mergeWorkspaceGraphs({
            baseGraph,
            currentGraph,
            incomingGraph: submittedGraph,
          });
          if (mergeResult.conflicts.length) {
            json(res, 409, {
              error: `Workspace 存在 ${mergeResult.conflicts.length} 处同字段冲突`,
              conflict: "field-conflict",
              expectedRevision: baseRevision,
              currentRevision,
              conflictPaths: mergeResult.conflicts.map((item) => item.path),
              conflictItems: mergeResult.conflicts,
              mergeGraph: mergeResult.graph,
              currentGraph,
            });
            return;
          }
          nextGraph = mergeResult.graph;
          merged = baseRevision !== currentRevision
            || workspaceRuntimeRevision(baseGraph) !== workspaceRuntimeRevision(currentGraph);
        } else if (baseRevision && baseRevision !== currentRevision) {
          json(res, 409, {
            error: "Workspace 已被其他成员更新，当前客户端缺少合并基线，请刷新后重试",
            conflict: "missing-merge-base",
            expectedRevision: baseRevision,
            currentRevision,
          });
          return;
        }
        const graph = mergeWorkspacePersistentNodeRefs(nextGraph, currentGraph);
        const committed = commitWorkspaceGraph(root, scoped, graph, userCtx);
        const { path: graphPath, revision, runtimeRevision } = committed;
        const workspaceSchedules = syncWorkspaceSchedulesForGraph(root, scoped, committed.graph, authUser, userCtx);
        broadcastWorkspaceCollaborationEvent(
          userCtx,
          scoped.flowSource,
          scoped.flowId,
          scoped.archived,
          {
            type: "graph.committed",
            revision,
            actorId: userCtx.userId || "",
            clientId: String(payload.clientId || ""),
          },
        );
        json(res, 200, {
          ok: true,
          path: graphPath,
          graph: committed.graph,
          revision,
          designRevision: revision,
          runtimeRevision,
          merged,
          workspaceSchedules,
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace/schedules") {
      try {
        const flowId = url.searchParams.get("flowId") || "";
        const flowSource = url.searchParams.get("flowSource") || "user";
        if (!flowId) {
          json(res, 400, { error: "Missing flowId" });
          return;
        }
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId,
          flowSource,
          archived: url.searchParams.get("archived") === "1",
        }, userCtx);
        if (scoped.error) {
          json(res, scoped.status || 400, { error: scoped.error });
          return;
        }
        json(res, 200, {
          schedules: listWorkspaceScheduleStatusesForFlow(
            workspaceScopedUserContext(scoped, userCtx),
            flowSource,
            flowId,
          ),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/run/plan") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          workspaceId: payload.workspaceId || "",
          adminOwnerId: payload.adminOwnerId || "",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (scoped.collaborationAccess?.runnable === false) {
          json(res, 403, { error: "Workspace run permission denied" });
          return;
        }
        const flowId = String(payload.flowId || "").trim();
        if (!flowId) {
          json(res, 400, { error: "Missing flowId" });
          return;
        }
        const graph = hydrateWorkspaceGraphForRuntime(root, scoped, payload.graph || {}, userCtx);
        const runNodeId = String(payload.runNodeId || "").trim();
        const plan = workspaceRunPlan(graph, runNodeId, scoped.root, {
          forceNodeIds: Array.isArray(payload.forceNodeIds) ? payload.forceNodeIds : [],
          ignoreCache: payload.ignoreCache === true,
        });
        const plannedNodeIds = workspaceRunPlanNodeIds(runNodeId, plan);
        const scopeKey = workspaceRunKey(userCtx, scoped.flowSource || payload.flowSource || "user", flowId);
        const conflict = workspaceFindActiveRunConflict(scopeKey, plannedNodeIds);
        json(res, 200, {
          ok: true,
          runNodeId,
          order: plan.order,
          pauseNodeIds: plan.pauseNodeIds,
          plannedNodeIds,
          conflict: conflict ? {
            runId: conflict.entry?.runId || "",
            runNodeId: conflict.entry?.runNodeId || "",
            conflictNodeIds: conflict.conflictNodeIds,
          } : null,
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/run/optimize") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          workspaceId: payload.workspaceId || "",
          adminOwnerId: payload.adminOwnerId || "",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (
          scoped.archived
          || isReadonlyBuiltinFlowSource(scoped.flowSource)
          || scoped.collaborationAccess?.writable === false
        ) {
          json(res, 400, { error: "Cannot optimize workspace graph for builtin or archived pipeline" });
          return;
        }
        const flowId = String(payload.flowId || "").trim();
        if (!flowId) {
          json(res, 400, { error: "Missing flowId" });
          return;
        }
        const result = await workspaceOptimizeRunImplementations(root, scoped.root, payload, userCtx, {
          emit: () => {},
        });
        const currentGraph = readWorkspaceGraph(scoped.root, root).graph;
        const touchedIds = new Set((result.optimized || []).map((item) => item.nodeId).filter(Boolean));
        const mergedGraph = mergeWorkspaceRunGraph(currentGraph, result.graph, touchedIds);
        const committed = commitWorkspaceGraph(root, scoped, mergedGraph, userCtx);
        const { path: graphPath, revision } = committed;
        const workspaceSchedules = syncWorkspaceSchedulesForGraph(root, scoped, committed.graph, authUser, userCtx);
        broadcastWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
          type: "graph.committed",
          revision,
          actorId: userCtx.userId || "",
          clientId: String(payload.clientId || ""),
        });
        json(res, 200, {
          ok: true,
          path: graphPath,
          graph: committed.graph,
          revision,
          order: result.order,
          optimized: result.optimized,
          skipped: result.skipped,
          workspaceSchedules,
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/run") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          workspaceId: payload.workspaceId || "",
          adminOwnerId: payload.adminOwnerId || "",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (
          scoped.archived
          || isReadonlyBuiltinFlowSource(scoped.flowSource)
          || scoped.collaborationAccess?.runnable === false
        ) {
          json(res, 400, { error: "Cannot run workspace graph for builtin or archived pipeline" });
          return;
        }
        const wantsStream = /\bapplication\/x-ndjson\b/i.test(req.headers.accept || "") || payload.stream === true;
        const flowId = String(payload.flowId || "").trim();
        if (!flowId) {
          json(res, 400, { error: "Missing flowId" });
          return;
        }
        const canonicalStoredGraph = readWorkspaceGraph(scoped.root, root).graph;
        const canonicalGraph = hydrateWorkspaceGraphForRuntime(
          root,
          scoped,
          canonicalStoredGraph,
          userCtx,
        );
        const canonicalRevision = workspaceDesignRevision(canonicalGraph);
        const expectedRevision = String(payload.expectedRevision || payload.baseRevision || "").trim();
        if (scoped.collaboration && expectedRevision && expectedRevision !== canonicalRevision) {
          json(res, 409, {
            error: "Workspace 已更新，请刷新后再运行",
            conflict: "revision-mismatch",
            expectedRevision,
            currentRevision: canonicalRevision,
          });
          return;
        }
        const runtimeGraph = scoped.collaboration
          ? canonicalGraph
          : hydrateWorkspaceGraphForRuntime(root, scoped, payload.graph || canonicalGraph, userCtx);
        const runNodeId = String(payload.runNodeId || "").trim();
        const plan = workspaceRunPlan(runtimeGraph, runNodeId, scoped.root, {
          forceNodeIds: Array.isArray(payload.forceNodeIds) ? payload.forceNodeIds : [],
          ignoreCache: payload.ignoreCache === true,
        });
        const plannedNodeIds = workspaceRunPlanNodeIds(runNodeId, plan);
        const scopeKey = workspaceRunKey(userCtx, scoped.flowSource || payload.flowSource || "user", flowId);
        const conflict = workspaceFindActiveRunConflict(scopeKey, plannedNodeIds);
        if (conflict) {
          json(res, 409, {
            error: "该 Run 与正在执行的 Run 共享节点",
            runNodeId: conflict.entry?.runNodeId || "",
            runId: conflict.entry?.runId || "",
            conflictNodeIds: conflict.conflictNodeIds,
          });
          return;
        }
        const controller = new AbortController();
        const runControl = workspaceRunControl(controller);
        const runId = String(payload.runSessionId || payload.runId || "").trim() || runLedgerId("workspace");
        const runKey = workspaceRunEntryKey(scopeKey, runId);
        const runAlias = String(payload.runAlias || "").trim() || workspaceRuntimeNodeLabel(runtimeGraph, runNodeId, "Workspace Run");
        const runEntry = {
          scopeKey,
          controller,
          runControl,
          runId,
          userId: String(userCtx.userId || ""),
          username: String(authUser?.username || userCtx.userId || ""),
          runNodeId,
          label: runAlias,
          flowId,
          flowSource: scoped.flowSource || payload.flowSource || "user",
          plannedNodeIds,
          startedAt: Date.now(),
        };
        const runLog = createWorkspaceRunLogSession({
          runId,
          userId: runEntry.userId,
          username: runEntry.username,
          flowId: runEntry.flowId,
          flowSource: runEntry.flowSource,
          scheduleNodeId: String(runtimeGraph.instances?.[runNodeId]?.definitionId || "") === "workspace_scheduled_run" ? runNodeId : "",
          runNodeId,
          scheduled: false,
          trigger: "manual",
          label: runAlias,
          startedAt: runEntry.startedAt,
        });
        activeWorkspaceRuns.set(runKey, runEntry);
        appendWorkspaceRunStarted(runEntry);
        broadcastWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
          type: "run.started",
          runId,
          runNodeId,
          plannedNodeIds,
          revision: canonicalRevision,
          actorId: userCtx.userId || "",
        });
        const setActiveChild = (child, childOptions = {}) => {
          runControl.setChild(child, childOptions);
        };
        const clearActiveRun = (status = "finished") => {
          runControl.finish(status);
          if (activeWorkspaceRuns.get(runKey) === runEntry) activeWorkspaceRuns.delete(runKey);
          broadcastWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
            type: "run.finished",
            status,
            runId,
            runNodeId,
            actorId: userCtx.userId || "",
          });
        };
        if (wantsStream) {
          const runPayload = { ...payload, requestBaseUrl: requestPublicBaseUrl(req) };
          res.writeHead(200, {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
          });
          const writeEvent = (event) => {
            appendWorkspaceRunLogEvent(runLog.runId, event);
            try { res.write(JSON.stringify(event) + "\n"); } catch (_) {}
          };
          try {
            const result = await runWorkspaceGraph(root, scoped.root, runPayload, userCtx, {
              onEvent: writeEvent,
              signal: controller.signal,
              onActiveChild: setActiveChild,
            });
            const currentGraph = readWorkspaceGraph(scoped.root, root).graph;
            const touchedIds = workspaceRunTouchedNodeIds(result);
            const mergedGraph = mergeWorkspaceRunGraph(currentGraph, result.graph, touchedIds);
            const committed = commitWorkspaceGraph(root, scoped, mergedGraph, userCtx);
            const { path: graphPath, revision, runtimeRevision } = committed;
            const collaborationEventType = revision === workspaceDesignRevision(currentGraph)
              ? "runtime.committed"
              : "graph.committed";
            const endedAt = Date.now();
            appendWorkspaceRunFinished({
              ...runEntry,
              endedAt,
              durationMs: endedAt - runEntry.startedAt,
            }, "success");
            finishWorkspaceRunLogSession(runLog.runId, "success", {
              endedAt,
              durationMs: endedAt - runEntry.startedAt,
              runNodeId,
            });
            broadcastWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
              type: collaborationEventType,
              revision,
              runtimeRevision,
              actorId: userCtx.userId || "",
              source: "run",
            });
            writeEvent({ type: "done", ok: true, path: graphPath, graph: committed.graph, revision, runtimeRevision, order: result.order, touchedNodeIds: Array.from(touchedIds), pauseNodeIds: result.pauseNodeIds || [] });
            res.end();
          } catch (e) {
            const endedAt = Date.now();
            if (isWorkspaceRunAbortError(e) || controller.signal.aborted) {
              appendWorkspaceRunFinished({
                ...runEntry,
                endedAt,
                durationMs: endedAt - runEntry.startedAt,
              }, "stopped");
              finishWorkspaceRunLogSession(runLog.runId, "stopped", {
                endedAt,
                durationMs: endedAt - runEntry.startedAt,
                runNodeId,
              });
              writeEvent({ type: "stopped", ok: false, stopped: true, message: "Workspace run stopped" });
            } else {
              const error = (e && e.message) || String(e);
              appendWorkspaceRunFinished({
                ...runEntry,
                endedAt,
                durationMs: endedAt - runEntry.startedAt,
              }, "failed");
              finishWorkspaceRunLogSession(runLog.runId, "failed", {
                endedAt,
                durationMs: endedAt - runEntry.startedAt,
                runNodeId,
                error,
              });
              writeEvent({ type: "error", error });
            }
            res.end();
          } finally {
            clearActiveRun(controller.signal.aborted ? "stopped" : "finished");
          }
          return;
        }
        try {
          const result = await runWorkspaceGraph(root, scoped.root, { ...payload, requestBaseUrl: requestPublicBaseUrl(req) }, userCtx, {
            signal: controller.signal,
            onActiveChild: setActiveChild,
            onEvent: (event) => appendWorkspaceRunLogEvent(runLog.runId, event),
          });
          const currentGraph = readWorkspaceGraph(scoped.root, root).graph;
          const touchedIds = workspaceRunTouchedNodeIds(result);
          const mergedGraph = mergeWorkspaceRunGraph(currentGraph, result.graph, touchedIds);
          const committed = commitWorkspaceGraph(root, scoped, mergedGraph, userCtx);
          const { path: graphPath, revision, runtimeRevision } = committed;
          const collaborationEventType = revision === workspaceDesignRevision(currentGraph)
            ? "runtime.committed"
            : "graph.committed";
          const endedAt = Date.now();
          appendWorkspaceRunFinished({
            ...runEntry,
            endedAt,
            durationMs: endedAt - runEntry.startedAt,
          }, "success");
          finishWorkspaceRunLogSession(runLog.runId, "success", {
            endedAt,
            durationMs: endedAt - runEntry.startedAt,
            runNodeId,
          });
          broadcastWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
            type: collaborationEventType,
            revision,
            runtimeRevision,
            actorId: userCtx.userId || "",
            source: "run",
          });
          json(res, 200, { ok: true, path: graphPath, ...result, graph: committed.graph, revision, runtimeRevision, touchedNodeIds: Array.from(touchedIds) });
        } catch (e) {
          const endedAt = Date.now();
          if (isWorkspaceRunAbortError(e) || controller.signal.aborted) {
            appendWorkspaceRunFinished({
              ...runEntry,
              endedAt,
              durationMs: endedAt - runEntry.startedAt,
            }, "stopped");
            finishWorkspaceRunLogSession(runLog.runId, "stopped", {
              endedAt,
              durationMs: endedAt - runEntry.startedAt,
              runNodeId,
            });
            json(res, 200, { ok: false, stopped: true, message: "Workspace run stopped" });
          } else {
            const error = (e && e.message) || String(e);
            appendWorkspaceRunFinished({
              ...runEntry,
              endedAt,
              durationMs: endedAt - runEntry.startedAt,
            }, "failed");
            appendWorkspaceRunLogEvent(runLog.runId, { type: "error", error, ts: endedAt });
            finishWorkspaceRunLogSession(runLog.runId, "failed", {
              endedAt,
              durationMs: endedAt - runEntry.startedAt,
              runNodeId,
              error,
            });
            throw e;
          }
        } finally {
          clearActiveRun(controller.signal.aborted ? "stopped" : "finished");
        }
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace/run-logs") {
      try {
        const flowId = url.searchParams.get("flowId") || "";
        const flowSource = url.searchParams.get("flowSource") || "";
        const scheduleNodeId = url.searchParams.get("scheduleNodeId") || "";
        const runNodeId = url.searchParams.get("runNodeId") || "";
        const limit = Number(url.searchParams.get("limit") || 50);
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId,
          flowSource: flowSource || "user",
          archived: url.searchParams.get("archived") === "1",
        }, userCtx);
        if (scoped.error) {
          json(res, scoped.status || 400, { error: scoped.error });
          return;
        }
        const scopedUserCtx = workspaceScopedUserContext(scoped, userCtx);
        json(res, 200, {
          runs: listWorkspaceRunLogs({
            userId: flowSource === "workspace" ? "" : scopedUserCtx.userId || "",
            flowId,
            flowSource,
            scheduleNodeId,
            runNodeId,
            limit,
          }),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/workspace/run-logs/")) {
      try {
        const runId = decodeURIComponent(url.pathname.slice("/api/workspace/run-logs/".length));
        if (!runId) {
          json(res, 400, { error: "Missing runId" });
          return;
        }
        const flowId = url.searchParams.get("flowId") || "";
        const flowSource = url.searchParams.get("flowSource") || "user";
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId,
          flowSource,
          archived: url.searchParams.get("archived") === "1",
        }, userCtx);
        if (scoped.error) {
          json(res, scoped.status || 400, { error: scoped.error });
          return;
        }
        const scopedUserCtx = workspaceScopedUserContext(scoped, userCtx);
        const run = listWorkspaceRunLogs({
          userId: flowSource === "workspace" ? "" : scopedUserCtx.userId || "",
          flowId,
          flowSource,
          limit: 200,
        })
          .find((item) => String(item.runId || "") === runId);
        if (!run) {
          json(res, 404, { error: "Run log not found" });
          return;
        }
        json(res, 200, {
          run,
          events: readWorkspaceRunLogEvents(runId),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace/run/status") {
      const flowId = typeof url.searchParams.get("flowId") === "string" ? url.searchParams.get("flowId").trim() : "";
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      const flowSource = url.searchParams.get("flowSource") || "user";
      const scoped = resolveWorkspaceScopeRoot(root, {
        flowId,
        flowSource,
        archived: url.searchParams.get("archived") === "1",
      }, userCtx);
      if (scoped.error) {
        json(res, scoped.status || 400, { error: scoped.error });
        return;
      }
      const scopeKey = workspaceRunKey(workspaceScopedUserContext(scoped, userCtx), flowSource, flowId);
      const entries = workspaceActiveRunsForScope(scopeKey).map(([, entry]) => entry);
      const entry = entries[0] || null;
      json(res, 200, {
        running: entries.length > 0,
        state: entry?.runControl?.state || (entries.length > 0 ? "running" : "idle"),
        flowId,
        flowSource,
        runNodeId: entry?.runNodeId || "",
        label: entry?.label || "",
        startedAt: entry?.startedAt || null,
        runs: entries.map((item) => ({
          runId: item?.runId || "",
          runNodeId: item?.runNodeId || "",
          label: item?.label || "",
          startedAt: item?.startedAt || null,
          plannedNodeIds: Array.isArray(item?.plannedNodeIds) ? item.plannedNodeIds : [],
          scheduled: item?.scheduled === true,
          state: item?.runControl?.state || "running",
        })),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/run/stop") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = typeof payload.flowId === "string" ? payload.flowId.trim() : "";
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      const flowSource = payload.flowSource || "user";
      const scoped = resolveWorkspaceScopeRoot(root, {
        flowId,
        flowSource,
        adminOwnerId: payload.adminOwnerId || "",
        archived: payload.archived === true || payload.flowArchived === true,
      }, userCtx);
      if (scoped.error) {
        json(res, scoped.status || 400, { error: scoped.error });
        return;
      }
      if (scoped.collaborationAccess?.runnable === false) {
        json(res, 403, { error: "Workspace collaboration run permission denied" });
        return;
      }
      const scopeKey = workspaceRunKey(userCtx, flowSource, flowId);
      const runId = String(payload.runId || payload.runSessionId || "").trim();
      const runNodeId = String(payload.runNodeId || "").trim();
      const entries = workspaceActiveRunsForScope(scopeKey);
      const match = entries.find(([, item]) => runId && String(item?.runId || "") === runId)
        || entries.find(([, item]) => runNodeId && String(item?.runNodeId || "") === runNodeId)
        || (!runId && !runNodeId && entries.length === 1 ? entries[0] : null);
      const entry = match?.[1] || null;
      if (!entry) {
        json(res, 404, { error: "该 Workspace 未在运行" });
        return;
      }
      appendWorkspaceRunLogEvent(entry.runId, {
        type: "stop-requested",
        runNodeId: entry.runNodeId || "",
        ts: Date.now(),
      });
      broadcastWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
        type: "run.stop-requested",
        runId: entry.runId,
        runNodeId: entry.runNodeId || "",
        actorId: userCtx.userId || "",
      });
      const result = await entry.runControl.stop();
      if (!result.stopped) {
        appendWorkspaceRunLogEvent(entry.runId, {
          type: "stop-failed",
          runNodeId: entry.runNodeId || "",
          reason: result.timedOut ? "timeout" : "unknown",
          ts: Date.now(),
        });
        json(res, 409, {
          error: "停止请求已发送，但运行进程未能退出",
          ok: false,
          stopped: false,
          state: entry.runControl.state,
        });
        return;
      }
      appendWorkspaceRunLogEvent(entry.runId, {
        type: "stop-completed",
        runNodeId: entry.runNodeId || "",
        forced: result.forced === true,
        ts: Date.now(),
      });
      json(res, 200, {
        ok: true,
        stopped: true,
        forced: result.forced === true,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace/file") {
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: url.searchParams.get("flowId") || "",
          flowSource: url.searchParams.get("flowSource") || "user",
          archived: url.searchParams.get("archived") === "1",
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        const { abs, rel } = resolveWorkspaceFilePath(scoped.root, url.searchParams.get("path") || "");
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          json(res, 404, { error: "File not found" });
          return;
        }
        const stat = fs.statSync(abs);
        if (stat.size > 2 * 1024 * 1024) {
          json(res, 413, { error: "File too large" });
          return;
        }
        const content = fs.readFileSync(abs, "utf-8");
        json(res, 200, {
          path: rel,
          content,
          size: stat.size,
          revision: crypto.createHash("sha256").update(content).digest("hex"),
        });
      } catch (e) {
        json(res, /traversal/i.test(String(e.message || e)) ? 403 : 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace/file/raw") {
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: url.searchParams.get("flowId") || "",
          flowSource: url.searchParams.get("flowSource") || "user",
          archived: url.searchParams.get("archived") === "1",
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        const { abs, rel } = resolveWorkspaceFilePath(scoped.root, url.searchParams.get("path") || "");
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          json(res, 404, { error: "File not found" });
          return;
        }
        const ext = path.extname(abs).toLowerCase();
        const type = MIME[ext] || "application/octet-stream";
        const data = fs.readFileSync(abs);
        const headers = {
          "Content-Type": type,
          "Content-Length": data.length,
          "Cache-Control": "no-store",
        };
        if (url.searchParams.get("download") === "1") {
          headers["Content-Disposition"] = workspaceDownloadContentDisposition(rel);
        }
        res.writeHead(200, headers);
        res.end(data);
      } catch (e) {
        json(res, /traversal/i.test(String(e.message || e)) ? 403 : 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/html-screenshot") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          adminOwnerId: payload.adminOwnerId || "",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        const sourceFilePath = String(payload.sourceFilePath || payload.path || "").trim();
        let html = String(payload.content || "");
        let baseDir = scoped.root;
        if (sourceFilePath) {
          const { abs } = resolveWorkspaceFilePath(scoped.root, sourceFilePath);
          if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
            json(res, 404, { error: "HTML file not found" });
            return;
          }
          const stat = fs.statSync(abs);
          if (stat.size > 5 * 1024 * 1024) {
            json(res, 413, { error: "HTML file too large" });
            return;
          }
          if (!html.trim()) html = fs.readFileSync(abs, "utf-8");
          baseDir = path.dirname(abs);
        }
        if (!html.trim()) {
          json(res, 400, { error: "Missing HTML content" });
          return;
        }
        const screenshot = await renderHtmlScreenshotWithChrome({
          html,
          workspaceRoot: scoped.root,
          baseDir,
          width: payload.width,
          height: payload.height,
        });
        const png = screenshot.png;
        const filename = sanitizeWorkspaceUploadName(payload.filename || "html-render.png").replace(/\.[^.]+$/i, ".png");
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": png.length,
          "Cache-Control": "no-store",
          "Content-Disposition": workspaceDownloadContentDisposition(filename),
        });
        res.end(png);
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/file") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          adminOwnerId: payload.adminOwnerId || "",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (
          scoped.archived
          || isReadonlyBuiltinFlowSource(scoped.flowSource)
          || scoped.collaborationAccess?.writable === false
        ) {
          json(res, 400, { error: "Cannot write to builtin or archived pipeline workspace" });
          return;
        }
        const { abs, rel } = resolveWorkspaceFilePath(scoped.root, payload.path || "");
        if (!rel) {
          json(res, 400, { error: "Missing path" });
          return;
        }
        const content = String(payload.content ?? "");
        const baseRevision = String(payload.baseRevision || "").trim();
        if (baseRevision && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          const currentContent = fs.readFileSync(abs, "utf-8");
          const currentRevision = crypto.createHash("sha256").update(currentContent).digest("hex");
          if (currentRevision !== baseRevision) {
            json(res, 409, {
              error: "文件已被其他成员更新，请处理冲突后重试",
              conflict: "revision-mismatch",
              currentRevision,
            });
            return;
          }
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, content, "utf-8");
        fs.renameSync(tmp, abs);
        const revision = crypto.createHash("sha256").update(content).digest("hex");
        broadcastWorkspaceCollaborationEvent(
          userCtx,
          scoped.flowSource,
          scoped.flowId,
          scoped.archived,
          {
            type: "file.committed",
            path: rel,
            revision,
            actorId: userCtx.userId || "",
            clientId: String(payload.clientId || ""),
          },
        );
        json(res, 200, { ok: true, path: rel, revision });
      } catch (e) {
        json(res, /traversal/i.test(String(e.message || e)) ? 403 : 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/upload") {
      let parsed;
      try {
        parsed = await parseWorkspaceUploadForm(req);
      } catch (e) {
        json(res, /FILE_TOO_LARGE/.test(String(e.message || e)) ? 413 : 400, { error: (e && e.message) || String(e) });
        return;
      }
      try {
        if (!parsed.gotFile || !parsed.file.length) {
          json(res, 400, { error: "Missing upload file" });
          return;
        }
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: parsed.fields.flowId || "",
          flowSource: parsed.fields.flowSource || "user",
          adminOwnerId: parsed.fields.adminOwnerId || "",
          archived: parsed.fields.archived === "1" || parsed.fields.archived === "true" || parsed.fields.flowArchived === "true",
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource) || scoped.collaborationAccess?.writable === false) {
          json(res, 400, { error: "Cannot write to builtin or archived pipeline workspace" });
          return;
        }
        const safeName = sanitizeWorkspaceUploadName(parsed.filename);
        const targetDir = String(parsed.fields.dir ?? "").trim().replace(/^[/\\]+/, "").replace(/\\/g, "/");
        const targetRel = targetDir ? path.posix.join(targetDir, safeName) : safeName;
        const target = uniqueWorkspaceRelPath(scoped.root, targetRel);
        fs.mkdirSync(path.dirname(target.abs), { recursive: true });
        fs.writeFileSync(target.abs, parsed.file);
        broadcastWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
          type: "file.committed",
          path: target.rel,
          actorId: userCtx.userId || "",
        });
        json(res, 200, {
          ok: true,
          path: target.rel,
          size: parsed.file.length,
          mimeType: parsed.mimeType,
        });
      } catch (e) {
        json(res, /traversal/i.test(String(e.message || e)) ? 403 : 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/folder") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          adminOwnerId: payload.adminOwnerId || "",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource) || scoped.collaborationAccess?.writable === false) {
          json(res, 400, { error: "Cannot write to builtin or archived pipeline workspace" });
          return;
        }
        const { abs, rel } = resolveWorkspaceFilePath(scoped.root, payload.path || "");
        if (!rel) {
          json(res, 400, { error: "Missing path" });
          return;
        }
        fs.mkdirSync(abs, { recursive: true });
        broadcastWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
          type: "file.tree-changed",
          path: rel,
          actorId: userCtx.userId || "",
        });
        json(res, 200, { ok: true, path: rel });
      } catch (e) {
        json(res, /traversal/i.test(String(e.message || e)) ? 403 : 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/delete") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          adminOwnerId: payload.adminOwnerId || "",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource) || scoped.collaborationAccess?.writable === false) {
          json(res, 400, { error: "Cannot write to builtin or archived pipeline workspace" });
          return;
        }
        const { abs, rel } = resolveWorkspaceFilePath(scoped.root, payload.path || "");
        if (!rel) {
          json(res, 400, { error: "Missing path" });
          return;
        }
        if (!fs.existsSync(abs)) {
          json(res, 404, { error: "Path not found" });
          return;
        }
        fs.rmSync(abs, { recursive: true, force: true });
        broadcastWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
          type: "file.tree-changed",
          path: rel,
          deleted: true,
          actorId: userCtx.userId || "",
        });
        json(res, 200, { ok: true, path: rel });
      } catch (e) {
        json(res, /traversal/i.test(String(e.message || e)) ? 403 : 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (url.pathname === "/api/workspace/conversations") {
      let payload = {};
      if (req.method === "POST") {
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { error: "Invalid JSON body" });
          return;
        }
      } else if (req.method !== "GET") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: req.method === "POST" ? (payload.flowId || "") : (url.searchParams.get("flowId") || ""),
          flowSource: req.method === "POST" ? (payload.flowSource || "user") : (url.searchParams.get("flowSource") || "user"),
          adminOwnerId: req.method === "POST" ? (payload.adminOwnerId || "") : "",
          archived: req.method === "POST"
            ? (payload.archived === true || payload.flowArchived === true)
            : (url.searchParams.get("archived") === "1" || url.searchParams.get("flowArchived") === "1"),
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (req.method === "GET") {
          json(res, 200, { ok: true, conversations: readWorkspaceConversations(scoped.root) });
          return;
        }
        if (scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource) || scoped.collaborationAccess?.writable === false) {
          json(res, 400, { error: "Cannot write conversations for builtin or archived pipeline workspace" });
          return;
        }
        const conversations = writeWorkspaceConversations(scoped.root, payload.conversations || payload);
        json(res, 200, { ok: true, conversations });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/generate") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const prompt = String(payload?.prompt || "").trim();
      if (!prompt) {
        json(res, 400, { error: "Missing prompt" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          adminOwnerId: payload.adminOwnerId || "",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (scoped.collaborationAccess?.writable === false) {
          json(res, 403, { error: "Workspace collaboration edit permission denied" });
          return;
        }
        const selectedSkillKeys = Array.isArray(payload?.selectedSkills)
          ? payload.selectedSkills.map((x) => String(x || "").trim()).filter(Boolean)
          : [];
        const selectedSkillResources = selectedSkillKeys.length > 0
          ? loadResourcesForSkillKeys(selectedSkillKeys, PACKAGE_ROOT, scoped.root)
          : { skills: [], references: [] };
        const skillsBlock = selectedSkillKeys.length > 0
          ? buildSkillCompactInjectionBlock(selectedSkillResources.skills, selectedSkillResources.references)
          : "";
        let content = "";
        const events = [];
        const maxAttempts = 3;
        const nodeCatalogBlock = workspaceNodePackageCatalogBlock(root, scoped, userCtx);
        const promptText = buildWorkspaceGeneratePrompt({ ...payload, skillsBlock, nodeCatalogBlock });
        const modelKey = typeof payload?.model === "string" ? payload.model.trim() : "";
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          let attemptResult = "";
          const assistantSegments = [];
          try {
            if (attempt > 1) {
              events.push({
                type: "status",
                line: `Workspace agent retry ${attempt}/${maxAttempts} after transient network failure...`,
              });
              await sleepMs(Math.min(1500 * attempt, 5000));
            }
            const handle = startComposerAgent({
              uiWorkspaceRoot: scoped.root,
              cliWorkspace: scoped.root,
              prompt: promptText,
              modelKey,
              agentflowUserId: userCtx.userId || "",
              onStreamEvent: (ev) => {
                events.push(ev);
                if (ev?.type === "natural" && ev.kind === "assistant" && typeof ev.text === "string") {
                  const text = ev.text.trim();
                  if (text) assistantSegments.push(text);
                } else if (ev?.type === "natural" && ev.kind === "result" && typeof ev.text === "string") {
                  const text = ev.text.trim();
                  if (text) attemptResult = text;
                }
              },
            });
            await handle.finished;
            content = attemptResult || assistantSegments.at(-1) || "";
            break;
          } catch (e) {
            if (attempt < maxAttempts && isTransientAgentNetworkError(e)) {
              events.push({
                type: "status",
                line: `Workspace agent transient network error: ${String(e.message || e).slice(0, 220)}`,
              });
              continue;
            }
            throw e;
          }
        }
        json(res, 200, { ok: true, content: content.trim(), events });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/node-chat") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const message = String(payload?.message || "").trim();
      if (!message) {
        json(res, 400, { error: "Missing message" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          adminOwnerId: payload.adminOwnerId || "",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (scoped.collaborationAccess?.writable === false) {
          json(res, 403, { error: "Workspace collaboration edit permission denied" });
          return;
        }
        const targetFilePath = String(payload?.targetFilePath || "").trim();
        let targetFile = null;
        if (targetFilePath) {
          if (scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource) || scoped.collaborationAccess?.writable === false) {
            json(res, 400, { error: "Cannot edit builtin or archived pipeline workspace" });
            return;
          }
          targetFile = resolveWorkspaceFilePath(scoped.root, targetFilePath);
          if (!targetFile.rel) {
            json(res, 400, { error: "Missing artifact file path" });
            return;
          }
        }
        const beforeTargetContent = targetFile && fs.existsSync(targetFile.abs) && fs.statSync(targetFile.abs).isFile()
          ? fs.readFileSync(targetFile.abs, "utf-8")
          : null;
        const promptText = buildWorkspaceNodeChatPrompt(payload);
        const modelKey = typeof payload?.model === "string" ? payload.model.trim() : "";
        let content = "";
        const events = [];
        const handle = startComposerAgent({
          uiWorkspaceRoot: scoped.root,
          cliWorkspace: scoped.root,
          prompt: promptText,
          modelKey,
          agentflowUserId: userCtx.userId || "",
          onStreamEvent: (ev) => {
            events.push(ev);
            if (ev?.type === "natural" && ev.kind === "assistant" && typeof ev.text === "string") {
              content += (content ? "\n" : "") + ev.text;
            }
          },
        });
        await handle.finished;
        let candidateContent = targetFile
          ? (fs.existsSync(targetFile.abs) && fs.statSync(targetFile.abs).isFile()
              ? fs.readFileSync(targetFile.abs, "utf-8")
              : "")
          : content.trim();
        if (targetFile) {
          const unwrappedTargetContent = workspaceUnwrapOutputEnvelopeForDisplay(candidateContent);
          if (unwrappedTargetContent && unwrappedTargetContent !== candidateContent) {
            fs.writeFileSync(targetFile.abs, unwrappedTargetContent, "utf-8");
            candidateContent = unwrappedTargetContent;
          }
        }
        if (targetFile && beforeTargetContent != null && candidateContent === beforeTargetContent) {
          json(res, 500, { error: "Agent 未修改目标展示文件，请换一种更明确的描述后重试。" });
          return;
        }
        json(res, 200, {
          ok: true,
          sessionId: String(payload?.sessionId || "") || `nodechat_${Date.now()}`,
          reply: targetFile ? content.trim() : candidateContent,
          candidateContent,
          directFileEdit: Boolean(targetFile),
          artifactPath: targetFile?.rel || "",
          events,
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/nodes") {
      const flowId = url.searchParams.get("flowId");
      const flowSource = url.searchParams.get("flowSource") || "user";
      const lang = url.searchParams.get("lang") || "en";
      const marketplaceScope = url.searchParams.get("scope") === "owned" ? "owned" : "all";
      if (flowId && !isValidFlowSourceRead(flowSource)) {
        json(res, 400, { error: "Invalid flowSource" });
        return;
      }
      const nodesArchived = url.searchParams.get("archived") === "1";
      try {
        const requestedContext = adminWorkspaceRequestedUserContext(userCtx);
        if (requestedContext.error) {
          json(res, requestedContext.status || 403, { error: requestedContext.error });
          return;
        }
        const { setLanguage } = await import("./i18n.mjs");
        setLanguage(lang);
        json(res, 200, listNodesJson(root, flowId || "", flowId ? flowSource : "", {
          archived: nodesArchived,
          ...requestedContext.userCtx,
          marketplaceScope,
        }));
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/nodes/detail") {
      const nodeId = url.searchParams.get("id") || "";
      const flowId = url.searchParams.get("flowId") || "";
      const flowSource = url.searchParams.get("flowSource") || "";
      if (!nodeId) {
        json(res, 400, { error: "Missing node id" });
        return;
      }
      if (flowId && !isValidFlowSourceRead(flowSource || "user")) {
        json(res, 400, { error: "Invalid flowSource" });
        return;
      }
      const archived = url.searchParams.get("archived") === "1";
      try {
        const requestedContext = adminWorkspaceRequestedUserContext(userCtx);
        if (requestedContext.error) {
          json(res, requestedContext.status || 403, { error: requestedContext.error });
          return;
        }
        const detail = readNodeDetailJson(root, nodeId, flowId, flowId ? (flowSource || "user") : "", {
          archived,
          ...requestedContext.userCtx,
        });
        if (detail.error) {
          json(res, 404, { error: detail.error });
          return;
        }
        json(res, 200, detail);
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/nodes/file") {
      const nodeId = url.searchParams.get("id") || "";
      const relPath = url.searchParams.get("path") || "";
      const flowId = url.searchParams.get("flowId") || "";
      const flowSource = url.searchParams.get("flowSource") || "";
      if (!nodeId || !relPath) {
        json(res, 400, { error: "Missing node id or path" });
        return;
      }
      if (flowId && !isValidFlowSourceRead(flowSource || "user")) {
        json(res, 400, { error: "Invalid flowSource" });
        return;
      }
      const archived = url.searchParams.get("archived") === "1";
      try {
        const file = readNodeFilePreview(root, nodeId, relPath, flowId, flowId ? (flowSource || "user") : "", { archived, ...userCtx });
        if (file.error) {
          json(res, 404, { error: file.error });
          return;
        }
        json(res, 200, file);
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/node-studio/drafts") {
      try {
        json(res, 200, { drafts: listNodeStudioDrafts(userCtx) });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/node-studio/draft") {
      try {
        const id = url.searchParams.get("id") || "";
        if (!id) {
          json(res, 200, { draft: null });
          return;
        }
        const draft = readNodeStudioDraft(userCtx, id);
        json(res, 200, { draft: draft && !isLegacyNodeStudioDemoDraft(draft) ? draft : null });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/node-studio/draft") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const draftId = normalizeNodeStudioDraftId(payload.id || "untitled_node");
        const current = readNodeStudioDraft(userCtx, draftId) || emptyNodeStudioDraft(userCtx, draftId);
        const promptDraft = payload.promptDraft != null ? String(payload.promptDraft) : current.promptDraft || "";
        const agentMessages = Array.isArray(current.agentMessages) ? [...current.agentMessages] : [];
        const generate = payload.appendUserMessage === true && promptDraft.trim();

        if (generate) {
          const at = new Date().toISOString();
          agentMessages.push({ role: "user", text: promptDraft.trim(), at });
          const packageDir = nodeStudioPackageDir(userCtx, draftId);
          fs.mkdirSync(packageDir, { recursive: true });
          const before = nodeStudioReadPackage(userCtx, draftId);
          const reply = await runNodeStudioAgent({
            packageDir,
            userCtx,
            modelKey: typeof payload.model === "string" ? payload.model.trim() : "",
            prompt: buildNodeStudioPrompt({
              requirement: promptDraft,
              currentSource: before.source,
              parseError: before.error,
              history: current.agentMessages,
            }),
          });
          const after = nodeStudioReadPackage(userCtx, draftId);
          agentMessages.push({
            role: "assistant",
            at: new Date().toISOString(),
            text: after.error
              ? `${reply || "已改写 index.mjs"}\n\n⚠️ 解析失败：${after.error}`
              : (reply || `已写出 ${after.manifest?.id}@${after.manifest?.version}`),
            error: Boolean(after.error),
          });
          const draft = writeNodeStudioDraft(userCtx, {
            ...current,
            ...nodeStudioDraftFromPackage(after, draftId),
            promptDraft: "",
            agentMessages,
            test: { inputs: current?.test?.inputs || {}, log: [], status: "not run", packageDigest: "" },
          });
          json(res, 200, { ok: true, draft });
          return;
        }

        const draft = writeNodeStudioDraft(userCtx, {
          ...current,
          ...(payload.config && typeof payload.config === "object" ? { config: { ...(current.config || {}), ...payload.config } } : {}),
          promptDraft,
          agentMessages,
        });
        json(res, 200, { ok: true, draft });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/node-studio/publish") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const draftId = normalizeNodeStudioDraftId(payload.id || "");
        if (!readNodeStudioDraft(userCtx, draftId)) {
          json(res, 404, { error: "草稿不存在" });
          return;
        }
        // 发布前必须解析得过。发布一个读不出声明的包，等于往 marketplace 里放一个在面板上
        // 根本不出现的条目——问题会在别人安装它的时候才暴露。
        const pkg = nodeStudioReadPackage(userCtx, draftId);
        if (!pkg.source) {
          json(res, 400, { error: `还没有 ${NODE_PACKAGE_ENTRY}，先让 Agent 生成` });
          return;
        }
        if (pkg.error) {
          json(res, 400, { error: pkg.error });
          return;
        }
        const current = readNodeStudioDraft(userCtx, draftId);
        if (current?.test?.status !== "passed" || !pkg.packageDigest || current?.test?.packageDigest !== pkg.packageDigest) {
          json(res, 400, { error: "发布前必须对当前节点包运行并通过 Test" });
          return;
        }
        const result = publishNodePackage(root, nodeStudioPackageDir(userCtx, draftId), {
          immutable: true,
          ownerUserId: userCtx.userId,
        });
        if (!result.ok) {
          json(res, result.conflict ? 409 : 400, { error: result.error || "发布失败" });
          return;
        }
        json(res, 200, { ok: true, ...result });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/node-studio/test") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const draftId = normalizeNodeStudioDraftId(payload.id || "");
        const current = readNodeStudioDraft(userCtx, draftId);
        if (!current) {
          json(res, 404, { error: "草稿不存在" });
          return;
        }
        const pkg = nodeStudioReadPackage(userCtx, draftId);
        if (pkg.error || !pkg.manifest) {
          json(res, 400, { error: pkg.error || `还没有 ${NODE_PACKAGE_ENTRY}` });
          return;
        }
        const inputs = payload.inputs && typeof payload.inputs === "object" ? payload.inputs : {};
        const result = await runNodeStudioPackageTest({
          packageDir: nodeStudioPackageDir(userCtx, draftId),
          manifest: pkg.manifest,
          inputs,
          userCtx,
        });
        const draft = writeNodeStudioDraft(userCtx, {
          ...current,
          ...nodeStudioDraftFromPackage(pkg, draftId),
          test: {
            inputs,
            log: result.log,
            status: result.status,
            durationMs: result.durationMs,
            packageDigest: pkg.packageDigest || "",
          },
        });
        json(res, 200, { ok: true, draft, ...result });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

}

/**
 * @returns {Promise<boolean>} 是否已经由 PRD workflow 路由处理掉
 */
export async function handleWorkspaceRoutes(req, res, ctx) {
  await workspaceRoutes(req, res, ctx);
  return res.headersSent;
}
