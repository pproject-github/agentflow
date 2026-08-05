import crypto from "node:crypto";

const WORKFLOW_REPORT_SCHEMA_VERSION = 1;
const WORKFLOW_ACTION_STATUSES = new Set([
  "pending",
  "running",
  "done",
  "error",
  "conflict",
  "skipped",
  "cancelled",
  "observed",
]);
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanString(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function hasOwn(value, key) {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => !UNSAFE_OBJECT_KEYS.has(key))
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function valueKey(value) {
  try {
    return JSON.stringify(stableValue(value));
  } catch {
    return String(value);
  }
}

function uniqueValues(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (value == null || value === "") continue;
    const key = valueKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function normalizeActionStatus(value) {
  const raw = cleanString(value, 40).toLowerCase();
  const aliases = {
    success: "done",
    succeeded: "done",
    complete: "done",
    completed: "done",
    failed: "error",
    failure: "error",
    canceled: "cancelled",
    in_progress: "running",
    "in-progress": "running",
  };
  const normalized = aliases[raw] || raw || "pending";
  return WORKFLOW_ACTION_STATUSES.has(normalized) ? normalized : "pending";
}

function normalizeStringList(value, maxItems = 100) {
  const list = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return uniqueValues(list.map((item) => cleanString(item, 240)).filter(Boolean)).slice(0, maxItems);
}

function normalizeWorkflowArtifact(value, index = 0, defaultScope = "action") {
  const raw = plainObject(value);
  const url = cleanString(raw.url || raw.href, 4000);
  const path = cleanString(raw.path, 4000);
  const title = cleanString(raw.title || raw.label || raw.name || url || path || `Artifact ${index + 1}`, 500);
  const type = cleanString(raw.type || raw.kind || "artifact", 120).toLowerCase() || "artifact";
  const key = cleanString(
    raw.key ||
    raw.id ||
    [type, url || path || title].filter(Boolean).join(":") ||
    `artifact-${index + 1}`,
    500,
  );
  const scope = cleanString(raw.scope || defaultScope, 40).toLowerCase() === "global" ? "global" : "action";
  return {
    ...raw,
    key,
    type,
    kind: cleanString(raw.kind || type, 120) || type,
    title,
    label: cleanString(raw.label || title, 500) || title,
    ...(url ? { url } : {}),
    ...(path ? { path } : {}),
    scope,
    status: cleanString(raw.status, 80),
  };
}

export function normalizeWorkflowTimelineProjection(value, index = 0) {
  const raw = plainObject(value);
  const kind = cleanString(raw.kind || raw.type, 80).toLowerCase();
  const id = cleanString(raw.id || raw.key, 240);
  if (!kind || !id) return null;
  const source = cleanString(raw.source || raw.namespace, 120).toLowerCase();
  const date = cleanString(raw.date || raw.targetDate || raw.target_date, 80);
  const dimensions = mergeWorkflowGlobalState({}, plainObject(raw.dimensions || raw.facets));
  const key = cleanString(raw.key || [source, kind, id].filter(Boolean).join(":"), 500);
  return {
    ...mergeWorkflowGlobalState({}, raw),
    key: key || `${kind}:${id}`,
    kind,
    id,
    title: cleanString(raw.title || raw.label || id, 500) || id,
    ...(source ? { source } : {}),
    ...(date ? { date } : {}),
    dimensions,
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index,
  };
}

function normalizeWorkflowProjectionState(value = {}) {
  const raw = mergeWorkflowGlobalState({}, plainObject(value));
  if (Array.isArray(value?.timeline)) {
    raw.timeline = value.timeline
      .map((item, index) => normalizeWorkflowTimelineProjection(item, index))
      .filter(Boolean)
      .slice(0, 100);
  } else {
    delete raw.timeline;
  }
  return raw;
}

export function normalizeWorkflowExtensions(value = {}) {
  const raw = plainObject(value);
  const out = {};
  for (const [namespace, extension] of Object.entries(raw)) {
    const key = cleanString(namespace, 120).toLowerCase();
    if (!key || !/^[a-z][a-z0-9._-]{0,119}$/.test(key)) continue;
    if (!extension || typeof extension !== "object" || Array.isArray(extension)) continue;
    out[key] = mergeWorkflowGlobalState({}, extension);
  }
  return out;
}

export function materializeWorkflowExtensions(snapshot = {}, runtimeEvents = []) {
  let extensions = normalizeWorkflowExtensions(
    snapshot.extensions || snapshot.workflowExtensions || snapshot.workflow_extensions || {},
  );
  const events = [...(Array.isArray(runtimeEvents) ? runtimeEvents : [])]
    .sort((left, right) => eventTime(left) - eventTime(right));
  for (const event of events) {
    const patch = event?.extensionsPatch || event?.extensions_patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) continue;
    extensions = mergeWorkflowGlobalState(extensions, normalizeWorkflowExtensions(patch));
  }
  return extensions;
}

export function materializeWorkflowProjections(snapshot = {}, runtimeEvents = []) {
  const base =
    snapshot.projections ||
    snapshot.workflowProjections ||
    snapshot.workflow_projections ||
    snapshot.raw?.projections ||
    {};
  let projections = normalizeWorkflowProjectionState(base);
  const events = [...(Array.isArray(runtimeEvents) ? runtimeEvents : [])]
    .sort((left, right) => eventTime(left) - eventTime(right));
  for (const event of events) {
    const next = event?.projections || event?.workflowProjections || event?.workflow_projections;
    if (!next || typeof next !== "object" || Array.isArray(next) || !hasOwn(next, "timeline")) continue;
    projections = {
      ...projections,
      timeline: Array.isArray(next.timeline)
        ? next.timeline
            .map((item, index) => normalizeWorkflowTimelineProjection(item, index))
            .filter(Boolean)
            .slice(0, 100)
        : projections.timeline || [],
    };
  }
  return projections;
}

export function mergeWorkflowGlobalState(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return plainObject(base);
  const out = { ...plainObject(base) };
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) continue;
    if (value === undefined) continue;
    if (value === null) {
      delete out[key];
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = mergeWorkflowGlobalState(out[key], value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function removeWorkflowGlobalStatePath(value, rawPath) {
  const root = mergeWorkflowGlobalState({}, value);
  const parts = cleanString(rawPath, 1000).split(".").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return root;
  if (parts.some((part) => UNSAFE_OBJECT_KEYS.has(part))) return root;
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) return root;
    cursor = cursor[part];
  }
  delete cursor[parts[parts.length - 1]];
  return root;
}

export function normalizeWorkflowReference(payload = {}) {
  const workflow = plainObject(payload.workflow);
  const explicitKey = cleanString(workflow.key || payload.workflowKey || payload.workflow_key, 400);
  const keySeparator = explicitKey.indexOf(":");
  const keyedNamespace = keySeparator > 0 ? explicitKey.slice(0, keySeparator) : "";
  const keyedId = keySeparator > 0 ? explicitKey.slice(keySeparator + 1) : explicitKey;
  const namespace = cleanString(
    workflow.namespace || workflow.type || payload.workflowNamespace || payload.workflow_namespace || keyedNamespace || "tapd",
    80,
  ).toLowerCase() || "tapd";
  const id = cleanString(
    workflow.id ||
    keyedId ||
    payload.workflowId ||
    payload.workflow_id ||
    payload.tapdId ||
    payload.tapd_id,
    240,
  );
  if (!/^[a-z][a-z0-9._-]{0,79}$/.test(namespace)) {
    return { error: "Invalid workflow namespace" };
  }
  if (!id) return { error: "Missing workflow id" };
  return {
    namespace,
    id,
    key: `${namespace}:${id}`,
  };
}

export function normalizeWorkflowReport(payload = {}) {
  const schemaVersion = Number(payload.schemaVersion || payload.schema_version || WORKFLOW_REPORT_SCHEMA_VERSION);
  if (schemaVersion !== WORKFLOW_REPORT_SCHEMA_VERSION) {
    return { error: `Unsupported workflow report schemaVersion: ${schemaVersion}` };
  }
  const workflow = normalizeWorkflowReference(payload);
  if (workflow.error) return workflow;
  const rawWorkflow = plainObject(payload.workflow);
  const source = cleanString(payload.source || "agentflow-cli", 120).toLowerCase() || "agentflow-cli";
  if (!/^[a-z][a-z0-9._-]{0,119}$/.test(source)) {
    return { error: "Invalid workflow report source" };
  }

  const rawObservation = plainObject(payload.observation);
  const hasObservation = Object.keys(rawObservation).length > 0;
  const observationState = plainObject(rawObservation.state || rawObservation.facts || rawObservation.value);
  if (hasObservation && !Object.keys(observationState).length) {
    return { error: "observation requires state" };
  }
  const observation = hasObservation ? {
    schema: cleanString(rawObservation.schema || rawObservation.model || "workflow-observation/v1", 160),
    state: mergeWorkflowGlobalState({}, observationState),
    observedAt: cleanString(rawObservation.observedAt || rawObservation.observed_at, 80),
    clientId: cleanString(rawObservation.clientId || rawObservation.client_id, 160),
    scope: cleanString(rawObservation.scope || "client", 80).toLowerCase() || "client",
  } : null;

  const rawAction = plainObject(payload.action);
  const hasAction = Object.keys(rawAction).length > 0;
  const actionKey = cleanString(rawAction.key || rawAction.id || rawAction.actionKey || rawAction.action_key, 240);
  if (hasAction && !actionKey) return { error: "Workflow action requires a stable key" };
  const action = hasAction ? {
    ...rawAction,
    key: actionKey,
    title: cleanString(rawAction.title || rawAction.label || actionKey, 500),
    detail: cleanString(rawAction.detail || rawAction.description || rawAction.message, 4000),
    status: normalizeActionStatus(rawAction.status),
    group: cleanString(rawAction.group || rawAction.stage || rawAction.category, 120),
    scope: cleanString(rawAction.scope, 80),
    platform: cleanString(rawAction.platform, 80),
    issueKey: cleanString(rawAction.issueKey || rawAction.issue_key, 240),
    tags: normalizeStringList(rawAction.tags),
    occurredAt: cleanString(
      rawAction.occurredAt ||
      rawAction.occurred_at ||
      rawAction.completedAt ||
      rawAction.startedAt,
      80,
    ),
  } : null;

  const rawArtifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
  const artifacts = rawArtifacts
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item, index) => ({
      ...normalizeWorkflowArtifact(item, index, action ? "action" : "global"),
      producer: source,
    }));

  const rawProjections = plainObject(payload.projections || payload.workflowProjections || payload.workflow_projections);
  const hasProjections = Object.keys(rawProjections).length > 0 || hasOwn(payload, "projections");
  if (hasProjections && !hasOwn(rawProjections, "timeline")) {
    return { error: "projections requires timeline" };
  }
  if (hasProjections && !Array.isArray(rawProjections.timeline)) {
    return { error: "projections.timeline must be an array" };
  }
  const invalidTimelineIndex = hasProjections
    ? rawProjections.timeline.findIndex((item, index) => !normalizeWorkflowTimelineProjection(item, index))
    : -1;
  if (invalidTimelineIndex >= 0) {
    return { error: `projections.timeline[${invalidTimelineIndex}] requires kind and id` };
  }
  const projections = hasProjections ? normalizeWorkflowProjectionState(rawProjections) : null;

  const rawExtensions = plainObject(payload.extensions);
  const hasExtensions = Object.keys(rawExtensions).length > 0;
  const extensions = hasExtensions ? normalizeWorkflowExtensions(rawExtensions) : null;
  if (hasExtensions && !Object.keys(extensions).length) {
    return { error: "extensions requires at least one valid namespace object" };
  }

  const rawGlobalState = plainObject(payload.globalState || payload.global_state);
  const hasGlobalState = Object.keys(rawGlobalState).length > 0;
  const globalStatePatch = plainObject(rawGlobalState.patch);
  const globalStateRemove = normalizeStringList(rawGlobalState.remove || rawGlobalState.removePaths || rawGlobalState.remove_paths);
  const mode = cleanString(rawGlobalState.mode || "merge", 40).toLowerCase() || "merge";
  if (hasGlobalState && mode !== "merge") return { error: "globalState.mode must be merge" };
  if (hasGlobalState && !Object.keys(globalStatePatch).length && !globalStateRemove.length) {
    return { error: "globalState requires patch or remove" };
  }
  if (!action && !artifacts.length && !hasGlobalState && !hasProjections && !hasExtensions && !hasObservation) {
    return { error: "Workflow report requires observation, action, artifacts, globalState, projections, or extensions" };
  }

  const idempotencyKey = cleanString(
    payload.idempotencyKey ||
    payload.idempotency_key ||
    action?.idempotencyKey ||
    action?.idempotency_key,
    500,
  );
  const event = {
    schemaVersion,
    type: "workflow-report",
    source,
    workflow,
    workflowKey: workflow.key,
    aggregateByStage: Boolean(action),
    auxiliary: !action,
    conflictOnArtifact: payload.conflictOnArtifact === true || payload.conflict_on_artifact === true,
    artifactScope: action ? "action" : "global",
    ...(action ? {
      action: action.key,
      actionId: action.key,
      actionModel: action,
      stageKey: action.key,
      stage: action.group || action.key,
      title: action.title,
      detail: action.detail,
      status: action.status,
      scope: action.scope || action.group || "workflow",
      platform: action.platform,
      issueKey: action.issueKey,
      tags: action.tags,
      ...(action.occurredAt ? { occurredAt: action.occurredAt } : {}),
    } : {
      title: cleanString(payload.title || "Workflow 全局状态更新", 500),
      detail: cleanString(payload.detail, 4000),
      status: "done",
      scope: "global",
    }),
    artifacts,
    ...(hasProjections ? { projections } : {}),
    ...(hasExtensions ? { extensionsPatch: extensions } : {}),
    ...(hasGlobalState ? {
      globalStatePatch,
      globalStateRemove,
    } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
  return {
    schemaVersion,
    workflow,
    action,
    artifacts,
    projections,
    extensions,
    observation,
    hasRuntimeUpdate: Boolean(action || artifacts.length || hasGlobalState || hasProjections || hasExtensions),
    globalState: hasGlobalState ? {
      mode: "merge",
      patch: globalStatePatch,
      remove: globalStateRemove,
    } : null,
    expectedRevision: cleanString(payload.expectedRevision || payload.expected_revision, 500),
    idempotencyKey,
    flowId: cleanString(payload.flowId || payload.flow_id || rawWorkflow.flowId || rawWorkflow.flow_id, 240),
    flowSource: cleanString(payload.flowSource || payload.flow_source || rawWorkflow.flowSource || rawWorkflow.flow_source || "user", 80) || "user",
    event,
  };
}

function displayValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  const raw = plainObject(value);
  return raw.label || raw.name || raw.value || raw.username || raw.userId || raw.key || raw.code || "";
}

function legacyExperimentLabel(value) {
  const raw = plainObject(value);
  if (!Object.keys(raw).length) return displayValue(value);
  const name = displayValue(raw);
  const groups = Array.isArray(raw.groups || raw.variants || raw.buckets)
    ? (raw.groups || raw.variants || raw.buckets).map(displayValue).filter(Boolean)
    : [];
  return [name, groups.length ? groups.join(" / ") : ""].filter(Boolean).join(" · ");
}

function legacySettingLabel(value) {
  const raw = plainObject(value);
  if (!Object.keys(raw).length) return displayValue(value);
  const name = displayValue(raw);
  const defaultValue = raw.defaultValue ?? raw.default_value ?? raw.default;
  return [name, defaultValue != null && defaultValue !== "" ? `默认 ${String(defaultValue)}` : ""].filter(Boolean).join(" · ");
}

function globalField(label, type, value) {
  const empty = value == null || value === "" || (Array.isArray(value) && value.length === 0);
  return empty ? null : { label, type, value };
}

export function legacyOverallToGlobalState(tapdId, value = {}) {
  const overall = plainObject(value);
  const requirement = plainObject(overall.requirement);
  const id = cleanString(requirement.tapdId || requirement.tapd_id || tapdId, 240);
  const sections = {};
  for (const [rawPlatform, rawValue] of Object.entries(plainObject(overall.platforms))) {
    const platform = cleanString(rawPlatform, 80).toLowerCase();
    if (!platform) continue;
    const platformValue = plainObject(rawValue);
    const filters = plainObject(platformValue.filters);
    const fields = Object.fromEntries([
      ["owner", globalField("负责人", "user", platformValue.owner)],
      ["tags", globalField("Tag", "chips", platformValue.tags)],
      ["experiments", globalField("AB 实验", "chips", (Array.isArray(platformValue.experiments) ? platformValue.experiments : []).map(legacyExperimentLabel).filter(Boolean))],
      ["settings", globalField("Settings", "chips", (Array.isArray(platformValue.settings) ? platformValue.settings : []).map(legacySettingLabel).filter(Boolean))],
      ["countries", globalField("国家过滤", "chips", filters.countries)],
      ["users", globalField("用户过滤", "chips", filters.users)],
      ["versions", globalField("版本过滤", "chips", filters.versions)],
      ["rules", globalField("实现规则", "list", platformValue.rules)],
    ].filter(([, field]) => field));
    if (Object.keys(fields).length) {
      sections[platform] = {
        title: platform === "android" ? "Android" : platform === "ios" ? "iOS" : rawPlatform,
        fields,
      };
    }
  }
  const title = cleanString(requirement.title || requirement.name, 500);
  const url = cleanString(requirement.tapdUrl || requirement.tapd_url || requirement.url, 4000);
  const status = requirement.status || requirement.tapdStatus || requirement.tapd_status || "";
  return {
    workflow: { namespace: "tapd", id, key: `tapd:${id}` },
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(status ? { status } : {}),
    sections,
  };
}

function eventTime(event) {
  const value = event?.updatedAt || event?.occurredAt || event?.completedAt || event?.createdAt || event?.observedAt || "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function materializeWorkflowGlobalState(tapdId, snapshot = {}, runtimeEvents = [], legacyOverall = {}) {
  const legacy = legacyOverallToGlobalState(tapdId, legacyOverall);
  const raw = plainObject(
    snapshot.globalState ||
    snapshot.global_state ||
    snapshot.raw?.globalState ||
    snapshot.raw?.global_state,
  );
  let state = mergeWorkflowGlobalState(legacy, raw);
  const events = [...(Array.isArray(runtimeEvents) ? runtimeEvents : [])].sort((left, right) => eventTime(left) - eventTime(right));
  for (const event of events) {
    const patch = event?.globalStatePatch || event?.global_state_patch;
    if (patch && typeof patch === "object" && !Array.isArray(patch)) {
      state = mergeWorkflowGlobalState(state, patch);
    }
    const remove = event?.globalStateRemove || event?.global_state_remove;
    for (const path of Array.isArray(remove) ? remove : []) {
      state = removeWorkflowGlobalStatePath(state, path);
    }
  }
  const workflow = normalizeWorkflowReference({ workflow: state.workflow, tapdId });
  state.workflow = workflow.error ? { namespace: "tapd", id: String(tapdId || ""), key: `tapd:${String(tapdId || "")}` } : workflow;
  return state;
}

export function mergeWorkflowArtifacts(baseArtifacts = [], runtimeEvents = []) {
  const globalArtifacts = [];
  for (const event of Array.isArray(runtimeEvents) ? runtimeEvents : []) {
    const defaultScope = event?.artifactScope === "global" || !event?.action ? "global" : "action";
    for (const artifact of Array.isArray(event?.artifacts) ? event.artifacts : []) {
      const scope = cleanString(artifact?.scope || defaultScope, 40).toLowerCase();
      if (scope === "global") globalArtifacts.push(artifact);
    }
  }
  return mergeWorkflowArtifactLists(baseArtifacts, globalArtifacts, "global");
}

export function mergeWorkflowArtifactLists(left = [], right = [], defaultScope = "action") {
  const out = [];
  const seen = new Map();
  const normalizedUrl = (value) => {
    const raw = cleanString(value, 4000);
    if (!raw) return "";
    try {
      const parsed = new URL(raw, "http://agentflow.local");
      return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "") || "/"}`;
    } catch {
      return raw.split(/[?#]/)[0].replace(/\/+$/, "");
    }
  };
  const artifactAliases = (artifact) => {
    const aliases = [];
    const producer = cleanString(artifact?.producer || artifact?.reportSource || artifact?.report_source, 120).toLowerCase();
    const ownedAlias = (alias) => producer ? `producer:${producer}:${alias}` : alias;
    const explicitKey = cleanString(
      artifact?.key || artifact?.artifactKey || artifact?.artifact_key,
      500,
    );
    if (explicitKey) aliases.push(ownedAlias(`key:${explicitKey}`));
    const url = normalizedUrl(
      artifact?.canonicalUrl
      || artifact?.canonical_url
      || artifact?.href
      || artifact?.url,
    );
    if (url) aliases.push(ownedAlias(`url:${url}`));
    const artifactPath = cleanString(artifact?.path, 4000);
    if (artifactPath) aliases.push(ownedAlias(`path:${artifactPath}`));
    return aliases;
  };
  const add = (artifact) => {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return;
    const rawAliases = artifactAliases(artifact);
    const normalized = normalizeWorkflowArtifact(artifact, out.length, defaultScope);
    const aliases = uniqueValues([
      ...rawAliases,
      ...artifactAliases(normalized),
      ...(!rawAliases.length ? [`value:${normalized.type}:${normalized.title}`] : []),
    ]);
    const existing = aliases.map((alias) => seen.get(alias)).find((value) => value != null);
    if (existing == null) {
      const index = out.length;
      out.push(normalized);
      aliases.forEach((alias) => seen.set(alias, index));
    } else {
      out[existing] = { ...out[existing], ...normalized };
      artifactAliases(out[existing]).forEach((alias) => seen.set(alias, existing));
    }
  };
  for (const artifact of Array.isArray(left) ? left : []) add(artifact);
  for (const artifact of Array.isArray(right) ? right : []) add(artifact);
  return out;
}

export function workflowRuntimeRevision(globalState = {}, artifacts = [], runtimeEvents = [], projections = {}, extensions = {}) {
  const events = (Array.isArray(runtimeEvents) ? runtimeEvents : []).map((event) => ({
    id: event?.id || "",
    action: event?.action || event?.actionId || "",
    stageKey: event?.stageKey || event?.stage || "",
    status: event?.status || "",
    artifacts: event?.artifacts || [],
    globalStatePatch: event?.globalStatePatch || {},
    globalStateRemove: event?.globalStateRemove || [],
    projections: event?.projections || {},
    extensionsPatch: event?.extensionsPatch || {},
  }));
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue({ globalState, artifacts, projections, extensions, events })))
    .digest("hex")
    .slice(0, 24);
  return `runtime:${hash}`;
}
