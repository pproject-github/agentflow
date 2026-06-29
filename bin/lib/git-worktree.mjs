import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

export function runGit(args, cwd) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseJsonObject(raw) {
  if (raw == null) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function gitOrThrow(args, cwd, label) {
  const result = runGit(args, cwd);
  if (result.status !== 0) {
    throw new Error(`${label || "git"} failed: ${result.stderr || result.stdout || result.error?.message || "unknown error"}`);
  }
  return result.stdout.trim();
}

function readGitRemoteUrl(repoPath, remote = "origin") {
  const result = runGit(["remote", "get-url", remote], repoPath);
  return result.status === 0 ? result.stdout.trim() : "";
}

function parseRemoteUrl(remoteUrl) {
  const raw = String(remoteUrl || "").trim().replace(/\.git$/i, "");
  if (!raw) return { host: "", projectPath: "", provider: "" };
  let host = "";
  let projectPath = "";
  const scpLike = raw.match(/^[^@]+@([^:]+):(.+)$/);
  if (scpLike) {
    host = scpLike[1];
    projectPath = scpLike[2].replace(/^\/+/, "");
  } else {
    try {
      const u = new URL(raw);
      host = u.host;
      projectPath = u.pathname.replace(/^\/+/, "");
    } catch {
      projectPath = raw;
    }
  }
  const provider = host && /gitlab|git\.sysop/i.test(host) ? "gitlab" : "";
  return { host, projectPath, provider };
}

export function normalizeGitContext(raw) {
  const parsed = parseJsonObject(raw);
  if (!parsed) return null;
  return {
    version: 1,
    repoPath: parsed.repoPath ? path.resolve(String(parsed.repoPath)) : "",
    worktreePath: parsed.worktreePath ? path.resolve(String(parsed.worktreePath)) : "",
    branch: parsed.branch ? String(parsed.branch) : "",
    commit: parsed.commit ? String(parsed.commit) : "",
    remote: parsed.remote ? String(parsed.remote) : "",
    remoteUrl: parsed.remoteUrl ? String(parsed.remoteUrl) : "",
    provider: parsed.provider ? String(parsed.provider) : "",
    host: parsed.host ? String(parsed.host) : "",
    projectPath: parsed.projectPath ? String(parsed.projectPath) : "",
  };
}

export function buildGitContext({ repoPath, worktreePath = "", branch = "", commit = "", remote = "origin", remoteUrl = "" }) {
  const repoRoot = resolveGitRepoRoot(repoPath);
  const actualRemote = String(remote || "origin").trim() || "origin";
  const actualRemoteUrl = remoteUrl || readGitRemoteUrl(repoRoot, actualRemote);
  const remoteMeta = parseRemoteUrl(actualRemoteUrl);
  return {
    version: 1,
    repoPath: repoRoot,
    worktreePath: worktreePath ? path.resolve(worktreePath) : "",
    branch: String(branch || ""),
    commit: String(commit || ""),
    remote: actualRemote,
    remoteUrl: actualRemoteUrl,
    provider: remoteMeta.provider,
    host: remoteMeta.host,
    projectPath: remoteMeta.projectPath,
  };
}

export function sanitizeWorktreeName(raw) {
  return String(raw || "worktree")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "worktree";
}

export function resolveGitRepoRoot(repoPath) {
  const raw = String(repoPath || "").trim();
  if (!raw) throw new Error("repoPath is required");
  const abs = path.resolve(raw);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`repoPath directory not found: ${abs}`);
  }
  return path.resolve(gitOrThrow(["rev-parse", "--show-toplevel"], abs, "git rev-parse"));
}

export function inferGitRepoRootFromWorktree(worktreePath) {
  const raw = String(worktreePath || "").trim();
  if (!raw) throw new Error("worktreePath is required");
  const abs = path.resolve(raw);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`worktreePath directory not found: ${abs}`);
  }
  const commonDir = gitOrThrow(["rev-parse", "--git-common-dir"], abs, "git rev-parse common dir");
  const commonAbs = path.resolve(abs, commonDir);
  if (path.basename(commonAbs) === ".git") {
    return path.dirname(commonAbs);
  }
  return resolveGitRepoRoot(abs);
}

export function currentGitBranch(repoRoot) {
  const branch = gitOrThrow(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot, "git rev-parse branch");
  return branch === "HEAD" ? "" : branch;
}

export function currentGitCommit(repoRoot) {
  return gitOrThrow(["rev-parse", "HEAD"], repoRoot, "git rev-parse commit");
}

export function listGitWorktrees(repoRoot) {
  const text = gitOrThrow(["worktree", "list", "--porcelain"], repoRoot, "git worktree list");
  const entries = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ").trim();
    if (key === "worktree") {
      if (current) entries.push(current);
      current = { path: path.resolve(value), head: "", branchRef: "", branch: "" };
    } else if (current && key === "HEAD") {
      current.head = value;
    } else if (current && key === "branch") {
      current.branchRef = value;
      current.branch = value.replace(/^refs\/heads\//, "");
    } else if (current && key === "detached") {
      current.branch = "DETACHED";
    }
  }
  if (current) entries.push(current);
  return entries;
}

export function findRegisteredWorktree(repoRoot, worktreePath) {
  const target = canonicalPathForCompare(worktreePath);
  return listGitWorktrees(repoRoot).find((entry) => canonicalPathForCompare(entry.path) === target) || null;
}

function canonicalPathForCompare(rawPath) {
  const abs = path.resolve(String(rawPath || ""));
  try {
    return fs.realpathSync.native(abs);
  } catch {
    /* missing path: canonicalize the nearest existing parent */
  }
  const missingParts = [];
  let cursor = abs;
  while (cursor && !fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missingParts.unshift(path.basename(cursor));
    cursor = parent;
  }
  try {
    return path.join(fs.realpathSync.native(cursor), ...missingParts);
  } catch {
    return abs;
  }
}

function pruneGitWorktrees(repoRoot) {
  const result = runGit(["worktree", "prune", "--expire", "now"], repoRoot);
  if (result.status !== 0) {
    throw new Error(`git worktree prune failed: ${result.stderr || result.stdout}`);
  }
}

function isMissingRegisteredWorktreeError(result) {
  const text = String(result?.stderr || result?.stdout || "");
  return /missing but already registered worktree/i.test(text);
}

function branchExists(repoRoot, branch) {
  const result = runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
  return result.status === 0;
}

function defaultWorktreePath(pipelineWorkspace, repoRoot, branch) {
  const repoName = sanitizeWorktreeName(path.basename(repoRoot));
  const commit = currentGitCommit(repoRoot);
  const currentBranch = currentGitBranch(repoRoot);
  const refLabel = branch || currentBranch || commit.slice(0, 12);
  return path.join(path.resolve(pipelineWorkspace), ".workspace", "agentflow", "worktrees", repoName, sanitizeWorktreeName(refLabel));
}

function actualWorktreeBranch(worktreePath) {
  const branch = gitOrThrow(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath, "git rev-parse worktree branch");
  return branch === "HEAD" ? "DETACHED" : branch;
}

export function loadGitWorktree({ repoPath, branch = "", worktreePath = "", pipelineWorkspace, force = false, pruneMissing = true }) {
  const repoRoot = resolveGitRepoRoot(repoPath);
  const wantedBranch = String(branch || "").trim();
  const target = path.resolve(worktreePath || defaultWorktreePath(pipelineWorkspace || repoRoot, repoRoot, wantedBranch));

  if (wantedBranch && !branchExists(repoRoot, wantedBranch)) {
    throw new Error(`branch does not exist in repoPath: ${wantedBranch}`);
  }

  let registered = findRegisteredWorktree(repoRoot, target);
  if (fs.existsSync(target)) {
    if (!registered) {
      throw new Error(`worktreePath exists but is not registered for repoPath: ${target}`);
    }
    if (wantedBranch && registered.branch !== wantedBranch) {
      throw new Error(`worktreePath branch mismatch: expected ${wantedBranch}, got ${registered.branch || "DETACHED"}`);
    }
  } else {
    if (registered && pruneMissing) {
      pruneGitWorktrees(repoRoot);
      registered = findRegisteredWorktree(repoRoot, target);
    }
    if (registered && !force) {
      throw new Error(`worktreePath is missing but still registered: ${target}; set pruneMissing=true or force=true`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const args = ["worktree", "add"];
    if (force) args.push("--force");
    if (wantedBranch) {
      args.push(target, wantedBranch);
    } else {
      args.push("--detach", target, "HEAD");
    }
    let result = runGit(args, repoRoot);
    if (result.status !== 0 && pruneMissing && isMissingRegisteredWorktreeError(result)) {
      pruneGitWorktrees(repoRoot);
      result = runGit(args, repoRoot);
    }
    if (result.status !== 0) {
      throw new Error(`git worktree add failed: ${result.stderr || result.stdout}`);
    }
  }

  const actualBranch = actualWorktreeBranch(target);
  const commit = currentGitCommit(target);
  return {
    repoRoot,
    worktreePath: target,
    branch: actualBranch,
    commit,
  };
}

export function unloadGitWorktree({ repoPath, worktreePath, force = false, prune = true }) {
  const repoRoot = resolveGitRepoRoot(repoPath);
  const targetRaw = String(worktreePath || "").trim();
  if (!targetRaw) throw new Error("worktreePath is required");
  const target = path.resolve(targetRaw);
  const registered = findRegisteredWorktree(repoRoot, target);
  if (!registered) {
    throw new Error(`worktreePath is not registered for repoPath: ${target}`);
  }

  if (!force && fs.existsSync(target)) {
    const status = runGit(["status", "--porcelain"], target);
    if (status.status !== 0) throw new Error(`git status failed: ${status.stderr || status.stdout}`);
    if (status.stdout.trim()) {
      throw new Error("worktree has uncommitted or untracked changes; set force=true to remove it");
    }
  }

  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(target);
  const remove = runGit(args, repoRoot);
  if (remove.status !== 0) {
    throw new Error(`git worktree remove failed: ${remove.stderr || remove.stdout}`);
  }
  if (prune) {
    const pruneResult = runGit(["worktree", "prune"], repoRoot);
    if (pruneResult.status !== 0) throw new Error(`git worktree prune failed: ${pruneResult.stderr || pruneResult.stdout}`);
  }
  return {
    repoRoot,
    worktreePath: target,
    removed: true,
    message: `removed worktree: ${target}`,
  };
}
