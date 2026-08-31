import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function scheduledAgentGraph() {
  return {
    version: 1,
    instances: {
      daily: {
        definitionId: "workspace_scheduled_run",
        label: "Daily",
        body: JSON.stringify({
          enabled: true,
          cron: "0 8 * * *",
          timezone: "Asia/Shanghai",
          overlapPolicy: "skip",
        }),
        input: [{ type: "node", name: "prev", value: "" }],
        output: [{ type: "node", name: "next", value: "" }],
      },
      agent: {
        definitionId: "agent_subAgent",
        label: "Agent",
        body: "Run the required Shell, WebSearch, and MCP tools.",
        input: [{ type: "node", name: "prev", value: "" }],
        output: [{ type: "node", name: "next", value: "" }],
      },
    },
    edges: [{ source: "daily", sourceHandle: "output-0", target: "agent", targetHandle: "input-0" }],
    ui: { nodePositions: {} },
  };
}

test("only a published enabled Scheduled Run launches Cursor with --force", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-scheduled-cursor-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  const previousCursorAgentCommand = process.env.CURSOR_AGENT_CMD;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const mockCallsPath = path.join(tempRoot, "cursor-calls.jsonl");
    const mockCursorAgent = path.join(tempRoot, "mock-cursor-agent.mjs");
    fs.writeFileSync(mockCursorAgent, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(mockCallsPath)}, JSON.stringify(args) + "\\n");
console.log(JSON.stringify({ type: "tool_call", subtype: "completed", tool_call: { shellToolCall: { result: { success: true } } } }));
console.log(JSON.stringify({ type: "tool_call", subtype: "completed", tool_call: { WebSearch: { result: { success: true } } } }));
console.log(JSON.stringify({ type: "tool_call", subtype: "completed", tool_call: { mcpToolCall: { result: { success: true } } } }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }));
`, "utf8");
    fs.chmodSync(mockCursorAgent, 0o755);
    process.env.CURSOR_AGENT_CMD = mockCursorAgent;

    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }, workspaceServer] = await Promise.all([
      import(`../bin/lib/auth.mjs?scheduled-cursor=${nonce}`),
      import(`../bin/lib/ui-server.mjs?scheduled-cursor=${nonce}`),
      import("../bin/lib/workspace-server.mjs"),
    ]);
    const user = loginOrCreateUser("scheduled-cursor-owner", "scheduled-cursor-password");
    const workspaceRoot = path.join(tempRoot, "workspace");
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
      enableWorkspaceScheduler: false,
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" };
    const request = async (method, pathname, body) => {
      const response = await fetch(base + pathname, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch {}
      return { status: response.status, body: payload, text };
    };

    const created = await request("POST", "/api/flows", { flowId: "scheduled-cursor", targetSpace: "user" });
    assert.equal(created.status, 200, created.text);
    const initial = await request("GET", "/api/workspace/graph?flowId=scheduled-cursor&flowSource=user");
    assert.equal(initial.status, 200, initial.text);
    const saved = await request("POST", "/api/workspace/graph", {
      flowId: "scheduled-cursor",
      flowSource: "user",
      graph: scheduledAgentGraph(),
    });
    assert.equal(saved.status, 200, saved.text);
    const published = await request("POST", "/api/workspace/releases/publish", {
      flowId: "scheduled-cursor",
      flowSource: "user",
      runNodeId: "daily",
      expectedRevision: saved.body.revision,
    });
    assert.equal(published.status, 200, published.text);
    assert.equal(published.body.workspaceSchedules[0].enabled, true);

    await workspaceServer.runWorkspaceScheduledEntry(workspaceRoot, published.body.workspaceSchedules[0]);
    await workspaceServer.runWorkspaceGraph(workspaceRoot, initial.body.root, {
      flowId: "scheduled-cursor",
      flowSource: "user",
      runNodeId: "daily",
      graph: scheduledAgentGraph(),
      ignoreCache: true,
    }, { userId: user.user.userId });

    const calls = fs.readFileSync(mockCallsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].includes("--force"), true, "published enabled Scheduled Run must be unattended");
    assert.equal(calls[1].includes("--force"), false, "manual execution must preserve the permission boundary");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    if (previousCursorAgentCommand === undefined) delete process.env.CURSOR_AGENT_CMD;
    else process.env.CURSOR_AGENT_CMD = previousCursorAgentCommand;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
