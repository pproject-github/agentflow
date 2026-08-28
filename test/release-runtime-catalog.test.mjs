import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("discovers action-level release nodes and filters by platform and batch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-catalog-"));
  try {
    const approval = path.join(root, "release-approval");
    const google = path.join(root, "release-google-play");
    fs.mkdirSync(path.join(approval, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(google, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(approval, "SKILL.md"), `---\nname: release-approval\ndescription: 审核\nactions:\n  - name: create-initial-release-approval\n    inputs: [operator]\n    platforms: [ios, android]\n    requires_confirmation: true\n    release_context:\n      allowed_batches: [initial]\n  - name: create-full-rollout-approval\n    inputs: [operator]\n    platforms: [ios, android]\n    requires_confirmation: true\n    release_context:\n      allowed_batches: [initial, supplemental]\n---\n`);
    fs.writeFileSync(path.join(google, "SKILL.md"), `---\nname: release-google-play\ndescription: Google Play\nactions:\n  - name: preview-aab-submission\n    inputs: [config]\n    platforms: [android]\n    requires_confirmation: false\n  - name: submit-aab-internal-testing\n    inputs: [config]\n    platforms: [android]\n    requires_confirmation: true\n---\n`);
    for (const file of [
      path.join(approval, "scripts", "run.py"),
      path.join(google, "scripts", "run.py"),
    ]) fs.writeFileSync(file, "#!/usr/bin/env python3\n");

    const { discoverReleaseActions } = await import("../bin/lib/release-runtime.mjs");
    const nodes = await discoverReleaseActions({ roots: [root], businessLine: "likee", platform: "android", batch: "initial" });
    assert.deepEqual(nodes.map((node) => node.id), [
      "release-approval:create-full-rollout-approval",
      "release-approval:create-initial-release-approval",
      "release-google-play:preview-aab-submission",
      "release-google-play:submit-aab-internal-testing",
    ]);
    const submit = nodes.find((node) => node.action === "submit-aab-internal-testing");
    assert.equal(submit.requiresConfirmation, true);
    assert.equal(submit.inputSchema[0].key, "config");
    assert.equal(submit.source.scriptPath, path.join(google, "scripts", "run.py"));
    assert.deepEqual(submit.businessLines, ["likee", "bigolive", "hello"]);
    const supplemental = await discoverReleaseActions({ roots: [root], businessLine: "likee", platform: "ios", batch: "supplemental" });
    assert.deepEqual(supplemental.map((node) => node.id), ["release-approval:create-full-rollout-approval"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
