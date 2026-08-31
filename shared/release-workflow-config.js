const freeze = (value) => Object.freeze(value);
const normalize = (value) => String(value ?? "").trim().toLowerCase();

const processOrder = [
  "preparation", "localization", "approval", "metrics", "gray-observe",
  "records", "channel-packages", "store", "notification",
];

const processTitles = {
  preparation: "发版准备",
  localization: "多语言处理",
  approval: "发版审核",
  metrics: "指标检查",
  "gray-observe": "灰度观察",
  records: "发版记录",
  "channel-packages": "渠道包",
  store: "商店发布",
  notification: "发版通知",
};

const skillProcessMap = {
  "release-setup": "preparation",
  "release-management": "preparation",
  "release-git": "preparation",
  "release-localization": "localization",
  "release-approval": "approval",
  "release-metrics": "metrics",
  "release-gray-observe": "gray-observe",
  "release-records": "records",
  "release-channel-packages": "channel-packages",
  "release-google-play": "store",
  "release-release-notes": "store",
  "release-notification": "notification",
};

const actionOrder = {
  "release-setup:configure-notification-recipient": 10,
  "release-setup:discover-skills": 20,
  "release-management:append-release-batch": 30,
  "release-management:register-release-branch": 40,
  "release-management:update-active-release": 50,
  "release-git:create-release-branch": 60,
  "release-git:commit-managed-changes": 70,
  "release-git:merge-release-to-main": 80,
  "release-git:merge-release-to-develop": 90,
  "release-git:enable-mr-auto-merge": 100,
  "release-localization:upload-source-file": 10,
  "release-localization:prepare-translation-archive": 20,
  "release-localization:apply-translations": 30,
  "release-localization:commit-localization-changes": 40,
  "release-approval:create-initial-release-approval": 10,
  "release-approval:create-full-rollout-approval": 20,
  "release-metrics:query-version-metrics": 10,
  "release-metrics:save-metrics-snapshot": 20,
  "release-gray-observe:observe-gray-dashboard": 10,
  "release-gray-observe:investigate-gray-anomaly": 20,
  "release-records:compose-update-summary": 10,
  "release-records:append-release-wiki-row": 20,
  "release-records:record-store-approved": 30,
  "release-records:record-full-rollout-time": 40,
  "release-channel-packages:plan-channel-packages": 10,
  "release-channel-packages:trigger-channel-package": 20,
  "release-channel-packages:trigger-channel-packages-batch": 30,
  "release-channel-packages:refresh-channel-package-build": 40,
  "release-google-play:preview-aab-submission": 10,
  "release-google-play:submit-aab-internal-testing": 20,
  "release-release-notes:upload-ios-release-notes": 10,
  "release-notification:send-notification": 10,
  "release-notification:send-rollout-notification": 20,
};

const action = (id) => ({ id });
const stage = (id, title, nodeIds, extra = {}) => ({
  id, title, nodes: nodeIds.map(action), ...extra,
});

const composite = (id, title, description, businessLines, platforms, batches, actions, extra = {}) => ({
  id,
  title,
  description,
  businessLines,
  platforms,
  batches,
  actions,
  ...extra,
});

// 用户需求点: 复合节点把多个 release-skill 原子能力收敛为一个可执行发版阶段，默认推荐以减少人工逐步操作。
const compositeDefinitions = [
  composite(
    "localization-upload-notify",
    "多语言上传 & 通知",
    "上传源多语言文件，成功后发送多语言上传通知。",
    ["likee"],
    ["android", "ios"],
    ["initial", "supplemental"],
    [
      { stepId: "upload", id: "release-localization:upload-source-file", inputs: { source_path: { context: "source_path" } }, continueOn: ["completed"] },
      { stepId: "notify", id: "release-notification:send-notification", inputs: { event: "localization-uploaded", source_record_id: { fromStep: "upload", output: "record_id" } }, waitFor: { step: "upload", statuses: ["completed", "confirmed"] } },
    ],
    { default: true, stageIds: ["localization"], intent: "upload", consumesAtomicActionIds: ["release-localization:upload-source-file", "release-notification:send-notification"] },
  ),
  composite(
    "localization-download-merge-notify",
    "多语言下载 & 合入 & 通知",
    "准备翻译归档，应用翻译并提交多语言变更，随后发送回仓通知。",
    ["likee"],
    ["android", "ios"],
    ["initial", "supplemental"],
    [
      { stepId: "prepare", id: "release-localization:prepare-translation-archive", inputs: {}, continueOn: ["completed"] },
      { stepId: "apply", id: "release-localization:apply-translations", inputs: { prepare_record_id: { fromStep: "prepare", output: "record_id" } }, requiresConfirmation: true, waitFor: { step: "prepare", statuses: ["completed", "confirmed"] }, continueOn: ["completed", "confirmed"] },
      { stepId: "commit", id: "release-localization:commit-localization-changes", inputs: { apply_record_id: { fromStep: "apply", output: "record_id" } }, requiresConfirmation: true, continueOn: ["merged", "confirmed"] },
      { stepId: "notify", id: "release-notification:send-notification", inputs: { event: "localization-applied", source_record_id: { fromStep: "commit", output: "record_id" }, merge_request_url: { fromStep: "commit", output: "operator_url" } }, waitFor: { step: "commit", statuses: ["merged", "confirmed"] }, requiresConfirmation: true },
    ],
    { default: true, stageIds: ["localization"], intent: "download", consumesAtomicActionIds: ["release-localization:prepare-translation-archive", "release-localization:apply-translations", "release-localization:commit-localization-changes", "release-notification:send-notification"] },
  ),
  composite(
    "release-summary-record",
    "更新摘要 & 登记发版记录",
    "整理本次发版更新摘要并登记到发版 Wiki。",
    ["likee"],
    ["android", "ios"],
    ["initial", "supplemental"],
    [
      { stepId: "summary", id: "release-records:compose-update-summary", inputs: { as_of_date: { context: "as_of_date" }, include_git_summary: { context: "include_git_summary" } }, continueOn: ["completed", "confirmed"] },
      { stepId: "wiki", id: "release-records:append-release-wiki-row", inputs: { updates_text: { fromStep: "summary", output: "updates_text" } }, requiresConfirmation: true, waitFor: { step: "summary", statuses: ["confirmed"] } },
    ],
    { default: true, stageIds: ["records"], intent: "summary", consumesAtomicActionIds: ["release-records:compose-update-summary", "release-records:append-release-wiki-row"] },
  ),
  composite(
    "android-channel-packages",
    "Android 渠道包批量构建",
    "规划渠道包、批量触发构建并刷新构建状态。",
    ["likee"],
    ["android"],
    ["initial", "supplemental"],
    [
      { stepId: "plan", id: "release-channel-packages:plan-channel-packages", inputs: { build_number: { context: "build_number" } }, continueOn: ["completed"] },
      { stepId: "trigger", id: "release-channel-packages:trigger-channel-packages-batch", inputs: {}, requiresConfirmation: true, continueOn: ["completed"] },
      { stepId: "refresh", id: "release-channel-packages:refresh-channel-package-build", inputs: {}, forEach: { source: "planned_items", expectedCount: 6, itemInput: "item_id" } },
    ],
    { default: true, stageIds: ["channel-packages"], intent: "channel-packages", expectedCount: 6, consumesAtomicActionIds: ["release-channel-packages:plan-channel-packages", "release-channel-packages:trigger-channel-packages-batch", "release-channel-packages:refresh-channel-package-build"] },
  ),
];

export const RELEASE_WORKFLOW_CONFIG = freeze({
  processOrder: freeze([...processOrder]),
  processTitles: freeze({ ...processTitles }),
  skillProcessMap: freeze({ ...skillProcessMap }),
  actionOrder: freeze({ ...actionOrder }),
  statusAliases: freeze({ succeeded: "completed", managed_mr_merged: "merged" }),
  workflows: freeze([
    {
      id: "likee-android-release",
      title: "Likee Android 发版",
      businessLines: ["likee"],
      platforms: ["android"],
      batches: ["initial", "supplemental"],
      evidence: { records: 35, succeeded: 31, failed: 0, unknown: 4, versions: ["5.63.0"] },
      stages: [
        stage("preparation-initial", "首包准备", ["release-setup:configure-notification-recipient", "release-setup:discover-skills", "release-git:create-release-branch", "release-management:register-release-branch", "release-git:commit-managed-changes", "release-git:merge-release-to-main", "release-git:merge-release-to-develop", "release-git:enable-mr-auto-merge"], { batches: ["initial"], optionalNodeIds: ["release-setup:configure-notification-recipient", "release-setup:discover-skills", "release-git:commit-managed-changes", "release-git:merge-release-to-main", "release-git:merge-release-to-develop", "release-git:enable-mr-auto-merge"] }),
        stage("preparation-supplemental", "补包准备", ["release-management:append-release-batch", "release-management:update-active-release"], { batches: ["supplemental"] }),
        stage("localization", "多语言处理", ["release-localization:upload-source-file", "release-localization:prepare-translation-archive", "release-localization:apply-translations", "release-localization:commit-localization-changes"], { batches: ["initial"], compositeIds: ["localization-upload-notify", "localization-download-merge-notify"], defaultCompositeIds: ["localization-upload-notify", "localization-download-merge-notify"] }),
        stage("records-summary", "更新摘要", ["release-records:compose-update-summary"]),
        stage("approval-initial", "首次发版审核", ["release-approval:create-initial-release-approval"], { batches: ["initial"] }),
        stage("approval-full", "全量发布审核", ["release-approval:create-full-rollout-approval"]),
        stage("metrics", "指标检查", ["release-metrics:query-version-metrics", "release-metrics:save-metrics-snapshot"], { optional: true }),
        stage("gray-observe", "灰度观察", ["release-gray-observe:observe-gray-dashboard"]),
        stage("records", "发版记录", ["release-records:append-release-wiki-row", "release-records:record-store-approved"], { compositeIds: ["release-summary-record"], defaultCompositeIds: ["release-summary-record"] }),
        stage("notification", "发版通知", ["release-notification:send-notification", "release-notification:send-rollout-notification"]),
        stage("channel-packages", "Android 渠道包", ["release-channel-packages:plan-channel-packages", "release-channel-packages:trigger-channel-packages-batch", "release-channel-packages:refresh-channel-package-build"], { optional: true, compositeIds: ["android-channel-packages"], defaultCompositeIds: ["android-channel-packages"] }),
      ],
    },
    {
      id: "likee-ios-release",
      title: "Likee iOS 首包 / 补包",
      businessLines: ["likee"],
      platforms: ["ios"],
      batches: ["initial", "supplemental"],
      evidence: { records: 0, succeeded: 0, failed: 0, unknown: 0, versions: [] },
      stages: [
        stage("preparation", "发版准备", ["release-git:create-release-branch", "release-management:register-release-branch"]),
        stage("localization", "多语言处理", ["release-localization:upload-source-file", "release-localization:prepare-translation-archive", "release-localization:apply-translations", "release-localization:commit-localization-changes"], { compositeIds: ["localization-upload-notify", "localization-download-merge-notify"], defaultCompositeIds: ["localization-upload-notify", "localization-download-merge-notify"] }),
        stage("store", "商店版本说明", ["release-release-notes:upload-ios-release-notes"]),
        stage("records-summary", "更新摘要", ["release-records:compose-update-summary"]),
        stage("approval-initial", "首次发版审核", ["release-approval:create-initial-release-approval"], { batches: ["initial"] }),
        stage("approval-full", "全量发布审核", ["release-approval:create-full-rollout-approval"]),
        stage("metrics", "指标检查", ["release-metrics:query-version-metrics", "release-metrics:save-metrics-snapshot"]),
        stage("gray-observe", "灰度观察", ["release-gray-observe:observe-gray-dashboard"]),
        stage("records", "发版记录", ["release-records:append-release-wiki-row", "release-records:record-store-approved", "release-records:record-full-rollout-time"], { optionalNodeIds: ["release-records:record-full-rollout-time"], compositeIds: ["release-summary-record"], defaultCompositeIds: ["release-summary-record"] }),
        stage("notification", "发版通知", ["release-notification:send-notification", "release-notification:send-rollout-notification"]),
      ],
    },
  ].map((workflow) => freeze({
    ...workflow,
    businessLines: freeze([...workflow.businessLines]),
    platforms: freeze([...workflow.platforms]),
    batches: freeze([...workflow.batches]),
    evidence: freeze({ ...workflow.evidence, versions: freeze([...(workflow.evidence?.versions || [])]) }),
    stages: freeze(workflow.stages.map((item) => freeze({
      ...item,
      batches: item.batches ? freeze([...item.batches]) : item.batches,
      nodes: freeze(item.nodes.map((node) => freeze({ ...node }))),
      nodeIds: freeze(item.nodes.map((node) => node.id)),
      optionalNodeIds: freeze([...(item.optionalNodeIds || [])]),
      ...(item.compositeIds != null ? { compositeIds: freeze([...item.compositeIds]) } : {}),
      ...(item.defaultCompositeIds != null ? { defaultCompositeIds: freeze([...item.defaultCompositeIds]) } : {}),
    }))),
  }))),
  compositeWorkflows: freeze(compositeDefinitions.map((item) => freeze({
    ...item,
    businessLines: freeze([...item.businessLines]),
    platforms: freeze([...item.platforms]),
    batches: freeze([...item.batches]),
    actions: freeze(item.actions.map((entry) => freeze({
      ...entry,
      ...(entry.inputs && typeof entry.inputs === "object" ? { inputs: freeze(Object.fromEntries(Object.entries(entry.inputs).map(([key, value]) => [key, value && typeof value === "object" ? freeze({ ...value }) : value]))) } : {}),
      ...(entry.continueOn ? { continueOn: freeze([...entry.continueOn]) } : {}),
      ...(entry.waitFor && typeof entry.waitFor === "object" ? { waitFor: freeze({ ...entry.waitFor, statuses: freeze([...(entry.waitFor.statuses || [])]) }) } : {}),
      ...(entry.forEach && typeof entry.forEach === "object" ? { forEach: freeze({ ...entry.forEach }) } : {}),
    }))),
    ...(item.stageIds ? { stageIds: freeze([...item.stageIds]) } : {}),
    ...(item.consumesAtomicActionIds ? { consumesAtomicActionIds: freeze([...item.consumesAtomicActionIds]) } : {}),
  }))),
});

export const compositeWorkflows = RELEASE_WORKFLOW_CONFIG.compositeWorkflows;

function contextScope(context = {}) {
  return {
    businessLine: normalize(context.businessLine),
    platform: normalize(context.platform),
    batch: normalize(context.batch || "initial") || "initial",
  };
}

function stageEnabled(item, scope) {
  return !Array.isArray(item?.batches) || item.batches.map(normalize).includes(scope.batch);
}

function nodeId(node) {
  return typeof node === "string" ? node : String(node?.id || "").trim();
}

function compositeActionEntries(composite) {
  return Array.isArray(composite?.actions) ? composite.actions : [];
}

function scopeMatches(value, scope) {
  return Array.isArray(value) && value.map(normalize).includes(scope);
}

function actionScopeMatches(value, scope) {
  return !Array.isArray(value) || value.map(normalize).includes(scope);
}

// 用户需求点: 复合节点和原子节点共用业务线、平台、批次作用域，避免跨平台暴露不可执行流程。
export function selectReleaseCompositeWorkflow(context = {}, config = RELEASE_WORKFLOW_CONFIG) {
  const scope = contextScope(context);
  const requestedId = String(context.compositeId || context.id || "").trim();
  const stageId = String(context.stageId || "").trim();
  const intent = String(context.intent || "").trim().toLowerCase();
  const matches = (Array.isArray(config?.compositeWorkflows) ? config.compositeWorkflows : []).filter((item) => (
    scopeMatches(item?.businessLines, scope.businessLine)
      && scopeMatches(item?.platforms, scope.platform)
      && scopeMatches(item?.batches, scope.batch)
      && (!stageId || (Array.isArray(item?.stageIds) && item.stageIds.includes(stageId)))
      && (!intent || normalize(item?.intent) === intent)
  ));
  if (requestedId) return matches.find((item) => String(item?.id || "").trim() === requestedId) || null;
  const defaults = matches.filter((item) => item?.default === true);
  return defaults.length === 1 ? defaults[0] : (matches.length === 1 ? matches[0] : null);
}

// 用户需求点: 阶段有多个默认复合流程时必须由阶段引用和操作意图消歧，不能静默执行错误流程。
export function selectReleaseCompositeForStage(context = {}, stage = {}, config = RELEASE_WORKFLOW_CONFIG) {
  const ids = Array.isArray(stage?.defaultCompositeIds) ? stage.defaultCompositeIds : (Array.isArray(stage?.compositeIds) ? stage.compositeIds : []);
  const candidates = ids
    .map((id) => selectReleaseCompositeWorkflow({ ...context, compositeId: id, stageId: stage?.id }, config))
    .filter(Boolean);
  const intent = String(context.intent || "").trim().toLowerCase();
  const matching = intent ? candidates.filter((item) => normalize(item.intent) === intent) : candidates;
  return matching.length === 1 ? matching[0] : null;
}

export function compositeActionIds(composite, context = {}) {
  const scope = contextScope(context);
  const ids = new Set();
  if (!scopeMatches(composite?.businessLines, scope.businessLine)
    || !scopeMatches(composite?.platforms, scope.platform)
    || !scopeMatches(composite?.batches, scope.batch)) return ids;
  for (const entry of compositeActionEntries(composite)) {
    const id = nodeId(entry);
    if (!id) continue;
    if (!actionScopeMatches(entry?.businessLines, scope.businessLine)
      || !actionScopeMatches(entry?.platforms, scope.platform)
      || !actionScopeMatches(entry?.batches, scope.batch)) continue;
    ids.add(id);
  }
  return ids;
}

export function workflowStageNodeIds(stage) {
  const entries = Array.isArray(stage?.nodes) ? stage.nodes : (Array.isArray(stage?.nodeIds) ? stage.nodeIds : []);
  return entries.map(nodeId).filter(Boolean);
}

// 用户需求点: 同一份配置同时决定状态流转和自定义阶段可执行节点集合，前后端必须按同一上下文选择 workflow。
export function selectReleaseWorkflow(context = {}, config = RELEASE_WORKFLOW_CONFIG) {
  const scope = contextScope(context);
  return (Array.isArray(config?.workflows) ? config.workflows : []).find((workflow) => (
    Array.isArray(workflow?.businessLines) && workflow.businessLines.map(normalize).includes(scope.businessLine)
      && Array.isArray(workflow?.platforms) && workflow.platforms.map(normalize).includes(scope.platform)
      && (!Array.isArray(workflow.batches) || workflow.batches.map(normalize).includes(scope.batch))
  )) || null;
}

export function workflowActionIds(workflow, context = {}) {
  const scope = contextScope(context);
  const ids = new Set();
  for (const item of Array.isArray(workflow?.stages) ? workflow.stages : []) {
    if (!stageEnabled(item, scope)) continue;
    for (const id of workflowStageNodeIds(item)) ids.add(id);
  }
  return ids;
}

export function releaseActionProcessMetadata(actionId, node = {}, config = RELEASE_WORKFLOW_CONFIG, context = {}) {
  const id = String(actionId || node?.id || "").trim();
  const skill = normalize(node.skill || id.split(":")[0]);
  const configuredProcess = String(node.processId || node.process?.id || "").trim();
  let configuredStage;
  if (!configuredProcess) {
    const hasContextScope = Boolean(String(context?.businessLine || "").trim() || String(context?.platform || "").trim());
    const workflows = hasContextScope
      ? [selectReleaseWorkflow(context, config)].filter(Boolean)
      : (Array.isArray(config?.workflows) ? config.workflows : []);
    const scope = hasContextScope ? contextScope(context) : null;
    for (const workflow of workflows) {
      configuredStage = workflow.stages.find((item) => (!scope || stageEnabled(item, scope)) && workflowStageNodeIds(item).includes(id));
      if (configuredStage) break;
    }
  }
  const processId = configuredProcess || configuredStage?.id || skillProcessMap[skill] || "other";
  const configuredOrder = Number(node.processOrder ?? node.process?.order);
  const processOrder = Number.isFinite(configuredOrder) ? configuredOrder : (actionOrder[id] ?? 1000);
  const processTitle = String(node.processTitle || node.process?.title || configuredStage?.title || processTitles[processId] || processId).trim();
  return { processId, processOrder, processTitle };
}

export function validateReleaseWorkflowConfig(config) {
  const errors = [];
  if (!config || !Array.isArray(config.workflows)) return { valid: false, errors: ["workflows must be an array"] };
  if (config.compositeWorkflows != null && !Array.isArray(config.compositeWorkflows)) {
    errors.push("compositeWorkflows must be an array");
  }
  const workflowIds = new Set();
  const configuredActionIds = new Set();
  const compositeIds = new Set();
  for (const workflow of config.workflows) {
    if (!workflow || typeof workflow !== "object") { errors.push("malformed workflow entry"); continue; }
    const workflowId = String(workflow.id || "").trim();
    if (!workflowId) errors.push("workflow id is required");
    else if (workflowIds.has(workflowId)) errors.push(`duplicate workflow id: ${workflowId}`);
    workflowIds.add(workflowId);
    for (const [key, label] of [["businessLines", "business line scope"], ["platforms", "platform scope"], ["batches", "batch scope"]]) {
      const values = workflow[key];
      if (!Array.isArray(values) || values.length === 0 || values.some((value) => !normalize(value))) {
        errors.push(`${workflowId || "workflow"} has empty ${label}`);
      }
    }
    if (!Array.isArray(workflow.stages) || workflow.stages.length === 0) { errors.push(`${workflowId || "workflow"} stages must be a non-empty array`); continue; }
    const stageIds = new Set();
    const actionIds = new Set();
    for (const item of workflow.stages) {
      const stageId = String(item?.id || "").trim();
      if (!stageId) errors.push(`${workflowId} has malformed stage`);
      else if (stageIds.has(stageId)) errors.push(`duplicate stage id: ${workflowId}/${stageId}`);
      stageIds.add(stageId);
      const nodes = Array.isArray(item?.nodes) ? item.nodes : item?.nodeIds;
      if (!Array.isArray(nodes) || nodes.length === 0) { errors.push(`${workflowId}/${stageId || "stage"} nodes must be a non-empty array`); continue; }
      for (const node of nodes) {
        const id = nodeId(node);
        if (!id) errors.push(`malformed node entry: ${workflowId}/${stageId}`);
        else if (actionIds.has(id)) errors.push(`duplicate Action reference: ${workflowId}/${id}`);
        actionIds.add(id);
        configuredActionIds.add(id);
      }
      if (item.optionalNodeIds != null && !Array.isArray(item.optionalNodeIds)) {
        errors.push(`optionalNodeIds must be an array: ${workflowId}/${stageId || "stage"}`);
      } else {
        for (const optionalId of item.optionalNodeIds || []) {
          if (!nodes.some((node) => nodeId(node) === nodeId(optionalId))) errors.push(`invalid optional reference: ${workflowId}/${optionalId}`);
        }
      }
      for (const key of ["compositeIds", "defaultCompositeIds"]) {
        if (item[key] != null && !Array.isArray(item[key])) {
          errors.push(`${key} must be an array: ${workflowId}/${stageId || "stage"}`);
        }
      }
    }
  }

  for (const item of Array.isArray(config.compositeWorkflows) ? config.compositeWorkflows : []) {
    if (!item || typeof item !== "object") { errors.push("malformed composite workflow entry"); continue; }
    const id = String(item.id || "").trim();
    if (!id) errors.push("composite workflow id is required");
    else if (compositeIds.has(id)) errors.push(`duplicate composite workflow id: ${id}`);
    compositeIds.add(id);
    for (const [key, label] of [["businessLines", "business line scope"], ["platforms", "platform scope"], ["batches", "batch scope"]]) {
      const values = item[key];
      if (!Array.isArray(values) || values.length === 0 || values.some((value) => !normalize(value))) {
        errors.push(`${id || "composite workflow"} has empty ${label}`);
      }
    }
    const actions = item.actions;
    if (!Array.isArray(actions) || actions.length === 0) {
      errors.push(`${id || "composite workflow"} actions must be a non-empty array`);
      continue;
    }
    const internalIds = new Set();
    const stepIds = new Set();
    for (const entry of actions) {
      const actionId = nodeId(entry);
      if (!actionId) {
        errors.push(`malformed composite Action entry: ${id || "composite workflow"}`);
        continue;
      }
      if (internalIds.has(actionId)) errors.push(`duplicate internal Action reference: ${id}/${actionId}`);
      internalIds.add(actionId);
      if (!configuredActionIds.has(actionId)) errors.push(`unknown composite Action reference: ${id}/${actionId}`);
      const compatibleWorkflow = config.workflows.some((workflow) => {
        const workflowActions = new Set((Array.isArray(workflow?.stages) ? workflow.stages : []).flatMap((candidateStage) => {
          const candidateNodes = Array.isArray(candidateStage?.nodes) ? candidateStage.nodes : candidateStage?.nodeIds;
          return Array.isArray(candidateNodes) ? candidateNodes.map(nodeId) : [];
        }));
        const businessOverlap = Array.isArray(item.businessLines) && Array.isArray(workflow.businessLines)
          && item.businessLines.some((value) => workflow.businessLines.map(normalize).includes(normalize(value)));
        const platformOverlap = Array.isArray(item.platforms) && Array.isArray(workflow.platforms)
          && item.platforms.some((value) => workflow.platforms.map(normalize).includes(normalize(value)));
        const batchCoverage = Array.isArray(item.batches) && Array.isArray(workflow.batches)
          && item.batches.every((value) => workflow.batches.map(normalize).includes(normalize(value)));
        return workflowActions.has(actionId) && businessOverlap && platformOverlap && batchCoverage;
      });
      if (!compatibleWorkflow) errors.push(`composite Action workflow scope mismatch: ${id}/${actionId}`);
      const stepId = String(entry?.stepId || "").trim();
      if (!stepId) errors.push(`composite Action stepId is required: ${id}/${actionId}`);
      else if (stepIds.has(stepId)) errors.push(`duplicate composite stepId: ${id}/${stepId}`);
      stepIds.add(stepId);
      if (!entry?.inputs || typeof entry.inputs !== "object" || Array.isArray(entry.inputs)) {
        errors.push(`composite Action inputs must be an object: ${id}/${stepId || actionId}`);
      } else {
        for (const [inputName, mapping] of Object.entries(entry.inputs)) {
          if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) continue;
          const fromStep = String(mapping.fromStep || "").trim();
          const contextKey = String(mapping.context || "").trim();
          if (fromStep && !actions.some((candidate) => String(candidate?.stepId || "").trim() === fromStep)) {
            errors.push(`unknown input source step: ${id}/${stepId}/${inputName}/${fromStep}`);
          }
          if (!fromStep && !contextKey && Object.keys(mapping).length > 0) {
            errors.push(`invalid input mapping: ${id}/${stepId}/${inputName}`);
          }
        }
      }
      if (entry?.continueOn != null && (!Array.isArray(entry.continueOn) || entry.continueOn.length === 0)) {
        errors.push(`continueOn must be a non-empty array: ${id}/${stepId || actionId}`);
      }
      if (entry?.waitFor != null) {
        const waitFor = entry.waitFor;
        const waitStep = String(waitFor?.step || "").trim();
        if (!waitStep || !actions.some((candidate) => String(candidate?.stepId || "").trim() === waitStep)) errors.push(`unknown waitFor step: ${id}/${stepId || actionId}/${waitStep}`);
        if (!Array.isArray(waitFor?.statuses) || waitFor.statuses.length === 0) errors.push(`waitFor statuses must be a non-empty array: ${id}/${stepId || actionId}`);
      }
      if (entry?.forEach != null) {
        if (!entry.forEach || typeof entry.forEach !== "object" || !String(entry.forEach.source || "").trim()) errors.push(`forEach source is required: ${id}/${stepId || actionId}`);
        if (!Number.isInteger(Number(entry.forEach.expectedCount)) || Number(entry.forEach.expectedCount) < 1) errors.push(`forEach expectedCount must be positive: ${id}/${stepId || actionId}`);
        if (!String(entry.forEach.itemInput || "").trim()) errors.push(`forEach itemInput is required: ${id}/${stepId || actionId}`);
      }
    }
    if (item.expectedCount != null && (!Number.isInteger(Number(item.expectedCount)) || Number(item.expectedCount) < 1)) errors.push(`expectedCount must be positive: ${id}`);
    if (item.stageIds != null && (!Array.isArray(item.stageIds) || item.stageIds.length === 0)) errors.push(`stageIds must be a non-empty array: ${id}`);
    if (item.consumesAtomicActionIds != null && !Array.isArray(item.consumesAtomicActionIds)) errors.push(`consumesAtomicActionIds must be an array: ${id}`);
  }

  for (const workflow of config.workflows) {
    const workflowId = String(workflow?.id || "").trim();
    for (const item of Array.isArray(workflow?.stages) ? workflow.stages : []) {
      const stageId = String(item?.id || "").trim();
      const composites = Array.isArray(item?.compositeIds) ? item.compositeIds : [];
      const defaults = Array.isArray(item?.defaultCompositeIds) ? item.defaultCompositeIds : [];
      for (const compositeId of [...composites, ...defaults]) {
        const normalizedId = String(compositeId || "").trim();
        if (!compositeIds.has(normalizedId)) errors.push(`invalid composite reference: ${workflowId}/${stageId}/${compositeId}`);
        const composite = (Array.isArray(config.compositeWorkflows) ? config.compositeWorkflows : []).find((candidate) => String(candidate?.id || "").trim() === normalizedId);
        if (composite) {
          const workflowScope = { businessLines: workflow.businessLines, platforms: workflow.platforms, batches: workflow.batches };
          const stageBatches = Array.isArray(item.batches) ? item.batches : workflow.batches;
          const intersects = [
            [composite.businessLines, workflowScope.businessLines],
            [composite.platforms, workflowScope.platforms],
            [composite.batches, stageBatches],
          ].every(([left, right]) => Array.isArray(left) && Array.isArray(right) && left.some((value) => right.map(normalize).includes(normalize(value))));
          if (!intersects) errors.push(`composite scope does not intersect workflow/stage: ${workflowId}/${stageId}/${normalizedId}`);
          if (!Array.isArray(composite.stageIds) || !composite.stageIds.includes(stageId)) errors.push(`composite stageIds must include referenced stage: ${workflowId}/${stageId}/${normalizedId}`);
          const consumed = Array.isArray(composite.consumesAtomicActionIds) ? composite.consumesAtomicActionIds : [];
          const workflowNodes = new Set((Array.isArray(workflow.stages) ? workflow.stages : []).flatMap((candidateStage) => {
            const candidateNodes = Array.isArray(candidateStage?.nodes) ? candidateStage.nodes : candidateStage?.nodeIds;
            return Array.isArray(candidateNodes) ? candidateNodes.map(nodeId) : [];
          }));
          for (const consumedId of consumed) if (!workflowNodes.has(nodeId(consumedId))) errors.push(`composite replacement must reference workflow Action: ${workflowId}/${stageId}/${normalizedId}/${consumedId}`);
        }
      }
      for (const compositeId of defaults) {
        if (!composites.some((candidate) => String(candidate || "").trim() === String(compositeId || "").trim())) {
          errors.push(`default composite must be listed in compositeIds: ${workflowId}/${stageId}/${compositeId}`);
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
