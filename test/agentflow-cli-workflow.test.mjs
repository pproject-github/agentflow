import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("agentflow-cli reads and reports the generic Workflow model", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-cli-workflow-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "project");
  const reportPath = path.join(tempRoot, "workflow-report.json");
  const artifactPath = path.join(tempRoot, "workflow-artifact.json");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    action: {
      key: "verify-cli-report",
      title: "验证 CLI 上报",
      status: "done",
    },
    artifacts: [{
      key: "cli-evidence",
      type: "document",
      title: "CLI 验证记录",
      url: "https://example.test/cli-evidence",
      scope: "global",
    }],
    globalState: {
      patch: {
        status: { label: "已验证" },
        sections: {
          verification: {
            title: "验证",
            fields: {
              result: { label: "结果", type: "text", value: "通过" },
            },
          },
        },
      },
    },
    projections: {
      timeline: [{
        kind: "milestone",
        id: "verification-complete",
        title: "验证完成",
        date: "2026-08-04",
        source: "prd-flow",
        dimensions: { channel: "internal" },
      }],
    },
  }), "utf8");
  fs.writeFileSync(artifactPath, JSON.stringify({
    title: "CLI Markdown 预览",
    markdown: "# CLI Markdown\n\n统一 Artifact 发布接口。",
    stage: "verification",
    artifactKey: "cli-markdown-preview",
    artifactLabel: "CLI Markdown 预览",
    durability: "temporary",
  }), "utf8");

  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?agentflow-cli-workflow=${nonce}`),
      import(`../bin/lib/ui-server.mjs?agentflow-cli-workflow=${nonce}`),
    ]);
    const user = loginOrCreateUser("cli-workflow-reporter", "reporter-password");
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const address = server.address();
    const cliPath = path.resolve("skills/agentflow-cli/scripts/agentflow-cli.mjs");
    const commonArgs = [
      "--base-url", `http://127.0.0.1:${address.port}`,
      "--token", user.token,
    ];

    const report = await execFileAsync(process.execPath, [
      cliPath,
      "workflow-report",
      "--workflow", "tapd:1015046",
      "--file", reportPath,
      "--idempotency-key", "cli-workflow-report-v1",
      ...commonArgs,
    ]);
    const reported = JSON.parse(report.stdout);
    assert.equal(reported.ok, true);
    assert.equal(reported.snapshot.globalState.status.label, "已验证");
    assert.equal(reported.snapshot.artifacts[0].key, "cli-evidence");
    assert.equal(reported.snapshot.projections.timeline[0].kind, "milestone");

    const get = await execFileAsync(process.execPath, [
      cliPath,
      "workflow-get",
      "--workflow", "tapd:1015046",
      "--runtime-only",
      ...commonArgs,
    ]);
    const current = JSON.parse(get.stdout);
    assert.equal(current.snapshot.globalState.sections.verification.fields.result.value, "通过");
    assert.equal(current.snapshot.projections.timeline[0].dimensions.channel, "internal");
    assert.match(current.snapshot.runtimeRevision, /^runtime:/);

    const published = await execFileAsync(process.execPath, [
      cliPath,
      "workflow-artifact-publish",
      "--workflow", "tapd:1015046",
      "--file", artifactPath,
      ...commonArgs,
    ]);
    const artifact = JSON.parse(published.stdout);
    assert.equal(artifact.ok, true);
    assert.equal(artifact.artifact.key, "cli-markdown-preview");
    assert.match(artifact.review.shortUrl || artifact.review.url, /\/(r|api\/prd-workflow\/review)\//);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
