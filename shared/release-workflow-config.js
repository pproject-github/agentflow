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
  "release-localization:send-upload-notification": 50,
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

export const RELEASE_WORKFLOW_CONFIG = freeze({
  processOrder: freeze([...processOrder]),
  processTitles: freeze({ ...processTitles }),
  skillProcessMap: freeze({ ...skillProcessMap }),
  actionOrder: freeze({ ...actionOrder }),
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
        stage("localization", "多语言处理", ["release-localization:upload-source-file", "release-localization:send-upload-notification", "release-localization:prepare-translation-archive", "release-localization:apply-translations", "release-localization:commit-localization-changes"], { batches: ["initial"] }),
        stage("records-summary", "更新摘要", ["release-records:compose-update-summary"]),
        stage("approval-initial", "首次发版审核", ["release-approval:create-initial-release-approval"], { batches: ["initial"] }),
        stage("approval-supplemental", "补包全量审核", ["release-approval:create-full-rollout-approval"], { batches: ["supplemental"] }),
        stage("metrics", "指标检查", ["release-metrics:query-version-metrics", "release-metrics:save-metrics-snapshot"], { optional: true }),
        stage("gray-observe", "灰度观察", ["release-gray-observe:observe-gray-dashboard"]),
        stage("records", "发版记录", ["release-records:append-release-wiki-row", "release-records:record-store-approved"]),
        stage("notification", "发版通知", ["release-notification:send-notification", "release-notification:send-rollout-notification"]),
        stage("channel-packages", "Android 渠道包", ["release-channel-packages:plan-channel-packages", "release-channel-packages:trigger-channel-packages-batch", "release-channel-packages:refresh-channel-package-build"], { optional: true }),
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
        stage("localization", "多语言处理", ["release-localization:upload-source-file", "release-localization:send-upload-notification", "release-localization:prepare-translation-archive", "release-localization:apply-translations", "release-localization:commit-localization-changes"]),
        stage("store", "商店版本说明", ["release-release-notes:upload-ios-release-notes"]),
        stage("records-summary", "更新摘要", ["release-records:compose-update-summary"]),
        stage("approval", "发版审核", ["release-approval:create-initial-release-approval", "release-approval:create-full-rollout-approval"]),
        stage("metrics", "指标检查", ["release-metrics:query-version-metrics", "release-metrics:save-metrics-snapshot"]),
        stage("gray-observe", "灰度观察", ["release-gray-observe:observe-gray-dashboard"]),
        stage("records", "发版记录", ["release-records:append-release-wiki-row", "release-records:record-store-approved", "release-records:record-full-rollout-time"], { optionalNodeIds: ["release-records:record-full-rollout-time"] }),
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
    }))),
  }))),
});

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

export function releaseActionProcessMetadata(actionId, node = {}, config = RELEASE_WORKFLOW_CONFIG) {
  const id = String(actionId || node?.id || "").trim();
  const skill = normalize(node.skill || id.split(":")[0]);
  const configuredProcess = String(node.processId || node.process?.id || "").trim();
  let configuredStage;
  if (!configuredProcess) {
    for (const workflow of Array.isArray(config?.workflows) ? config.workflows : []) {
      configuredStage = workflow.stages.find((item) => workflowStageNodeIds(item).includes(id));
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
  const workflowIds = new Set();
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
      }
      if (item.optionalNodeIds != null && !Array.isArray(item.optionalNodeIds)) {
        errors.push(`optionalNodeIds must be an array: ${workflowId}/${stageId || "stage"}`);
      } else {
        for (const optionalId of item.optionalNodeIds || []) {
          if (!nodes.some((node) => nodeId(node) === nodeId(optionalId))) errors.push(`invalid optional reference: ${workflowId}/${optionalId}`);
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
