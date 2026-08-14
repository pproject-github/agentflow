import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("publish-flow defaults schedules off, enables explicitly, and rolls back invalid activation", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-publish-schedule-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?publish-schedule=${nonce}`),
      import(`../bin/lib/ui-server.mjs?publish-schedule=${nonce}`),
    ]);
    const user = loginOrCreateUser("schedule-publisher", "schedule-password");
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
    fs.writeFileSync(path.join(flowDir, "workspace.flow.js"), `import { display, flow } from "agentflow/flow";
const result = display.markdown("Result", { content: "ok" });
export const daily = flow.schedule("Daily", \`{"enabled":true,"cron":"0 8 * * *","timezone":"Asia/Shanghai","overlapPolicy":"skip"}\`, result);
`, "utf8");

    const safePublished = await cli(
      "publish-flow",
      "--flow-id", "publishedScheduleDisabled",
      "--file", flowDir,
      "--target-space", "personal",
    );
    assert.equal(safePublished.success, true);
    assert.equal(safePublished.scheduleMode, "disabled");
    assert.equal(safePublished.workspaceSchedules[0].enabled, false);

    const published = await cli(
      "publish-flow",
      "--flow-id", "publishedSchedule",
      "--file", flowDir,
      "--target-space", "personal",
      "--schedule", "enabled",
    );
    assert.equal(published.success, true);
    assert.equal(published.workspaceSchedules.length, 1);
    assert.equal(published.workspaceSchedules[0].enabled, true);
    assert.ok(published.workspaceSchedules[0].nextRunAt);

    const listed = await cli("schedule-list", "--flow-id", "publishedSchedule");
    assert.equal(listed.schedules.length, 1);
    assert.equal(listed.schedules[0].lastStatus, "armed");

    const invalidDir = path.join(tempRoot, "invalid-flow");
    fs.mkdirSync(invalidDir);
    fs.writeFileSync(path.join(invalidDir, "workspace.flow.js"), `import { display, flow } from "agentflow/flow";
const result = display.markdown("Result", { content: "invalid" });
export const daily = flow.schedule("Daily", \`{"enabled":true,"cron":"not-a-cron","timezone":"Asia/Shanghai","overlapPolicy":"skip"}\`, result);
`, "utf8");
    await assert.rejects(
      cli(
        "publish-flow",
        "--flow-id", "invalidPublishedSchedule",
        "--file", invalidDir,
        "--target-space", "personal",
        "--schedule", "enabled",
      ),
      /rolled back|Invalid|cron/i,
    );
    const flows = await cli("list-flows");
    assert.equal(flows.some((item) => item.id === "invalidPublishedSchedule"), false);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
