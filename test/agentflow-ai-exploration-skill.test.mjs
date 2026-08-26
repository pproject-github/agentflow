import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const skillRoot = path.resolve("skills/agentflow-ai-exploration");
const cliPath = path.join(skillRoot, "scripts", "agentflow-ai-exploration.mjs");

async function runCli(baseUrl, token, authFile, args, scriptPath = cliPath) {
  const result = await execFileAsync(process.execPath, [scriptPath, ...args, "--base-url", baseUrl, "--token", token], {
    cwd: process.cwd(),
    env: { ...process.env, AGENTFLOW_AUTH_FILE: authFile, AGENTFLOW_ENV_FILE: path.join(path.dirname(authFile), "missing.env") },
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

test("AI exploration Skill is self-contained and exposes safe workflow instructions", () => {
  const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  const metadata = fs.readFileSync(path.join(skillRoot, "agents", "openai.yaml"), "utf8");
  const protocol = fs.readFileSync(path.join(skillRoot, "references", "protocol.md"), "utf8");

  assert.match(skill, /^name: agentflow-ai-exploration$/m);
  assert.doesNotMatch(skill, /\[TODO/);
  assert.match(skill, /executedTools: false/);
  assert.match(skill, /--approve-side-effects` only after the user explicitly approves/);
  assert.match(skill, /does not execute, publish, replace a stable release, or activate Scheduled Run/);
  assert.match(metadata, /\$agentflow-ai-exploration/);
  assert.match(protocol, /POST \/api\/workspace\/exploration\/events/);
  assert.equal(Boolean(fs.statSync(cliPath).mode & 0o100), true);
});

test("bundled exploration CLI creates, appends, dry-runs, reads, and finishes a Trace", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-exploration-skill-"));
  const workspaceRoot = path.join(temporary, "workspace");
  const dataRoot = path.join(temporary, "data");
  const authFile = path.join(temporary, "auth.json");
  const eventsFile = path.join(temporary, "events.json");
  const installedSkill = path.join(temporary, "installed-skill");
  fs.cpSync(skillRoot, installedSkill, { recursive: true });
  const installedCli = path.join(installedSkill, "scripts", "agentflow-ai-exploration.mjs");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(eventsFile, JSON.stringify([
    { id: "inspect", spanId: "inspect", type: "file", name: "Inspect logs", status: "planned", sideEffect: "read" },
    { id: "publish", spanId: "publish", parentSpanId: "inspect", type: "tool", name: "Publish result", status: "planned", sideEffect: "external" },
  ]), "utf8");
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?exploration-skill=${nonce}`),
      import(`../bin/lib/ui-server.mjs?exploration-skill=${nonce}`),
    ]);
    const auth = loginOrCreateUser("exploration-skill-user", "exploration-skill-password");
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(temporary, "static"),
      enableWorkspaceScheduler: false,
    });
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const created = await runCli(baseUrl, auth.token, authFile, [
      "create", "--title", "Skill Trace", "--goal", "Audit the task", "--mode", "planned",
    ], installedCli);
    const sessionId = created.exploration.id;
    assert.match(sessionId, /^exp_/);

    const appended = await runCli(baseUrl, auth.token, authFile, [
      "append", "--id", sessionId, "--phase", "planned", "--file", eventsFile,
    ], installedCli);
    assert.equal(appended.session.eventCount, 2);

    const dryRun = await runCli(baseUrl, auth.token, authFile, ["dry-run", "--id", sessionId], installedCli);
    assert.equal(dryRun.dryRun.executedTools, false);
    assert.equal(dryRun.dryRun.blockedCount, 1);

    const detail = await runCli(baseUrl, auth.token, authFile, ["get", "--id", sessionId], installedCli);
    assert.equal(detail.exploration.events.length, 4);

    const finished = await runCli(baseUrl, auth.token, authFile, [
      "finish", "--id", sessionId, "--status", "completed", "--summary", "Reviewed",
    ], installedCli);
    assert.equal(finished.session.status, "completed");
    assert.equal(finished.session.summary, "Reviewed");

    await assert.rejects(
      runCli(baseUrl, auth.token, authFile, ["materialize", "--id", sessionId], installedCli),
      (error) => /Side-effect review is required/.test(String(error?.stderr || error?.message || error)),
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
