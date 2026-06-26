import path from "path";

import { buildGitContext, currentGitBranch, currentGitCommit, normalizeGitContext, resolveGitRepoRoot, runGit } from "./git-worktree.mjs";

function gitOrThrow(args, cwd, label) {
  const result = runGit(args, cwd);
  if (result.status !== 0) {
    throw new Error(`${label || "git"} failed: ${result.stderr || result.stdout || result.error?.message || "unknown error"}`);
  }
  return result.stdout.trim();
}

function isTruthy(value, defaultValue = false) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return Boolean(defaultValue);
  return text === "true" || text === "1" || text === "yes" || text === "y" || text === "on";
}

function resolveToken(env, tokenEnv) {
  const names = String(tokenEnv || "")
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter(Boolean);
  const candidates = names.length > 0 ? names : ["GITLAB_TOKEN", "GITLAB_PRIVATE_TOKEN"];
  for (const name of candidates) {
    const value = env?.[name];
    if (value != null && String(value).trim()) return { token: String(value), tokenEnv: name };
  }
  throw new Error(`GitLab token not found in env: ${candidates.join(", ")}`);
}

function apiBaseFromContext(gitContext, explicit) {
  const raw = String(explicit || "").trim().replace(/\/+$/, "");
  if (raw) return raw.endsWith("/api/v4") ? raw : `${raw}/api/v4`;
  const host = String(gitContext?.host || "").trim();
  if (!host) throw new Error("gitlabApiBase or gitContext.host is required");
  return `https://${host}/api/v4`;
}

function projectPathFromContext(gitContext) {
  const projectPath = String(gitContext?.projectPath || "").trim().replace(/^\/+|\/+$/g, "");
  if (!projectPath) throw new Error("gitContext.projectPath is required");
  return projectPath;
}

function encodeProject(projectPath) {
  return encodeURIComponent(projectPath);
}

async function gitlabJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message = json?.message ? JSON.stringify(json.message) : text || `HTTP ${res.status}`;
    throw new Error(`GitLab API failed: ${message}`);
  }
  return json;
}

function latestCommitSubject(repoPath) {
  return gitOrThrow(["log", "-1", "--pretty=%s"], repoPath, "git log subject") || "";
}

function recentCommitDescription(repoPath, targetBranch, sourceBranch) {
  const ranges = [
    [`origin/${targetBranch}..${sourceBranch}`],
    [`${targetBranch}..${sourceBranch}`],
    ["-5"],
  ];
  for (const range of ranges) {
    const result = runGit(["log", "--pretty=format:- %h %s", ...range], repoPath);
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  return "";
}

function normalizeLabels(labels) {
  return String(labels || "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean)
    .join(",");
}

export async function createGitLabMergeRequest(payload = {}, env = process.env) {
  const inputGitContext = normalizeGitContext(payload.gitContext);
  const repoCandidate = String(payload.repoPath || "").trim() ||
    inputGitContext?.worktreePath ||
    inputGitContext?.repoPath ||
    String(payload.workspaceCwd || "").trim();
  if (!repoCandidate) throw new Error("repoPath, gitContext, or workspaceContext cwd is required");
  const repoPath = resolveGitRepoRoot(repoCandidate);
  const remote = String(payload.remote || inputGitContext?.remote || "origin").trim() || "origin";
  const commit = currentGitCommit(repoPath);
  const gitContext = inputGitContext?.projectPath
    ? { ...inputGitContext, commit: inputGitContext.commit || commit, remote }
    : buildGitContext({ repoPath, branch: currentGitBranch(repoPath) || "DETACHED", commit, remote });
  const sourceBranch = String(payload.sourceBranch || gitContext.branch || currentGitBranch(repoPath) || "").trim();
  if (!sourceBranch || sourceBranch === "DETACHED") {
    throw new Error("sourceBranch is required when repository is in detached HEAD");
  }
  const targetBranch = String(payload.targetBranch || "main").trim() || "main";
  const title = String(payload.title || "").trim() || latestCommitSubject(repoPath) || `${sourceBranch} -> ${targetBranch}`;
  const description = String(payload.description || "").trim() || recentCommitDescription(repoPath, targetBranch, sourceBranch);
  const apiBase = apiBaseFromContext(gitContext, payload.gitlabApiBase);
  const projectPath = projectPathFromContext(gitContext);
  const { token, tokenEnv } = resolveToken(env, payload.tokenEnv);
  const headers = {
    "PRIVATE-TOKEN": token,
    "Content-Type": "application/json",
  };

  if (isTruthy(payload.push, true)) {
    const push = runGit(["push", "-u", remote, sourceBranch], repoPath);
    if (push.status !== 0) throw new Error(`git push failed: ${push.stderr || push.stdout}`);
  }

  const query = new URLSearchParams({
    state: "opened",
    source_branch: sourceBranch,
    target_branch: targetBranch,
  });
  const projectId = encodeProject(projectPath);
  const existing = await gitlabJson(`${apiBase}/projects/${projectId}/merge_requests?${query.toString()}`, { headers });
  const openMr = Array.isArray(existing) ? existing[0] : null;
  if (openMr?.web_url) {
    return {
      created: false,
      mrUrl: openMr.web_url,
      mrIid: openMr.iid,
      projectId: openMr.project_id,
      sourceBranch,
      targetBranch,
      title: openMr.title || title,
      message: `reused existing MR: ${openMr.web_url}`,
      tokenEnv,
    };
  }

  const body = {
    source_branch: sourceBranch,
    target_branch: targetBranch,
    title: isTruthy(payload.draft, false) && !/^draft:/i.test(title) ? `Draft: ${title}` : title,
    description,
    remove_source_branch: isTruthy(payload.removeSourceBranch, false),
    squash: isTruthy(payload.squash, false),
  };
  const labels = normalizeLabels(payload.labels);
  if (labels) body.labels = labels;

  const created = await gitlabJson(`${apiBase}/projects/${projectId}/merge_requests`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!created?.web_url) throw new Error("GitLab API did not return merge request URL");
  return {
    created: true,
    mrUrl: created.web_url,
    mrIid: created.iid,
    projectId: created.project_id,
    sourceBranch,
    targetBranch,
    title: created.title || body.title,
    message: `created MR: ${created.web_url}`,
    tokenEnv,
  };
}
