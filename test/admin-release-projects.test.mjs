import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("admin release-projects helper writes under AGENTFLOW_HOME and reloads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "admin-release-projects-"));
  const previousHome = process.env.AGENTFLOW_HOME;
  const previousJson = process.env.AGENTFLOW_RELEASE_PROJECTS_JSON;
  const previousFile = process.env.AGENTFLOW_RELEASE_PROJECTS_FILE;
  const previousSeed = process.env.AGENTFLOW_RELEASE_SEED_PROJECTS;
  process.env.AGENTFLOW_HOME = root;
  process.env.AGENTFLOW_RELEASE_SEED_PROJECTS = "0";
  delete process.env.AGENTFLOW_RELEASE_PROJECTS_JSON;
  delete process.env.AGENTFLOW_RELEASE_PROJECTS_FILE;
  try {
    const {
      getReleaseProjectsConfigPath,
      readAdminReleaseProjectsConfig,
      writeAdminReleaseProjectsConfig,
      readReleaseDeploymentConfigWithDataRoot,
      ensureReleaseProjectsFileSeeded,
    } = await import(`../bin/lib/admin-release-projects.mjs?admin-release=${Date.now()}`);
    assert.equal(ensureReleaseProjectsFileSeeded(process.env).reason, "seed-disabled");
    const before = readAdminReleaseProjectsConfig();
    assert.equal(before.envLocked, false);
    assert.equal(before.exists, false);
    assert.equal(before.configPath, path.join(root, "release-projects.json"));
    const saved = writeAdminReleaseProjectsConfig({
      document: {
        projects: [{
          id: "likee-android-prod",
          businessLine: "likee",
          platform: "android",
          workspaceRoot: "/data1/services/mengmai/workspace/repos/likee_android",
          skillRoots: ["/data1/services/mengmai/agentflow/workspaces/repos/ws_skills"],
        }],
        operators: { likee: { android: ["duanfengyuan"], ios: ["yangcaimu"] } },
      },
    });
    assert.equal(saved.exists, true);
    assert.ok(fs.existsSync(getReleaseProjectsConfigPath()));
    const deployment = readReleaseDeploymentConfigWithDataRoot({ NODE_ENV: "production", AGENTFLOW_RELEASE_SEED_PROJECTS: "0" });
    assert.equal(deployment.projectsSource, "data-root-file");
    assert.equal(deployment.projects[0]?.id, "likee-android-prod");
    assert.equal(deployment.operators.likee.android.includes("duanfengyuan"), true);
  } finally {
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    if (previousJson === undefined) delete process.env.AGENTFLOW_RELEASE_PROJECTS_JSON;
    else process.env.AGENTFLOW_RELEASE_PROJECTS_JSON = previousJson;
    if (previousFile === undefined) delete process.env.AGENTFLOW_RELEASE_PROJECTS_FILE;
    else process.env.AGENTFLOW_RELEASE_PROJECTS_FILE = previousFile;
    if (previousSeed === undefined) delete process.env.AGENTFLOW_RELEASE_SEED_PROJECTS;
    else process.env.AGENTFLOW_RELEASE_SEED_PROJECTS = previousSeed;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seeds release-projects.json once under production when missing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "admin-release-seed-"));
  const previousHome = process.env.AGENTFLOW_HOME;
  const previousJson = process.env.AGENTFLOW_RELEASE_PROJECTS_JSON;
  const previousFile = process.env.AGENTFLOW_RELEASE_PROJECTS_FILE;
  const previousSeed = process.env.AGENTFLOW_RELEASE_SEED_PROJECTS;
  process.env.AGENTFLOW_HOME = root;
  delete process.env.AGENTFLOW_RELEASE_PROJECTS_JSON;
  delete process.env.AGENTFLOW_RELEASE_PROJECTS_FILE;
  delete process.env.AGENTFLOW_RELEASE_SEED_PROJECTS;
  try {
    const { ensureReleaseProjectsFileSeeded, getReleaseProjectsConfigPath } = await import(`../bin/lib/admin-release-projects.mjs?admin-seed=${Date.now()}`);
    const first = ensureReleaseProjectsFileSeeded({ NODE_ENV: "production" });
    assert.equal(first.created, true);
    assert.equal(first.reason, "seeded");
    assert.ok(fs.existsSync(getReleaseProjectsConfigPath()));
    const parsed = JSON.parse(fs.readFileSync(getReleaseProjectsConfigPath(), "utf8"));
    assert.equal(parsed.projects.some((item) => item.id === "likee-android-prod"), true);
    assert.equal(parsed.projects.some((item) => item.id === "likee-ios-prod"), true);
    const second = ensureReleaseProjectsFileSeeded({ NODE_ENV: "production" });
    assert.equal(second.created, false);
    assert.equal(second.reason, "exists");
  } finally {
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    if (previousJson === undefined) delete process.env.AGENTFLOW_RELEASE_PROJECTS_JSON;
    else process.env.AGENTFLOW_RELEASE_PROJECTS_JSON = previousJson;
    if (previousFile === undefined) delete process.env.AGENTFLOW_RELEASE_PROJECTS_FILE;
    else process.env.AGENTFLOW_RELEASE_PROJECTS_FILE = previousFile;
    if (previousSeed === undefined) delete process.env.AGENTFLOW_RELEASE_SEED_PROJECTS;
    else process.env.AGENTFLOW_RELEASE_SEED_PROJECTS = previousSeed;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
