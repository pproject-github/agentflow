import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  formatRelativeTime,
  loadOpenedEntries,
  mergeRecentActivity,
} from "../pipelineRecent.js";
import { ImportFlowModal } from "../ImportFlowModal.jsx";
import { NewPipelineModal } from "../NewPipelineModal.jsx";
import { preferredFlowUrl } from "../pipelineViewPreference.js";
import SkillHubPanel from "../components/SkillHubPanel.jsx";
import { collectionSkillKeys, normalizeSkillCollections, skillCollectionConfig } from "../skillCollections.js";
import { useRoute } from "../routeContext.jsx";

function badgeClass(tone) {
  if (tone === "builtin") return "af-proj-badge af-proj-badge--builtin";
  if (tone === "secondary") return "af-proj-badge af-proj-badge--secondary";
  if (tone === "primary") return "af-proj-badge af-proj-badge--primary";
  if (tone === "muted") return "af-proj-badge af-proj-badge--muted";
  return "af-proj-badge";
}

function projectCardClass(source) {
  const s = source ?? "user";
  return s === "builtin" || s === "admin" ? "af-project-card af-project-card--builtin" : "af-project-card";
}

function activityIconKind(kind) {
  if (kind === "executed") return "material-symbols-outlined af-act-icon af-act-icon--executed";
  return "material-symbols-outlined af-act-icon af-act-icon--opened";
}

function sourceBadgeMeta(source, t) {
  if (source === "builtin") return { label: t("project:sourceBadge.builtin"), tone: "builtin" };
  if (source === "admin") return { label: t("project:sourceBadge.builtin"), tone: "builtin" };
  if (source === "workspace") return { label: t("project:sourceBadge.workspace"), tone: "secondary" };
  return { label: t("project:sourceBadge.user"), tone: "primary" };
}

/** @param {{ source?: string, id: string, archived?: boolean }} f */
function sourcePathHint(f) {
  if (f.collaboration?.role && f.collaboration.role !== "owner") {
    return `共享 Project / ${f.collaboration.ownerUsername || f.collaboration.ownerId} / ${f.id}`;
  }
  const s = f.source ?? "user";
  if (s === "builtin") return `builtin/pipelines / ${f.id}`;
  if (s === "admin") return `admin builtin / ${f.ownerUserId || "-"} / ${f.id}`;
  if (s === "workspace")
    return f.archived
      ? `.workspace/agentflow/pipelines/_archived / ${f.id}`
      : `.workspace/agentflow/pipelines / ${f.id}`;
  return f.archived ? `~/agentflow/pipelines/_archived / ${f.id}` : `~/agentflow/pipelines / ${f.id}`;
}

const DEFAULT_PIPELINE_CARD_DESC_KEY = "project:defaultCardDesc";

/** @param {{ description?: string }} f */
function pipelineCardDescription(f, t) {
  const d = f.description != null ? String(f.description).trim() : "";
  return d !== "" ? d : t(DEFAULT_PIPELINE_CARD_DESC_KEY);
}

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {{ children: string, className?: string, query: string }} props
 */
function HighlightMatch({ children, className = "", query }) {
  const q = query.trim();
  const text = String(children);
  if (!q) return <span className={className}>{text}</span>;
  const re = new RegExp(`(${escapeRegExp(q)})`, "gi");
  const parts = text.split(re);
  return (
    <span className={className}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="af-search-hit">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
}

/**
 * @param {{ source?: string, id: string, archived?: boolean, description?: string }} f
 * @param {string} q normalized lowercase trimmed query
 * @param {function} t translation function
 */
function flowSearchHaystack(f, q, t) {
  const parts = [String(f.id), pipelineCardDescription(f, t), sourcePathHint(f), sourceBadgeMeta(f.source, t).label];
  if (f.archived) parts.push(t("project:archived"));
  return parts.join("\n").toLowerCase();
}

/**
 * @param {{ source?: string, id: string, archived?: boolean, description?: string }} f
 * @param {string} q normalized lowercase trimmed query
 * @param {function} t translation function
 */
function flowMatchesSearch(f, q, t) {
  if (!q) return true;
  return flowSearchHaystack(f, q, t).includes(q);
}

/**
 * @param {string} query
 * @param {{ flowId: string, flowSource?: string }} row
 */
function activityMatchesSearch(query, row) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const id = String(row.flowId).toLowerCase();
  const src = String(row.flowSource ?? "user").toLowerCase();
  return id.includes(q) || src.includes(q);
}

function resourceTextMatches(query, parts) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return parts.filter(Boolean).join("\n").toLowerCase().includes(q);
}

function nodeSourceLabel(source, t) {
  if (source === "flow") return t("project:resourceSource.flow");
  if (source === "marketplace") return t("project:resourceSource.marketplace");
  if (source === "project") return t("project:resourceSource.global");
  return source || t("project:resourceSource.global");
}

function flowSnippetPathHint(snippet) {
  if (snippet?.packageDir) return snippet.packageDir;
  return `marketplace/flow-snippets / ${snippet?.id || ""}`;
}

const NODE_FILTERS = ["all", "agent", "control", "provide", "marketplace"];
const MY_NODE_FILTERS = ["all", "agent", "control", "provide"];
const ACTIVITY_PANEL_OPEN_STORAGE_KEY = "agentflow.projects.activityPanelOpen";
const ACTIVITY_SELECTED_STORAGE_KEY = "agentflow.projects.activitySelected";
const PROJECT_VIEW_STORAGE_KEY = "agentflow.projects.scopeView";

function loadProjectView() {
  if (typeof localStorage === "undefined") return "personal";
  try {
    return localStorage.getItem(PROJECT_VIEW_STORAGE_KEY) === "team" ? "team" : "personal";
  } catch {
    return "personal";
  }
}

function loadActivityPanelOpen() {
  if (typeof localStorage === "undefined") return true;
  const value = localStorage.getItem(ACTIVITY_PANEL_OPEN_STORAGE_KEY);
  if (value === "0") return false;
  if (value === "1") return true;
  return true;
}

function activitySelectionKey(row) {
  return `${row?.flowSource || "user"}:${row?.flowId || ""}`;
}

function loadActivitySelectionKey() {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(ACTIVITY_SELECTED_STORAGE_KEY) || "";
}

function slotsToRows(slots) {
  if (!slots || typeof slots !== "object") return [];
  return Object.entries(slots).map(([key, value]) => ({
    key,
    ...(value && typeof value === "object" ? value : {}),
  }));
}

function resourceKey(item) {
  return item?.key || `${item?.id || item?.name || ""}:${item?.source || ""}:${item?.packageId || ""}`;
}

function isOwnedMarketplaceNode(node, authUser) {
  if (node?.source !== "marketplace") return false;
  const owner = String(node?.ownerUserId || node?.createdBy || "").trim();
  if (!owner) return true;
  const userIds = new Set([
    String(authUser?.userId || "").trim(),
    String(authUser?.username || "").trim(),
  ].filter(Boolean));
  return userIds.has(owner);
}

function flowSnippetKey(item) {
  return `${item?.id || ""}:${item?.version || ""}:${item?.packageDir || ""}`;
}

function flowSnippetInstances(snippet) {
  const raw = snippet?.snippet?.instances;
  if (Array.isArray(raw)) return raw.filter((item) => item && typeof item === "object");
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([instanceId, item]) => ({
      ...(item && typeof item === "object" ? item : {}),
      instanceId: item?.instanceId || instanceId,
    }));
  }
  return [];
}

function flowSnippetEdges(snippet) {
  const raw = snippet?.snippet?.edges;
  return Array.isArray(raw) ? raw.filter((item) => item && typeof item === "object") : [];
}

function flowSnippetNodeId(node, index) {
  return String(node?.instanceId || node?.id || node?.nodeId || `node_${index + 1}`);
}

function flowSnippetNodeTitle(node, index) {
  return String(node?.label || node?.displayName || node?.name || flowSnippetNodeId(node, index));
}

function flowSnippetNodeMeta(node) {
  return String(node?.definitionId || node?.type || node?.runtimeType || "").replace(/^marketplace:/, "");
}

function flowSnippetEdgeEndpoint(edge, side) {
  if (side === "source") {
    return String(edge?.source || edge?.from || edge?.sourceId || edge?.fromNode || edge?.fromInstanceId || "");
  }
  return String(edge?.target || edge?.to || edge?.targetId || edge?.toNode || edge?.toInstanceId || "");
}

function flowSnippetEdgeLabel(edge) {
  const out = edge?.sourceHandle || edge?.fromHandle || edge?.output || edge?.outputName;
  const input = edge?.targetHandle || edge?.toHandle || edge?.input || edge?.inputName;
  if (out && input) return `${out} -> ${input}`;
  return String(out || input || "");
}

function compactDiagramLabel(value, max = 16) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function numericPoint(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function autoFlowSnippetPositions(nodes, edges) {
  const ids = nodes.map((node) => node.id);
  const idSet = new Set(ids);
  const incoming = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, []]));
  edges.forEach((edge) => {
    if (!idSet.has(edge.sourceId) || !idSet.has(edge.targetId)) return;
    incoming.set(edge.targetId, (incoming.get(edge.targetId) || 0) + 1);
    outgoing.get(edge.sourceId)?.push(edge.targetId);
  });
  const level = new Map();
  const queue = ids.filter((id) => (incoming.get(id) || 0) === 0);
  if (queue.length === 0 && ids[0]) queue.push(ids[0]);
  queue.forEach((id) => level.set(id, 0));
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i];
    const nextLevel = (level.get(id) || 0) + 1;
    for (const target of outgoing.get(id) || []) {
      if (!level.has(target) || nextLevel > level.get(target)) {
        level.set(target, nextLevel);
        queue.push(target);
      }
    }
  }
  ids.forEach((id, index) => {
    if (!level.has(id)) level.set(id, index % 3);
  });
  const lanes = new Map();
  const positions = new Map();
  ids.forEach((id) => {
    const col = level.get(id) || 0;
    const row = lanes.get(col) || 0;
    lanes.set(col, row + 1);
    positions.set(id, { x: col * 190, y: row * 86 });
  });
  return positions;
}

function flowSnippetPreview(snippet) {
  const instances = flowSnippetInstances(snippet);
  const rawEdges = flowSnippetEdges(snippet);
  const idToTitle = new Map(instances.map((node, index) => [flowSnippetNodeId(node, index), flowSnippetNodeTitle(node, index)]));
  const nodes = instances.map((node, index) => ({
    id: flowSnippetNodeId(node, index),
    title: flowSnippetNodeTitle(node, index),
    meta: flowSnippetNodeMeta(node),
  }));
  const edges = rawEdges.map((edge, index) => {
    const source = flowSnippetEdgeEndpoint(edge, "source");
    const target = flowSnippetEdgeEndpoint(edge, "target");
    return {
      key: edge?.id || `${source}-${target}-${index}`,
      sourceId: source,
      targetId: target,
      source: idToTitle.get(source) || source || "?",
      target: idToTitle.get(target) || target || "?",
      label: flowSnippetEdgeLabel(edge),
    };
  });
  const rawPositions = snippet?.snippet?.ui?.nodePositions && typeof snippet.snippet.ui.nodePositions === "object"
    ? snippet.snippet.ui.nodePositions
    : {};
  const rawSizes = snippet?.snippet?.ui?.nodeSizes && typeof snippet.snippet.ui.nodeSizes === "object"
    ? snippet.snippet.ui.nodeSizes
    : {};
  const fallbackPositions = autoFlowSnippetPositions(nodes, edges);
  const diagramNodes = nodes.map((node) => {
    const position = numericPoint(rawPositions[node.id]) || fallbackPositions.get(node.id) || { x: 0, y: 0 };
    const size = rawSizes[node.id] && typeof rawSizes[node.id] === "object" ? rawSizes[node.id] : {};
    const rawWidth = Number(size.width);
    const rawHeight = Number(size.height);
    const width = Math.max(132, Math.min(210, Number.isFinite(rawWidth) ? rawWidth * 0.62 : 150));
    const height = Math.max(48, Math.min(76, Number.isFinite(rawHeight) ? rawHeight * 0.46 : 54));
    return { ...node, x: position.x, y: position.y, width, height };
  });
  const nodeById = new Map(diagramNodes.map((node) => [node.id, node]));
  const diagramEdges = edges
    .map((edge) => {
      const sourceNode = nodeById.get(edge.sourceId);
      const targetNode = nodeById.get(edge.targetId);
      if (!sourceNode || !targetNode) return null;
      const sx = sourceNode.x + sourceNode.width;
      const sy = sourceNode.y + sourceNode.height / 2;
      const tx = targetNode.x;
      const ty = targetNode.y + targetNode.height / 2;
      const curve = Math.max(48, Math.abs(tx - sx) * 0.45);
      return {
        ...edge,
        path: `M ${sx} ${sy} C ${sx + curve} ${sy}, ${tx - curve} ${ty}, ${tx} ${ty}`,
        labelX: (sx + tx) / 2,
        labelY: (sy + ty) / 2,
      };
    })
    .filter(Boolean);
  const bounds = diagramNodes.reduce(
    (acc, node) => ({
      minX: Math.min(acc.minX, node.x),
      minY: Math.min(acc.minY, node.y),
      maxX: Math.max(acc.maxX, node.x + node.width),
      maxY: Math.max(acc.maxY, node.y + node.height),
    }),
    { minX: 0, minY: 0, maxX: 420, maxY: 220 },
  );
  const pad = 36;
  const viewBox = `${bounds.minX - pad} ${bounds.minY - pad} ${Math.max(360, bounds.maxX - bounds.minX + pad * 2)} ${Math.max(180, bounds.maxY - bounds.minY + pad * 2)}`;
  return {
    nodes,
    edges,
    diagram: { nodes: diagramNodes, edges: diagramEdges, viewBox },
  };
}

export default function ProjectsPage({ resourceKind = "", authUser = null }) {
  const { t } = useTranslation();
  const { navigate, path } = useRoute();
  const canEditSkillCollections = Boolean(authUser?.isAdmin);
  const [filter, setFilter] = useState(resourceKind || "all");
  const [apiFlows, setApiFlows] = useState([]);
  const [projectView, setProjectView] = useState(loadProjectView);
  const [globalNodes, setGlobalNodes] = useState([]);
  const [globalSkills, setGlobalSkills] = useState([]);
  const [flowSnippets, setFlowSnippets] = useState([]);
  const [skillCollections, setSkillCollections] = useState([]);
  const [newSkillCollectionName, setNewSkillCollectionName] = useState("");
  const [skillCollectionSaving, setSkillCollectionSaving] = useState(false);
  const [recentRuns, setRecentRuns] = useState([]);
  const [listError, setListError] = useState("");
  const [resourceError, setResourceError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [resourcesLoaded, setResourcesLoaded] = useState(false);
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);
  const [pendingImportFile, setPendingImportFile] = useState(/** @type {File | null} */ (null));
  const [dropHighlight, setDropHighlight] = useState(false);
  const [pipelineSearch, setPipelineSearch] = useState("");
  const [activityPanelOpen, setActivityPanelOpen] = useState(loadActivityPanelOpen);
  const [selectedActivityKey, setSelectedActivityKey] = useState(loadActivitySelectionKey);
  const [resourceFilter, setResourceFilter] = useState("all");
  const [selectedResourceKey, setSelectedResourceKey] = useState("");
  const [resourceDetailTab, setResourceDetailTab] = useState("overview");
  const [skillDetails, setSkillDetails] = useState({});
  const [skillDetailLoading, setSkillDetailLoading] = useState("");
  const [nodeDetails, setNodeDetails] = useState({});
  const [nodeDetailLoading, setNodeDetailLoading] = useState("");
  const [nodeFilePath, setNodeFilePath] = useState("");
  const [nodeFilePreviews, setNodeFilePreviews] = useState({});
  const [nodeFileLoading, setNodeFileLoading] = useState("");
  const [nodeDeleteBusy, setNodeDeleteBusy] = useState("");
  const [nodeDeleteMessage, setNodeDeleteMessage] = useState("");
  const [flowSnippetDeleteBusy, setFlowSnippetDeleteBusy] = useState("");
  const [flowSnippetDeleteMessage, setFlowSnippetDeleteMessage] = useState("");
  const [hideCommunityLinks, setHideCommunityLinks] = useState(false);
  const [adminBuiltinBusy, setAdminBuiltinBusy] = useState("");
  const [adminBuiltinConfig, setAdminBuiltinConfig] = useState({ hiddenBuiltins: [], promoted: [] });
  const [flowRestoreBusy, setFlowRestoreBusy] = useState("");
  const dragDepthRef = useRef(0);
  const mountIdRef = useRef(0);
  const resourceLoadIdRef = useRef(0);

  const loadFlows = useCallback(async () => {
    const myId = ++mountIdRef.current;
    setListError("");
    try {
      const rFlows = await fetch(`/api/flows?view=${encodeURIComponent(projectView)}`);
      if (myId !== mountIdRef.current) return;
      if (!rFlows.ok) throw new Error("HTTP " + rFlows.status);
      const data = await rFlows.json();
      if (myId !== mountIdRef.current) return;
      setApiFlows(Array.isArray(data) ? data : []);
    } catch (e) {
      if (myId !== mountIdRef.current) return;
      setApiFlows([]);
      setListError(String(e.message || e));
    }
    try {
      const rRuns = await fetch("/api/pipeline-recent-runs");
      if (myId !== mountIdRef.current) return;
      if (rRuns.ok) {
        const j = await rRuns.json();
        if (myId !== mountIdRef.current) return;
        setRecentRuns(Array.isArray(j.runs) ? j.runs : []);
      } else {
        setRecentRuns([]);
      }
    } catch {
      if (myId !== mountIdRef.current) return;
      setRecentRuns([]);
    }
    if (authUser?.isAdmin) {
      try {
        const rAdmin = await fetch("/api/admin/builtin-flows");
        if (myId !== mountIdRef.current) return;
        const jAdmin = await rAdmin.json().catch(() => ({}));
        if (rAdmin.ok) {
          setAdminBuiltinConfig({
            hiddenBuiltins: Array.isArray(jAdmin?.config?.hiddenBuiltins) ? jAdmin.config.hiddenBuiltins : [],
            promoted: Array.isArray(jAdmin?.config?.promoted) ? jAdmin.config.promoted : [],
          });
        }
      } catch {
        if (myId !== mountIdRef.current) return;
        setAdminBuiltinConfig({ hiddenBuiltins: [], promoted: [] });
      }
    } else {
      setAdminBuiltinConfig({ hiddenBuiltins: [], promoted: [] });
    }
    setLoaded(true);
  }, [authUser?.isAdmin, projectView]);

  const updateAdminBuiltinFlow = useCallback(async (flow, action) => {
    if (!authUser?.isAdmin || !flow?.id) return;
    const busyKey = `${action}:${flow.source}:${flow.id}`;
    setAdminBuiltinBusy(busyKey);
    setListError("");
    try {
      const res = await fetch("/api/admin/builtin-flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          flowId: flow.id,
          ownerUserId: flow.ownerUserId || authUser.userId,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "更新内置配置失败");
      await loadFlows();
    } catch (e) {
      setListError(String(e.message || e));
    } finally {
      setAdminBuiltinBusy("");
    }
  }, [authUser?.isAdmin, authUser?.userId, loadFlows]);

  const restoreFlow = useCallback(async (flow) => {
    if (!flow?.id || !flow.archived || (flow.source !== "user" && flow.source !== "workspace")) return;
    if (flow.collaboration?.role && flow.collaboration.role !== "owner") return;
    const key = `${flow.source}:${flow.id}`;
    setFlowRestoreBusy(key);
    setListError("");
    try {
      const res = await fetch("/api/flow/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId: flow.id, flowSource: flow.source }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "恢复流水线失败");
      await loadFlows();
    } catch (e) {
      setListError(String(e.message || e));
    } finally {
      setFlowRestoreBusy("");
    }
  }, [loadFlows]);

  const loadResources = useCallback(async () => {
    const loadId = ++resourceLoadIdRef.current;
    setResourceError("");
    setResourcesLoaded(false);
    const nodesUrl = "/api/nodes";
    const flowSnippetsUrl = resourceKind === "my-flows" ? "/api/marketplace/flow-snippets?scope=owned" : "/api/marketplace/flow-snippets";
    setGlobalNodes([]);
    setFlowSnippets([]);
    setSelectedResourceKey("");
    try {
      const [nodesRes, skillsRes, collectionsRes, flowSnippetsRes] = await Promise.all([
        fetch(nodesUrl),
        fetch("/api/skills"),
        fetch("/api/skill-collections"),
        fetch(flowSnippetsUrl),
      ]);
      const nodesJson = await nodesRes.json().catch(() => ({}));
      const skillsJson = await skillsRes.json().catch(() => ({}));
      const collectionsJson = await collectionsRes.json().catch(() => ({}));
      const flowSnippetsJson = await flowSnippetsRes.json().catch(() => ({}));
      if (!nodesRes.ok) throw new Error(nodesJson.error || "Nodes HTTP " + nodesRes.status);
      if (!skillsRes.ok) throw new Error(skillsJson.error || "Skills HTTP " + skillsRes.status);
      if (!collectionsRes.ok) throw new Error(collectionsJson.error || "Collections HTTP " + collectionsRes.status);
      if (!flowSnippetsRes.ok) throw new Error(flowSnippetsJson.error || "Flow snippets HTTP " + flowSnippetsRes.status);
      if (loadId !== resourceLoadIdRef.current) return;
      setGlobalNodes(Array.isArray(nodesJson.nodes) ? nodesJson.nodes : Array.isArray(nodesJson) ? nodesJson : []);
      setGlobalSkills(Array.isArray(skillsJson.skills) ? skillsJson.skills : []);
      setSkillCollections(normalizeSkillCollections(collectionsJson));
      setFlowSnippets(Array.isArray(flowSnippetsJson.snippets) ? flowSnippetsJson.snippets : []);
    } catch (e) {
      if (loadId !== resourceLoadIdRef.current) return;
      setGlobalNodes([]);
      setGlobalSkills([]);
      setFlowSnippets([]);
      setSkillCollections([]);
      setResourceError(String(e.message || e));
    } finally {
      if (loadId !== resourceLoadIdRef.current) return;
      setResourcesLoaded(true);
    }
  }, [resourceKind]);

  useEffect(() => {
    setLoaded(false);
    loadFlows();
    loadResources();
  }, [loadFlows, loadResources]);

  useEffect(() => {
    try {
      localStorage.setItem(ACTIVITY_PANEL_OPEN_STORAGE_KEY, activityPanelOpen ? "1" : "0");
    } catch {
      /* ignore storage failures */
    }
  }, [activityPanelOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(PROJECT_VIEW_STORAGE_KEY, projectView);
    } catch {
      /* ignore storage failures */
    }
  }, [projectView]);

  useEffect(() => {
    try {
      if (selectedActivityKey) localStorage.setItem(ACTIVITY_SELECTED_STORAGE_KEY, selectedActivityKey);
      else localStorage.removeItem(ACTIVITY_SELECTED_STORAGE_KEY);
    } catch {
      /* ignore storage failures */
    }
  }, [selectedActivityKey]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/ui-context")
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) setHideCommunityLinks(Boolean(j.hideCommunityLinks));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const saveSkillCollections = useCallback(async (nextCollections) => {
    if (!canEditSkillCollections) return;
    const normalized = normalizeSkillCollections({ collections: nextCollections });
    setSkillCollectionSaving(true);
    setResourceError("");
    try {
      const res = await fetch("/api/skill-collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(skillCollectionConfig(normalized)),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Collections HTTP " + res.status);
      setSkillCollections(normalizeSkillCollections(json));
    } catch (e) {
      setResourceError(String(e.message || e));
    } finally {
      setSkillCollectionSaving(false);
    }
  }, [canEditSkillCollections]);

  const createSkillCollection = useCallback(() => {
    if (!canEditSkillCollections) return;
    const name = newSkillCollectionName.trim();
    if (!name) return;
    const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "collection";
    const used = new Set(skillCollections.map((collection) => collection.id));
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    const now = Date.now();
    void saveSkillCollections([...skillCollections, { id, name, skillKeys: [], createdAt: now, updatedAt: now }]);
    setNewSkillCollectionName("");
    setResourceFilter(`collection:${id}`);
  }, [canEditSkillCollections, newSkillCollectionName, saveSkillCollections, skillCollections]);

  const deleteSkillCollection = useCallback((collectionId) => {
    if (!canEditSkillCollections) return;
    const collection = skillCollections.find((item) => item.id === collectionId);
    if (collection?.builtin) return;
    const next = skillCollections.filter((collection) => collection.id !== collectionId);
    if (resourceFilter === `collection:${collectionId}`) setResourceFilter("all");
    void saveSkillCollections(next);
  }, [canEditSkillCollections, resourceFilter, saveSkillCollections, skillCollections]);

  const toggleSkillCollectionMembership = useCallback((collectionId, skillKey, checked) => {
    if (!canEditSkillCollections) return;
    const key = String(skillKey || "").trim();
    if (!key) return;
    const now = Date.now();
    const next = skillCollections.map((collection) => {
      if (collection.id !== collectionId) return collection;
      const keys = new Set(collection.skillKeys || []);
      if (checked) keys.add(key);
      else keys.delete(key);
      return { ...collection, skillKeys: Array.from(keys), updatedAt: now };
    });
    void saveSkillCollections(next);
  }, [canEditSkillCollections, saveSkillCollections, skillCollections]);

  const deleteMarketplaceNode = useCallback(async (node) => {
    const packageId = node?.packageId;
    const version = node?.version;
    if (!packageId || !version) return;
    if (!window.confirm(t("project:deleteMyNodeConfirm", { id: packageId, version }))) return;
    const key = resourceKey(node);
    setNodeDeleteBusy(key);
    setNodeDeleteMessage("");
    setResourceError("");
    try {
      const params = new URLSearchParams({ id: packageId, version });
      const res = await fetch(`/api/marketplace/node?${params.toString()}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        const usage = Array.isArray(json?.usage) && json.usage.length > 0
          ? ` ${t("project:deleteMyNodeUsedBy", { count: json.usage.length })}`
          : "";
        throw new Error((json?.error || "Delete failed") + usage);
      }
      setNodeDeleteMessage(t("project:deleteMyNodeSuccess", { id: packageId, version }));
      setNodeDetails((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setNodeFilePreviews((prev) => {
        const next = {};
        for (const [previewKey, value] of Object.entries(prev)) {
          if (!previewKey.startsWith(`${key}:`)) next[previewKey] = value;
        }
        return next;
      });
      setSelectedResourceKey("");
      await loadResources();
    } catch (e) {
      setNodeDeleteMessage(String(e.message || e));
    } finally {
      setNodeDeleteBusy("");
    }
  }, [loadResources, t]);

  const deleteFlowSnippet = useCallback(async (snippet) => {
    const id = snippet?.id;
    const version = snippet?.version || "1.0.0";
    if (!id || !version) return;
    if (!window.confirm(t("project:deleteMyFlowConfirm", { id, version }))) return;
    const key = flowSnippetKey(snippet);
    setFlowSnippetDeleteBusy(key);
    setFlowSnippetDeleteMessage("");
    setResourceError("");
    try {
      const params = new URLSearchParams({ id, version });
      const res = await fetch(`/api/marketplace/flow-snippet?${params.toString()}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) throw new Error(json?.error || "Delete failed");
      setFlowSnippetDeleteMessage(t("project:deleteMyFlowSuccess", { id, version }));
      setSelectedResourceKey("");
      await loadResources();
    } catch (e) {
      setFlowSnippetDeleteMessage(String(e.message || e));
    } finally {
      setFlowSnippetDeleteBusy("");
    }
  }, [loadResources, t]);

  useEffect(() => {
    if (resourceKind === "nodes" || resourceKind === "my-nodes" || resourceKind === "my-flows" || resourceKind === "skills") {
      setFilter(resourceKind);
      setResourceFilter("all");
      setSelectedResourceKey("");
      setResourceDetailTab("overview");
      return;
    }
    setFilter((prev) => (prev === "archived" ? "archived" : "all"));
  }, [resourceKind]);

  /** 从 /flow?new=1 重定向到 /projects?new=1 时打开弹框；?tab=archived 切换归档标签；随后去掉查询串 */
  useEffect(() => {
    if (path !== "/projects" && path !== "/") return;
    const sp = new URLSearchParams(window.location.search);
    const tab = sp.get("tab");
    let changed = false;
    if (tab === "nodes") {
      navigate("/nodes");
      return;
    }
    if (tab === "my-nodes") {
      navigate("/my-nodes");
      return;
    }
    if (tab === "my-flows") {
      navigate("/my-flows");
      return;
    }
    if (tab === "skills") {
      navigate("/skills");
      return;
    }
    if (tab === "archived") {
      setFilter("archived");
      sp.delete("tab");
      changed = true;
    } else if (tab) {
      setFilter("all");
      sp.delete("tab");
      changed = true;
    }
    if (sp.get("new") === "1") {
      setNewPipelineOpen(true);
      sp.delete("new");
      changed = true;
    }
    if (changed) {
      const q = sp.toString();
      window.history.replaceState({}, "", q ? `/projects?${q}` : "/projects");
    }
  }, [path, navigate]);

  const recentActivity = useMemo(
    () => mergeRecentActivity(recentRuns, loadOpenedEntries(), apiFlows),
    [recentRuns, apiFlows, path],
  );

  const filteredRecentActivity = useMemo(
    () => recentActivity.filter((row) => activityMatchesSearch(pipelineSearch, row)),
    [recentActivity, pipelineSearch],
  );

  const searchNorm = pipelineSearch.trim().toLowerCase();

  const displayedFlows = useMemo(() => {
    if (filter === "archived") {
      return apiFlows.filter((f) => f.archived);
    }
    return apiFlows.filter((f) => !f.archived);
  }, [apiFlows, filter]);

  const filteredFlows = useMemo(
    () => displayedFlows.filter((f) => flowMatchesSearch(f, searchNorm, t)),
    [displayedFlows, searchNorm, t],
  );

  const promotedAdminFlowIds = useMemo(
    () => new Set((adminBuiltinConfig.promoted || []).map((item) => String(item?.id || "").trim()).filter(Boolean)),
    [adminBuiltinConfig.promoted],
  );

  const hiddenBuiltinFlows = useMemo(
    () => (adminBuiltinConfig.hiddenBuiltins || []).map((id) => String(id || "").trim()).filter(Boolean),
    [adminBuiltinConfig.hiddenBuiltins],
  );

  const isNodeResourceTab = filter === "nodes" || filter === "my-nodes";
  const isMyNodesTab = filter === "my-nodes";
  const isMyFlowsTab = filter === "my-flows";

  const filteredNodes = useMemo(
    () =>
      globalNodes.filter((n) => {
        if (isMyNodesTab && !isOwnedMarketplaceNode(n, authUser)) return false;
        const filterMatch =
          resourceFilter === "all" ||
          (resourceFilter === "marketplace" ? n.source === "marketplace" : n.type === resourceFilter);
        return filterMatch && resourceTextMatches(pipelineSearch, [
          n.id,
          n.label,
          n.displayName,
          n.description,
          n.type,
          n.source,
          n.packageId,
          n.version,
        ]);
      }),
    [authUser, globalNodes, isMyNodesTab, pipelineSearch, resourceFilter],
  );

  const skillCollectionSkillSets = useMemo(() => {
    const map = new Map();
    for (const collection of skillCollections) {
      map.set(collection.id, new Set(collectionSkillKeys(collection, globalSkills)));
    }
    return map;
  }, [globalSkills, skillCollections]);

  const skillResourceFilters = useMemo(
    () => [
      { id: "all", label: "全部" },
      ...skillCollections.map((collection) => ({
        id: `collection:${collection.id}`,
        label: collection.name,
        count: skillCollectionSkillSets.get(collection.id)?.size || 0,
        collection,
      })),
      { id: "ungrouped", label: "未分组" },
    ],
    [skillCollectionSkillSets, skillCollections],
  );

  const filteredSkills = useMemo(
    () =>
      globalSkills.filter((s) => {
        const key = resourceKey(s);
        let filterMatch = resourceFilter === "all";
        if (resourceFilter.startsWith("collection:")) {
          const id = resourceFilter.slice("collection:".length);
          filterMatch = Boolean(skillCollectionSkillSets.get(id)?.has(key));
        } else if (resourceFilter === "ungrouped") {
          filterMatch = !Array.from(skillCollectionSkillSets.values()).some((keys) => keys.has(key));
        }
        return filterMatch && resourceTextMatches(pipelineSearch, [
          s.name,
          s.id,
          s.description,
          s.sourceLabel,
          s.source,
          s.path,
        ]);
      }),
    [globalSkills, pipelineSearch, resourceFilter, skillCollectionSkillSets],
  );

  const filteredFlowSnippets = useMemo(
    () =>
      flowSnippets.filter((snippet) =>
        resourceTextMatches(pipelineSearch, [
          snippet.id,
          snippet.name,
          snippet.displayName,
          snippet.description,
          snippet.version,
          snippet.packageDir,
          Array.isArray(snippet.tags) ? snippet.tags.join(" ") : "",
        ]),
      ),
    [flowSnippets, pipelineSearch],
  );

  const isResourceTab = isNodeResourceTab || isMyFlowsTab || filter === "skills";
  const selectedNode = useMemo(
    () => filteredNodes.find((n) => resourceKey(n) === selectedResourceKey) || filteredNodes[0] || null,
    [filteredNodes, selectedResourceKey],
  );
  const selectedSkill = useMemo(
    () => filteredSkills.find((s) => resourceKey(s) === selectedResourceKey) || filteredSkills[0] || null,
    [filteredSkills, selectedResourceKey],
  );
  const selectedFlowSnippet = useMemo(
    () => filteredFlowSnippets.find((s) => flowSnippetKey(s) === selectedResourceKey) || filteredFlowSnippets[0] || null,
    [filteredFlowSnippets, selectedResourceKey],
  );
  const selectedSkillDetail = selectedSkill ? skillDetails[resourceKey(selectedSkill)] : null;
  const selectedNodeDetail = selectedNode ? nodeDetails[resourceKey(selectedNode)] : null;
  const selectedNodeFilePreview = selectedNode && nodeFilePath ? nodeFilePreviews[`${resourceKey(selectedNode)}:${nodeFilePath}`] : null;
  const searchPlaceholder =
    isNodeResourceTab
      ? t("project:searchNodes")
      : isMyFlowsTab
        ? t("project:searchFlows")
      : filter === "skills"
        ? t("project:searchSkills")
        : t("project:searchPipelines");

  useEffect(() => {
    if (filter !== "skills" || !selectedSkill) return;
    const key = resourceKey(selectedSkill);
    if (skillDetails[key]) return;
    let cancelled = false;
    setSkillDetailLoading(key);
    fetch(`/api/skills/detail?key=${encodeURIComponent(key)}`)
      .then((r) => r.json().then((j) => ({ ok: r.ok, json: j })))
      .then(({ ok, json }) => {
        if (cancelled) return;
        if (ok && json.skill) {
          setSkillDetails((prev) => ({ ...prev, [key]: json.skill }));
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setSkillDetailLoading("");
      });
    return () => {
      cancelled = true;
    };
  }, [filter, selectedSkill, skillDetails]);

  useEffect(() => {
    if (!isNodeResourceTab || !selectedNode) return;
    const key = resourceKey(selectedNode);
    if (nodeDetails[key]) return;
    let cancelled = false;
    setNodeDetailLoading(key);
    fetch(`/api/nodes/detail?id=${encodeURIComponent(selectedNode.id)}`)
      .then((r) => r.json().then((j) => ({ ok: r.ok, json: j })))
      .then(({ ok, json }) => {
        if (cancelled) return;
        if (ok) setNodeDetails((prev) => ({ ...prev, [key]: json }));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setNodeDetailLoading("");
      });
    return () => {
      cancelled = true;
    };
  }, [isNodeResourceTab, selectedNode, nodeDetails]);

  useEffect(() => {
    if (!isNodeResourceTab) return;
    const files = Array.isArray(selectedNodeDetail?.files) ? selectedNodeDetail.files : [];
    setNodeFilePath((prev) => (prev && files.some((f) => f.path === prev) ? prev : files[0]?.path || ""));
  }, [isNodeResourceTab, selectedNodeDetail]);

  useEffect(() => {
    if (!isNodeResourceTab || !selectedNode || !nodeFilePath) return;
    const key = `${resourceKey(selectedNode)}:${nodeFilePath}`;
    if (nodeFilePreviews[key]) return;
    let cancelled = false;
    setNodeFileLoading(key);
    fetch(`/api/nodes/file?id=${encodeURIComponent(selectedNode.id)}&path=${encodeURIComponent(nodeFilePath)}`)
      .then((r) => r.json().then((j) => ({ ok: r.ok, json: j })))
      .then(({ ok, json }) => {
        if (cancelled) return;
        if (ok) setNodeFilePreviews((prev) => ({ ...prev, [key]: json }));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setNodeFileLoading("");
      });
    return () => {
      cancelled = true;
    };
  }, [isNodeResourceTab, selectedNode, nodeFilePath, nodeFilePreviews]);

  useEffect(() => {
    setNodeDeleteMessage("");
  }, [selectedResourceKey, filter]);

  const openFlow = (f) => {
    navigate(preferredFlowUrl(f, "workspace"));
  };

  const openActivityRow = (row) => {
    setSelectedActivityKey(activitySelectionKey(row));
    navigate(preferredFlowUrl({
      id: row.flowId,
      source: row.flowSource,
      archived: Boolean(row.archived),
    }, "workspace"));
  };

  const onImportDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.dataTransfer?.types?.includes("Files")) return;
    dragDepthRef.current += 1;
    setDropHighlight(true);
  }, []);

  const onImportDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setDropHighlight(false);
    }
  }, []);

  const onImportDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onImportDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setDropHighlight(false);
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    const n = f.name.toLowerCase();
    if (!n.endsWith(".yaml") && !n.endsWith(".yml") && !n.endsWith(".zip")) return;
    setPendingImportFile(f);
  }, []);

  return (
    <div
      className={"af-projects" + (dropHighlight ? " af-projects--drop-target" : "")}
      onDragEnter={onImportDragEnter}
      onDragLeave={onImportDragLeave}
      onDragOver={onImportDragOver}
      onDrop={onImportDrop}
    >
      <header className="af-projects-top">
        {resourceKind ? (
          <div className="af-projects-tabs af-projects-tabs--empty" aria-hidden />
        ) : (
          <div className="af-projects-tabs">
            <button
              type="button"
              className={filter === "all" ? "af-tab af-tab--active" : "af-tab"}
              onClick={() => setFilter("all")}
            >
              {t("project:all")}
            </button>
            <button
              type="button"
              className={filter === "archived" ? "af-tab af-tab--active" : "af-tab"}
              onClick={() => setFilter("archived")}
            >
              {t("project:archived")}
            </button>
          </div>
        )}
        <div className="af-projects-top-right">
          {!isResourceTab ? (
            <div className="af-scope-switch af-project-scope-switch" aria-label="Project 视图">
              <button type="button" className={projectView === "personal" ? "is-active" : ""} onClick={() => setProjectView("personal")}>个人</button>
              <button type="button" className={projectView === "team" ? "is-active" : ""} onClick={() => setProjectView("team")}>团队</button>
            </div>
          ) : null}
          <div className="af-search-wrap">
            <span className="material-symbols-outlined af-search-icon">search</span>
            <input
              className={"af-search" + (pipelineSearch.trim() ? " af-search--has-clear" : "")}
              type="search"
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              autoComplete="off"
              value={pipelineSearch}
              onChange={(e) => setPipelineSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setPipelineSearch("");
                  e.currentTarget.blur();
                }
              }}
            />
            {pipelineSearch.trim() ? (
              <button
                type="button"
                className="af-search-clear"
                aria-label="Clear search"
                onClick={() => setPipelineSearch("")}
              >
                <span className="material-symbols-outlined" aria-hidden>
                  close
                </span>
              </button>
            ) : null}
          </div>
          {isResourceTab ? (
            <button type="button" className="af-btn-primary af-create-btn" onClick={() => loadResources()}>
              {t("project:refreshResources")}
            </button>
          ) : (
            <>
              <button
                type="button"
                className={"af-icon-btn" + (activityPanelOpen ? " af-icon-btn--active" : "")}
                aria-label={t("flow:palette.toggleRecentActivity")}
                aria-expanded={activityPanelOpen}
                aria-controls="af-recent-activity-panel"
                onClick={() => setActivityPanelOpen((v) => !v)}
              >
                <span className="material-symbols-outlined">notifications</span>
              </button>
              <button type="button" className="af-btn-primary af-create-btn" onClick={() => setNewPipelineOpen(true)}>
                {t("project:createNew")}
              </button>
            </>
          )}
        </div>
      </header>

      <div className="af-projects-body">
        <section className="af-projects-main">
          <header className="af-projects-section-head">
            <h2 className="af-projects-h2">
              {filter === "my-nodes"
                ? t("project:myNodes")
                : filter === "my-flows"
                ? t("project:myFlows")
                : filter === "nodes"
                ? t("project:nodes")
                : filter === "skills"
                  ? t("project:globalSkills")
                  : filter === "archived"
                    ? t("project:archivedPipelines")
                    : t("project:activeProjects")}
            </h2>
            <p className="af-projects-sub">
              {searchNorm
                ? t("project:filterResult", {
                    count:
                      (filter === "nodes" || filter === "my-nodes")
                        ? filteredNodes.length
                        : filter === "my-flows"
                          ? filteredFlowSnippets.length
                        : filter === "skills"
                          ? filteredSkills.length
                          : filteredFlows.length,
                  })
                : filter === "my-nodes"
                  ? t("project:myNodesHint", { count: filteredNodes.length })
                : filter === "my-flows"
                  ? t("project:myFlowsHint", { count: filteredFlowSnippets.length })
                : filter === "nodes"
                  ? t("project:nodesHint", { count: globalNodes.length })
                  : filter === "skills"
                    ? t("project:skillsHint", { count: globalSkills.length })
                : filter === "archived"
                  ? t("project:archivedHint")
                  : t("project:activeHint")}
            </p>
            {listError ? <p className="af-err af-projects-api-hint">{listError}</p> : null}
            {resourceError && isResourceTab ? <p className="af-err af-projects-api-hint">{resourceError}</p> : null}
          </header>

          {isResourceTab ? (
            <div className="af-resource-toolbar">
              {filter === "skills" ? <SkillHubPanel onChanged={loadResources} canManage={Boolean(authUser?.isAdmin)} /> : null}
              <div className="af-resource-purpose">
                <span className="material-symbols-outlined">{isMyFlowsTab ? "schema" : isNodeResourceTab ? (isMyNodesTab ? "deployed_code" : "account_tree") : "extension"}</span>
                <div>
                  <h3>{isMyFlowsTab ? t("project:myFlowsPurposeTitle") : isMyNodesTab ? t("project:myNodesPurposeTitle") : isNodeResourceTab ? t("project:nodesPurposeTitle") : t("project:skillsPurposeTitle")}</h3>
                  <p>{isMyFlowsTab ? t("project:myFlowsPurposeDesc") : isMyNodesTab ? t("project:myNodesPurposeDesc") : isNodeResourceTab ? t("project:nodesPurposeDesc") : t("project:skillsPurposeDesc")}</p>
                </div>
              </div>
              {!isMyFlowsTab ? (
                <>
                  {isNodeResourceTab ? (
                    <div className="af-resource-filter-row">
                      <button
                        type="button"
                        className={"af-resource-filter" + (!isMyNodesTab ? " af-resource-filter--active" : "")}
                        onClick={() => {
                          setFilter("nodes");
                          setResourceFilter("all");
                          setSelectedResourceKey("");
                        }}
                      >
                        {t("project:nodeScopeAll")}
                      </button>
                      <button
                        type="button"
                        className={"af-resource-filter" + (isMyNodesTab ? " af-resource-filter--active" : "")}
                        onClick={() => {
                          setFilter("my-nodes");
                          setResourceFilter("all");
                          setSelectedResourceKey("");
                        }}
                      >
                        {t("project:nodeScopeMine")}
                      </button>
                    </div>
                  ) : null}
                  <div className="af-resource-filter-row">
                    {(isNodeResourceTab ? (isMyNodesTab ? MY_NODE_FILTERS : NODE_FILTERS).map((item) => ({ id: item, label: t(`project:resourceFilter.${item}`) })) : skillResourceFilters).map((item) => (
                      item.collection ? (
                        <span
                          key={item.id}
                          className={"af-resource-filter-chip" + (resourceFilter === item.id ? " af-resource-filter-chip--active" : "")}
                        >
                          <button
                            type="button"
                            className="af-resource-filter af-resource-filter--embedded"
                            onClick={() => {
                              setResourceFilter(item.id);
                              setSelectedResourceKey("");
                            }}
                          >
                            {item.label}
                            <em>{item.count}</em>
                            {item.collection.builtin ? <strong>built-in</strong> : null}
                          </button>
                          {canEditSkillCollections && !item.collection.builtin ? (
                            <button
                              type="button"
                              className="af-resource-filter-chip__delete"
                              disabled={skillCollectionSaving}
                              aria-label={`删除 ${item.collection.name}`}
                              onClick={() => deleteSkillCollection(item.collection.id)}
                            >
                              <span className="material-symbols-outlined">close</span>
                            </button>
                          ) : null}
                        </span>
                      ) : (
                        <button
                          key={item.id}
                          type="button"
                          className={"af-resource-filter" + (resourceFilter === item.id ? " af-resource-filter--active" : "")}
                          onClick={() => {
                            setResourceFilter(item.id);
                            setSelectedResourceKey("");
                          }}
                        >
                          {item.label}
                        </button>
                      )
                    ))}
                  </div>
                </>
              ) : null}
              {filter === "skills" && canEditSkillCollections ? (
                <div className="af-skill-collections-manager">
                  <div className="af-skill-collections-create">
                    <input
                      className="af-set-input af-set-input--sm"
                      value={newSkillCollectionName}
                      onChange={(e) => setNewSkillCollectionName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") createSkillCollection();
                      }}
                      placeholder="新建 skill collection"
                    />
                    <button
                      type="button"
                      className="af-set-btn-add af-set-btn-add--compact"
                      disabled={!newSkillCollectionName.trim() || skillCollectionSaving}
                      onClick={() => createSkillCollection()}
                    >
                      <span className="material-symbols-outlined">add</span>
                      新建
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {isNodeResourceTab ? (
            <div className="af-resource-grid">
              {filteredNodes.length > 0 ? (
                filteredNodes.map((n) => (
                  <button
                    key={`${n.id}:${n.source || ""}:${n.packageId || ""}`}
                    type="button"
                    className={"af-resource-card" + (selectedNode && resourceKey(n) === resourceKey(selectedNode) ? " af-resource-card--active" : "")}
                    onClick={() => setSelectedResourceKey(resourceKey(n))}
                  >
                    <div className="af-resource-card-head">
                      <span className={badgeClass(n.type === "control" ? "secondary" : n.type === "provide" ? "primary" : "muted")}>
                        <HighlightMatch query={pipelineSearch}>{n.type || "node"}</HighlightMatch>
                      </span>
                      <span className="af-resource-source">
                        <HighlightMatch query={pipelineSearch}>{nodeSourceLabel(n.source, t)}</HighlightMatch>
                      </span>
                    </div>
                    <h3 className="af-project-title">
                      <HighlightMatch query={pipelineSearch}>{n.label || n.displayName || n.id}</HighlightMatch>
                    </h3>
                    <p className="af-project-desc">
                      <HighlightMatch query={pipelineSearch}>{n.description || t("project:noDescription")}</HighlightMatch>
                    </p>
                    <div className="af-resource-meta-row">
                      <span>
                        <HighlightMatch query={pipelineSearch}>{n.id}</HighlightMatch>
                      </span>
                      <span>{t("project:nodeSlots", { inputs: Object.keys(n.inputs || {}).length, outputs: Object.keys(n.outputs || {}).length })}</span>
                    </div>
                    {n.packageId ? (
                      <div className="af-project-path">
                        <span className="material-symbols-outlined af-path-icon">deployed_code</span>
                        <span className="af-path-text">
                          <HighlightMatch query={pipelineSearch}>{`${n.packageId}${n.version ? ` / ${n.version}` : ""}`}</HighlightMatch>
                        </span>
                      </div>
                    ) : null}
                  </button>
                ))
              ) : !resourcesLoaded ? (
                <div className="af-projects-empty-block">
                  <p className="af-projects-empty">{t("project:loadingResources")}</p>
                </div>
              ) : (
                <div className="af-projects-empty-block">
                  <p className="af-projects-empty">
                    {searchNorm ? t("project:noNodeMatch", { query: pipelineSearch.trim() }) : isMyNodesTab ? t("project:noMyNodes") : t("project:noNodes")}
                  </p>
                </div>
              )}
            </div>
          ) : isMyFlowsTab ? (
            <div className="af-resource-grid">
              {filteredFlowSnippets.length > 0 ? (
                filteredFlowSnippets.map((snippet) => {
                  const instances = flowSnippetInstances(snippet);
                  const edges = flowSnippetEdges(snippet);
                  const nodeCount = Number.isFinite(Number(snippet.nodeCount)) ? Number(snippet.nodeCount) : instances.length;
                  const edgeCount = Number.isFinite(Number(snippet.edgeCount)) ? Number(snippet.edgeCount) : edges.length;
                  return (
                    <button
                      key={flowSnippetKey(snippet)}
                      type="button"
                      className={"af-resource-card" + (selectedFlowSnippet && flowSnippetKey(snippet) === flowSnippetKey(selectedFlowSnippet) ? " af-resource-card--active" : "")}
                      onClick={() => setSelectedResourceKey(flowSnippetKey(snippet))}
                    >
                      <div className="af-resource-card-head">
                        <span className={badgeClass("primary")}>
                          <HighlightMatch query={pipelineSearch}>{snippet.version ? `v${snippet.version}` : "flow"}</HighlightMatch>
                        </span>
                        <span className="af-resource-source">{t("project:flowSnippet")}</span>
                      </div>
                      <h3 className="af-project-title">
                        <HighlightMatch query={pipelineSearch}>{snippet.displayName || snippet.name || snippet.id}</HighlightMatch>
                      </h3>
                      <p className="af-project-desc">
                        <HighlightMatch query={pipelineSearch}>{snippet.description || t("project:noDescription")}</HighlightMatch>
                      </p>
                      <div className="af-resource-meta-row">
                        <span>{t("project:flowSnippetNodes", { nodes: nodeCount, edges: edgeCount })}</span>
                        <span>
                          <HighlightMatch query={pipelineSearch}>{snippet.id}</HighlightMatch>
                        </span>
                      </div>
                      <div className="af-project-path">
                        <span className="material-symbols-outlined af-path-icon">schema</span>
                        <span className="af-path-text">
                          <HighlightMatch query={pipelineSearch}>{flowSnippetPathHint(snippet)}</HighlightMatch>
                        </span>
                      </div>
                    </button>
                  );
                })
              ) : !resourcesLoaded ? (
                <div className="af-projects-empty-block">
                  <p className="af-projects-empty">{t("project:loadingResources")}</p>
                </div>
              ) : (
                <div className="af-projects-empty-block">
                  <p className="af-projects-empty">
                    {searchNorm ? t("project:noFlowSnippetMatch", { query: pipelineSearch.trim() }) : t("project:noMyFlows")}
                  </p>
                </div>
              )}
            </div>
          ) : filter === "skills" ? (
            <div className="af-resource-grid">
              {filteredSkills.length > 0 ? (
                filteredSkills.map((s) => {
                  const key = resourceKey(s);
                  const memberships = skillCollections.filter((collection) => skillCollectionSkillSets.get(collection.id)?.has(key));
                  return (
                    <button
                      key={s.key || `${s.source}:${s.name}`}
                      type="button"
                      className={"af-resource-card" + (selectedSkill && key === resourceKey(selectedSkill) ? " af-resource-card--active" : "")}
                      onClick={() => setSelectedResourceKey(key)}
                    >
                      <div className="af-resource-card-head">
                        <span className={badgeClass(s.source === "builtin" ? "muted" : "primary")}>
                          <HighlightMatch query={pipelineSearch}>{s.sourceLabel || s.source || "skill"}</HighlightMatch>
                        </span>
                        <span className="af-resource-source">{t("project:skill")}</span>
                      </div>
                      <h3 className="af-project-title">
                        <HighlightMatch query={pipelineSearch}>{s.name || s.id}</HighlightMatch>
                      </h3>
                      <p className="af-project-desc">
                        <HighlightMatch query={pipelineSearch}>{s.description || t("project:noDescription")}</HighlightMatch>
                      </p>
                      <div className="af-project-path">
                        <span className="material-symbols-outlined af-path-icon">extension</span>
                        <span className="af-path-text">
                          <HighlightMatch query={pipelineSearch}>{s.path || s.key || ""}</HighlightMatch>
                        </span>
                      </div>
                      <div className="af-skill-card-collections">
                        {memberships.slice(0, 3).map((collection) => (
                          <span key={collection.id}>{collection.name}</span>
                        ))}
                        {memberships.length === 0 ? (
                          <span className="af-skill-card-collection-empty">未分组</span>
                        ) : null}
                      </div>
                    </button>
                  );
                })
              ) : !resourcesLoaded ? (
                <div className="af-projects-empty-block">
                  <p className="af-projects-empty">{t("project:loadingResources")}</p>
                </div>
              ) : (
                <div className="af-projects-empty-block">
                  <p className="af-projects-empty">
                    {searchNorm ? t("project:noSkillMatch", { query: pipelineSearch.trim() }) : t("project:noSkills")}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <>
            {authUser?.isAdmin && filter === "all" && hiddenBuiltinFlows.length > 0 ? (
              <div className="af-project-admin-panel">
                <div>
                  <strong>已隐藏内置</strong>
                  <span>这些包内置流水线不会出现在普通项目列表中。</span>
                </div>
                <div className="af-project-admin-hidden-list">
                  {hiddenBuiltinFlows.map((flowId) => {
                    const busy = adminBuiltinBusy === `show-builtin:builtin:${flowId}`;
                    return (
                      <button
                        key={flowId}
                        type="button"
                        disabled={busy}
                        onClick={() => updateAdminBuiltinFlow({ id: flowId, source: "builtin" }, "show-builtin")}
                      >
                        <span>{flowId}</span>
                        <em>{busy ? "恢复中" : "恢复"}</em>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div className="af-project-grid">
              {filteredFlows.length > 0 ? (
                filteredFlows.map((f) => {
                  const canPromote = authUser?.isAdmin && f.source === "user" && !f.archived && !promotedAdminFlowIds.has(f.id);
                  const canUnpromote = authUser?.isAdmin && f.source === "admin";
                  const canHideBuiltin = authUser?.isAdmin && f.source === "builtin";
                  const busyAction = adminBuiltinBusy.endsWith(`:${f.source}:${f.id}`);
                  const canRestore = f.archived && (f.source === "user" || f.source === "workspace")
                    && (!f.collaboration?.role || f.collaboration.role === "owner");
                  const restoreBusy = flowRestoreBusy === `${f.source}:${f.id}`;
                  return (
                  <div
                    key={`${f.id}:${f.source ?? "user"}:${f.archived ? "a" : ""}:${f.collaboration?.id || "own"}`}
                    className={projectCardClass(f.source)}
                    role="button"
                    tabIndex={0}
                    onClick={() => openFlow(f)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openFlow(f);
                      }
                    }}
                  >
                    <div className="af-project-card-body">
                      <span className={badgeClass(sourceBadgeMeta(f.source, t).tone)}>
                        <HighlightMatch query={pipelineSearch}>{sourceBadgeMeta(f.source, t).label}</HighlightMatch>
                      </span>
                      {f.collaboration?.role ? (
                        <span className={badgeClass(f.collaboration.role === "owner" ? "primary" : "muted")}>
                          {f.collaboration.role === "owner"
                            ? f.collaboration.teamShares?.length ? "已分享团队" : "我创建的"
                            : f.collaboration.accessSource === "team"
                              ? `${f.collaboration.teamShares?.find((share) => share.teamId === f.collaboration.teamId)?.teamName || "团队"}共享`
                              : `${f.collaboration.ownerUsername || f.collaboration.ownerId} 分享`}
                        </span>
                      ) : null}
                      {f.archived ? (
                        <span className={badgeClass("muted")}>
                          <HighlightMatch query={pipelineSearch}>{t("project:archived")}</HighlightMatch>
                        </span>
                      ) : null}
                      <h3 className="af-project-title">
                        <HighlightMatch query={pipelineSearch}>{f.id}</HighlightMatch>
                      </h3>
                      <p className="af-project-desc">
                        <HighlightMatch query={pipelineSearch}>{pipelineCardDescription(f, t)}</HighlightMatch>
                      </p>
                      <div className="af-project-path">
                        <span className="material-symbols-outlined af-path-icon">database</span>
                        <span className="af-path-text">
                          <HighlightMatch query={pipelineSearch}>{sourcePathHint(f)}</HighlightMatch>
                        </span>
                      </div>
                      {authUser?.isAdmin || canRestore ? (
                        <div
                          className="af-project-admin-actions"
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          {canRestore ? (
                            <button type="button" disabled={restoreBusy} onClick={() => restoreFlow(f)}>
                              {restoreBusy ? t("project:restoringActive") : t("project:restoreActive")}
                            </button>
                          ) : null}
                          {canPromote ? (
                            <button type="button" disabled={busyAction} onClick={() => updateAdminBuiltinFlow(f, "promote")}>
                              设为内置
                            </button>
                          ) : null}
                          {canUnpromote ? (
                            <button type="button" disabled={busyAction} onClick={() => updateAdminBuiltinFlow(f, "unpromote")}>
                              取消内置
                            </button>
                          ) : null}
                          {canHideBuiltin ? (
                            <button type="button" disabled={busyAction} onClick={() => updateAdminBuiltinFlow(f, "hide-builtin")}>
                              隐藏内置
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );})
              ) : !loaded ? (
                <div className="af-projects-empty-block">
                  <p className="af-projects-empty">{t("project:loadingPipelines")}</p>
                </div>
              ) : displayedFlows.length === 0 ? (
                <div className="af-projects-empty-block">
                  <p className="af-projects-empty">
                    {filter === "archived"
                      ? t("project:noArchived")
                      : apiFlows.length > 0
                        ? t("project:noActive")
                        : listError
                          ? t("project:loadFailed")
                          : t("project:noPipelines")}
                  </p>
                  {!listError && apiFlows.length === 0 && filter === "all" ? (
                    <p className="af-projects-empty-hint">
                      {t("project:emptyHint", {
                        code1: "agentflow ui",
                        code2: ".agentflow/pipelines"
                      })}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="af-projects-empty-block">
                  <p className="af-projects-empty">
                    {t("project:noMatch", { query: pipelineSearch.trim() })}
                  </p>
                </div>
              )}

              <button type="button" className="af-project-add" onClick={() => setNewPipelineOpen(true)}>
                <span className="material-symbols-outlined af-project-add-icon">add_circle</span>
                <span className="af-project-add-label">{t("project:newPipeline")}</span>
              </button>

              {!hideCommunityLinks ? (
                <a
                  className="af-hub-card"
                  href="https://agentflow-hub.com"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <div className="af-hub-card__glow" aria-hidden />
                  <span className="af-hub-card__eyebrow">
                    <span className="material-symbols-outlined af-hub-card__eyebrow-icon">hub</span>
                    {t("project:hubCard.eyebrow")}
                  </span>
                  <h3 className="af-hub-card__title">{t("project:hubCard.title")}</h3>
                  <p className="af-hub-card__desc">{t("project:hubCard.desc")}</p>
                  <span className="af-hub-card__cta">
                    {t("project:hubCard.cta")}
                    <span className="material-symbols-outlined af-hub-card__cta-icon">arrow_outward</span>
                  </span>
                  <code className="af-hub-card__cli">{t("project:hubCard.cliHint")}</code>
                </a>
              ) : null}
            </div>
            </>
          )}
        </section>

        {isResourceTab ? (
          <aside className="af-resource-detail" aria-label={isNodeResourceTab ? t("project:nodeDetail") : isMyFlowsTab ? t("project:flowDetail") : t("project:skillDetail")}>
            {isNodeResourceTab && selectedNode ? (
              <>
                <div className="af-resource-detail-head">
                  <span className="material-symbols-outlined">account_tree</span>
                  <div>
                    <h3>{selectedNode.label || selectedNode.displayName || selectedNode.id}</h3>
                    <p>{selectedNode.id}</p>
                  </div>
                </div>

                <div className="af-resource-detail-tabs">
                  {["overview", "schema", "runtime", "files", "usage"].map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      className={"af-resource-detail-tab" + (resourceDetailTab === tab ? " af-resource-detail-tab--active" : "")}
                      onClick={() => setResourceDetailTab(tab)}
                    >
                      {t(`project:nodeDetailTabs.${tab}`)}
                    </button>
                  ))}
                </div>

                {nodeDetailLoading === resourceKey(selectedNode) ? (
                  <p className="af-resource-detail-desc">{t("project:loadingResources")}</p>
                ) : resourceDetailTab === "overview" ? (
                  <>
                    <p className="af-resource-detail-desc">{selectedNode.description || selectedNodeDetail?.node?.description || t("project:noDescription")}</p>
                    <dl className="af-resource-detail-kv">
                      <div><dt>{t("project:detailType")}</dt><dd>{selectedNode.type || selectedNodeDetail?.node?.type || "node"}</dd></div>
                      <div><dt>{t("project:detailSource")}</dt><dd>{nodeSourceLabel(selectedNode.source, t)}</dd></div>
                      {selectedNode.packageId ? <div><dt>{t("project:detailPackage")}</dt><dd>{selectedNode.packageId}</dd></div> : null}
                      {selectedNode.version ? <div><dt>{t("project:detailVersion")}</dt><dd>{selectedNode.version}</dd></div> : null}
                      {(selectedNode.packageDir || selectedNodeDetail?.baseDir) ? (
                        <div><dt>{t("project:detailPath")}</dt><dd>{selectedNode.packageDir || selectedNodeDetail?.baseDir}</dd></div>
                      ) : null}
                      <div><dt>{t("project:detailEditable")}</dt><dd>{selectedNodeDetail?.readOnly === false ? t("project:editable") : t("project:readOnly")}</dd></div>
                    </dl>
                    {isMyNodesTab && selectedNode.source === "marketplace" ? (
                      <div className="af-resource-detail-section af-resource-danger-zone">
                        <h4>{t("project:myNodeManagement")}</h4>
                        <p>{t("project:deleteMyNodeHint")}</p>
                        <button
                          type="button"
                          className="af-btn-secondary af-btn-danger"
                          disabled={nodeDeleteBusy === resourceKey(selectedNode)}
                          onClick={() => deleteMarketplaceNode(selectedNode)}
                        >
                          <span className="material-symbols-outlined">delete</span>
                          {nodeDeleteBusy === resourceKey(selectedNode) ? t("project:deletingMyNode") : t("project:deleteMyNode")}
                        </button>
                        {nodeDeleteMessage ? <p className="af-resource-action-message">{nodeDeleteMessage}</p> : null}
                      </div>
                    ) : null}
                    <div className="af-resource-detail-section">
                      <h4>{t("project:resourceMeaning")}</h4>
                      <p>{t("project:nodesMeaning")}</p>
                    </div>
                  </>
                ) : resourceDetailTab === "schema" ? (
                  <div className="af-resource-detail-section af-resource-detail-section--plain">
                    <h4>{t("project:nodeSchema")}</h4>
                    <div className="af-resource-slot-group">
                      <span>{t("project:nodeInputs")}</span>
                      {slotsToRows(selectedNodeDetail?.node?.inputs || selectedNode.inputs).length > 0 ? (
                        slotsToRows(selectedNodeDetail?.node?.inputs || selectedNode.inputs).map((slot) => (
                          <code key={slot.key}>{slot.name || slot.key}{slot.type ? `: ${slot.type}` : ""}</code>
                        ))
                      ) : (
                        <em>{t("project:noSlots")}</em>
                      )}
                    </div>
                    <div className="af-resource-slot-group">
                      <span>{t("project:nodeOutputs")}</span>
                      {slotsToRows(selectedNodeDetail?.node?.outputs || selectedNode.outputs).length > 0 ? (
                        slotsToRows(selectedNodeDetail?.node?.outputs || selectedNode.outputs).map((slot) => (
                          <code key={slot.key}>{slot.name || slot.key}{slot.type ? `: ${slot.type}` : ""}</code>
                        ))
                      ) : (
                        <em>{t("project:noSlots")}</em>
                      )}
                    </div>
                  </div>
                ) : resourceDetailTab === "runtime" ? (
                  <div className="af-resource-detail-section af-resource-detail-section--plain">
                    <h4>{t("project:nodeRuntime")}</h4>
                    {selectedNodeDetail?.runtime ? (
                      <pre className="af-resource-skill-preview">{JSON.stringify(selectedNodeDetail.runtime, null, 2)}</pre>
                    ) : (
                      <p>{t("project:noRuntimeManifest")}</p>
                    )}
                    {selectedNodeDetail?.body ? (
                      <>
                        <h4 className="af-resource-detail-subtitle">{t("project:nodeBody")}</h4>
                        <pre className="af-resource-skill-preview">{selectedNodeDetail.body}</pre>
                      </>
                    ) : (
                      <p>{t("project:noNodeBody")}</p>
                    )}
                  </div>
                ) : resourceDetailTab === "files" ? (
                  <div className="af-resource-detail-section af-resource-detail-section--plain">
                    <h4>{t("project:nodeFiles")}</h4>
                    {Array.isArray(selectedNodeDetail?.files) && selectedNodeDetail.files.length > 0 ? (
                      <div className="af-node-file-browser">
                        <div className="af-node-file-list">
                          {selectedNodeDetail.files.map((file) => (
                            <button
                              key={file.path}
                              type="button"
                              className={"af-node-file-item" + (nodeFilePath === file.path ? " af-node-file-item--active" : "")}
                              onClick={() => setNodeFilePath(file.path)}
                            >
                              <span className="material-symbols-outlined">description</span>
                              <span>{file.path}</span>
                            </button>
                          ))}
                        </div>
                        <pre className="af-resource-skill-preview">
                          {nodeFileLoading === `${resourceKey(selectedNode)}:${nodeFilePath}`
                            ? t("project:loadingResources")
                            : selectedNodeFilePreview?.binary
                              ? t("project:binaryFile")
                              : selectedNodeFilePreview?.content || t("project:selectNodeFile")}
                          {selectedNodeFilePreview?.truncated ? `\n\n${t("project:fileTruncated")}` : ""}
                        </pre>
                      </div>
                    ) : (
                      <p>{t("project:noNodeFiles")}</p>
                    )}
                  </div>
                ) : (
                  <div className="af-resource-detail-section af-resource-detail-section--plain">
                    <h4>{t("project:nodeUsage")}</h4>
                    {Array.isArray(selectedNodeDetail?.usage) && selectedNodeDetail.usage.length > 0 ? (
                      <div className="af-node-usage-list">
                        {selectedNodeDetail.usage.map((row) => (
                          <div key={`${row.flowSource}:${row.flowId}:${row.archived ? "a" : ""}`} className="af-node-usage-item">
                            <strong>{row.flowId}</strong>
                            <span>{row.flowSource}{row.archived ? ` · ${t("project:archived")}` : ""}</span>
                            <em>{row.instances.map((x) => x.label || x.instanceId).join(", ")}</em>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p>{t("project:noNodeUsage")}</p>
                    )}
                  </div>
                )}
              </>
            ) : isMyFlowsTab && selectedFlowSnippet ? (
              (() => {
                const preview = flowSnippetPreview(selectedFlowSnippet);
                return (
              <>
                <div className="af-resource-detail-head">
                  <span className="material-symbols-outlined">schema</span>
                  <div>
                    <h3>{selectedFlowSnippet.displayName || selectedFlowSnippet.name || selectedFlowSnippet.id}</h3>
                    <p>{selectedFlowSnippet.id}</p>
                  </div>
                </div>
                <p className="af-resource-detail-desc">{selectedFlowSnippet.description || t("project:noDescription")}</p>
                <dl className="af-resource-detail-kv">
                  <div><dt>{t("project:detailVersion")}</dt><dd>{selectedFlowSnippet.version || "1.0.0"}</dd></div>
                  <div><dt>{t("project:detailPath")}</dt><dd>{flowSnippetPathHint(selectedFlowSnippet)}</dd></div>
                  <div>
                    <dt>{t("project:flowSnippetScale")}</dt>
                    <dd>
                      {t("project:flowSnippetNodes", {
                        nodes: Number.isFinite(Number(selectedFlowSnippet.nodeCount))
                          ? Number(selectedFlowSnippet.nodeCount)
                          : preview.nodes.length,
                        edges: Number.isFinite(Number(selectedFlowSnippet.edgeCount))
                          ? Number(selectedFlowSnippet.edgeCount)
                          : preview.edges.length,
                      })}
                    </dd>
                  </div>
                </dl>
                <div className="af-resource-detail-section">
                  <h4>{t("project:resourceMeaning")}</h4>
                  <p>{t("project:myFlowsMeaning")}</p>
                </div>
                <div className="af-resource-detail-section af-resource-danger-zone">
                  <h4>{t("project:myFlowManagement")}</h4>
                  <p>{t("project:deleteMyFlowHint")}</p>
                  <button
                    type="button"
                    className="af-btn-secondary af-btn-danger"
                    disabled={flowSnippetDeleteBusy === flowSnippetKey(selectedFlowSnippet)}
                    onClick={() => deleteFlowSnippet(selectedFlowSnippet)}
                  >
                    <span className="material-symbols-outlined" aria-hidden>delete</span>
                    {flowSnippetDeleteBusy === flowSnippetKey(selectedFlowSnippet) ? t("project:deletingMyFlow") : t("project:deleteMyFlow")}
                  </button>
                  {flowSnippetDeleteMessage ? <p className="af-resource-action-message">{flowSnippetDeleteMessage}</p> : null}
                </div>
                <div className="af-resource-detail-section">
                  <h4>{t("project:flowSnippetPreview")}</h4>
                  {preview.diagram.nodes.length > 0 ? (
                    <div className="af-flow-snippet-map">
                      <svg viewBox={preview.diagram.viewBox} role="img" aria-label={t("project:flowSnippetPreview")}>
                        <defs>
                          <marker id="af-flow-snippet-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
                            <path d="M 0 0 L 8 4 L 0 8 z" />
                          </marker>
                        </defs>
                        <g className="af-flow-snippet-map__edges">
                          {preview.diagram.edges.map((edge) => (
                            <g key={edge.key}>
                              <path d={edge.path} />
                              {edge.label ? (
                                <text x={edge.labelX} y={edge.labelY - 5} textAnchor="middle">
                                  {compactDiagramLabel(edge.label, 18)}
                                </text>
                              ) : null}
                            </g>
                          ))}
                        </g>
                        <g className="af-flow-snippet-map__nodes">
                          {preview.diagram.nodes.map((node, index) => (
                            <g key={node.id} transform={`translate(${node.x} ${node.y})`}>
                              <rect width={node.width} height={node.height} rx="10" />
                              <circle cx="19" cy={node.height / 2} r="12" />
                              <text className="af-flow-snippet-map__node-index" x="19" y={node.height / 2 + 4} textAnchor="middle">
                                {index + 1}
                              </text>
                              <text className="af-flow-snippet-map__node-title" x="40" y={node.height / 2 - 3}>
                                {compactDiagramLabel(node.title)}
                              </text>
                              <text className="af-flow-snippet-map__node-meta" x="40" y={node.height / 2 + 16}>
                                {compactDiagramLabel(node.meta || node.id, 20)}
                              </text>
                            </g>
                          ))}
                        </g>
                      </svg>
                    </div>
                  ) : (
                    <p className="af-resource-detail-desc">{t("project:noFlowSnippetPreview")}</p>
                  )}
                  <details className="af-flow-snippet-json">
                    <summary>{t("project:flowSnippetJson")}</summary>
                    <pre className="af-resource-skill-preview">
                      {JSON.stringify(selectedFlowSnippet.snippet || {}, null, 2)}
                    </pre>
                  </details>
                </div>
              </>
                );
              })()
            ) : filter === "skills" && selectedSkill ? (
              <>
                <div className="af-resource-detail-head">
                  <span className="material-symbols-outlined">extension</span>
                  <div>
                    <h3>{selectedSkill.name || selectedSkill.id}</h3>
                    <p>{selectedSkill.sourceLabel || selectedSkill.source}</p>
                  </div>
                </div>
                <p className="af-resource-detail-desc">{selectedSkill.description || t("project:noDescription")}</p>
                <dl className="af-resource-detail-kv">
                  <div><dt>{t("project:detailSource")}</dt><dd>{selectedSkill.sourceLabel || selectedSkill.source}</dd></div>
                  <div><dt>{t("project:detailPath")}</dt><dd>{selectedSkill.path || selectedSkill.key}</dd></div>
                </dl>
                <div className="af-resource-detail-section">
                  <h4>Collections</h4>
                  {skillCollections.length === 0 ? (
                    <p>暂无 collection。可在左侧新建后再添加。</p>
                  ) : (
                    <div className="af-skill-detail-collections">
                      {skillCollections.map((collection) => {
                        const key = resourceKey(selectedSkill);
                        const resolvedKeys = skillCollectionSkillSets.get(collection.id) || new Set();
                        const checked = resolvedKeys.has(key);
                        return (
                          <label key={collection.id} className="af-composer-skill-option af-skill-detail-collection-option">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={skillCollectionSaving || !canEditSkillCollections}
                              onChange={(e) => toggleSkillCollectionMembership(collection.id, key, e.target.checked)}
                            />
                            <span className="af-composer-skill-option-main">
                              <span className="af-composer-skill-option-title">{collection.name}</span>
                              <span className="af-composer-skill-option-desc">{resolvedKeys.size} skills</span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="af-resource-detail-section">
                  <h4>{t("project:resourceMeaning")}</h4>
                  <p>{t("project:skillsMeaning")}</p>
                </div>
                <div className="af-resource-detail-section">
                  <h4>{t("project:skillPreview")}</h4>
                  <pre className="af-resource-skill-preview">
                    {skillDetailLoading === resourceKey(selectedSkill)
                      ? t("project:loadingResources")
                      : selectedSkillDetail?.body || selectedSkillDetail?.content || t("project:skillPreviewEmpty")}
                  </pre>
                </div>
              </>
            ) : (
              <p className="af-activity-empty">{t("project:selectResource")}</p>
            )}
          </aside>
        ) : (
          <aside
            id="af-recent-activity-panel"
            className={"af-activity" + (!activityPanelOpen ? " af-activity--hidden" : "")}
            aria-hidden={!activityPanelOpen}
            aria-label={t("project:recentActivity")}
          >
            <h2 className="af-activity-title">
              <span className="af-activity-bullet" />
              {t("project:recentActivity")}
            </h2>
            <div className="af-activity-list">
              {filteredRecentActivity.length === 0 ? (
                <p className="af-activity-empty">
                  {recentActivity.length === 0 ? t("project:noRecentActivity") : t("project:noMatchRecent")}
                </p>
              ) : (
                filteredRecentActivity.map((row) => {
                  const active = selectedActivityKey === activitySelectionKey(row);
                  return (
                  <button
                    key={`${row.kind}-${row.flowId}-${row.flowSource}-${row.at}`}
                    type="button"
                    className={"af-activity-row af-activity-row--action" + (active ? " af-activity-row--active" : "")}
                    aria-current={active ? "page" : undefined}
                    onClick={() => openActivityRow(row)}
                  >
                    <div className="af-activity-row-top">
                      <h4 className="af-activity-name">
                        <HighlightMatch query={pipelineSearch}>{row.flowId}</HighlightMatch>
                      </h4>
                      <span className="af-activity-time">{formatRelativeTime(row.at, t)}</span>
                    </div>
                    <div className="af-activity-meta">
                      <span className={activityIconKind(row.kind)}>{row.kind === "executed" ? "play_arrow" : "visibility"}</span>
                      <p className="af-activity-text">
                        {row.kind === "executed" ? t("project:recentRun") : t("project:recentOpen")} · {formatRelativeTime(row.at, t)}
                      </p>
                    </div>
                  </button>
                );})
              )}
            </div>
          </aside>
        )}
      </div>

      <NewPipelineModal
        open={newPipelineOpen}
        onClose={() => setNewPipelineOpen(false)}
        onCreated={async (flow) => {
          setNewPipelineOpen(false);
          await loadFlows();
          const src = flow.source ?? "user";
          navigate(preferredFlowUrl({ id: flow.id, source: src }, "workspace"));
        }}
      />

      {pendingImportFile ? (
        <ImportFlowModal
          key={`${pendingImportFile.name}-${pendingImportFile.size}-${pendingImportFile.lastModified}`}
          file={pendingImportFile}
          onClose={() => setPendingImportFile(null)}
          onImported={async (flow) => {
            setPendingImportFile(null);
            await loadFlows();
            const src = flow.source ?? "user";
            navigate(preferredFlowUrl({ id: flow.id, source: src }, "workspace"));
          }}
        />
      ) : null}
    </div>
  );
}
