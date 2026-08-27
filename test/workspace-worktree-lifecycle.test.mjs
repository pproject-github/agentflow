import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { unloadGitWorktree } from "../bin/lib/git-worktree.mjs";
import { cleanupWorkspaceRunResources, runWorkspaceGraph } from "../bin/lib/workspace-server.mjs";

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createRepository(root) {
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(repoPath, { recursive: true });
  git(["init", "-b", "main"], repoPath);
  git(["config", "user.email", "agentflow@example.test"], repoPath);
  git(["config", "user.name", "AgentFlow Test"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "fixture\n", "utf-8");
  git(["add", "README.md"], repoPath);
  git(["commit", "-m", "fixture"], repoPath);
  return repoPath;
}

function outputValue(instance, name) {
  const slot = (instance?.output || []).find((item) => String(item?.name || "") === name);
  return String(slot?.value ?? slot?.default ?? "");
}

function lifecycleGraph(repoPath, stepScript) {
  return {
    version: 1,
    instances: {
      run: {
        definitionId: "workspace_run",
        label: "Run",
        input: [{ type: "node", name: "prev" }],
        output: [{ type: "node", name: "next" }],
      },
      worktree: {
        definitionId: "tool_git_worktree_load",
        label: "Load Worktree",
        input: [
          { type: "node", name: "prev" },
          { type: "file", name: "repoPath", value: repoPath },
          { type: "text", name: "branch", value: "" },
          { type: "file", name: "worktreePath", value: "" },
          { type: "bool", name: "pruneMissing", value: "true" },
          { type: "bool", name: "force", value: "false" },
          { type: "text", name: "gitContext", value: "" },
          { type: "text", name: "workspaceContext", value: "{}" },
        ],
        output: [
          { type: "node", name: "next" },
          { type: "file", name: "worktreePath", value: "" },
          { type: "text", name: "branch", value: "" },
          { type: "text", name: "commit", value: "" },
          { type: "text", name: "workspaceContext", value: "" },
          { type: "text", name: "gitContext", value: "" },
        ],
      },
      loop: {
        definitionId: "control_while",
        label: "Checkpoint",
        script: `node ${stepScript}`,
        input: [
          { type: "node", name: "prev" },
          { type: "json", name: "state", value: "{}" },
          { type: "text", name: "maxIterations", value: "2" },
          { type: "text", name: "timeout", value: "10s" },
        ],
        output: [
          { type: "node", name: "next" },
          { type: "json", name: "result", value: "" },
          { type: "json", name: "state", value: "null" },
          { type: "text", name: "decision", value: "" },
          { type: "text", name: "iterations", value: "0" },
          { type: "text", name: "summary", value: "" },
          { type: "json", name: "history", value: "[]" },
          { type: "text", name: "checkpointFingerprint", value: "" },
        ],
      },
    },
    edges: [
      { source: "run", target: "worktree", sourceHandle: "output-0", targetHandle: "input-0" },
      { source: "worktree", target: "loop", sourceHandle: "output-0", targetHandle: "input-0" },
    ],
    ui: { nodePositions: {} },
  };
}

test("wait retains a run worktree, resume reuses it, and terminal completion removes it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-worktree-resume-"));
  const scopedRoot = path.join(root, "flow");
  fs.mkdirSync(scopedRoot, { recursive: true });
  const repoPath = createRepository(root);
  const resumeFlag = path.join(root, "resume.flag");
  const stepScript = path.join(root, "step.mjs");
  fs.writeFileSync(stepScript, [
    'import fs from "node:fs";',
    `const done = fs.existsSync(${JSON.stringify(resumeFlag)});`,
    'console.log(JSON.stringify({ decision: done ? "done" : "wait", state: {}, summary: done ? "resumed" : "waiting" }));',
  ].join("\n") + "\n", "utf-8");

  const first = await runWorkspaceGraph(root, scopedRoot, {
    flowId: "worktree-lifecycle",
    flowSource: "user",
    runNodeId: "run",
    graph: lifecycleGraph(repoPath, stepScript),
  }, { userId: "worktree-test" }, { runId: "worktree-run-1" });

  const retainedPath = outputValue(first.graph.instances.worktree, "worktreePath");
  assert.equal(outputValue(first.graph.instances.loop, "decision"), "wait");
  assert.ok(retainedPath.includes(`${path.sep}run-workspaces${path.sep}`));
  assert.ok(fs.existsSync(retainedPath), "waiting run must retain its worktree");

  const firstManifestPath = path.join(scopedRoot, ".workspace", "agentflow", "run-manifests", "worktree-run-1.json");
  const firstManifest = JSON.parse(fs.readFileSync(firstManifestPath, "utf-8"));
  assert.equal(firstManifest.status, "waiting");
  assert.equal(firstManifest.artifactRoot, path.join(scopedRoot, "outputs"));
  assert.equal(firstManifest.worktrees[0].worktreePath, retainedPath);
  assert.equal(fs.existsSync(firstManifest.runtimeRoot), false, "node tmp is independent and removed while waiting");

  fs.writeFileSync(resumeFlag, "resume\n", "utf-8");
  const resumed = await runWorkspaceGraph(root, scopedRoot, {
    flowId: "worktree-lifecycle",
    flowSource: "user",
    runNodeId: "run",
    graph: first.graph,
  }, { userId: "worktree-test" }, { runId: "worktree-run-2" });

  assert.equal(outputValue(resumed.graph.instances.loop, "decision"), "done");
  assert.equal(fs.existsSync(retainedPath), false, "terminal completion must remove a clean retained worktree");
  assert.equal(outputValue(resumed.graph.instances.worktree, "worktreePath"), "");
  const secondManifest = JSON.parse(fs.readFileSync(
    path.join(scopedRoot, ".workspace", "agentflow", "run-manifests", "worktree-run-2.json"),
    "utf-8",
  ));
  assert.equal(secondManifest.status, "completed");
  assert.equal(secondManifest.worktrees[0].removed, true);
});

test("terminal cleanup preserves a dirty worktree instead of forcing data loss", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-worktree-dirty-"));
  const scopedRoot = path.join(root, "flow");
  fs.mkdirSync(scopedRoot, { recursive: true });
  const repoPath = createRepository(root);
  const stepScript = path.join(root, "dirty-step.mjs");
  fs.writeFileSync(stepScript, [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'fs.writeFileSync(path.join(process.argv[2], "uncommitted.txt"), "keep me\\n", "utf-8");',
    'console.log(JSON.stringify({ decision: "done", state: {}, summary: "dirty" }));',
  ].join("\n") + "\n", "utf-8");

  const events = [];
  const graph = lifecycleGraph(repoPath, stepScript);
  graph.instances.loop.script = `node ${stepScript} \${cwd}`;
  const result = await runWorkspaceGraph(root, scopedRoot, {
    flowId: "worktree-dirty",
    flowSource: "user",
    runNodeId: "run",
    graph,
  }, { userId: "worktree-test" }, {
    runId: "worktree-dirty-1",
    onEvent: (event) => events.push(event),
  });

  const worktreePath = outputValue(result.graph.instances.worktree, "worktreePath");
  assert.ok(fs.existsSync(path.join(worktreePath, "uncommitted.txt")));
  assert.ok(events.some((event) => event.kind === "warning" && /已保留/.test(String(event.text || ""))));
  const manifest = JSON.parse(fs.readFileSync(
    path.join(scopedRoot, ".workspace", "agentflow", "run-manifests", "worktree-dirty-1.json"),
    "utf-8",
  ));
  assert.equal(manifest.status, "completed");
  assert.equal(manifest.resourcesPreserved, true);
  assert.equal(manifest.worktrees[0].removed, false);

  unloadGitWorktree({ repoPath, worktreePath, force: true, prune: true });
});

test("stopping a deferred run cleans resources from its persisted run manifest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-worktree-stop-"));
  const scopedRoot = path.join(root, "flow");
  fs.mkdirSync(scopedRoot, { recursive: true });
  const repoPath = createRepository(root);
  const stepScript = path.join(root, "wait-step.mjs");
  fs.writeFileSync(stepScript, [
    'console.log(JSON.stringify({ decision: "wait", state: {}, summary: "waiting" }));',
  ].join("\n") + "\n", "utf-8");

  const waiting = await runWorkspaceGraph(root, scopedRoot, {
    flowId: "worktree-stop",
    flowSource: "user",
    runNodeId: "run",
    graph: lifecycleGraph(repoPath, stepScript),
  }, { userId: "worktree-test" }, { runId: "worktree-stop-1" });
  const worktreePath = outputValue(waiting.graph.instances.worktree, "worktreePath");
  assert.ok(fs.existsSync(worktreePath));

  const cleanup = cleanupWorkspaceRunResources(scopedRoot, "worktree-stop-1", { status: "stopped" });
  assert.deepEqual(cleanup.preserved, []);
  assert.deepEqual(cleanup.cleaned, [worktreePath]);
  assert.equal(fs.existsSync(worktreePath), false);
  const manifest = JSON.parse(fs.readFileSync(cleanup.manifestPath, "utf-8"));
  assert.equal(manifest.status, "stopped");
  assert.equal(manifest.worktrees[0].removed, true);
});
