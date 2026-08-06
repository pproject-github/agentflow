import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function flowYaml(label) {
  return `instances:
  start:
    definitionId: control_start
    label: ${label}
    role: normal
    input: []
    output:
      - type: node
        name: next
        value: ""
edges: []
ui:
  nodePositions:
    start: { x: 120, y: 160 }
`;
}

test("agentflow-cli publishes a reviewed Flow and requires explicit replacement", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-cli-publish-flow-")));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  const flowPath = path.join(tempRoot, "flow.yaml");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(flowPath, flowYaml("First draft"), "utf8");

  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }, { createTeam, setTeamMembers }] = await Promise.all([
      import(`../bin/lib/auth.mjs?agentflow-cli-publish=${nonce}`),
      import(`../bin/lib/ui-server.mjs?agentflow-cli-publish=${nonce}`),
      import("../bin/lib/teams.mjs"),
    ]);
    const user = loginOrCreateUser("flow-publisher", "publisher-password");
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const cliPath = path.resolve("skills/agentflow-cli/scripts/agentflow-cli.mjs");
    const commonArgs = ["--base-url", baseUrl, "--token", user.token];

    const created = await execFileAsync(process.execPath, [
      cliPath,
      "publish-flow",
      "--flow-id", "local-review-flow",
      "--file", flowPath,
      "--target-space", "personal",
      ...commonArgs,
    ]);
    const createdPayload = JSON.parse(created.stdout);
    assert.equal(createdPayload.success, true);
    assert.equal(createdPayload.action, "created");
    assert.equal(createdPayload.flowSource, "user");

    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath,
        "publish-flow",
        "--flow-id", "local-review-flow",
        "--file", flowPath,
        "--target-space", "personal",
        ...commonArgs,
      ]),
      (error) => /已存在同名流水线/.test(error.stderr),
    );

    fs.writeFileSync(flowPath, flowYaml("Confirmed revision"), "utf8");
    const updated = await execFileAsync(process.execPath, [
      cliPath,
      "publish-flow",
      "--flow-id", "local-review-flow",
      "--file", flowPath,
      "--target-space", "personal",
      "--replace",
      ...commonArgs,
    ]);
    const updatedPayload = JSON.parse(updated.stdout);
    assert.equal(updatedPayload.success, true);
    assert.equal(updatedPayload.action, "updated");
    assert.match(updatedPayload.revision, /^[a-f0-9]{24}$/);

    const currentResponse = await fetch(`${baseUrl}/api/flow?flowId=local-review-flow&flowSource=user`, {
      headers: { Authorization: `Bearer ${user.token}` },
    });
    const current = await currentResponse.json();
    assert.equal(currentResponse.status, 200);
    assert.match(current.flowYaml, /Confirmed revision/);

    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath,
        "publish-flow",
        "--flow-id", "must-not-be-created",
        "--file", flowPath,
        "--target-space", "team",
        ...commonArgs,
      ]),
      (error) => /not assigned to an active team/.test(error.stderr),
    );
    const absentResponse = await fetch(`${baseUrl}/api/flow?flowId=must-not-be-created&flowSource=workspace`, {
      headers: { Authorization: `Bearer ${user.token}` },
    });
    assert.equal(absentResponse.status, 404);

    const createdTeam = createTeam({ name: "CLI publish team" });
    assert.ok(createdTeam.team?.id);
    assert.ok(setTeamMembers(createdTeam.team.id, [user.user.userId]).team);
    const teamPublished = await execFileAsync(process.execPath, [
      cliPath,
      "publish-flow",
      "--flow-id", "team-review-flow",
      "--file", flowPath,
      "--target-space", "team",
      ...commonArgs,
    ]);
    const teamPayload = JSON.parse(teamPublished.stdout);
    assert.equal(teamPayload.success, true);
    assert.equal(teamPayload.flowSource, "workspace");
    assert.equal(teamPayload.targetSpace, "team");
    assert.equal(teamPayload.team.id, createdTeam.team.id);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
