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
    const initialApproval = nodes.find((node) => node.action === "create-initial-release-approval");
    const fullApproval = nodes.find((node) => node.action === "create-full-rollout-approval");
    assert.notEqual(initialApproval.description, fullApproval.description);
    assert.match(initialApproval.description, /首包/);
    assert.match(fullApproval.description, /全量/);
    const supplemental = await discoverReleaseActions({ roots: [root], businessLine: "likee", platform: "ios", batch: "supplemental" });
    assert.deepEqual(supplemental.map((node) => node.id), ["release-approval:create-full-rollout-approval"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dynamic catalog applies Android supplemental gray_percent schema override", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-records-gray-schema-"));
  try {
    const records = path.join(root, "release-records");
    fs.mkdirSync(path.join(records, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(records, "SKILL.md"), `---\nname: release-records\nactions:\n  - name: append-release-wiki-row\n    inputs: [gray_percent]\n    platforms: [android, ios]\n---\n`);
    fs.writeFileSync(path.join(records, "scripts", "run.py"), "print('ok')\n");
    const { discoverReleaseActions } = await import(`../bin/lib/release-runtime.mjs?gray-schema=${Date.now()}`);
    const android = await discoverReleaseActions({ roots: [root], businessLine: "likee", platform: "android", version: "5.63.2", batch: "supplemental" });
    const ios = await discoverReleaseActions({ roots: [root], businessLine: "likee", platform: "ios", version: "5.63.2", batch: "supplemental" });
    const androidInput = android.find((node) => node.id === "release-records:append-release-wiki-row").inputSchema[0];
    const iosInput = ios.find((node) => node.id === "release-records:append-release-wiki-row").inputSchema[0];
    assert.equal(androidInput.type, "number");
    assert.equal(androidInput.required, true);
    assert.equal(androidInput.min, 1);
    assert.equal(androidInput.max, 100);
    assert.equal(androidInput.integer, true);
    assert.equal(iosInput.type, "text");
    assert.equal(iosInput.required, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not infer configure-target after release initialization", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-setup-catalog-"));
  try {
    const setup = path.join(root, "release-setup");
    fs.mkdirSync(path.join(setup, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(setup, "SKILL.md"), "---\nname: release-setup\ndescription: Setup\n---\n");
    fs.writeFileSync(path.join(setup, "scripts", "run.py"), "print('ok')\n");

    const { discoverReleaseActions } = await import(`../bin/lib/release-runtime.mjs?setup-no-target=${Date.now()}`);
    const nodes = await discoverReleaseActions({ roots: [root], businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" });
    assert.equal(nodes.some((node) => node.id === "release-setup:configure-target"), false);
    assert.deepEqual(nodes.map((node) => node.id), [
      "release-setup:configure-notification-recipient",
      "release-setup:discover-skills",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not expose guide-current-release after release initialization", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-management-catalog-"));
  try {
    const management = path.join(root, "release-management");
    fs.mkdirSync(path.join(management, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(management, "SKILL.md"), `---\nname: release-management\ndescription: Management\nactions:\n  - name: guide-current-release\n    platforms: [android]\n  - name: register-release-branch\n    platforms: [android]\n---\n`);
    fs.writeFileSync(path.join(management, "scripts", "run.py"), "print('ok')\n");

    const { discoverReleaseActions } = await import(`../bin/lib/release-runtime.mjs?no-guide=${Date.now()}`);
    const nodes = await discoverReleaseActions({ roots: [root], businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" });
    assert.equal(nodes.some((node) => node.id === "release-management:guide-current-release"), false);
    assert.equal(nodes.some((node) => node.id === "release-management:register-release-branch"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not expose create-active-release after release initialization", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-management-active-catalog-"));
  try {
    const management = path.join(root, "release-management");
    fs.mkdirSync(path.join(management, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(management, "SKILL.md"), `---\nname: release-management\ndescription: Management\nactions:\n  - name: create-active-release\n    platforms: [android]\n  - name: register-release-branch\n    platforms: [android]\n---\n`);
    fs.writeFileSync(path.join(management, "scripts", "run.py"), "print('ok')\n");

    const { discoverReleaseActions } = await import(`../bin/lib/release-runtime.mjs?no-active-release=${Date.now()}`);
    const nodes = await discoverReleaseActions({ roots: [root], businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" });
    assert.equal(nodes.some((node) => node.id === "release-management:create-active-release"), false);
    assert.equal(nodes.some((node) => node.id === "release-management:register-release-branch"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps create-active-release hidden while exposing it through initialization preparation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-management-initialization-catalog-"));
  try {
    const management = path.join(root, "release-management");
    fs.mkdirSync(path.join(management, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(management, "SKILL.md"), "---\nname: release-management\ndescription: Management\n---\n");
    fs.writeFileSync(path.join(management, "scripts", "run.py"), "print('ok')\n");

    const { discoverReleaseActions, discoverReleaseInitializationAction } = await import(`../bin/lib/release-runtime.mjs?initialization=${Date.now()}`);
    const context = { businessLine: "likee", platform: "android", version: "1.1.0", batch: "initial" };
    const regular = await discoverReleaseActions({ roots: [root], ...context });
    assert.equal(regular.some((node) => node.id === "release-management:create-active-release"), false);
    const initialization = await discoverReleaseInitializationAction(context, [root]);
    assert.equal(initialization.id, "release-initialization:prepare-context");
    assert.equal(initialization.action, "create-active-release");
    assert.equal(initialization.requiresConfirmation, true);
    assert.equal(initialization.inputSchema.some((input) => input.key === "publish_date"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exposes an editable release branch name for create-release-branch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-git-branch-input-"));
  try {
    const git = path.join(root, "release-git");
    fs.mkdirSync(path.join(git, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(git, "SKILL.md"), `---\nname: release-git\ndescription: Git\nactions:\n  - name: create-release-branch\n    inputs: []\n    platforms: [android]\n    requires_confirmation: true\n---\n`);
    fs.writeFileSync(path.join(git, "scripts", "run.py"), "print('ok')\n");

    const { discoverReleaseActions } = await import(`../bin/lib/release-runtime.mjs?branch-input=${Date.now()}`);
    const [node] = await discoverReleaseActions({ roots: [root], businessLine: "likee", platform: "android", version: "1.1.0" });
    assert.deepEqual(node.inputSchema, [{
      key: "release_branch",
      label: "Release 分支名",
      type: "text",
      required: false,
      placeholder: "release/v1.1",
      defaultValue: "release/v1.1",
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("provides a project-relative default source path for localization uploads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-localization-source-input-"));
  try {
    const localization = path.join(root, "release-localization");
    fs.mkdirSync(path.join(localization, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(localization, "SKILL.md"), `---\nname: release-localization\ndescription: Localization\nactions:\n  - name: upload-source-file\n    inputs: [source_path]\n    platforms: [android, ios]\n---\n`);
    fs.writeFileSync(path.join(localization, "scripts", "run.py"), "print('ok')\n");

    const { discoverReleaseActions } = await import(`../bin/lib/release-runtime.mjs?localization-source-input=${Date.now()}`);
    const android = await discoverReleaseActions({ roots: [root], businessLine: "likee", platform: "android", version: "1.2.0" });
    const ios = await discoverReleaseActions({ roots: [root], businessLine: "likee", platform: "ios", version: "1.2.0" });
    assert.equal(android.find((node) => node.id === "release-localization:upload-source-file").inputSchema[0].defaultValue, "iHeima/res/values/strings.xml");
    assert.equal(ios.find((node) => node.id === "release-localization:upload-source-file").inputSchema[0].defaultValue, "yymeet/Resources/MultiLanguage/en.lproj/Localizable.strings");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("configured Likee iOS release notes action has an executable entrypoint", async () => {
  const skillsRoot = "/Users/duanfengyuan/migration-workspace/test/likee_android/.workspace/release-skills";
  const { discoverReleaseActions } = await import(`../bin/lib/release-runtime.mjs?release-notes-entrypoint=${Date.now()}`);
  const nodes = await discoverReleaseActions({
    roots: [skillsRoot],
    businessLine: "likee",
    platform: "ios",
    version: "1.2.0",
    batch: "initial",
  });
  const node = nodes.find((item) => item.id === "release-release-notes:upload-ios-release-notes");
  assert.ok(node);
  assert.equal(node.runnable, true, node.error);
});

test("prefers explicit process metadata supplied by a future workflow profile", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-process-metadata-"));
  try {
    const skill = path.join(root, "release-demo");
    fs.mkdirSync(path.join(skill, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), `---\nname: release-demo\ndescription: Demo\nactions:\n  - name: notify\n    platforms: [android]\n    process_id: localization-upload\n    process_order: 20\n    process_title: 多语言上传\n---\n`);
    fs.writeFileSync(path.join(skill, "scripts", "run.py"), "print('ok')\n");
    const { discoverReleaseActions } = await import(`../bin/lib/release-runtime.mjs?explicit-process=${Date.now()}`);
    const [node] = await discoverReleaseActions({ roots: [root], businessLine: "likee", platform: "android" });
    assert.equal(node.processId, "localization-upload");
    assert.equal(node.processOrder, 20);
    assert.equal(node.processTitle, "多语言上传");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discovers only actions referenced by the selected project profile", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-profile-catalog-"));
  try {
    const profileDir = path.join(root, "skills", "release-setup", "profiles", "likee");
    const actionDir = path.join(root, "skills", "release-approval", "scripts");
    const gitDir = path.join(root, "skills", "release-git", "scripts");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(actionDir, { recursive: true });
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, "android.yaml"), "profile_id: likee-android\nproduct_id: likee\nplatform: android\nprofile_refs:\n  approval: release-approval/likee-android\n");
    fs.writeFileSync(path.join(profileDir, "ios.yaml"), "profile_id: likee-ios\nproduct_id: likee\nplatform: ios\nprofile_refs:\n  git: release-git/likee-ios\n");
    fs.writeFileSync(path.join(root, "skills", "release-approval", "SKILL.md"), "---\nname: release-approval\ndescription: Approval\nactions:\n  - name: create-full-rollout-approval\n    platforms: [android, ios]\n---\n");
    fs.writeFileSync(path.join(root, "skills", "release-git", "SKILL.md"), "---\nname: release-git\ndescription: Git\nactions:\n  - name: branch\n    platforms: [android, ios]\n---\n");
    fs.writeFileSync(path.join(actionDir, "run.py"), "print('approval')\n");
    fs.writeFileSync(path.join(gitDir, "run.py"), "print('git')\n");

    const { discoverReleaseActions } = await import(`../bin/lib/release-runtime.mjs?profile=${Date.now()}`);
    const nodes = await discoverReleaseActions({ roots: [root], businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" });
    assert.deepEqual(nodes.map((node) => node.id), ["release-approval:create-full-rollout-approval"]);
    assert.deepEqual(nodes[0].businessLines, ["likee"]);
    assert.equal(nodes[0].contextSnapshot.version, "5.63.2");
    assert.equal(nodes[0].processId, "approval-full");
    assert.equal(nodes[0].processOrder, 20);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("static release fallback only exposes configured action-level process metadata", async () => {
  const { getReleaseNodes } = await import(`../builtin/web-ui/src/lib/releaseNodeCatalog.js?process-metadata=${Date.now()}`);
  const nodes = getReleaseNodes({ businessLine: "likee", platform: "android" });
  const setup = nodes.find((node) => node.id === "release-setup:configure-notification-recipient");
  const approval = nodes.find((node) => node.id === "release-approval:create-initial-release-approval");
  assert.equal(setup.processId, "preparation-initial");
  assert.equal(approval.processId, "approval-initial");
  assert.equal(nodes.some((node) => ["release-setup", "release-git", "release-approval"].includes(node.id)), false);
});

test("static fallback catalog contains configured action-level nodes for workflow parity", async () => {
  const { getReleaseNodes } = await import(`../builtin/web-ui/src/lib/releaseNodeCatalog.js?fallback-parity=${Date.now()}`);
  const { createReleaseProcessStateMachine } = await import(`../builtin/web-ui/src/lib/releaseWorkflowStateMachine.js?fallback-parity=${Date.now()}`);
  const context = { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" };
  const nodes = getReleaseNodes(context);
  assert.ok(nodes.some((node) => node.id === "release-git:create-release-branch"));
  assert.ok(nodes.some((node) => node.id === "release-management:register-release-branch"));
  assert.equal(
    nodes.find((node) => node.id === "release-localization:upload-source-file")?.inputSchema?.[0]?.defaultValue,
    "iHeima/res/values/strings.xml",
  );
  const machine = createReleaseProcessStateMachine({ context, nodes });
  assert.ok(machine.processes.length > 0);
  assert.ok(machine.nodes.some((node) => node.id === "release-git:create-release-branch"));
});

test("static fallback localization catalog keeps the complete iOS source file set", async () => {
  const { getReleaseNodes } = await import(`../builtin/web-ui/src/lib/releaseNodeCatalog.js?fallback-localization-files=${Date.now()}`);
  const iosNodes = getReleaseNodes({ businessLine: "likee", platform: "ios", version: "5.63.2", batch: "initial" });
  // 静态目录现只暴露 Agent 能力；源文件集合由 Skill 自行发现，不再嵌在 catalog。
  assert.ok(iosNodes.some((node) => node.compositeId === "localization-upload-notify" || node.id === "composite:localization-upload-notify"));
  assert.equal(iosNodes.some((node) => /rollout/.test(node.compositeId || node.id) && !/full-rollout/.test(node.compositeId || node.id)), false);
  assert.ok(iosNodes.every((node) => node.workflowId === "likee-ios-release"));
});

test("static fallback honors approval batch scopes and Android gray input differences", async () => {
  const { getReleaseNodes } = await import(`../builtin/web-ui/src/lib/releaseNodeCatalog.js?approval-batches=${Date.now()}`);
  const initialAndroid = new Map(getReleaseNodes({ businessLine: "likee", platform: "android", batch: "initial" }).map((node) => [node.compositeId || node.id, node]));
  const supplementalAndroid = new Map(getReleaseNodes({ businessLine: "likee", platform: "android", batch: "supplemental" }).map((node) => [node.compositeId || node.id, node]));
  const initialIos = new Map(getReleaseNodes({ businessLine: "likee", platform: "ios", batch: "initial" }).map((node) => [node.compositeId || node.id, node]));
  const supplementalIos = new Map(getReleaseNodes({ businessLine: "likee", platform: "ios", batch: "supplemental" }).map((node) => [node.compositeId || node.id, node]));
  assert.equal(initialAndroid.has("submit-approval"), true);
  assert.equal(initialAndroid.has("submit-full-rollout-approval"), true);
  assert.equal(initialAndroid.has("rollout"), true);
  assert.equal(supplementalAndroid.has("submit-approval"), false);
  assert.equal(supplementalAndroid.has("submit-full-rollout-approval"), true);
  assert.equal(supplementalAndroid.has("rollout"), true);
  assert.equal(initialIos.has("submit-approval"), true);
  assert.equal(initialIos.has("submit-full-rollout-approval"), true);
  assert.equal(initialIos.has("rollout"), false);
  assert.equal(supplementalIos.has("submit-approval"), false);
  assert.equal(supplementalIos.has("submit-full-rollout-approval"), true);
  assert.equal(supplementalIos.has("rollout"), false);
});

test("static fallback catalog is empty when no workflow matches the requested scope", async () => {
  const { getReleaseNodes } = await import(`../builtin/web-ui/src/lib/releaseNodeCatalog.js?fallback-empty=${Date.now()}`);
  assert.deepEqual(getReleaseNodes({ businessLine: "bigolive", platform: "android", batch: "initial" }), []);
  assert.deepEqual(getReleaseNodes({ businessLine: "likee", platform: "web", batch: "initial" }), []);
  assert.deepEqual(getReleaseNodes({ businessLine: "likee", platform: "android", batch: "unknown" }), []);
});

test("applies the selected profile to extension skill roots as well", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-profile-extension-"));
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-profile-extension-extra-"));
  try {
    const profileDir = path.join(root, "skills", "release-setup", "profiles", "likee");
    const approvalDir = path.join(root, "skills", "release-approval", "scripts");
    const extensionSkillDir = path.join(extensionRoot, "release-google-play", "scripts");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(approvalDir, { recursive: true });
    fs.mkdirSync(extensionSkillDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, "android.yaml"), "profile_id: likee-android\nproduct_id: likee\nplatform: android\nprofile_refs:\n  approval: release-approval/likee-android\n");
    fs.writeFileSync(path.join(root, "skills", "release-approval", "SKILL.md"), "---\nname: release-approval\nactions:\n  - name: approve\n    platforms: [android]\n---\n");
    fs.writeFileSync(path.join(approvalDir, "run.py"), "print('approval')\n");
    fs.writeFileSync(path.join(extensionRoot, "release-google-play", "SKILL.md"), "---\nname: release-google-play\nactions:\n  - name: submit\n    platforms: [android]\n---\n");
    fs.writeFileSync(path.join(extensionSkillDir, "run.py"), "print('google')\n");

    const { discoverReleaseActions } = await import(`../bin/lib/release-runtime.mjs?profile-extension=${Date.now()}`);
    const nodes = await discoverReleaseActions({
      roots: [root, extensionRoot],
      businessLine: "likee",
      platform: "android",
      version: "5.63.2",
      batch: "initial",
    });
    assert.deepEqual(nodes.map((node) => node.id), ["release-approval:approve"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
});

test("filters discovered actions to the selected workflow and keeps frontend parity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-workflow-allowlist-"));
  try {
    const configuredDir = path.join(root, "release-git", "scripts");
    const extraDir = path.join(root, "release-demo", "scripts");
    fs.mkdirSync(configuredDir, { recursive: true });
    fs.mkdirSync(extraDir, { recursive: true });
    fs.writeFileSync(path.join(root, "release-git", "SKILL.md"), "---\nname: release-git\nactions:\n  - name: create-release-branch\n    platforms: [android]\n---\n");
    fs.writeFileSync(path.join(root, "release-demo", "SKILL.md"), "---\nname: release-demo\nactions:\n  - name: extra\n    platforms: [android]\n---\n");
    fs.writeFileSync(path.join(configuredDir, "run.py"), "print('configured')\n");
    fs.writeFileSync(path.join(extraDir, "run.py"), "print('extra')\n");

    const { discoverReleaseActions, filterReleaseActionsForWorkflow } = await import(`../bin/lib/release-runtime.mjs?workflow-allowlist=${Date.now()}`);
    const context = { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" };
    const discovered = await discoverReleaseActions({ roots: [root], ...context });
    assert.deepEqual(discovered.map((node) => node.id), ["release-git:create-release-branch", "release-demo:extra"]);
    const filtered = filterReleaseActionsForWorkflow(discovered, context);
    assert.deepEqual(filtered.map((node) => node.id), ["release-git:create-release-branch"]);

    const { createReleaseProcessStateMachine, selectWorkflowProcessNodes } = await import(`../builtin/web-ui/src/lib/releaseWorkflowStateMachine.js?workflow-allowlist=${Date.now()}`);
    const machine = createReleaseProcessStateMachine({ nodes: discovered, context });
    assert.deepEqual(selectWorkflowProcessNodes({ machine, nodes: filtered }).map((node) => node.id), filtered.map((node) => node.id));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("uses generic process metadata when no workflow matches the business line", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-workflow-no-match-"));
  try {
    const approval = path.join(root, "release-approval");
    fs.mkdirSync(path.join(approval, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(approval, "SKILL.md"), "---\nname: release-approval\nactions:\n  - name: create-full-rollout-approval\n    platforms: [android]\n---\n");
    fs.writeFileSync(path.join(approval, "scripts", "run.py"), "print('ok')\n");
    const { discoverReleaseActions } = await import(`../bin/lib/release-runtime.mjs?workflow-no-match=${Date.now()}`);
    const [node] = await discoverReleaseActions({ roots: [root], businessLine: "bigolive", platform: "android", version: "5.63.2", batch: "initial" });
    assert.equal(node.processId, "approval");
    assert.equal(node.processTitle, "发版审核");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("materializes configured composite nodes with ordered atomic action metadata", async () => {
  const { discoverReleaseCompositeActions } = await import(`../bin/lib/release-runtime.mjs?composite-catalog=${Date.now()}`);
  const atomicNodes = [
    { id: "release-localization:upload-source-file", title: "Upload", inputSchema: [{ key: "source_path", type: "text" }], runnable: true, source: { scriptPath: "/tmp/upload.py" } },
    { id: "release-notification:send-notification", title: "Notify", inputSchema: [{ key: "event", type: "text" }], runnable: true, source: { scriptPath: "/tmp/notify.py" } },
  ];
  const composites = discoverReleaseCompositeActions({ businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" }, atomicNodes);
  const upload = composites.find((node) => node.id === "composite:localization-upload-notify");
  assert.ok(upload);
  assert.equal(upload.kind, "composite");
  assert.equal(upload.compositeId, "localization-upload-notify");
  assert.deepEqual(upload.actions.map((step) => step.id), [
    "release-localization:upload-source-file",
    "release-notification:send-notification",
  ]);
  assert.deepEqual(upload.inputSchema.map((input) => input.key), ["source_path", "event"]);
  assert.equal(upload.scopeKey, "likee/android/5.63.2/initial");
});

test("omits a composite from catalog when an internal Action is missing", async () => {
  const { discoverReleaseCompositeActions } = await import(`../bin/lib/release-runtime.mjs?composite-missing=${Date.now()}`);
  const composites = discoverReleaseCompositeActions({ businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" }, [
    { id: "release-localization:upload-source-file", title: "Upload", inputSchema: [], runnable: true, source: { scriptPath: "/tmp/upload.py" } },
  ]);
  assert.equal(composites.some((node) => node.id === "composite:localization-upload-notify"), false);
});
