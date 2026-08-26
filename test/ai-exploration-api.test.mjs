import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Workspace exploration API accepts external traces and performs a side-effect-safe dry-run check", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-ai-exploration-api-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const previousHome = process.env.AGENTFLOW_HOME;
  const previousCursorAgentCommand = process.env.CURSOR_AGENT_CMD;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?ai-exploration-api=${nonce}`),
      import(`../bin/lib/ui-server.mjs?ai-exploration-api=${nonce}`),
    ]);
    const auth = loginOrCreateUser("exploration-user", "exploration-password");
    const mockCursorAgent = path.join(tempRoot, "mock-plan-agent.mjs");
    const mockCallsPath = path.join(tempRoot, "mock-agent-calls.jsonl");
    fs.writeFileSync(mockCursorAgent, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(mockCallsPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "models") {
  console.log(JSON.stringify({ models: [] }));
} else if (args.includes("--mode")) {
  if (args[args.indexOf("--mode") + 1] !== "plan" || args.includes("--force") || args.includes("--sandbox") || args.includes("--approve-mcps")) {
    console.error("Plan must be read-only and tool-free");
    process.exit(2);
  }
  const plan = { title: "Safe plan", summary: "Inspect first", spans: [{ id: "step_1", type: "file", name: "Inspect", sideEffect: "read" }] };
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(plan) }));
} else {
  writeFileSync(join(process.cwd(), "workspace.flow.js"), 'import { display, flow } from "agentflow/flow";\\nconst result = display.markdown("Exploration Result", { content: "planned" });\\nexport const main = flow("Exploration", result);\\n');
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "materialized" }));
}
`, "utf8");
    fs.chmodSync(mockCursorAgent, 0o755);
    process.env.CURSOR_AGENT_CMD = mockCursorAgent;
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
      enableWorkspaceScheduler: false,
    });
    const address = server.address();
    const request = (pathname, init = {}) => fetch(`http://127.0.0.1:${address.port}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });

    const created = await request("/api/workspace/exploration", {
      method: "POST",
      body: JSON.stringify({ title: "External Codex", goal: "Inspect and publish", mode: "observed" }),
    });
    const createdBody = await created.json();
    assert.equal(created.status, 201, JSON.stringify(createdBody));
    const id = createdBody.exploration.id;

    const ingested = await request("/api/workspace/exploration/events", {
      method: "POST",
      body: JSON.stringify({
        id,
        phase: "planned",
        events: [
          { id: "read", spanId: "read", type: "file", name: "Read config", status: "planned", sideEffect: "read" },
          { id: "publish", spanId: "publish", parentSpanId: "read", type: "tool", name: "Publish", status: "planned", sideEffect: "external" },
        ],
      }),
    });
    assert.equal(ingested.status, 200, await ingested.text());

    const dryRun = await request("/api/workspace/exploration/dry-run", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    const dryRunBody = await dryRun.json();
    assert.equal(dryRun.status, 200, JSON.stringify(dryRunBody));
    assert.equal(dryRunBody.dryRun.executedTools, false);
    assert.equal(dryRunBody.dryRun.blockedCount, 1);
    assert.deepEqual(
      dryRunBody.exploration.events.filter((event) => event.phase === "simulated").map((event) => event.status),
      ["success", "blocked"],
    );

    const listed = await request("/api/workspace/explorations");
    const listedBody = await listed.json();
    assert.equal(listed.status, 200);
    assert.equal(listedBody.explorations[0].id, id);
    assert.equal(listedBody.explorations[0].eventCount, 4);

    const unreviewed = await request("/api/workspace/exploration/materialize", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    assert.equal(unreviewed.status, 409, await unreviewed.text());

    const workspaceFlowPath = path.join(workspaceRoot, "workspace.flow.js");
    const beforePlanSource = fs.existsSync(workspaceFlowPath) ? fs.readFileSync(workspaceFlowPath, "utf8") : "";
    const planned = await request("/api/workspace/exploration/plan", {
      method: "POST",
      body: JSON.stringify({ goal: "Inspect this Workspace before changing it" }),
    });
    const plannedBody = await planned.json();
    assert.equal(planned.status, 201, JSON.stringify(plannedBody));
    assert.equal(plannedBody.exploration.title, "Safe plan");
    assert.equal(plannedBody.exploration.status, "ready");
    assert.equal(plannedBody.exploration.events[0].phase, "planned");
    assert.equal(plannedBody.exploration.events[0].sideEffect, "read");
    const afterPlanSource = fs.existsSync(workspaceFlowPath) ? fs.readFileSync(workspaceFlowPath, "utf8") : "";
    assert.equal(afterPlanSource, beforePlanSource, `Plan mode must not write the Workspace DSL; calls: ${fs.existsSync(mockCallsPath) ? fs.readFileSync(mockCallsPath, "utf8") : "none"}`);

    const materialized = await request("/api/workspace/exploration/materialize", {
      method: "POST",
      body: JSON.stringify({ id: plannedBody.exploration.id }),
    });
    const materializedBody = await materialized.json();
    assert.equal(materialized.status, 200, JSON.stringify(materializedBody));
    assert.equal(materializedBody.exploration.mode, "materialized");
    assert.equal(materializedBody.materialization.nodeIds.length > 0, true, JSON.stringify(materializedBody.materialization));
    assert.equal(fs.existsSync(path.join(workspaceRoot, ".workspace", "agentflow", "explorations", plannedBody.exploration.id, "materialization.json")), true);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    if (previousCursorAgentCommand === undefined) delete process.env.CURSOR_AGENT_CMD;
    else process.env.CURSOR_AGENT_CMD = previousCursorAgentCommand;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
