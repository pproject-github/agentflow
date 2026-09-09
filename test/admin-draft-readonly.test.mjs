/**
 * 管理员只读视图要看得见 draft 流程。
 *
 * 管理员那条分支是用 `listFlowsJson` 找目录的，而流程列表按设计滤掉了 draft /
 * preview 目录；owner 自己打开走的却是 `getPipelineFiles`。同一个目录，两条解析，
 * 于是 owner 打得开、管理员带上 adminOwnerId 反而 404「Pipeline workspace not found」
 * ——看着像没权限，其实是根本没找到。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-admin-draft-"));
process.env.AGENTFLOW_HOME = home;

const { resolveWorkspaceScopeRoot } = await import("../bin/lib/workspace-server.mjs");

const OWNER = "draft-owner";
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-admin-draft-ws-"));

function seedFlow(flowId, { draft = false } = {}) {
  const dir = path.join(home, "users", OWNER, "pipelines", flowId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "workspace.flow.js"),
    'import { display, flow } from "agentflow/flow";\nconst d = display.markdown("x", { content: "x" });\nexport const run = flow("Run", d);\n',
  );
  if (draft) {
    fs.writeFileSync(path.join(dir, ".agentflow-workspace-draft.json"), JSON.stringify({
      flowId,
      ownerId: OWNER,
      expiresAt: new Date(Date.now() + 3600e3).toISOString(),
    }));
  }
  return dir;
}

test("管理员只读视图打得开 draft 流程，和 owner 落到同一个目录", () => {
  const draftId = "draft_aaaaaaaaaaaaaaaaaaaa";
  const dir = seedFlow(draftId, { draft: true });

  const asOwner = resolveWorkspaceScopeRoot(workspaceRoot,
    { flowId: draftId, flowSource: "user" },
    { isAdmin: false, userId: OWNER });
  assert.equal(asOwner.error, undefined);
  assert.equal(fs.realpathSync(asOwner.root), fs.realpathSync(dir));

  const asAdmin = resolveWorkspaceScopeRoot(workspaceRoot,
    { flowId: draftId, flowSource: "user", adminOwnerId: OWNER },
    { isAdmin: true, userId: "admin-user" });
  assert.equal(asAdmin.error, undefined, `管理员不该被挡：${asAdmin.error || ""}`);
  assert.equal(fs.realpathSync(asAdmin.root), fs.realpathSync(dir));
  assert.equal(asAdmin.adminReadonly, true);
  assert.equal(asAdmin.collaborationAccess.writable, false);
  assert.equal(asAdmin.collaborationAccess.runnable, false);
});

test("非管理员带上 adminOwnerId 仍然被拒", () => {
  const flowId = "plain-flow";
  seedFlow(flowId);
  const denied = resolveWorkspaceScopeRoot(workspaceRoot,
    { flowId, flowSource: "user", adminOwnerId: OWNER },
    { isAdmin: false, userId: "someone-else" });
  assert.equal(denied.status, 403);
});

test("owner 不存在时照旧 404", () => {
  const missing = resolveWorkspaceScopeRoot(workspaceRoot,
    { flowId: "draft_bbbbbbbbbbbbbbbbbbbb", flowSource: "user", adminOwnerId: "nobody-here" },
    { isAdmin: true, userId: "admin-user" });
  assert.equal(missing.status, 404);
});
