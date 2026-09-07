import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-release-registry-"));
process.env.AGENTFLOW_HOME = tempRoot;

const {
  createRelease,
  listReleases,
  PROJECTS,
  PLATFORMS,
} = await import("../bin/lib/release-registry.mjs");

test("release registry projects and platforms", () => {
  assert.deepEqual(PROJECTS, ["Likee", "Bigolive", "Hello"]);
  assert.deepEqual(PLATFORMS, ["iOS", "Android"]);
});

test("createRelease persists and filters by project/platform", () => {
  const created = createRelease({
    project: "Likee",
    platform: "Android",
    version: "5.64",
    releaseDate: "2026-09-04",
    ownerId: "u1",
  });
  assert.equal(created.error, undefined);
  assert.equal(created.release.id, "likee:android:5.64");
  const listed = listReleases({ project: "Likee", platform: "Android", userId: "u1" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].version, "5.64");
});

test("release versions are shared across authenticated identities", () => {
  const listed = listReleases({ project: "Likee", platform: "Android", userId: "another-user" });
  assert.equal(listed.some((item) => item.version === "5.64"), true);
});

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
