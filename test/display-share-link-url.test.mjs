/**
 * 「分享展示链接」发出去的必须是展示页地址。
 *
 * 审批收件箱那次改动把这个节点的 `url` 从 `/display/<shareId>` 换成了
 * `/review/plan?token=…`。审核页只认中断记录，而中断记录是下游 `control_interrupt`
 * 节点才写的——日报这类根本没有审批的流程，推给企微的每一条链接都是死的，点开
 * 只会说「审核链接已失效或已处理」。
 *
 * 所以 `url` 跟着图走：没有中断节点消费 `reviewToken` 就给展示页地址；已经发出去
 * 的那些审核页地址，则要能自己跳回展示页。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const REPORT_FLOW = `import { display, flow, tool } from "agentflow/flow";

const report = display.markdown("日报", { content: "# 昨天花了 3 块钱" });
const link = tool.displayShareLink("分享", { title: "日报" });

export const run = flow("Run", report, link);
`;

const APPROVAL_FLOW = `import { control, display, flow, tool } from "agentflow/flow";

const plan = display.markdown("Plan", { content: "# 执行计划" });
const link = tool.displayShareLink("分享", { title: "Plan" });
const gate = control.interrupt("确认", {
  value: plan.content,
  reason: "plan_confirmation",
  resumeToken: link.reviewToken,
});

export const run = flow("Run", plan, link, gate);
`;

async function withServer(flowId, source, body) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-share-url-"));
  const workspaceRoot = path.join(tempRoot, "project");
  const flowDir = path.join(workspaceRoot, ".workspace", "agentflow", "pipelines", flowId);
  fs.mkdirSync(flowDir, { recursive: true });
  fs.writeFileSync(path.join(flowDir, "workspace.flow.js"), source, "utf-8");

  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?share-url=${Date.now()}`),
      import(`../bin/lib/ui-server.mjs?share-url=${Date.now()}`),
    ]);
    const user = loginOrCreateUser("runner", "runner-password");
    assert.equal(user.ok, true);
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const request = (pathname, init = {}) => fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${user.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
    await body({ request, baseUrl, flowDir });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test("没有审批节点时，分享链接指向展示页，审核页地址自己跳回去", async () => {
  await withServer("report-flow", REPORT_FLOW, async ({ request, baseUrl }) => {
    const graphRes = await request("/api/workspace/graph?flowId=report-flow&flowSource=workspace");
    const { graph } = await graphRes.json();
    assert.equal(graphRes.status, 200);

    const runRes = await request("/api/workspace/run", {
      method: "POST",
      body: JSON.stringify({ flowId: "report-flow", flowSource: "workspace", runNodeId: "run", graph }),
    });
    const runJson = await runRes.json();
    assert.equal(runRes.status, 200, JSON.stringify(runJson).slice(0, 400));

    const slots = runJson.graph?.instances?.link?.output || [];
    const slot = (name) => String(slots.find((item) => item?.name === name)?.value || "");
    const shareId = slot("shareId");
    const reviewToken = slot("reviewToken");
    assert.ok(shareId, "分享节点要产出 shareId");
    assert.ok(
      slot("url").endsWith(`/display/${shareId}`),
      `url 应当是展示页地址，实际是 ${slot("url")}`,
    );
    assert.ok(slot("reviewUrl").includes(`/review/plan?token=${encodeURIComponent(reviewToken)}`));

    // 历史上已经发出去的审核页地址：不再是死胡同，跳回展示页
    const orphan = await fetch(`${baseUrl}/review/plan?token=${encodeURIComponent(reviewToken)}`, {
      redirect: "manual",
    });
    assert.equal(orphan.status, 302);
    assert.equal(orphan.headers.get("location"), `/display/${encodeURIComponent(shareId)}`);
  });
});

test("有审批节点消费 token 时，分享链接就是审核入口", async () => {
  await withServer("approval-flow", APPROVAL_FLOW, async ({ request }) => {
    const graphRes = await request("/api/workspace/graph?flowId=approval-flow&flowSource=workspace");
    const { graph } = await graphRes.json();
    assert.equal(graphRes.status, 200);

    const runRes = await request("/api/workspace/run", {
      method: "POST",
      body: JSON.stringify({ flowId: "approval-flow", flowSource: "workspace", runNodeId: "run", graph }),
    });
    const runJson = await runRes.json();
    assert.equal(runRes.status, 200, JSON.stringify(runJson).slice(0, 400));

    const slots = runJson.graph?.instances?.link?.output || [];
    const slot = (name) => String(slots.find((item) => item?.name === name)?.value || "");
    assert.ok(
      slot("url").includes(`/review/plan?token=${encodeURIComponent(slot("reviewToken"))}`),
      `url 应当是审核入口，实际是 ${slot("url")}`,
    );
  });
});
