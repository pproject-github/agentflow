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

test("release project config preserves TAPD synchronization settings", async () => {
  const { readReleaseDeploymentConfig } = await import(`../shared/release-deployment-config.js?tapd-config=${Date.now()}`);
  const config = readReleaseDeploymentConfig({ AGENTFLOW_RELEASE_PROJECTS_JSON: JSON.stringify({
    projects: [{ id: "likee-android", businessLine: "likee", platform: "android", workspaceRoot: "/srv/releases/likee-android", tapd: { workspaceId: "33202860", categoryName: "版本", iterationName: "Likee Android", apiBaseUrl: "https://api.tapd.cn", accessTokenEnv: "TAPD_ACCESS_TOKEN", accessToken: "do-not-persist" } }],
  }) });
  assert.deepEqual(config.projects[0].tapd, { workspaceId: "33202860", categoryName: "版本", iterationName: "Likee Android", apiBaseUrl: "https://api.tapd.cn", accessTokenEnv: "TAPD_ACCESS_TOKEN" });
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

test("reads release-projects.json from the default data-root file when env is unset", async () => {
  const { readReleaseDeploymentConfig, resolveReleaseProjectsFilePath, writeReleaseProjectsDocument } = await import("../shared/release-deployment-config.js?config-default-file");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-projects-default-"));
  const filePath = resolveReleaseProjectsFilePath(root);
  writeReleaseProjectsDocument(filePath, {
    projects: [{
      id: "likee-ios-prod",
      businessLine: "likee",
      platform: "ios",
      workspaceRoot: "/data1/services/mengmai/workspace/repos/likee_ios",
      skillRoots: ["/data1/services/mengmai/agentflow/workspaces/repos/ws_skills"],
    }],
    operators: { likee: { ios: ["yangcaimu"], android: [] } },
  });
  const config = readReleaseDeploymentConfig({ NODE_ENV: "production" }, { defaultFilePath: filePath });
  assert.equal(config.projectsSource, "data-root-file");
  assert.equal(config.projects[0]?.id, "likee-ios-prod");
  assert.equal(config.projects[0]?.workspaceRoot, path.resolve("/data1/services/mengmai/workspace/repos/likee_ios"));
  assert.deepEqual(config.operators.likee.ios, ["yangcaimu"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing default release-projects file is not a config error", async () => {
  const { readReleaseDeploymentConfig } = await import("../shared/release-deployment-config.js?config-missing-default");
  const missing = path.join(os.tmpdir(), `release-projects-missing-${Date.now()}.json`);
  const config = readReleaseDeploymentConfig({ NODE_ENV: "production" }, { defaultFilePath: missing });
  assert.equal(config.configError, "");
  assert.equal(config.projectsSource, "none");
  assert.deepEqual(config.projects, []);
});

test("release operators parse membership and authorize writes per business line and platform", async () => {
  const {
    readReleaseDeploymentConfig,
    resolveReleaseOperatorMembership,
    canWriteRelease,
    validateReleaseOperators,
    buildReleaseAccessPayload,
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
  const allowed = buildReleaseAccessPayload("duanfengyuan", {}, config);
  assert.equal(allowed.operable, true);
  assert.equal(allowed.message, "");
  assert.deepEqual(allowed.membership, { businessLine: "likee", platform: "android" });
  const denied = buildReleaseAccessPayload("nobody", {}, config);
  assert.equal(denied.operable, false);
  assert.equal(denied.message, "无法操作");
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
