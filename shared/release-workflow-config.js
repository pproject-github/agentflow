const freeze = (value) => Object.freeze(value);
const normalize = (value) => String(value ?? "").trim().toLowerCase();

const processOrder = ["entry", "localization", "merge-master", "build", "approval", "publish", "rollout", "full-rollout"];
const processTitles = {
  entry: "发版入口", localization: "多语言处理", "merge-master": "合回 master", build: "构建包",
  approval: "提审单", publish: "发布并通知", rollout: "放量", "full-rollout": "全量发布",
};
const skillProcessMap = {
  "release-localization": "localization", "release-git": "merge-master", "release-channel-packages": "build",
  "release-approval": "approval", "release-google-play": "publish", "release-notification": "publish",
  "release-gray-observe": "rollout",
};
const actionOrder = Object.freeze({
  "release-localization:upload-source-file": 10,
  "release-git:create-release-branch": 20,
  "release-localization:prepare-translation-archive": 30,
  "release-git:merge-release-to-main": 40,
  "release-channel-packages:trigger-channel-packages-batch": 50,
  "release-approval:create-initial-release-approval": 60,
  "release-google-play:submit-aab-internal-testing": 70,
  "release-notification:send-rollout-notification": 80,
  "release-gray-observe:observe-gray-dashboard": 90,
});

const resultOutputs = [
  { key: "summary", type: "text" }, { key: "steps", type: "json" }, { key: "records", type: "json" },
  { key: "artifacts", type: "json" }, { key: "waiting", type: "json" }, { key: "next_action", type: "text" },
];

const promptTemplate = (goal) => [
  "你是发版执行 Agent：版本页上下文已锁定，按业务意图在 skillRoot 触发对应 Skill，不要只给计划。",
  "相关 Skill：${skillHints}。按 Skill operator-guide / cli 自行编排；失败再查 references/cli.md。",
  "禁止 skillhub evolve/detect/report。",
  "当前上下文：businessLine=${businessLine}，platform=${platform}，version=${version}，batch=${batch}，batchIndex=${batchIndex}。",
  `任务：${goal}`,
  "必须只返回 JSON：{status:\"completed|waiting|failed\",summary,steps,records,artifacts,waiting,next_action}。",
].join("\n");

const capability = (id, title, description, stageId, batches, skillHints, inputs = [], extra = {}) => ({
  id, title, description, capabilityGoal: description, businessLines: ["likee"], platforms: ["android"], batches, stageId, skillHints, inputs,
  outputs: resultOutputs.map((item) => ({ ...item })), promptTemplate: promptTemplate(description), ...extra,
});

// 用户需求点: 复合发版节点只声明能力和提示词，原子 Skill 的编排由 Agent 读取最新 Skill 后完成。
const capabilityDefinitions = [
  capability("release-initialization:prepare-context", "准备活动发版上下文", "读取并准备当前业务线、平台、版本和批次的活动发版上下文；已有活动发版时复用，否则按 release-management Skill 的安全流程创建。", "entry", ["initial", "supplemental"], ["release-management", "release-runtime"], [{ key: "publish_date", type: "text", required: false, label: "发布日期", placeholder: "YYYY-MM-DD" }], { requiresConfirmation: false, nodeId: "release-initialization:prepare-context" }),
  capability("localization-upload-notify", "多语言上传 & 通知", "读取 release-localization Skill 维护的当前业务线与平台受审源文件集合，上传全部源多语言并发送通知；文件集合由 Skill 自行发现。", "entry", ["initial"], ["release-localization", "release-notification"]),
  capability("create-release-branch", "创建/复用发版分支", "创建或复用当前版本的 release 分支并登记结果。", "entry", ["initial"], ["release-git", "release-management"], [{ key: "release_branch", type: "text", required: false }]),
  capability("localization-download-merge-notify", "多语言下载 & 合入代码 & 提交 MR & 通知", "拉回翻译、应用到工程、提交受管理变更并发送通知。", "localization", ["initial"], ["release-localization", "release-git", "release-notification"], [
    { key: "force_rerun", type: "checkbox", required: false, label: "强制重新下载", placeholder: "忽略历史成功，重新 prepare/apply 并合入" },
  ]),
  capability("merge-release-to-master", "发版分支合回 master", "按 release-git Skill 的安全流程将发版分支合回 master。", "merge-master", ["initial"], ["release-git"]),
  capability("build-package", "构建发版包", "根据当前批次和 Skill 配置构建 Android 发版包并记录产物。", "build", ["initial", "supplemental"], ["release-channel-packages", "release-google-play"], [{ key: "build_number", type: "text", required: false, label: "构建号", placeholder: "未填则读活动发版清单" }]),
  capability("submit-approval", "提交发版审核单", "创建当前批次的发版审核草稿并返回审核记录。", "approval", ["initial", "supplemental"], ["release-approval", "release-records"]),
  capability("publish-and-notify", "首包/补包发布 & 通知", "检查当前 Skill 是否提供商店发布能力；具备能力时按确认流程发布并通知，否则返回 waiting 或 failed。", "publish", ["initial", "supplemental"], ["release-google-play", "release-notification", "release-records"]),
  capability("supplemental-notification", "补包通知", "通知协作者当前补包批次已创建并准备继续发布。", "entry", ["supplemental"], ["release-notification", "release-management"]),
  capability("rollout", "放量", "观察灰度指标并按确认要求推进当前版本放量。", "rollout", ["initial", "supplemental"], ["release-gray-observe", "release-metrics", "release-notification"], [
    { key: "gray_percent", type: "text", required: false, label: "目标灰度 %", placeholder: "如 5 / 50 / 100" },
  ]),
  capability("full-rollout", "全量发布", "在满足审核和指标条件后执行全量发布并记录结果。", "full-rollout", ["initial", "supplemental"], ["release-approval", "release-gray-observe", "release-notification", "release-records"]),
  // 用户需求点: 自由 Agent 可插入任意发版阶段，不进入状态机默认推荐；任务正文由操作员填写。
  capability("free-prompt-agent", "自由 Agent", "按操作员给出的任务说明，在锁定的发版上下文与 skillRoot 下执行发版相关操作。", "entry", ["initial", "supplemental"], ["release-runtime", "release-management"], [
    { key: "prompt", type: "textarea", required: true, label: "任务说明", placeholder: "描述要执行的发版任务，可点名 Skill / CLI…" },
    { key: "skill_hints", type: "text", required: false, label: "Skill 提示（可选）", placeholder: "release-git,release-localization" },
  ], {
    insertableInAnyStage: true,
    requiresConfirmation: false,
    promptTemplate: [
      "你是发版执行 Agent：版本页上下文已锁定，按操作员任务在 skillRoot 触发对应 Skill，不要只给计划。",
      "相关 Skill：${skillHints}。按 Skill operator-guide / cli 自行编排；失败再查 references/cli.md。",
      "禁止 skillhub evolve/detect/report。",
      "当前上下文：businessLine=${businessLine}，platform=${platform}，version=${version}，batch=${batch}，batchIndex=${batchIndex}。",
      "操作员任务：${prompt}",
      "必须只返回 JSON：{status:\"completed|waiting|failed\",summary,steps,records,artifacts,waiting,next_action}。",
    ].join("\n"),
  }),
];

const stage = (id, title, ids, extra = {}) => ({ id, title, nodes: ids.map((capabilityId) => ({ id: capabilityId })), ...extra });
const frozenCapabilities = freeze(capabilityDefinitions.map((item) => freeze({
  ...item, businessLines: freeze([...item.businessLines]), platforms: freeze([...item.platforms]), batches: freeze([...item.batches]),
  skillHints: freeze([...item.skillHints]), inputs: freeze(item.inputs.map((input) => freeze({ ...input }))),
  outputs: freeze(item.outputs.map((output) => freeze({ ...output }))),
})));

export const RELEASE_WORKFLOW_CONFIG = freeze({
  processOrder: freeze([...processOrder]), processTitles: freeze({ ...processTitles }), skillProcessMap: freeze({ ...skillProcessMap }),
  actionOrder, statusAliases: freeze({ succeeded: "completed", managed_mr_merged: "merged" }),
  capabilities: frozenCapabilities,
  compositeWorkflows: frozenCapabilities,
  workflows: freeze([freeze({
    id: "likee-android-release", title: "Likee Android 发版", businessLines: freeze(["likee"]), platforms: freeze(["android"]), batches: freeze(["initial", "supplemental"]), entryStageIds: freeze(["entry"]),
    stages: freeze([
      stage("entry", "发版入口", ["release-initialization:prepare-context", "localization-upload-notify", "create-release-branch", "supplemental-notification"], { order: 0 }),
      stage("localization", "多语言处理", ["localization-download-merge-notify"], { order: 1 }),
      stage("merge-master", "合回 master", ["merge-release-to-master"], { order: 2 }),
      stage("build", "构建包", ["build-package"], { order: 3 }),
      stage("approval", "提审单", ["submit-approval"], { order: 4 }),
      stage("publish", "发布并通知", ["publish-and-notify"], { order: 5 }),
      stage("rollout", "放量", ["rollout"], { order: 6 }),
      stage("full-rollout", "全量发布", ["full-rollout"], { order: 7 }),
    ].map((item) => freeze({ ...item, nodes: freeze(item.nodes.map((node) => freeze({ ...node }))), nodeIds: freeze(item.nodes.map((node) => node.id)), optionalNodeIds: freeze([]) }))),
    transitions: freeze([
      freeze({ id: "create_supplemental_batch", from: "rollout", to: "create_supplemental_batch", targetBatch: "supplemental", entryStageId: "entry", repeatable: true }),
      freeze({ id: "create_supplemental_batch", from: "full-rollout", to: "create_supplemental_batch", targetBatch: "supplemental", entryStageId: "entry", repeatable: true }),
    ]),
  })]),
});

// Compatibility name retained while callers migrate from “composite workflow” to capability terminology.
export const compositeWorkflows = RELEASE_WORKFLOW_CONFIG.capabilities;

function contextScope(context = {}) { return { businessLine: normalize(context.businessLine), platform: normalize(context.platform), batch: normalize(context.batch || "initial") || "initial" }; }
function scopeMatches(values, value) { return Array.isArray(values) && values.map(normalize).includes(normalize(value)); }
function stageEnabled(item, scope) { return !Array.isArray(item?.batches) || item.batches.map(normalize).includes(scope.batch); }
function nodeId(node) { return typeof node === "string" ? node : String(node?.id || "").trim(); }
function capabilityList(config = RELEASE_WORKFLOW_CONFIG) { return Array.isArray(config?.capabilities) ? config.capabilities : Array.isArray(config?.compositeWorkflows) ? config.compositeWorkflows : []; }

// 用户需求点: 能力和状态机必须按同一业务线、平台、批次上下文选择，不能跨平台暴露节点。
export function selectReleaseCompositeWorkflow(context = {}, config = RELEASE_WORKFLOW_CONFIG) {
  const scope = contextScope(context); const requestedId = String(context.capabilityId || context.compositeId || context.id || "").trim(); const stageId = String(context.stageId || "").trim();
  const candidates = capabilityList(config).filter((item) => scopeMatches(item?.businessLines, scope.businessLine) && scopeMatches(item?.platforms, scope.platform) && scopeMatches(item?.batches, scope.batch) && (!stageId || item?.insertableInAnyStage === true || String(item?.stageId || "") === stageId));
  if (requestedId) return candidates.find((item) => String(item?.id || "").trim() === requestedId) || null;
  return candidates.length === 1 ? candidates[0] : null;
}

// 用户需求点: 自由 Agent 等能力可插入任意阶段，不进入状态机默认节点列表，但仍要出现在自定义添加目录。
export function insertableReleaseCapabilities(context = {}, config = RELEASE_WORKFLOW_CONFIG) {
  const scope = contextScope(context);
  return capabilityList(config).filter((item) => item?.insertableInAnyStage === true
    && scopeMatches(item?.businessLines, scope.businessLine)
    && scopeMatches(item?.platforms, scope.platform)
    && scopeMatches(item?.batches, scope.batch));
}
export function selectReleaseCompositeForStage(context = {}, stageValue = {}, config = RELEASE_WORKFLOW_CONFIG) {
  const ids = Array.isArray(stageValue?.capabilityIds) ? stageValue.capabilityIds : workflowStageNodeIds(stageValue);
  const candidates = ids.map((id) => selectReleaseCompositeWorkflow({ ...context, capabilityId: id, stageId: stageValue?.id }, config)).filter(Boolean);
  return candidates.length === 1 ? candidates[0] : null;
}
// Deprecated adapter: capability definitions no longer contain an atomic Action sequence.
export function compositeActionIds() { return new Set(); }
export function workflowStageNodeIds(stageValue) {
  const entries = Array.isArray(stageValue?.nodes) ? stageValue.nodes : (Array.isArray(stageValue?.nodeIds) ? stageValue.nodeIds : stageValue?.capabilityIds);
  return (Array.isArray(entries) ? entries : []).map(nodeId).filter(Boolean);
}

// 用户需求点: 同一份配置同时决定状态流转和自定义阶段可执行节点集合，前后端必须按同一上下文选择 workflow。
export function selectReleaseWorkflow(context = {}, config = RELEASE_WORKFLOW_CONFIG) {
  const scope = contextScope(context);
  return (Array.isArray(config?.workflows) ? config.workflows : []).find((workflow) => scopeMatches(workflow?.businessLines, scope.businessLine) && scopeMatches(workflow?.platforms, scope.platform) && (!Array.isArray(workflow?.batches) || workflow.batches.map(normalize).includes(scope.batch))) || null;
}
export function workflowActionIds(workflow, context = {}, config = RELEASE_WORKFLOW_CONFIG) {
  const scope = contextScope(context); const ids = new Set();
  const capabilities = new Map(capabilityList(config).map((item) => [String(item?.id || "").trim(), item]));
  for (const item of Array.isArray(workflow?.stages) ? workflow.stages : []) {
    if (!stageEnabled(item, scope)) continue;
    for (const id of workflowStageNodeIds(item)) {
      const capability = capabilities.get(id);
      if (capability && scopeMatches(capability.businessLines, scope.businessLine)
        && scopeMatches(capability.platforms, scope.platform)
        && scopeMatches(capability.batches, scope.batch)) ids.add(id);
    }
  }
  return ids;
}
export function releaseActionProcessMetadata(actionId, node = {}, config = RELEASE_WORKFLOW_CONFIG, context = {}) {
  const id = String(actionId || node?.id || "").trim(); const explicit = String(node.processId || node.process?.id || "").trim(); const workflow = selectReleaseWorkflow(context, config); const stageValue = explicit ? null : (workflow?.stages || []).find((item) => stageEnabled(item, contextScope(context)) && workflowStageNodeIds(item).includes(id));
  const processId = explicit || stageValue?.id || skillProcessMap[normalize(node.skill || id.split(":")[0])] || "other";
  const processOrder = Number.isFinite(Number(node.processOrder)) ? Number(node.processOrder) : Number.isFinite(Number(stageValue?.order)) ? Number(stageValue.order) : (actionOrder[id] ?? 1000);
  const processTitle = String(node.processTitle || node.process?.title || stageValue?.title || processTitles[processId] || processId).trim();
  return { processId, processOrder, processTitle };
}

function validateScope(errors, item, id) {
  for (const [key, label] of [["businessLines", "business line scope"], ["platforms", "platform scope"], ["batches", "batch scope"]]) {
    const values = item?.[key]; if (!Array.isArray(values) || values.length === 0 || values.some((value) => !normalize(value))) errors.push(`${id || "workflow"} has empty ${label}`);
  }
}
export function validateReleaseWorkflowConfig(config) {
  const errors = []; if (!config || !Array.isArray(config.workflows)) return { valid: false, errors: ["workflows must be an array"] };
  const capabilities = capabilityList(config); if (!Array.isArray(capabilities)) return { valid: false, errors: ["capabilities must be an array"] };
  const capabilityIds = new Set();
  for (const item of capabilities) {
    if (!item || typeof item !== "object") { errors.push("malformed capability entry"); continue; }
    const id = String(item.id || "").trim(); if (!id) errors.push("capability id is required"); else if (capabilityIds.has(id)) errors.push(`duplicate capability id: ${id}`); capabilityIds.add(id); validateScope(errors, item, id || "capability");
    if (item.actions !== undefined) errors.push(`capability must not define actions: ${id}`); if (item.expandSourceFiles !== undefined) errors.push(`capability must not define expandSourceFiles: ${id}`);
    if (!String(item.promptTemplate || "").includes("${businessLine}")) errors.push(`capability promptTemplate must include businessLine: ${id}`);
    if (!Array.isArray(item.skillHints) || item.skillHints.length === 0 || item.skillHints.some((hint) => !normalize(hint).startsWith("release-"))) errors.push(`capability skillHints must reference release Skills: ${id}`);
    if (!Array.isArray(item.inputs) || !Array.isArray(item.outputs)) errors.push(`capability inputs and outputs must be arrays: ${id}`);
  }
  const workflowIds = new Set();
  for (const workflow of config.workflows) {
    if (!workflow || typeof workflow !== "object") { errors.push("malformed workflow entry"); continue; }
    const workflowId = String(workflow.id || "").trim(); if (!workflowId) errors.push("workflow id is required"); else if (workflowIds.has(workflowId)) errors.push(`duplicate workflow id: ${workflowId}`); workflowIds.add(workflowId); validateScope(errors, workflow, workflowId);
    if (!Array.isArray(workflow.stages) || workflow.stages.length === 0) { errors.push(`${workflowId} stages must be a non-empty array`); continue; }
    const stageIds = new Set(); const idsInWorkflow = new Set();
    for (const item of workflow.stages) {
      const stageId = String(item?.id || "").trim(); if (!stageId) errors.push(`${workflowId} has malformed stage`); else if (stageIds.has(stageId)) errors.push(`duplicate stage id: ${workflowId}/${stageId}`); stageIds.add(stageId);
      const ids = workflowStageNodeIds(item); if (!ids.length) errors.push(`${workflowId}/${stageId || "stage"} nodes must be a non-empty array`);
      for (const id of ids) { if (idsInWorkflow.has(id)) errors.push(`duplicate capability reference: ${workflowId}/${id}`); idsInWorkflow.add(id); if (!capabilityIds.has(id)) errors.push(`unknown capability reference: ${workflowId}/${id}`); }
      if (item.optionalNodeIds != null && !Array.isArray(item.optionalNodeIds)) errors.push(`optionalNodeIds must be an array: ${workflowId}/${stageId}`);
      for (const optionalId of item.optionalNodeIds || []) if (!ids.includes(nodeId(optionalId))) errors.push(`invalid optional reference: ${workflowId}/${optionalId}`);
    }
    for (const entry of workflow.transitions || []) { if (!entry || !String(entry.from || "").trim() || !String(entry.to || "").trim()) errors.push(`malformed transition: ${workflowId}`); if (entry.targetBatch && !workflow.batches.map(normalize).includes(normalize(entry.targetBatch))) errors.push(`invalid transition target batch: ${workflowId}/${entry.id || "transition"}`); }
  }
  return { valid: errors.length === 0, errors };
}
