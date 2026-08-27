import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const source = (message) => `import { display, flow } from "agentflow/flow";

const manualResult = display.markdown("Manual result", { content: ${JSON.stringify(message)} });
const scheduledResult = display.markdown("Scheduled result", { content: "scheduled" });

export const run = flow("Run", manualResult);
export const daily = flow.schedule("Daily", \`{"enabled":true,"cron":"0 8 * * *","timezone":"Asia/Shanghai","overlapPolicy":"skip"}\`, scheduledResult);
`;

test("CLI drives draft iteration, promotion, and schedule lifecycle", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-cli-draft-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?cli-draft=${nonce}`),
      import(`../bin/lib/ui-server.mjs?cli-draft=${nonce}`),
    ]);
    const user = loginOrCreateUser("cli-draft-owner", "cli-draft-password");
    server = await startUiServer({
      workspaceRoot: path.join(tempRoot, "workspace"),
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
      enableWorkspaceScheduler: false,
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const cliPath = path.resolve("skills/agentflow-cli/scripts/agentflow-cli.mjs");
    const cli = async (...extra) => {
      const { stdout } = await execFileAsync(process.execPath, [
        cliPath,
        ...extra,
        "--base-url", baseUrl,
        "--token", user.token,
        "--agentflow-package-root", path.resolve("."),
      ]);
      return JSON.parse(stdout);
    };

    const flowDir = path.join(tempRoot, "flow");
    fs.mkdirSync(flowDir);
    fs.writeFileSync(path.join(flowDir, "workspace.flow.js"), source("first"), "utf8");

    const draft = await cli("draft-create", "--file", flowDir, "--ttl-seconds", "600");
    assert.equal(draft.draft, true);
    assert.match(draft.draftId, /^draft_/);

    const firstRun = await cli("draft-run", "--draft-id", draft.draftId, "--run-node-id", "run");
    assert.equal(firstRun.ok, true);
    assert.equal(firstRun.graph.instances.manualResult.body, "first");

    fs.writeFileSync(path.join(flowDir, "workspace.flow.js"), source("second"), "utf8");
    const updated = await cli(
      "draft-update",
      "--draft-id", draft.draftId,
      "--base-revision", draft.revision,
      "--file", flowDir,
    );
    assert.equal(updated.draftId, draft.draftId);
    await assert.rejects(
      cli(
        "draft-update",
        "--draft-id", draft.draftId,
        "--base-revision", draft.revision,
        "--file", flowDir,
      ),
      /Draft 已被更新|revision-mismatch/,
    );
    const pulledDir = path.join(tempRoot, "pulled-draft");
    const pulled = await cli("draft-pull", "--draft-id", draft.draftId, "--output", pulledDir);
    assert.equal(pulled.draft, true);
    assert.equal(pulled.revision, updated.revision);
    assert.ok(fs.existsSync(path.join(pulledDir, "workspace.flow.js")));
    const secondRun = await cli("draft-run", "--draft-id", draft.draftId, "--run-node-id", "run");
    assert.equal(secondRun.graph.instances.manualResult.body, "second");

    const published = await cli(
      "draft-publish",
      "--draft-id", draft.draftId,
      "--flow-id", "cliDraftPublished",
      "--target-space", "personal",
      "--schedule", "enabled",
    );
    assert.equal(published.success, true);
    assert.equal(published.workspaceSchedules[0].enabled, true);

    const listed = await cli("schedule-list", "--flow-id", "cliDraftPublished");
    assert.equal(listed.schedules.length, 1);
    assert.equal(listed.schedules[0].scheduleNodeId, "daily");

    const disabled = await cli(
      "schedule-disable",
      "--flow-id", "cliDraftPublished",
      "--schedule-node-id", "daily",
    );
    assert.equal(disabled.schedule.enabled, false);

    const enabled = await cli(
      "schedule-set",
      "--flow-id", "cliDraftPublished",
      "--schedule-node-id", "daily",
      "--enabled", "true",
      "--cron", "30 9 * * 1-5",
      "--timezone", "Asia/Shanghai",
    );
    assert.equal(enabled.schedule.enabled, true);
    assert.equal(enabled.schedule.cron, "30 9 * * 1-5");

    const runNow = await cli(
      "schedule-run-now",
      "--flow-id", "cliDraftPublished",
      "--schedule-node-id", "daily",
    );
    assert.equal(runNow.ok, true);
    assert.equal(runNow.graph.instances.scheduledResult.body, "scheduled");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
