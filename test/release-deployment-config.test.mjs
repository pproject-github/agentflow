import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("release deployment config resolves a business/platform project and independent skills", async () => {
  const { readReleaseDeploymentConfig, resolveReleaseWorkspace, releaseSkillRoots } = await import("../shared/release-deployment-config.js?config-contract");
  const config = readReleaseDeploymentConfig({
    NODE_ENV: "production",
    AGENTFLOW_RELEASE_PROJECTS_JSON: JSON.stringify({
      projects: [{ id: "likee-android-prod", businessLine: "likee", platform: "android", workspaceRoot: "/srv/releases/likee-android", skillRoots: ["/opt/release-skills"] }],
    }),
  });
  const resolved = resolveReleaseWorkspace(config, { businessLine: "likee", platform: "android" }, "likee-android-prod");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.workspaceRoot, path.resolve("/srv/releases/likee-android"));
  assert.deepEqual(releaseSkillRoots(config, resolved.project, resolved.workspaceRoot), [path.resolve("/opt/release-skills")]);
});

test("release deployment config rejects arbitrary paths and malformed production config", async () => {
  const { readReleaseDeploymentConfig, resolveReleaseWorkspace } = await import("../shared/release-deployment-config.js?config-security");
  const config = readReleaseDeploymentConfig({ NODE_ENV: "production", AGENTFLOW_RELEASE_PROJECTS_JSON: "not-json" });
  assert.match(config.configError, /invalid JSON/);
  const rejected = resolveReleaseWorkspace(config, { businessLine: "likee", platform: "android" }, "", "/tmp/other-project", "/srv/agentflow");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 403);
  assert.equal(rejected.code, "RELEASE_WORKSPACE_PATH_FORBIDDEN");
});

test("test mode requires explicit release-skills roots instead of workspace fallback", async () => {
  const { readReleaseDeploymentConfig, resolveReleaseWorkspace, releaseSkillRoots, assertReleaseSkillRootsConfigured } = await import("../shared/release-deployment-config.js?config-test-mode");
  const config = readReleaseDeploymentConfig({ AGENTFLOW_RELEASE_TEST_MODE: "1" });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "release-config-")));
  const resolved = resolveReleaseWorkspace(config, { businessLine: "likee", platform: "android" }, "release-test", "", root);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.workspaceRoot, root);
  assert.deepEqual(releaseSkillRoots(config, null, root), []);
  const missing = assertReleaseSkillRootsConfigured(config, null, root);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "RELEASE_SKILLS_NOT_CONFIGURED");
  fs.rmSync(root, { recursive: true, force: true });
});

test("release workspace remaps unknown workspaceId to the sole configured project", async () => {
  const { readReleaseDeploymentConfig, resolveReleaseWorkspace } = await import("../shared/release-deployment-config.js?config-remap");
  const config = readReleaseDeploymentConfig({
    AGENTFLOW_DEV: "1",
    AGENTFLOW_RELEASE_TEST_MODE: "1",
  });
  const resolved = resolveReleaseWorkspace(config, { businessLine: "likee", platform: "android" }, "ws_knowledge_base_release_skills");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.workspaceId, "likee-android-local");
  assert.equal(resolved.remappedFromWorkspaceId, "ws_knowledge_base_release_skills");
  const rejected = resolveReleaseWorkspace(config, { businessLine: "likee", platform: "android" }, "release-api-temp");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "RELEASE_WORKSPACE_NOT_ALLOWED");
});

test("dev release config maps likee android to the local migration project", async () => {
  const { readReleaseDeploymentConfig, resolveReleaseWorkspace } = await import("../shared/release-deployment-config.js?config-dev-default");
  const workspaceRoot = "/Users/duanfengyuan/migration-workspace/test/likee_android";
  const config = readReleaseDeploymentConfig({ AGENTFLOW_DEV: "1", AGENTFLOW_RELEASE_TEST_MODE: "1" });
  const project = config.projects.find((entry) => entry.businessLine === "likee" && entry.platform === "android");
  assert.ok(project, "开发模式应提供 likee/android 发版工程");
  assert.equal(project.workspaceRoot, path.resolve(workspaceRoot));
  const resolved = resolveReleaseWorkspace(config, { businessLine: "likee", platform: "android" }, project.id, workspaceRoot, "/Users/duanfengyuan/PycharmProjects/agentflow");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.workspaceRoot, path.resolve(workspaceRoot));
});

test("release operators parse membership and authorize writes per business line and platform", async () => {
  const {
    readReleaseDeploymentConfig,
    resolveReleaseOperatorMembership,
    canWriteRelease,
    validateReleaseOperators,
  } = await import("../shared/release-deployment-config.js?operators-acl");
  const config = readReleaseDeploymentConfig({
    NODE_ENV: "production",
    AGENTFLOW_RELEASE_PROJECTS_JSON: JSON.stringify({
      projects: [{ id: "likee-android-prod", businessLine: "likee", platform: "android", workspaceRoot: "/srv/releases/likee-android" }],
      operators: {
        likee: {
          android: ["DuanFengYuan", "suruijia", "wangfang"],
          ios: ["liangjiajian", "yangcaimu"],
        },
        bigolive: { android: [], ios: [] },
        hello: { android: [], ios: [] },
      },
    }),
  });
  assert.deepEqual(config.operators.likee.android, ["duanfengyuan", "suruijia", "wangfang"]);
  assert.deepEqual(resolveReleaseOperatorMembership("DuanFengYuan", config), { businessLine: "likee", platform: "android" });
  assert.equal(resolveReleaseOperatorMembership("nobody", config), null);
  assert.equal(canWriteRelease("duanfengyuan", { businessLine: "likee", platform: "android" }, config), true);
  assert.equal(canWriteRelease("duanfengyuan", { businessLine: "likee", platform: "ios" }, config), false);
  assert.equal(canWriteRelease("guest", { businessLine: "likee", platform: "android" }, config), false);
  assert.equal(validateReleaseOperators(config.operators).valid, true);
});

test("release operators reject duplicate membership across platforms", async () => {
  const { validateReleaseOperators } = await import("../shared/release-deployment-config.js?operators-dup");
  const result = validateReleaseOperators({
    likee: {
      android: ["shared-user"],
      ios: ["shared-user"],
    },
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /shared-user/i);
});
