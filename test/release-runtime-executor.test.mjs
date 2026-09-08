import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("fails the AgentFlow tool when a release skill reports preflight_failed", async () => {
  const { wrapperScript } = await import("../bin/lib/release-runtime-executor.mjs?preflight-exit");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-wrapper-preflight-"));
  const fakeRun = path.join(tempRoot, "run.py");
  fs.writeFileSync(fakeRun, "print('status: preflight_failed')\nprint('error: 本地化预检未通过')\n");
  const result = spawnSync("sh", ["-c", wrapperScript("release-localization", "upload-source-file", fakeRun, tempRoot)], {
    env: { ...process.env },
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /status: preflight_failed/);
});

test("extracts the actionable error from indented release skill output", async () => {
  const { releaseFailureFromResult } = await import("../bin/lib/release-runtime-executor.mjs?preflight-error");
  assert.equal(releaseFailureFromResult({ events: [{
    type: "script-finish",
    stdout: "status: preflight_failed\ndata:\n  error: 当前分支不符合发版分支规则\n",
  }] }), "当前分支不符合发版分支规则");
});

test("builds an AgentFlow tool graph for a release action without embedding raw input in code", async () => {
  const { buildReleaseRunGraph } = await import("../bin/lib/release-runtime-executor.mjs");
  const graph = buildReleaseRunGraph({
    id: "release-google-play:preview-aab-submission",
    skill: "release-google-play",
    action: "preview-aab-submission",
    source: { skillRoot: "/tmp/release-skills", scriptPath: "/tmp/release-skills/skills/release-google-play/scripts/run.py" },
  }, { businessLine: "likee", platform: "android", version: "5.63.2" }, { config: "a; rm -rf /" });
  const instance = graph.instances.release_action;
  assert.equal(instance.definitionId, "tool_nodejs");
  assert.match(instance.script, /uv run python/);
  assert.match(instance.script, /--action/);
  assert.match(instance.script, /cwd=/);
  assert.match(instance.script, /tmp\/release-skills/);
  assert.doesNotMatch(instance.script, /rm -rf/);
  assert.equal(graph.meta.releaseActionId, "release-google-play:preview-aab-submission");
});

test("requires a fresh confirmation fingerprint for external release actions", async () => {
  const { confirmationFingerprint, runReleaseAction, previewReleaseAction } = await import("../bin/lib/release-runtime-executor.mjs");
  const action = { id: "release-records:append-release-wiki-row", action: "append-release-wiki-row", requiresConfirmation: true, source: { scriptPath: "/tmp/run.py" } };
  const context = { businessLine: "likee", platform: "android", version: "5.63.2" };
  const inputs = { gray_percent: 10 };
  const preview = await previewReleaseAction(action, context, inputs);
  assert.equal(preview.confirmationFingerprint, confirmationFingerprint(action, context, inputs));
  await assert.rejects(
    () => runReleaseAction(action, context, { gray_percent: 20 }, { confirmationFingerprint: preview.confirmationFingerprint }),
    (error) => error.code === "RELEASE_CONFIRMATION_MISMATCH",
  );
});

test("routes release notifications to the debug bot only in local release test mode", async () => {
  const { buildReleaseRunGraph } = await import("../bin/lib/release-runtime-executor.mjs?notification-test-mode");
  const graph = buildReleaseRunGraph({
    id: "release-notification:send-notification",
    skill: "release-notification",
    action: "send-notification",
    source: { skillRoot: "/tmp/release-skills", scriptPath: "/tmp/release-skills/skills/release-notification/scripts/run.py" },
  });
  assert.match(graph.instances.release_action.script, /AGENTFLOW_RELEASE_TEST_MODE/);
  assert.match(graph.instances.release_action.script, /target.*debug/);
  assert.match(graph.instances.release_action.script, /bot.*debug/);
});

test("release execution inputs include immutable context aliases used by release skills", async () => {
  const { releaseExecutionInputs } = await import("../bin/lib/release-runtime-executor.mjs?context-inputs");
  const inputs = releaseExecutionInputs(
    { skill: "release-git", action: "create-release-branch" },
    { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" },
    { release_branch: "release/5.63" },
  );
  assert.deepEqual(inputs, {
    release_branch: "release/5.63",
    product: "likee",
    platform: "android",
    minor_version: "5.63.2",
    batch: "initial",
  });
});

test("release execution inputs carry version context to every release skill action", async () => {
  const { releaseExecutionInputs } = await import("../bin/lib/release-runtime-executor.mjs?all-release-context");
  const context = { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" };
  for (const skill of ["release-build", "release-google-play", "release-release-notes", "release-notification"]) {
    assert.deepEqual(releaseExecutionInputs({ skill, action: "run" }, context, {}), {
      product: "likee",
      platform: "android",
      minor_version: "5.63.2",
      batch: "initial",
    }, skill);
  }
});

test("composite release runs carry the same immutable version and batch aliases", async () => {
  const { releaseExecutionInputs } = await import("../bin/lib/release-runtime-executor.mjs?composite-context");
  assert.deepEqual(releaseExecutionInputs(
    { id: "composite:build-package", kind: "composite", skill: "release-composite" },
    { businessLine: "likee", platform: "android", version: "5.64.1", batch: "supplemental" },
    {},
  ), {
    product: "likee",
    platform: "android",
    minor_version: "5.64.1",
    batch: "supplemental",
  });
});

test("compiles composite release workflow into ordered AgentFlow tool nodes with mapped inputs", async () => {
  const { buildCompositeReleaseRunGraph } = await import("../bin/lib/release-runtime-executor.mjs?composite-graph");
  const composite = {
    id: "localization-upload-notify",
    title: "多语言上传 & 通知",
    actions: [
      { stepId: "upload", id: "release-localization:upload-source-file", inputs: { source_path: { context: "source_path" } }, continueOn: ["completed"] },
      { stepId: "notify", id: "release-notification:send-notification", inputs: { event: "localization-uploaded", source_record_id: { fromStep: "upload", output: "record_id" } }, waitFor: { step: "upload", statuses: ["completed"] } },
    ],
  };
  const nodes = [
    { id: "release-localization:upload-source-file", skill: "release-localization", action: "upload-source-file", title: "Upload", source: { skillRoot: "/tmp/release-skills", scriptPath: "/tmp/upload.py" } },
    { id: "release-notification:send-notification", skill: "release-notification", action: "send-notification", title: "Notify", source: { skillRoot: "/tmp/release-skills", scriptPath: "/tmp/notify.py" } },
  ];
  const graph = buildCompositeReleaseRunGraph(composite, nodes, { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" }, { source_path: "/tmp/source.yml" });
  assert.deepEqual(Object.keys(graph.instances), ["composite_upload", "composite_notify"]);
  assert.deepEqual(graph.meta.compositeActionIds, ["release-localization:upload-source-file", "release-notification:send-notification"]);
  assert.equal(graph.instances.composite_upload.definitionId, "tool_nodejs");
  assert.equal(graph.instances.composite_notify.input.find((slot) => slot.name === "event").value, "localization-uploaded");
  assert.equal(graph.edges.filter((edge) => edge.source === "composite_upload" && edge.target === "composite_notify").length, 2);
  // 边按槽位名标识，不按位置坐标。
  const mapped = graph.edges.filter((edge) => edge.source === "composite_upload" && edge.target === "composite_notify");
  // 边按槽位名标识，不按位置坐标：一条控制边，一条把上游产出接到下游同名入参。
  assert.ok(mapped.some((edge) => edge.sourceHandle === "next" && edge.targetHandle === "prev"), JSON.stringify(mapped));
  assert.ok(mapped.some((edge) => edge.sourceHandle !== "next" && edge.targetHandle !== "prev"), JSON.stringify(mapped));
  assert.equal(graph.instances.composite_notify.compositeStep.waitFor.step, "upload");
  assert.equal(graph.instances.composite_notify.compositeStep.waitFor.statuses[0], "completed");
});

test("expands localization upload composites across every reviewed source file before notifying", async () => {
  const { buildCompositeReleaseRunGraph } = await import("../bin/lib/release-runtime-executor.mjs?localization-bulk-upload");
  const sourceFiles = [
    "iHeima/res/values/strings.xml",
    "iHeima/src/samsung/res/values/strings_samsung.xml",
    "iHeima/reslive/values/livestrings.xml",
  ];
  const graph = buildCompositeReleaseRunGraph({
    id: "localization-upload-notify",
    expandSourceFiles: true,
    actions: [
      { stepId: "upload", id: "release-localization:upload-source-file", inputs: {}, continueOn: ["completed"] },
      { stepId: "notify", id: "release-notification:send-notification", inputs: { event: "localization-uploaded", source_record_id: { fromStep: "upload", output: "record_id" } }, waitFor: { step: "upload", statuses: ["completed"] } },
    ],
  }, [
    { id: "release-localization:upload-source-file", skill: "release-localization", action: "upload-source-file", title: "Upload", sourceFiles, inputSchema: [{ key: "source_path" }], source: { skillRoot: "/tmp/release-skills", scriptPath: "/tmp/upload.py" } },
    { id: "release-notification:send-notification", skill: "release-notification", action: "send-notification", title: "Notify", source: { skillRoot: "/tmp/release-skills", scriptPath: "/tmp/notify.py" } },
  ], { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" });
  const uploads = Object.entries(graph.instances).filter(([, instance]) => instance.compositeStep?.actionId === "release-localization:upload-source-file");
  assert.deepEqual(uploads.map(([id]) => id), ["composite_upload_1", "composite_upload_2", "composite_upload_3"]);
  assert.deepEqual(uploads.map(([, instance]) => instance.input.find((slot) => slot.name === "source_path")?.value), sourceFiles);
  assert.equal(graph.instances.composite_notify.compositeStep.waitFor.step, "upload_3");
  assert.equal(graph.instances.composite_notify.input.find((slot) => slot.name === "source_record_id")?.value, "");
  assert.equal(graph.edges.filter((edge) => edge.source.startsWith("composite_upload") && edge.target === "composite_notify").length, 2);
});

test("propagates hidden composite confirmation fingerprint to every internal step", async () => {
  const { buildCompositeReleaseRunGraph } = await import("../bin/lib/release-runtime-executor.mjs?composite-confirmation-input");
  const graph = buildCompositeReleaseRunGraph({
    id: "demo",
    actions: [
      { stepId: "one", id: "release-git:create-release-branch", inputs: {} },
      { stepId: "two", id: "release-git:commit-managed-changes", inputs: {} },
    ],
  }, [
    { id: "release-git:create-release-branch", skill: "release-git", action: "create-release-branch", source: { skillRoot: "/tmp", scriptPath: "/tmp/one.py" } },
    { id: "release-git:commit-managed-changes", skill: "release-git", action: "commit-managed-changes", source: { skillRoot: "/tmp", scriptPath: "/tmp/two.py" } },
  ], { businessLine: "likee", platform: "android", version: "1.0.0", batch: "initial" }, { __release_confirmation_fingerprint: "fp-123" });
  for (const instance of Object.values(graph.instances)) {
    assert.equal(instance.input.find((slot) => slot.name === "__release_confirmation_fingerprint")?.value, "fp-123");
  }
});

test("composite confirmation fingerprint changes when internal action order changes", async () => {
  const { confirmationFingerprint } = await import("../bin/lib/release-runtime-executor.mjs?composite-fingerprint");
  const context = { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" };
  const first = { id: "composite:demo", kind: "composite", actions: [{ id: "a" }, { id: "b" }] };
  const second = { id: "composite:demo", kind: "composite", actions: [{ id: "b" }, { id: "a" }] };
  assert.notEqual(confirmationFingerprint(first, context, { x: 1 }), confirmationFingerprint(second, context, { x: 1 }));
});

test("previewReleaseAction returns a non-executing composite graph and confirmation fingerprint", async () => {
  const { previewReleaseAction } = await import("../bin/lib/release-runtime-executor.mjs?composite-preview");
  const action = {
    id: "composite:demo",
    kind: "composite",
    compositeId: "demo",
    actions: [{ stepId: "one", id: "release-git:create-release-branch", source: { skillRoot: "/tmp", scriptPath: "/tmp/run.py" }, skill: "release-git", action: "create-release-branch", inputSchema: [] }],
  };
  const result = await previewReleaseAction(action, { businessLine: "likee", platform: "android", version: "1.0.0", batch: "initial" }, {});
  assert.equal(result.graph.meta.compositeId, "demo");
  assert.equal(result.graph.instances.composite_one.definitionId, "tool_nodejs");
  assert.ok(result.confirmationFingerprint);
});

test("single Agent composite graph carries lean skill-trigger prompt", async () => {
  const { buildCompositeReleaseRunGraph } = await import("../bin/lib/release-runtime-executor.mjs?single-agent-contract");
  const capability = {
    id: "localization-upload-notify", title: "多语言上传 & 通知",
    description: "上传当前平台全部受审源多语言并发送通知。",
    businessLines: ["likee"], platforms: ["android"], batches: ["initial", "supplemental"],
    stageId: "localization", skillHints: ["release-localization", "release-notification"],
    promptTemplate: "${businessLine}/${platform}/${version}/${batch}: 多语言上传并通知",
  };
  const graph = buildCompositeReleaseRunGraph(capability, [], {
    businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial", batchIndex: 0,
    repositoryRoot: "/tmp/project", skillRoot: "/tmp/release-skills",
  }, { source_path: "/tmp/source.yml" });
  assert.deepEqual(Object.values(graph.instances).map((node) => node.definitionId), ["agent_subAgent"]);
  assert.equal(Object.keys(graph.instances).some((id) => id.startsWith("composite_upload")), false);
  assert.match(graph.instances.release_agent.body, /受审源文件集合/);
  assert.match(graph.instances.release_agent.body, /businessLine":"likee"/);
  assert.match(graph.instances.release_agent.body, /skillRoot:/);
  assert.match(graph.instances.release_agent.body, /Skill: release-localization, release-notification/);
  assert.doesNotMatch(graph.instances.release_agent.body, /uv run python skills\//);
  assert.doesNotMatch(graph.instances.release_agent.body, /恢复摘要|勿重复 prepare|禁止 --rerun|直接按剧本/);
  assert.doesNotMatch(graph.instances.release_agent.body, /先读列出的 SKILL\.md/);
  assert.ok(graph.instances.release_agent.body.length < 4_000, `prompt too long: ${graph.instances.release_agent.body.length}`);
  assert.doesNotMatch(graph.instances.release_agent.body, /iHeima\/res\/values\/strings\.xml/);
  assert.doesNotMatch(graph.instances.release_agent.body, /source_path/);
});

test("create-release-branch agent uses primary release-skills root and skips google-play-aab", async () => {
  const { buildCompositeReleaseRunGraph, selectReleaseAgentSkillRoots } = await import("../bin/lib/release-runtime-executor.mjs?branch-skill-root");
  const main = "/tmp/project/.workspace/release-skills";
  const play = "/tmp/project/.workspace/release-skills-google-play-aab";
  assert.deepEqual(selectReleaseAgentSkillRoots([main, play], "create-release-branch"), [main]);
  assert.deepEqual(selectReleaseAgentSkillRoots([main, play], "google-play-submit"), [main]);
  const capability = {
    id: "create-release-branch",
    title: "创建/复用发版分支",
    description: "创建或复用当前版本的 release 分支并登记结果。",
    businessLines: ["likee"],
    platforms: ["android"],
    batches: ["initial"],
    stageId: "entry",
    skillHints: ["release-git", "release-management"],
    promptTemplate: "${businessLine}/${platform}/${version}/${batch}: 创建发版分支",
  };
  const graph = buildCompositeReleaseRunGraph(capability, [], {
    businessLine: "likee", platform: "android", version: "1.0.0", batch: "initial",
    repositoryRoot: "/tmp/project", skillRoots: [main, play],
  }, { release_branch: "release/v1.0" });
  assert.match(graph.instances.release_agent.body, /skillRoot: .*release-skills/);
  assert.match(graph.instances.release_agent.body, /输入:.*release\/v1\.0/);
  assert.match(graph.instances.release_agent.body, /Skill: release-git, release-management/);
  assert.doesNotMatch(graph.instances.release_agent.body, /uv run python skills\//);
  assert.doesNotMatch(graph.instances.release_agent.body, /release-skills-google-play-aab\/skills/);
  assert.equal(graph.instances.release_agent.input.find((slot) => slot.name === "skillsContext").value, main);
  assert.ok(graph.instances.release_agent.body.length < 4_000);
});

test("removed Google Play AAB extension never becomes an Agent Skill root", async () => {
  const { selectReleaseAgentSkillRoots } = await import("../bin/lib/release-runtime-executor.mjs?removed-google-play-aab");
  const main = "/tmp/project/.workspace/release-skills";
  const removedExtension = "/tmp/project/.workspace/release-skills-google-play-aab";
  assert.deepEqual(selectReleaseAgentSkillRoots([main, removedExtension], "google-play-submit", ["release-google-play"]), [main]);
});

test("build-package agent receives only the platform build skill root", async () => {
  const { selectReleaseAgentSkillRoots } = await import("../bin/lib/release-runtime-executor.mjs?build-package-skill-roots");
  const main = "/tmp/project/.workspace/release-skills";
  const play = "/tmp/project/.workspace/release-skills-google-play-aab";
  assert.deepEqual(
    selectReleaseAgentSkillRoots([main, play], "build-package", ["release-build"]),
    [main],
  );
});

test("build-package prompt points each skill hint at the matching root", async () => {
  const { buildReleaseAgentPrompt } = await import("../bin/lib/release-runtime-executor.mjs?build-package-skill-entrypoints");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-agent-skill-roots-"));
  const main = path.join(tempRoot, "release-skills");
  const play = path.join(tempRoot, "release-skills-google-play-aab");
  fs.mkdirSync(path.join(main, "skills", "release-build"), { recursive: true });
  fs.mkdirSync(path.join(play, "skills", "release-google-play"), { recursive: true });
  fs.writeFileSync(path.join(main, "skills", "release-build", "SKILL.md"), "---\nname: release-build\n---\n");
  fs.writeFileSync(path.join(play, "skills", "release-google-play", "SKILL.md"), "---\nname: release-google-play\n---\n");
  try {
    const prompt = buildReleaseAgentPrompt({
      capability: { id: "build-package", title: "构建发版包", skillHints: ["release-build"] },
      context: { businessLine: "likee", platform: "android", version: "5.64.0", batch: "initial" },
      skillRoots: [main, play],
      requiredReleaseFields: ["build_number"],
    });
    assert.match(prompt, /skillRoot:/);
    assert.doesNotMatch(prompt, /release-google-play/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("release capability intents stay lean and operator-guide shaped", async () => {
  const { buildReleaseCapabilityPlaybook, buildReleaseAgentPrompt } = await import("../bin/lib/release-runtime-executor.mjs?playbooks");
  const ctx = { businessLine: "likee", platform: "android", version: "5.64.0", batch: "initial" };
  const ids = [
    "localization-upload-notify",
    "create-release-branch",
    "localization-download-merge-notify",
    "merge-release-to-master",
    "build-package",
    "submit-approval",
    "initial-publish-and-notify",
    "supplemental-publish-and-notify",
    "start-supplemental-release-notify",
    "rollout",
    "submit-full-rollout-approval",
    "full-rollout",
  ];
  for (const id of ids) {
    const extra = /submit-approval|submit-full-rollout-approval|full-rollout/.test(id) ? { operator: "duanfengyuan" } : {};
    const playbook = buildReleaseCapabilityPlaybook(id, ctx, extra);
    assert.doesNotMatch(playbook, /uv run python skills\//, id);
    assert.doesNotMatch(playbook, /勿重复|禁止 --rerun|恢复摘要/, id);
    const prompt = buildReleaseAgentPrompt({
      capability: { id, title: id, description: id, skillHints: ["release-git"] },
      context: { ...ctx, repositoryRoot: "/tmp/p", skillRoots: ["/tmp/p/.workspace/release-skills"] },
      inputs: extra,
      skillRoots: ["/tmp/p/.workspace/release-skills"],
      previousResult: { status: "completed", summary: "旧成功", records: [{ record_id: "x".repeat(32), operation: "准备翻译归档" }] },
    });
    assert.match(prompt, /遵循 skillRoot 中相关 Skill/);
    assert.doesNotMatch(prompt, /恢复摘要|勿重复 prepare|幂等成功/);
    assert.match(
      prompt,
      /任务:/,
      id,
    );
    assert.ok(prompt.length < 3_500, `${id} prompt too long: ${prompt.length}`);
  }
  assert.match(buildReleaseCapabilityPlaybook("create-release-branch", ctx, { release_branch: "release/v5.64" }), /显式选择 release\/v5\.64 并登记/);
  assert.match(buildReleaseCapabilityPlaybook("create-release-branch", ctx, {}), /创建标准发版分支并登记/);
  assert.match(buildReleaseCapabilityPlaybook("merge-release-to-master", ctx, {}), /合入主干/);
  assert.match(buildReleaseCapabilityPlaybook("build-package", ctx, { build_number: "7542" }), /构建号 7542/);
  assert.match(buildReleaseCapabilityPlaybook("initial-publish-and-notify", ctx, {}), /首包商店发布/);
  assert.match(buildReleaseCapabilityPlaybook("initial-publish-and-notify", { ...ctx, platform: "ios" }, {}), /首包版本更新说明/);
  assert.match(buildReleaseCapabilityPlaybook("supplemental-publish-and-notify", { ...ctx, batch: "supplemental" }, {}), /补包商店发布/);
  assert.match(buildReleaseCapabilityPlaybook("supplemental-publish-and-notify", { ...ctx, platform: "ios", batch: "supplemental" }, {}), /补包版本更新说明/);
  const supplementalStart = buildReleaseCapabilityPlaybook("start-supplemental-release-notify", { ...ctx, batch: "supplemental" }, {});
  assert.match(supplementalStart, /guide-current-release/);
  assert.match(supplementalStart, /append-release-batch/);
  assert.match(supplementalStart, /补包开始通知/);
  assert.match(supplementalStart, /平台时间线没有历史记录也允许执行/);
  assert.doesNotMatch(supplementalStart, /send-rollout-notification|patch-flow-entered|gray_percent/);
  assert.match(buildReleaseCapabilityPlaybook("full-rollout", ctx, {}), /全量放量通知/);
  assert.doesNotMatch(buildReleaseCapabilityPlaybook("full-rollout", ctx, { operator: "duanfengyuan" }), /send-rollout-notification|gray_percent|uv run/);
  assert.match(buildReleaseCapabilityPlaybook("rollout", ctx, { gray_percent: "50" }), /放量到 50%/);
  assert.match(buildReleaseCapabilityPlaybook("rollout", ctx, {}), /观察灰度并推进放量/);
  const freePrompt = buildReleaseCapabilityPlaybook("free-prompt-agent", ctx, { prompt: "帮我查一下当前发版分支" });
  assert.equal(freePrompt, "帮我查一下当前发版分支");
  assert.match(buildReleaseCapabilityPlaybook("free-prompt-agent", ctx, {}), /prompt_required/);
  const upload = buildReleaseCapabilityPlaybook("localization-upload-notify", ctx, {});
  assert.match(upload, /上传 Likee android 的受审源多语言内容（版本 5\.64\.0/);
  assert.match(upload, /localization-uploaded/);
  assert.doesNotMatch(upload, /upload-source-file|uv run/);
  const rolloutMissingPercent = buildReleaseCapabilityPlaybook("rollout", ctx, {});
  assert.match(rolloutMissingPercent, /gray_percent|灰度百分比/);
  assert.match(rolloutMissingPercent, /waiting/);
  const download = buildReleaseCapabilityPlaybook("localization-download-merge-notify", ctx, {});
  assert.match(download, /为 Likee android 拉回翻译（版本 5\.64\.0/);
  assert.match(download, /创建或复用 MR/);
  assert.match(download, /MR 创建或复用成功后本节点立即完成/);
  assert.doesNotMatch(download, /MR 合入后|localization-applied/);
  assert.match(download, /不要发送合入通知/);
  assert.doesNotMatch(download, /prepare-translation-archive|uv run|勿重复|--rerun|强制重新下载/);
  const downloadForce = buildReleaseCapabilityPlaybook("localization-download-merge-notify", ctx, { force_rerun: true });
  assert.match(downloadForce, /强制重新下载/);
  assert.match(downloadForce, /--rerun/);
  assert.match(downloadForce, /创建或复用 MR/);
  assert.doesNotMatch(downloadForce, /MR 合入后|localization-applied/);
  assert.match(downloadForce, /不要发送合入通知/);
  assert.doesNotMatch(downloadForce, /uv run python/);
  const downloadResume = buildReleaseCapabilityPlaybook("localization-download-merge-notify", ctx, {
    apply_record_id: "029565ca36d54effa06a9da6bba82520",
    resume_record_id: "bd9027f693014db6899680f383a54c39",
  });
  // 续跑 ID 仅作为显式输入透传给 Agent，不再写成步骤剧本。
  assert.doesNotMatch(downloadResume, /已有 apply_record_id|跳过准备/);
  const missingVersion = buildReleaseCapabilityPlaybook("localization-upload-notify", { ...ctx, version: "" }, {});
  assert.match(missingVersion, /version_required|waiting/);
  assert.doesNotMatch(missingVersion, /upload-source-file/);
  const approval = buildReleaseCapabilityPlaybook("submit-approval", ctx, { operator: "duanfengyuan" });
  assert.match(approval, /为 Likee android 5\.64\.0（initial）创建首次发版审核草稿/);
  assert.match(approval, /审核申请人为 duanfengyuan/);
  assert.doesNotMatch(approval, /uv run|--input operator=/);
  const fullApproval = buildReleaseCapabilityPlaybook("submit-full-rollout-approval", ctx, { operator: "duanfengyuan" });
  assert.match(fullApproval, /创建全量发布审核草稿/);
  assert.match(fullApproval, /已确认指标快照|create-full-rollout-approval/);
  assert.match(fullApproval, /duanfengyuan/);
  const fullApprovalSupplemental = buildReleaseCapabilityPlaybook("submit-full-rollout-approval", { ...ctx, batch: "supplemental" }, { operator: "duanfengyuan" });
  assert.match(fullApprovalSupplemental, /supplemental.*全量发布审核草稿|全量发布审核草稿.*supplemental/);
  const { isReleaseApprovalOperatorUsername, resolveReleaseApprovalOperator } = await import("../bin/lib/release-runtime-executor.mjs?oa-operator");
  assert.equal(isReleaseApprovalOperatorUsername("duanfengyuan"), true);
  assert.equal(isReleaseApprovalOperatorUsername("yangcaimu"), true);
  assert.equal(isReleaseApprovalOperatorUsername("段丰源"), false);
  assert.equal(isReleaseApprovalOperatorUsername("Duan"), false);
  assert.equal(resolveReleaseApprovalOperator("段丰源", "duanfengyuan"), "duanfengyuan");
  const invalid = buildReleaseCapabilityPlaybook("submit-approval", ctx, { operator: "段丰源" });
  assert.match(invalid, /approval_operator_invalid|waiting/);
  assert.doesNotMatch(invalid, /uv run python skills\/release-approval/);
});

test("capability prompts use configured business goals without CLI playbooks", async () => {
  const { buildReleaseCapabilityPlaybook, buildReleaseAgentPrompt } = await import("../bin/lib/release-runtime-executor.mjs?config-driven-prompts");
  const capability = {
    id: "demo-capability",
    capabilityGoal: "完成 ${businessLine} ${platform} 的多语言同步并发送通知。",
    description: "不得使用的旧描述",
    skillHints: ["release-localization", "release-notification"],
    promptTemplate: "${businessLine}/${platform}/${version}: ${capabilityGoal}",
  };
  const context = { businessLine: "likee", platform: "android", version: "5.64.0", batch: "initial" };
  const intent = buildReleaseCapabilityPlaybook("demo-capability", context, {}, capability);
  assert.equal(intent, "完成 likee android 的多语言同步并发送通知。");
  const prompt = buildReleaseAgentPrompt({ capability, context, skillRoots: ["/tmp/release-skills"] });
  assert.match(prompt, /完成 likee android 的多语言同步并发送通知/);
  assert.doesNotMatch(prompt, /prepare-translation-archive|--rerun|upload-source-file|uv run|先执行|再执行/);
  assert.ok(prompt.length < 2_500, `prompt too long: ${prompt.length}`);
});

test("build-package only points at the platform build skill", async () => {
  const { buildReleaseCapabilityPlaybook } = await import("../bin/lib/release-runtime-executor.mjs?build-package-goal");
  const config = { id: "build-package", capabilityGoal: "按当前平台构建发版包并记录构建产物。", skillHints: ["release-build"] };
  const intent = buildReleaseCapabilityPlaybook("build-package", { businessLine: "likee", platform: "ios", version: "5.64.0", batch: "initial" }, {}, config);
  assert.equal(intent, "按当前平台构建发版包并记录构建产物。");
});

test("localization download capability completes when its MR is created", async () => {
  const { buildReleaseCapabilityPlaybook, buildReleaseAgentPrompt } = await import("../bin/lib/release-runtime-executor.mjs?localization-mr-completion");
  const context = {
    businessLine: "likee",
    platform: "android",
    version: "5.64.0",
    batch: "initial",
    repositoryRoot: "/tmp/likee-android",
  };
  const playbook = buildReleaseCapabilityPlaybook("localization-download-merge-notify", context, {});
  assert.match(playbook, /创建或复用 MR/);
  assert.doesNotMatch(playbook, /MR 合入后/);
  assert.doesNotMatch(playbook, /localization-applied/);
  assert.doesNotMatch(playbook, /发送 localization-uploaded 通知|发送 localization-applied 通知/);
  assert.match(playbook, /不要发送合入通知/);

  const prompt = buildReleaseAgentPrompt({
    capability: {
      id: "localization-download-merge-notify",
      title: "多语言下载 & 创建 MR",
      skillHints: ["release-localization", "release-git"],
    },
    context,
    skillRoots: ["/tmp/release-skills"],
  });
  assert.match(prompt, /创建或复用 MR/);
  assert.match(prompt, /MR 创建成功即完成/);
  assert.doesNotMatch(prompt, /localization-applied/);
  assert.doesNotMatch(prompt, /发送 localization-applied 通知/);
  assert.doesNotMatch(prompt, /发送合入通知/);
});

test("retry previousResult is compacted so agent prompts stay under Cursor limits", async () => {
  const { buildCompositeReleaseRunGraph, compactReleasePreviousResult, releasePreviousResultForAgent } = await import("../bin/lib/release-runtime-executor.mjs?compact-previous");
  const hugeEvents = Array.from({ length: 200 }, (_, i) => ({
    type: "raw",
    text: JSON.stringify({ tool_call: { readToolCall: { result: { content: "SKILL".repeat(5_000) } } } }),
  }));
  const huge = {
    status: "failed",
    summary: "timeout",
    error: "发版 Agent 执行超时",
    steps: [{ stepId: "one", status: "failed", logs: [{ text: "x".repeat(20_000) }], stdout: "y".repeat(20_000), output: { dump: "z".repeat(50_000) } }],
    logs: Array.from({ length: 50 }, () => ({ text: "z".repeat(10_000) })),
    events: hugeEvents,
  };
  const compact = compactReleasePreviousResult(huge);
  assert.equal(compact.status, "failed");
  assert.equal(compact.steps[0].logs, undefined);
  assert.equal(compact.events, undefined);
  assert.ok(JSON.stringify(compact).length < 12_000);
  const fromCard = releasePreviousResultForAgent({
    status: "failed",
    error: "Prompt exceeds 500000 characters",
    output: { events: hugeEvents },
    details: { steps: [{ stepId: "one", status: "failed", logs: hugeEvents }] },
  });
  assert.ok(fromCard);
  assert.equal(fromCard.events, undefined);
  assert.ok(JSON.stringify(fromCard).length < 4_000);
  const capability = {
    id: "create-release-branch",
    title: "创建/复用发版分支",
    description: "创建或复用当前版本的 release 分支并登记结果。",
    businessLines: ["likee"], platforms: ["android"], batches: ["initial"],
    stageId: "entry", skillHints: ["release-git", "release-management"],
    promptTemplate: "创建发版分支",
  };
  const graph = buildCompositeReleaseRunGraph(capability, [], {
    businessLine: "likee", platform: "android", version: "1.0.0", batch: "initial",
    repositoryRoot: "/tmp/project", skillRoots: ["/tmp/project/.workspace/release-skills"],
  }, {}, { previousResult: { output: { events: hugeEvents }, error: "Prompt exceeds 500000 characters" } });
  assert.ok(graph.instances.release_agent.body.length < 20_000, `prompt too long: ${graph.instances.release_agent.body.length}`);
  assert.doesNotMatch(graph.instances.release_agent.body, /SKILLSKILLSKILL/);
  assert.doesNotMatch(graph.instances.release_agent.body, /恢复摘要|Prompt exceeds 500000 characters/);
});

test("builds the activity release context preparation as a direct release-management script graph", async () => {
  const { buildCompositeReleaseRunGraph } = await import("../bin/lib/release-runtime-executor.mjs?prepare-context-fast");
  const capability = {
    id: "release-initialization:prepare-context",
    title: "准备活动发版上下文",
    description: "读取并准备当前业务线、平台和版本的活动发版上下文；已有活动发版时复用，否则按 Skill 安全创建。",
    businessLines: ["likee"],
    platforms: ["android"],
    batches: ["initial"],
    stageId: "entry",
    skillHints: ["release-management", "release-runtime"],
    promptTemplate: "${businessLine}/${platform}/${version}/${batch}: 准备活动发版上下文",
  };
  const graph = buildCompositeReleaseRunGraph(capability, [], {
    businessLine: "likee", platform: "android", version: "1.3.0", batch: "initial",
    repositoryRoot: "/tmp/project", skillRoots: ["/tmp/release-skills"],
  }, { publish_date: "2026-09-01" }, { skillRoots: ["/tmp/release-skills"] });
  assert.deepEqual(Object.values(graph.instances).map((node) => node.definitionId), ["tool_nodejs"]);
  assert.equal(graph.meta.prepareContextFastPath, true);
  assert.equal(graph.meta.agentDriven, false);
  assert.match(graph.instances.release_agent.script, /guide-current-release/);
  assert.match(graph.instances.release_agent.script, /create-active-release/);
  assert.match(graph.instances.release_agent.script, /release-management/);
  const publishInput = graph.instances.release_agent.input.find((slot) => slot.name === "publish_date");
  assert.equal(publishInput?.value, "2026-09-01");
  assert.equal(graph.instances.release_agent.input.find((slot) => slot.name === "minor_version")?.value, "1.3.0");
});

test("prepare-context graph embeds TAPD-derived publish_date for an executable run", async () => {
  const { buildCompositeReleaseRunGraph } = await import("../bin/lib/release-runtime-executor.mjs?prepare-context-graph-tapd");
  const graph = buildCompositeReleaseRunGraph({
    id: "release-initialization:prepare-context",
    title: "准备活动发版上下文",
    skillHints: ["release-management"],
  }, [], {
    businessLine: "likee", platform: "android", version: "5.64.0", batch: "initial",
    repositoryRoot: "/tmp/project", skillRoots: ["/tmp/release-skills"],
  }, {}, {
    skillRoots: ["/tmp/release-skills"],
    tapdConfig: { workspaceId: "33202860" },
    fetchIterationsSync: () => ({ data: [{ Iteration: { id: "it-564", name: "Likee Android&iOS V5.64（9/2）", enddate: "2026-09-02" } }] }),
  });
  assert.equal(graph.meta.inputs.publish_date, "2026-09-02");
  assert.equal(graph.instances.release_agent.input.find((slot) => slot.name === "publish_date")?.value, "2026-09-02");
  assert.equal(graph.meta.agentDriven, false);
});

test("extracts a release Agent result from the release_agent graph output slot", async () => {
  const { releaseAgentResultFromWorkspaceRun } = await import("../bin/lib/release-runtime.mjs?graph-agent-result");
  const result = releaseAgentResultFromWorkspaceRun({
    graph: {
      instances: {
        release_agent: {
          output: [
            { type: "node", name: "next", value: "" },
            { type: "text", name: "result", value: '{"status":"waiting","summary":"需要确认活动发版"}' },
          ],
        },
      },
    },
  });
  assert.equal(result.status, "waiting");
  assert.equal(result.summary, "需要确认活动发版");
});

test("normalizeReleaseAgentResult peels JSON glued to trailing markdown", async () => {
  const { normalizeReleaseAgentResult } = await import("../bin/lib/release-runtime.mjs?json-plus-markdown");
  const envelope = {
    status: "completed",
    summary: "plain with record_id=abc",
    steps: [{ action: "prepare-translation-archive", status: "skipped_already_succeeded" }],
    records: [{ record_id: "a".repeat(32), operation: "准备翻译归档" }],
    artifacts: [{ type: "merge_request", url: "https://git.example/mr/1" }],
  };
  const raw = `${JSON.stringify(envelope)}likee Android **5.64.0** 多语言已合入（[MR !1](https://git.example/mr/1)）。`;
  const result = normalizeReleaseAgentResult(raw);
  assert.equal(result.status, "completed");
  assert.match(result.summary, /\*\*5\.64\.0\*\*/);
  assert.match(result.summary, /\[MR !1\]/);
  assert.doesNotMatch(result.summary, /^\{/);
  assert.equal(result.steps.length, 1);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.records.length, 1);

  const nestedOnly = normalizeReleaseAgentResult({
    status: "completed",
    summary: raw,
    steps: [],
    artifacts: [],
    records: [],
  });
  assert.match(nestedOnly.summary, /\*\*5\.64\.0\*\*/);
  assert.equal(nestedOnly.steps.length, 1);
  assert.equal(nestedOnly.artifacts.length, 1);
});

test("loads a structured release Agent result when the output slot contains a published file path", async () => {
  const { releaseAgentResultFromWorkspaceRun } = await import("../bin/lib/release-runtime.mjs?graph-agent-result-file");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "release-agent-result-")));
  const resultPath = path.join(root, "outputs", "release_agent", "result.txt");
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, JSON.stringify({ status: "completed", summary: "上下文已复用", steps: [{ action: "inspect" }] }));
  const result = releaseAgentResultFromWorkspaceRun({
    graph: {
      meta: { context: { repositoryRoot: root } },
      instances: { release_agent: { output: [{ type: "text", name: "result", value: "outputs/release_agent/result.txt" }] } },
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.summary, "上下文已复用");
  assert.deepEqual(result.steps, [{ action: "inspect" }]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("prepare-context wrapper returns waiting when publish_date is missing", async () => {
  const { prepareContextWrapperScript } = await import("../bin/lib/release-runtime-executor.mjs?prepare-context-wrapper");
  const os = await import("node:os");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-prepare-context-"));
  const skillRoot = path.join(tempRoot, "release-management");
  fs.mkdirSync(path.join(skillRoot, "scripts"), { recursive: true });
  const runPy = path.join(skillRoot, "scripts", "run.py");
  fs.writeFileSync(runPy, [
    "import sys",
    "action = sys.argv[sys.argv.index('--action') + 1] if '--action' in sys.argv else ''",
    "if action == 'guide-current-release':",
    "    print('status: preflight_failed')",
    "    print('error: 未找到活动发版')",
    "    print('data:')",
    "    print('  guidance:')",
    "    print('    action: create-active-release')",
    "    print('    required_inputs:')",
    "    print('    - publish_date')",
    "elif action == 'create-active-release':",
    "    print('status: succeeded')",
    "    print('record_id: test-record')",
  ].join("\n"));
  const env = {
    ...process.env,
    AGENTFLOW_INPUTS_JSON: JSON.stringify({
      product: "likee",
      platform: "android",
      minor_version: "5.64.0",
      major_version: "5.64",
      batch: "initial",
      publish_date: "",
    }),
  };
  const result = spawnSync("sh", ["-c", prepareContextWrapperScript(runPy, skillRoot)], { env, encoding: "utf8" });
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.status, "waiting");
  assert.equal(payload.waiting?.reason, "publish_date_required");
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("prepare-context wrapper does not create a release for unrelated preflight failures", async () => {
  const { prepareContextWrapperScript } = await import("../bin/lib/release-runtime-executor.mjs?prepare-context-wrapper-unrelated");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-prepare-context-unrelated-"));
  const skillRoot = path.join(tempRoot, "release-management");
  fs.mkdirSync(path.join(skillRoot, "scripts"), { recursive: true });
  const runPy = path.join(skillRoot, "scripts", "run.py");
  fs.writeFileSync(runPy, [
    "import sys",
    "action = sys.argv[sys.argv.index('--action') + 1] if '--action' in sys.argv else ''",
    "if action == 'guide-current-release':",
    "    print('status: preflight_failed')",
    "    print('error: platform_selection_required')",
    "elif action == 'create-active-release':",
    "    raise SystemExit('must not create on platform selection failure')",
  ].join("\n"));
  const result = spawnSync("sh", ["-c", prepareContextWrapperScript(runPy, skillRoot)], {
    env: { ...process.env, AGENTFLOW_INPUTS_JSON: JSON.stringify({
      product: "likee", platform: "android", minor_version: "5.64.0", major_version: "5.64", batch: "initial", publish_date: "2026-09-02",
    }) },
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.status, "failed");
  assert.match(payload.summary, /platform_selection_required/);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("prepare-context wrapper does not reuse a successful context for another version", async () => {
  const { prepareContextWrapperScript } = await import("../bin/lib/release-runtime-executor.mjs?prepare-context-wrapper-version");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-prepare-context-version-"));
  const skillRoot = path.join(tempRoot, "release-management");
  fs.mkdirSync(path.join(skillRoot, "scripts"), { recursive: true });
  const runPy = path.join(skillRoot, "scripts", "run.py");
  fs.writeFileSync(runPy, [
    "import sys",
    "action = sys.argv[sys.argv.index('--action') + 1] if '--action' in sys.argv else ''",
    "if action == 'guide-current-release':",
    "    print('status: succeeded')",
    "    print('record_id: active-other')",
    "    print('current_release:')",
    "    print('  minor_version: 15.64.0')",
    "elif action == 'create-active-release':",
    "    raise SystemExit('must not create on version mismatch')",
  ].join("\n"));
  const result = spawnSync("sh", ["-c", prepareContextWrapperScript(runPy, skillRoot)], {
    env: { ...process.env, AGENTFLOW_INPUTS_JSON: JSON.stringify({
      product: "likee", platform: "android", minor_version: "5.64.0", major_version: "5.64", batch: "initial", publish_date: "2026-09-02",
    }) },
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.status, "failed");
  assert.match(payload.summary, /版本不匹配/);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("prepare-context wrapper rejects a required target precondition", async () => {
  const { prepareContextWrapperScript } = await import("../bin/lib/release-runtime-executor.mjs?prepare-context-wrapper-precondition");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-prepare-context-precondition-"));
  const skillRoot = path.join(tempRoot, "release-management");
  fs.mkdirSync(path.join(skillRoot, "scripts"), { recursive: true });
  const runPy = path.join(skillRoot, "scripts", "run.py");
  fs.writeFileSync(runPy, [
    "import sys",
    "action = sys.argv[sys.argv.index('--action') + 1] if '--action' in sys.argv else ''",
    "if action == 'guide-current-release':",
    "    print('status: succeeded')",
    "    print('current_release:')",
    "    print('  minor_version: 5.64.0')",
    "    print('precondition:')",
    "    print('  status: required')",
    "    print('  reason: target_not_configured')",
    "elif action == 'create-active-release':",
    "    raise SystemExit('must not create when target precondition is required')",
  ].join("\n"));
  const result = spawnSync("sh", ["-c", prepareContextWrapperScript(runPy, skillRoot)], {
    env: { ...process.env, AGENTFLOW_INPUTS_JSON: JSON.stringify({
      product: "likee", platform: "android", minor_version: "5.64.0", major_version: "5.64", batch: "initial", publish_date: "2026-09-02",
    }) },
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.status, "failed");
  assert.match(payload.summary, /target_not_configured/);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("prepare-context fast path fills publish_date from the matching TAPD iteration", async () => {
  const { runPrepareContextFastPath } = await import("../bin/lib/release-runtime-executor.mjs?prepare-context-tapd");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-prepare-tapd-"));
  const skillRoot = path.join(tempRoot, "release-skills");
  fs.mkdirSync(path.join(skillRoot, "release-management", "scripts"), { recursive: true });
  const runPy = path.join(skillRoot, "release-management", "scripts", "run.py");
  fs.writeFileSync(runPy, [
    "import sys",
    "action = sys.argv[sys.argv.index('--action') + 1] if '--action' in sys.argv else ''",
    "values = {}",
    "for index, item in enumerate(sys.argv):",
    "    if item == '--input' and index + 1 < len(sys.argv) and '=' in sys.argv[index + 1]:",
    "        key, value = sys.argv[index + 1].split('=', 1)",
    "        values[key] = value",
    "if action == 'guide-current-release':",
    "    print('status: preflight_failed')",
    "    print('error: 未找到活动发版')",
    "elif action == 'create-active-release':",
    "    print('status: succeeded')",
    "    print('record_id: tapd-created')",
    "    print('publish_date_seen: ' + values.get('publish_date', ''))",
  ].join("\n"));
  const fast = runPrepareContextFastPath(
    { businessLine: "likee", platform: "android", version: "5.64.0", batch: "initial" },
    {},
    [skillRoot],
    {
      tapdConfig: { workspaceId: "33202860" },
      fetchIterationsSync: () => ({ data: [{ Iteration: { id: "it-564", name: "Likee Android&iOS V5.64（9/2）", enddate: "2026-09-02" } }] }),
    },
  );
  assert.equal(fast.status, "completed");
  assert.equal(fast.records?.[0]?.record_id, "tapd-created");
  assert.equal(fast.summary, "活动发版上下文已创建");
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("prepare-context fast path reports an actionable waiting state when TAPD has no matching iteration", async () => {
  const { runPrepareContextFastPath } = await import("../bin/lib/release-runtime-executor.mjs?prepare-context-tapd-missing");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-prepare-tapd-missing-"));
  const skillRoot = path.join(tempRoot, "release-skills");
  fs.mkdirSync(path.join(skillRoot, "release-management", "scripts"), { recursive: true });
  const runPy = path.join(skillRoot, "release-management", "scripts", "run.py");
  fs.writeFileSync(runPy, [
    "import sys",
    "action = sys.argv[sys.argv.index('--action') + 1] if '--action' in sys.argv else ''",
    "if action == 'guide-current-release':",
    "    print('status: preflight_failed')",
    "    print('error: 未找到活动发版')",
  ].join("\n"));
  const fast = runPrepareContextFastPath(
    { businessLine: "likee", platform: "android", version: "9.99.0", batch: "initial" },
    {},
    [skillRoot],
    {
      tapdConfig: { workspaceId: "33202860" },
      fetchIterationsSync: () => ({ data: [] }),
    },
  );
  assert.equal(fast.status, "waiting");
  assert.match(fast.summary, /TAPD 未找到版本 9\.99\.0/);
  assert.equal(fast.waiting?.reason, "publish_date_required");
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("initialization bootstrap records context preparation on the initialization node", async () => {
  const { bootstrapReleasePrepareContext, runPrepareContextFastPath } = await import("../bin/lib/release-runtime-executor.mjs?prepare-context-bootstrap");
  const os = await import("node:os");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-prepare-bootstrap-"));
  const skillRoot = path.join(tempRoot, "skills", "release-management");
  fs.mkdirSync(path.join(skillRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, "scripts", "run.py"), [
    "import sys",
    "action = sys.argv[sys.argv.index('--action') + 1] if '--action' in sys.argv else ''",
    "if action == 'guide-current-release':",
    "    print('status: succeeded')",
    "    print('record_id: active-564')",
    "    print('data:')",
    "    print('  minor_version: 5.64.0')",
  ].join("\n"));
  const context = { businessLine: "likee", platform: "android", version: "5.64.0", batch: "initial" };
  const fast = runPrepareContextFastPath(context, {}, [tempRoot]);
  assert.equal(fast.status, "completed");
  const bootstrapped = bootstrapReleasePrepareContext({
    timeline: [{ nodeId: "release-initialization", status: "completed" }],
    pending: [{ nodeId: "release-initialization:prepare-context", status: "pending", id: "old-pending" }],
    dismissedNodeIds: [],
  }, context, [tempRoot]);
  assert.equal(bootstrapped.changed, true);
  assert.equal(bootstrapped.state.initialization?.status, "completed");
  assert.equal(bootstrapped.state.pending.some((item) => item.nodeId === "release-initialization:prepare-context"), false);
  const initialization = bootstrapped.state.timeline.find((item) => item.nodeId === "release-initialization");
  assert.equal(initialization?.contextPreparationStatus, "completed");
  assert.equal(initialization?.details?.summary, "活动发版上下文已就绪");
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("initialization bootstrap records context preparation on the initialization node", async () => {
  const { bootstrapReleasePrepareContext, runPrepareContextFastPath } = await import("../bin/lib/release-runtime-executor.mjs?prepare-context-bootstrap");
  const os = await import("node:os");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-prepare-bootstrap-"));
  const skillRoot = path.join(tempRoot, "skills", "release-management");
  fs.mkdirSync(path.join(skillRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, "scripts", "run.py"), [
    "import sys",
    "action = sys.argv[sys.argv.index('--action') + 1] if '--action' in sys.argv else ''",
    "if action == 'guide-current-release':",
    "    print('status: succeeded')",
    "    print('record_id: active-564')",
    "    print('data:')",
    "    print('  minor_version: 5.64.0')",
  ].join("\n"));
  const context = { businessLine: "likee", platform: "android", version: "5.64.0", batch: "initial" };
  const fast = runPrepareContextFastPath(context, {}, [tempRoot]);
  assert.equal(fast.status, "completed");
  const bootstrapped = bootstrapReleasePrepareContext({
    timeline: [{ nodeId: "release-initialization", status: "completed" }],
    pending: [{ nodeId: "release-initialization:prepare-context", status: "pending", id: "old-pending" }],
    dismissedNodeIds: [],
  }, context, [tempRoot]);
  assert.equal(bootstrapped.changed, true);
  assert.equal(bootstrapped.state.initialization?.status, "completed");
  assert.equal(bootstrapped.state.pending.some((item) => item.nodeId === "release-initialization:prepare-context"), false);
  const initialization = bootstrapped.state.timeline.find((item) => item.nodeId === "release-initialization");
  assert.equal(initialization?.contextPreparationStatus, "completed");
  assert.equal(initialization?.details?.summary, "活动发版上下文已就绪");
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
