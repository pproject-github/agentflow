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
const WORKFLOW_CHECKLIST_COMPLETION_POLICIES = new Set(["all_required", "any_required", "manual"]);
const WORKFLOW_CHECKLIST_ITEM_STATUSES = new Set(["pending", "passed", "failed", "blocked", "skipped"]);
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanString(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function rawString(value) {
  return String(value ?? "").trim();
}

function stringExceeds(value, max) {
  return rawString(value).length > max;
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

function isKnownActionStatus(value) {
  const raw = cleanString(value, 40).toLowerCase();
  if (!raw) return true;
  return WORKFLOW_ACTION_STATUSES.has(raw) || [
    "success", "succeeded", "complete", "completed", "failed", "failure", "canceled", "in_progress", "in-progress",
  ].includes(raw);
}

export function isSafeWorkflowUrl(value, { allowRelative = true } = {}) {
  const raw = rawString(value);
  if (!raw) return true;
  if (allowRelative && raw.startsWith("/") && !raw.startsWith("//")) return true;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeStringList(value, maxItems = 100) {
  const list = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return uniqueValues(list.map((item) => cleanString(item, 240)).filter(Boolean)).slice(0, maxItems);
}

function normalizeChecklistSection(value, index = 0) {
  const raw = plainObject(value);
  const rawContent = raw.content ?? raw.value ?? raw.text ?? "";
  const content = Array.isArray(rawContent)
    ? rawContent.map((item) => cleanString(item, 4000)).filter(Boolean).slice(0, 100)
    : cleanString(rawContent, 12000);
  return {
    key: cleanString(raw.key || raw.id || `section-${index + 1}`, 120),
    title: cleanString(raw.title || raw.label || `Section ${index + 1}`, 500),
    content,
  };
}

function normalizeWorkflowChecklist(value) {
  const raw = plainObject(value);
  const rawDocument = plainObject(raw.document);
  const items = (Array.isArray(raw.items) ? raw.items : []).map((value, index) => {
    const item = plainObject(value);
    const rawDetail = item.detail;
    const detailObject = plainObject(rawDetail);
    const sections = Array.isArray(detailObject.sections)
      ? detailObject.sections.map((section, sectionIndex) => normalizeChecklistSection(section, sectionIndex))
      : [];
    const summary = typeof rawDetail === "string"
      ? cleanString(rawDetail, 4000)
      : cleanString(detailObject.summary || detailObject.description, 4000);
    return {
      key: cleanString(item.key || item.id, 240),
      title: cleanString(item.title || item.label || item.key || item.id || `Item ${index + 1}`, 500),
      required: item.required !== false,
      ...(summary || sections.length ? { detail: { ...(summary ? { summary } : {}), ...(sections.length ? { sections } : {}) } } : {}),
      ...(item.evidenceRequired === true || item.evidence_required === true ? { evidenceRequired: true } : {}),
    };
  });
  const completionPolicy = cleanString(raw.completionPolicy || raw.completion_policy || "all_required", 40).toLowerCase();
  const documentUrl = cleanString(rawDocument.url || rawDocument.href, 4000);
  return {
    schemaVersion: 1,
    completionPolicy,
    document: {
      title: cleanString(rawDocument.title || rawDocument.label || "Checklist 详情", 500),
      ...(rawDocument.artifactKey || rawDocument.artifact_key ? { artifactKey: cleanString(rawDocument.artifactKey || rawDocument.artifact_key, 500) } : {}),
      ...(documentUrl ? { url: documentUrl } : {}),
    },
    items,
  };
}

function validateWorkflowChecklist(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "action.checklist must be an object";
  const raw = plainObject(value);
  const schemaVersion = Number(raw.schemaVersion ?? raw.schema_version ?? 1);
  if (schemaVersion !== 1) return `Unsupported action.checklist schemaVersion: ${schemaVersion}`;
  const completionPolicy = rawString(raw.completionPolicy || raw.completion_policy || "all_required").toLowerCase();
  if (!WORKFLOW_CHECKLIST_COMPLETION_POLICIES.has(completionPolicy)) {
    return `Invalid action.checklist completionPolicy: ${completionPolicy}`;
  }
  if (!Array.isArray(raw.items) || raw.items.length === 0) return "action.checklist requires at least one item";
  if (raw.items.length > 100) return "action.checklist supports at most 100 items";
  const seen = new Set();
  for (let index = 0; index < raw.items.length; index += 1) {
    const item = raw.items[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) return `action.checklist.items[${index}] must be an object`;
    const key = rawString(item.key || item.id);
    if (!key || key.length > 240 || /[\0\r\n]/.test(key)) return `action.checklist.items[${index}].key is invalid`;
    if (seen.has(key)) return `action.checklist.items[${index}].key must be unique`;
    seen.add(key);
    if (stringExceeds(item.title || item.label || key, 500)) return `action.checklist.items[${index}].title exceeds 500 characters`;
    if (item.detail != null && typeof item.detail !== "string" && (!item.detail || typeof item.detail !== "object" || Array.isArray(item.detail))) {
      return `action.checklist.items[${index}].detail must be a string or object`;
    }
    const detail = plainObject(item.detail);
    if (typeof item.detail === "string" && stringExceeds(item.detail, 4000)) return `action.checklist.items[${index}].detail exceeds 4000 characters`;
    if (stringExceeds(detail.summary || detail.description, 4000)) return `action.checklist.items[${index}].detail.summary exceeds 4000 characters`;
    if (detail.sections != null && !Array.isArray(detail.sections)) return `action.checklist.items[${index}].detail.sections must be an array`;
    if (Array.isArray(detail.sections) && detail.sections.length > 50) return `action.checklist.items[${index}].detail.sections supports at most 50 entries`;
  }
  const document = plainObject(raw.document);
  if (stringExceeds(document.title || document.label, 500)) return "action.checklist.document.title exceeds 500 characters";
  if (stringExceeds(document.artifactKey || document.artifact_key, 500)) return "action.checklist.document.artifactKey exceeds 500 characters";
  const documentUrl = rawString(document.url || document.href);
  if (documentUrl && !isSafeWorkflowUrl(documentUrl)) return "action.checklist.document.url must use http, https, or an absolute application path";
  return "";
}

export function normalizeWorkflowChecklistItemStatus(value) {
  const raw = cleanString(value, 40).toLowerCase();
  const aliases = { done: "passed", complete: "passed", completed: "passed", success: "passed", error: "failed", cancelled: "skipped", canceled: "skipped" };
  const normalized = aliases[raw] || raw || "pending";
  return WORKFLOW_CHECKLIST_ITEM_STATUSES.has(normalized) ? normalized : "pending";
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
      .filter(Boolean);
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
  const workflowInput = payload.workflow;
  const workflow = plainObject(workflowInput);
  const rawExplicitKey = rawString(
    (typeof workflowInput === "string" ? workflowInput : "") || workflow.key || payload.workflowKey || payload.workflow_key,
  );
  if (rawExplicitKey.length > 400) return { error: "Workflow key exceeds 400 characters" };
  if (/[\0\r\n]/.test(rawExplicitKey)) return { error: "Workflow key contains control characters" };
  const explicitKey = rawExplicitKey;
  const keySeparator = explicitKey.indexOf(":");
  const keyedNamespace = keySeparator > 0 ? explicitKey.slice(0, keySeparator) : "";
  const keyedId = keySeparator > 0 ? explicitKey.slice(keySeparator + 1) : explicitKey;
  const rawNamespace = rawString(workflow.namespace || workflow.type || payload.workflowNamespace || payload.workflow_namespace || keyedNamespace || "tapd");
  const rawId = rawString(workflow.id || keyedId || payload.workflowId || payload.workflow_id || payload.tapdId || payload.tapd_id);
  if (rawNamespace.length > 80) return { error: "Workflow namespace exceeds 80 characters" };
  if (rawId.length > 240) return { error: "Workflow id exceeds 240 characters" };
  if (/[\0\r\n]/.test(rawId)) return { error: "Workflow id contains control characters" };
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
  const schemaValue = payload.schemaVersion ?? payload.schema_version ?? WORKFLOW_REPORT_SCHEMA_VERSION;
  const schemaVersion = Number(schemaValue);
  if (schemaVersion !== WORKFLOW_REPORT_SCHEMA_VERSION) {
    return { error: `Unsupported workflow report schemaVersion: ${schemaVersion}` };
  }
  const workflow = normalizeWorkflowReference(payload);
  if (workflow.error) return workflow;
  const rawWorkflow = plainObject(payload.workflow);
  if (!rawString(payload.source)) return { error: "Workflow report requires source" };
  if (stringExceeds(payload.source, 120)) return { error: "Workflow report source exceeds 120 characters" };
  const source = cleanString(payload.source, 120).toLowerCase();
  if (!/^[a-z][a-z0-9._-]{0,119}$/.test(source)) {
    return { error: "Invalid workflow report source" };
  }

  const rawObservation = plainObject(payload.observation);
  const hasObservation = Object.keys(rawObservation).length > 0;
  const observationState = plainObject(rawObservation.state || rawObservation.facts || rawObservation.value);
  if (hasObservation && !Object.keys(observationState).length) {
    return { error: "observation requires state" };
  }
  if (stringExceeds(rawObservation.schema || rawObservation.model, 160)) return { error: "observation.schema exceeds 160 characters" };
  if (stringExceeds(rawObservation.clientId || rawObservation.client_id || source, 160)) return { error: "observation.clientId exceeds 160 characters" };
  if (stringExceeds(rawObservation.scope || "client", 80)) return { error: "observation.scope exceeds 80 characters" };
  const rawObservedAt = rawString(rawObservation.observedAt || rawObservation.observed_at);
  if (rawObservedAt && !Number.isFinite(Date.parse(rawObservedAt))) return { error: "observation.observedAt must be an ISO-compatible date" };
  const observation = hasObservation ? {
    schema: cleanString(rawObservation.schema || rawObservation.model || "workflow-observation/v1", 160),
    state: mergeWorkflowGlobalState({}, observationState),
    observedAt: cleanString(rawObservation.observedAt || rawObservation.observed_at, 80),
    clientId: cleanString(rawObservation.clientId || rawObservation.client_id || source, 160),
    scope: cleanString(rawObservation.scope || "client", 80).toLowerCase() || "client",
  } : null;

  const rawAction = plainObject(payload.action);
  const hasAction = Object.keys(rawAction).length > 0;
  if (stringExceeds(rawAction.key || rawAction.id || rawAction.actionKey || rawAction.action_key, 240)) {
    return { error: "Workflow action key exceeds 240 characters" };
  }
  const actionKey = cleanString(rawAction.key || rawAction.id || rawAction.actionKey || rawAction.action_key, 240);
  if (hasAction && !actionKey) return { error: "Workflow action requires a stable key" };
  if (hasAction && /[\0\r\n]/.test(actionKey)) return { error: "Workflow action key contains control characters" };
  if (stringExceeds(rawAction.title || rawAction.label || actionKey, 500)) return { error: "Workflow action title exceeds 500 characters" };
  if (stringExceeds(rawAction.detail || rawAction.description || rawAction.message, 4000)) return { error: "Workflow action detail exceeds 4000 characters" };
  if (stringExceeds(rawAction.group || rawAction.stage || rawAction.category, 120)) return { error: "Workflow action group exceeds 120 characters" };
  if (stringExceeds(rawAction.scope, 80)) return { error: "Workflow action scope exceeds 80 characters" };
  if (stringExceeds(rawAction.platform, 80)) return { error: "Workflow action platform exceeds 80 characters" };
  if (stringExceeds(rawAction.issueKey || rawAction.issue_key, 240)) return { error: "Workflow action issueKey exceeds 240 characters" };
  const rawTags = Array.isArray(rawAction.tags) ? rawAction.tags : rawAction.tags == null ? [] : [rawAction.tags];
  if (rawTags.length > 100 || rawTags.some((tag) => stringExceeds(tag, 240))) return { error: "Workflow action tags exceed supported limits" };
  const hasChecklist = hasOwn(rawAction, "checklist");
  if (hasChecklist) {
    const checklistError = validateWorkflowChecklist(rawAction.checklist);
    if (checklistError) return { error: checklistError };
  }
  if (hasAction && !isKnownActionStatus(rawAction.status)) return { error: `Invalid workflow action status: ${rawAction.status}` };
  const rawOccurredAt = rawString(rawAction.occurredAt || rawAction.occurred_at || rawAction.completedAt || rawAction.startedAt);
  if (rawOccurredAt && !Number.isFinite(Date.parse(rawOccurredAt))) return { error: "action.occurredAt must be an ISO-compatible date" };
  const action = hasAction ? {
    ...rawAction,
    key: actionKey,
    title: cleanString(rawAction.title || rawAction.label || actionKey, 500),
    ...(rawAction.detail || rawAction.description || rawAction.message ? { detail: cleanString(rawAction.detail || rawAction.description || rawAction.message, 4000) } : {}),
    status: normalizeActionStatus(rawAction.status),
    ...(rawAction.group || rawAction.stage || rawAction.category ? { group: cleanString(rawAction.group || rawAction.stage || rawAction.category, 120) } : {}),
    ...(rawAction.scope ? { scope: cleanString(rawAction.scope, 80) } : {}),
    ...(rawAction.platform ? { platform: cleanString(rawAction.platform, 80) } : {}),
    ...(rawAction.issueKey || rawAction.issue_key ? { issueKey: cleanString(rawAction.issueKey || rawAction.issue_key, 240) } : {}),
    ...(rawAction.tags != null ? { tags: normalizeStringList(rawAction.tags) } : {}),
    ...(hasChecklist ? { checklist: normalizeWorkflowChecklist(rawAction.checklist) } : {}),
    occurredAt: cleanString(
      rawAction.occurredAt ||
      rawAction.occurred_at ||
      rawAction.completedAt ||
      rawAction.startedAt,
      80,
    ),
  } : null;

  const rawArtifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
  if (rawArtifacts.length > 100) return { error: "Workflow report supports at most 100 artifacts per request" };
  const invalidArtifactShapeIndex = rawArtifacts.findIndex((item) => !item || typeof item !== "object" || Array.isArray(item));
  if (invalidArtifactShapeIndex >= 0) return { error: `artifacts[${invalidArtifactShapeIndex}] must be an object` };
  const missingArtifactTargetIndex = rawArtifacts.findIndex((item) => !rawString(item?.url || item?.href) && !rawString(item?.path));
  if (missingArtifactTargetIndex >= 0) return { error: `artifacts[${missingArtifactTargetIndex}] requires url or path` };
  const oversizedArtifactIndex = rawArtifacts.findIndex((item) => (
    stringExceeds(item?.url || item?.href, 4000) ||
    stringExceeds(item?.path, 4000) ||
    stringExceeds(item?.title || item?.label || item?.name, 500) ||
    stringExceeds(item?.type || item?.kind, 120) ||
    stringExceeds(item?.label, 500) ||
    stringExceeds(item?.status, 80)
  ));
  if (oversizedArtifactIndex >= 0) return { error: `artifacts[${oversizedArtifactIndex}] exceeds supported field limits` };
  const invalidArtifactIndex = rawArtifacts.findIndex((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const url = item.url || item.href;
    return Boolean(url) && !isSafeWorkflowUrl(url);
  });
  if (invalidArtifactIndex >= 0) return { error: `artifacts[${invalidArtifactIndex}].url must use http, https, or an absolute application path` };
  const invalidArtifactKeyIndex = rawArtifacts.findIndex((item) => {
    const key = rawString(item?.key || item?.id || item?.artifactKey || item?.artifact_key);
    return key.length > 500 || /[\0\r\n]/.test(key);
  });
  if (invalidArtifactKeyIndex >= 0) return { error: `artifacts[${invalidArtifactKeyIndex}].key is invalid` };
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
  if (hasProjections && rawProjections.timeline.length > 100) {
    return { error: "projections.timeline supports at most 100 entries" };
  }
  const invalidTimelineIndex = hasProjections
    ? rawProjections.timeline.findIndex((item, index) => !normalizeWorkflowTimelineProjection(item, index))
    : -1;
  if (invalidTimelineIndex >= 0) {
    return { error: `projections.timeline[${invalidTimelineIndex}] requires kind and id` };
  }
  const oversizedTimelineIndex = hasProjections
    ? rawProjections.timeline.findIndex((item) => (
        stringExceeds(item?.kind || item?.type, 80) ||
        stringExceeds(item?.id || item?.key, 240) ||
        stringExceeds(item?.key, 500) ||
        stringExceeds(item?.title || item?.label, 500) ||
        stringExceeds(item?.source || item?.namespace || source, 120) ||
        stringExceeds(item?.date || item?.targetDate || item?.target_date, 80)
      ))
    : -1;
  if (oversizedTimelineIndex >= 0) return { error: `projections.timeline[${oversizedTimelineIndex}] exceeds supported field limits` };
  const invalidTimelineSourceIndex = hasProjections
    ? rawProjections.timeline.findIndex((item) => {
        const itemSource = cleanString(item?.source || item?.namespace || source, 120).toLowerCase();
        return !/^[a-z][a-z0-9._-]{0,119}$/.test(itemSource);
      })
    : -1;
  if (invalidTimelineSourceIndex >= 0) return { error: `projections.timeline[${invalidTimelineSourceIndex}].source is invalid` };
  const invalidTimelineDateIndex = hasProjections
    ? rawProjections.timeline.findIndex((item) => {
        const date = rawString(item?.date || item?.targetDate || item?.target_date);
        return date && !Number.isFinite(Date.parse(date));
      })
    : -1;
  if (invalidTimelineDateIndex >= 0) return { error: `projections.timeline[${invalidTimelineDateIndex}].date must be ISO-compatible` };
  const projections = hasProjections ? normalizeWorkflowProjectionState({
    ...rawProjections,
    timeline: rawProjections.timeline.map((item) => ({
      ...plainObject(item),
      source: cleanString(item?.source || item?.namespace || source, 120).toLowerCase(),
    })),
  }) : null;

  const rawExtensions = plainObject(payload.extensions);
  const hasExtensions = Object.keys(rawExtensions).length > 0;
  const invalidExtensionNamespace = Object.keys(rawExtensions).findIndex((namespace) => (
    !/^[a-z][a-z0-9._-]{0,119}$/.test(rawString(namespace).toLowerCase()) ||
    !rawExtensions[namespace] ||
    typeof rawExtensions[namespace] !== "object" ||
    Array.isArray(rawExtensions[namespace])
  ));
  if (invalidExtensionNamespace >= 0) {
    const namespace = Object.keys(rawExtensions)[invalidExtensionNamespace];
    return { error: `extensions[${namespace}] must be a valid namespace object` };
  }
  const extensions = hasExtensions ? normalizeWorkflowExtensions(rawExtensions) : null;
  if (hasExtensions && !Object.keys(extensions).length) {
    return { error: "extensions requires at least one valid namespace object" };
  }
  if (hasExtensions && Object.keys(extensions).some((namespace) => namespace !== source)) {
    return { error: "extensions may only update the namespace matching report source" };
  }

  const rawGlobalState = plainObject(payload.globalState || payload.global_state);
  const hasGlobalState = Object.keys(rawGlobalState).length > 0;
  const globalStatePatch = plainObject(rawGlobalState.patch);
  const rawGlobalStateRemove = rawGlobalState.remove || rawGlobalState.removePaths || rawGlobalState.remove_paths;
  const rawGlobalStateRemoveList = Array.isArray(rawGlobalStateRemove) ? rawGlobalStateRemove : rawGlobalStateRemove == null || rawGlobalStateRemove === "" ? [] : [rawGlobalStateRemove];
  if (rawGlobalStateRemoveList.length > 100 || rawGlobalStateRemoveList.some((item) => stringExceeds(item, 240))) {
    return { error: "globalState.remove exceeds supported limits" };
  }
  const globalStateRemove = normalizeStringList(rawGlobalStateRemove);
  const globalStateOwnerPaths = uniqueValues([
    ...patchLeafPaths(globalStatePatch).filter((path) => path.length).map((path) => path.join(".")),
    ...globalStateRemove,
  ]);
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
  if (stringExceeds(payload.idempotencyKey || payload.idempotency_key || action?.idempotencyKey || action?.idempotency_key, 500)) {
    return { error: "idempotencyKey exceeds 500 characters" };
  }
  if (stringExceeds(payload.expectedRevision || payload.expected_revision, 500)) return { error: "expectedRevision exceeds 500 characters" };
  const rawExpectedVersions = plainObject(payload.expectedVersions || payload.expected_versions);
  const expectedVersions = {};
  for (const [resourceKey, version] of Object.entries(rawExpectedVersions)) {
    const key = rawString(resourceKey);
    if (!key || key.length > 800 || /[\0\r\n]/.test(key)) return { error: "Invalid expectedVersions resource key" };
    const normalizedVersion = version == null || version === "" ? "absent" : rawString(version);
    if (normalizedVersion.length > 160) return { error: `expectedVersions[${key}] exceeds 160 characters` };
    expectedVersions[key] = normalizedVersion;
  }
  const event = {
    schemaVersion,
    type: "workflow-report",
    operation: "report",
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
      ...(action.platform ? { platform: action.platform } : {}),
      ...(action.issueKey ? { issueKey: action.issueKey } : {}),
      ...(action.tags ? { tags: action.tags } : {}),
      ...(action.checklist ? { checklist: action.checklist } : {}),
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
      globalStateOwnerPaths,
    } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
  if (idempotencyKey) {
    event.idempotencyFingerprint = semanticHash({
      workflow,
      source,
      observation,
      action,
      artifacts,
      globalState: hasGlobalState ? { patch: globalStatePatch, remove: globalStateRemove } : null,
      projections,
      extensions,
    });
    event.idempotencyFingerprints = { [idempotencyKey]: event.idempotencyFingerprint };
  }
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
    expectedVersions,
    idempotencyKey,
    flowId: cleanString(payload.flowId || payload.flow_id || rawWorkflow.flowId || rawWorkflow.flow_id, 240),
    flowSource: cleanString(payload.flowSource || payload.flow_source || rawWorkflow.flowSource || rawWorkflow.flow_source || "user", 80) || "user",
    event,
  };
}

function semanticHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex").slice(0, 24);
}

function resourceVersion(value) {
  return `rv:${semanticHash(value)}`;
}

function actionDefinitionForVersion(event = {}) {
  const action = plainObject(event.actionModel);
  if (!Object.keys(action).length) return event;
  const checklist = plainObject(action.checklist);
  if (!Object.keys(checklist).length) return action;
  const items = Array.isArray(checklist.items)
    ? checklist.items.map((item) => {
        const clean = { ...plainObject(item) };
        delete clean.state;
        return clean;
      })
    : [];
  const cleanChecklist = { ...checklist, items };
  delete cleanChecklist.progress;
  delete cleanChecklist.source;
  return { ...action, checklist: cleanChecklist };
}

function addObjectResourceVersions(out, prefix, value, path = []) {
  if (value === undefined) return;
  if (path.length) out[`${prefix}:${path.join(".")}`] = resourceVersion(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) continue;
    addObjectResourceVersions(out, prefix, child, [...path, key]);
  }
}

export function workflowSnapshotResourceVersions(snapshot = {}) {
  const out = {};
  const runtimeEvents = Array.isArray(snapshot.runtimeEvents || snapshot.runtime_events)
    ? (snapshot.runtimeEvents || snapshot.runtime_events)
    : [];
  for (const event of runtimeEvents) {
    const source = cleanString(event?.source || event?.producer || "agentflow", 120).toLowerCase() || "agentflow";
    const checklistState = plainObject(event?.checklistState || event?.checklist_state);
    const checklistSource = cleanString(checklistState.producer || checklistState.source, 120).toLowerCase();
    const checklistActionKey = cleanString(checklistState.actionKey || checklistState.action_key, 240);
    const checklistItemKey = cleanString(checklistState.itemKey || checklistState.item_key, 240);
    if (checklistSource && checklistActionKey && checklistItemKey) {
      out[`checklist:${checklistSource}:${checklistActionKey}:${checklistItemKey}`] = resourceVersion(checklistState);
    }
    const actionKey = cleanString(event?.actionModel?.key || event?.action || event?.actionId || event?.stageKey, 240);
    if (actionKey && event?.auxiliary !== true) out[`action:${source}:${actionKey}`] = resourceVersion(actionDefinitionForVersion(event));
    for (const artifact of Array.isArray(event?.artifacts) ? event.artifacts : []) {
      const producer = cleanString(artifact?.producer || source, 120).toLowerCase() || source;
      const key = cleanString(artifact?.key || artifact?.artifactKey || artifact?.artifact_key, 500);
      if (key) out[`artifact:${producer}:${key}`] = resourceVersion(artifact);
    }
  }
  for (const artifact of Array.isArray(snapshot.artifacts) ? snapshot.artifacts : []) {
    const producer = cleanString(artifact?.producer || "legacy", 120).toLowerCase() || "legacy";
    const key = cleanString(artifact?.key || artifact?.artifactKey || artifact?.artifact_key, 500);
    if (key) out[`artifact:${producer}:${key}`] = resourceVersion(artifact);
  }
  for (const projection of Array.isArray(snapshot?.projections?.timeline) ? snapshot.projections.timeline : []) {
    const source = cleanString(projection?.source || "legacy", 120).toLowerCase() || "legacy";
    const kind = cleanString(projection?.kind, 80).toLowerCase();
    const id = cleanString(projection?.id, 240);
    if (kind && id) out[`projection:${source}:${kind}:${id}`] = resourceVersion(projection);
  }
  addObjectResourceVersions(out, "global", plainObject(snapshot.globalState));
  for (const [namespace, value] of Object.entries(plainObject(snapshot.extensions))) {
    addObjectResourceVersions(out, `extension:${namespace}`, value);
  }
  for (const observation of Array.isArray(snapshot.clientObservations) ? snapshot.clientObservations : []) {
    const source = cleanString(observation?.source || "legacy", 120).toLowerCase() || "legacy";
    const clientId = cleanString(observation?.clientId, 160);
    if (clientId) out[`observation:${source}:${clientId}`] = resourceVersion(observation);
  }
  return out;
}

function patchLeafPaths(value, path = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [path];
  const entries = Object.entries(value).filter(([key]) => !UNSAFE_OBJECT_KEYS.has(key));
  if (!entries.length) return [path];
  return entries.flatMap(([key, child]) => patchLeafPaths(child, [...path, key]));
}

export function workflowReportResourceKeys(report = {}, currentSnapshot = {}) {
  const keys = new Set();
  const source = cleanString(report?.event?.source || "agentflow-cli", 120).toLowerCase() || "agentflow-cli";
  if (report.action?.key) keys.add(`action:${source}:${report.action.key}`);
  for (const artifact of Array.isArray(report.artifacts) ? report.artifacts : []) {
    if (artifact?.key) keys.add(`artifact:${source}:${artifact.key}`);
  }
  for (const path of patchLeafPaths(report?.globalState?.patch || {})) {
    if (path.length) keys.add(`global:${path.join(".")}`);
  }
  for (const path of Array.isArray(report?.globalState?.remove) ? report.globalState.remove : []) {
    if (path) keys.add(`global:${path}`);
  }
  for (const [namespace, extension] of Object.entries(plainObject(report.extensions))) {
    for (const path of patchLeafPaths(extension)) {
      if (path.length) keys.add(`extension:${namespace}:${path.join(".")}`);
    }
  }
  if (report.projections) {
    const current = Array.isArray(currentSnapshot?.projections?.timeline) ? currentSnapshot.projections.timeline : [];
    const incoming = Array.isArray(report.projections.timeline) ? report.projections.timeline : [];
    for (const item of [...current, ...incoming]) {
      const owner = cleanString(item?.source || source, 120).toLowerCase() || source;
      if (owner !== source) continue;
      const kind = cleanString(item?.kind, 80).toLowerCase();
      const id = cleanString(item?.id, 240);
      if (kind && id) keys.add(`projection:${source}:${kind}:${id}`);
    }
  }
  if (report.observation?.clientId) keys.add(`observation:${source}:${report.observation.clientId}`);
  return [...keys].sort();
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
  const events = (Array.isArray(runtimeEvents) ? runtimeEvents : []).map((event) => {
    const semantic = { ...plainObject(event) };
    for (const key of ["updatedAt", "createdAt", "actor", "rawOutput", "output", "result"]) delete semantic[key];
    return semantic;
  });
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue({ globalState, artifacts, projections, extensions, events })))
    .digest("hex")
    .slice(0, 24);
  return `runtime:${hash}`;
}
