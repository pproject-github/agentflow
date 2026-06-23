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
import { useRoute } from "../routeContext.jsx";

function badgeClass(tone) {
  if (tone === "secondary") return "af-proj-badge af-proj-badge--secondary";
  if (tone === "primary") return "af-proj-badge af-proj-badge--primary";
  if (tone === "muted") return "af-proj-badge af-proj-badge--muted";
  return "af-proj-badge";
}

function activityIconKind(kind) {
  if (kind === "executed") return "material-symbols-outlined af-act-icon af-act-icon--executed";
  return "material-symbols-outlined af-act-icon af-act-icon--opened";
}

function sourceBadgeMeta(source, t) {
  if (source === "builtin") return { label: t("project:sourceBadge.builtin"), tone: "muted" };
  if (source === "workspace") return { label: t("project:sourceBadge.workspace"), tone: "secondary" };
  return { label: t("project:sourceBadge.user"), tone: "primary" };
}

/** @param {{ source?: string, id: string, archived?: boolean }} f */
function sourcePathHint(f) {
  const s = f.source ?? "user";
  if (s === "builtin") return `builtin/pipelines / ${f.id}`;
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

const NODE_FILTERS = ["all", "agent", "control", "provide", "marketplace"];
const SKILL_FILTERS = ["all", "builtin", "workspace-agents", "workspace-cursor"];

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

export default function ProjectsPage({ resourceKind = "" }) {
  const { t } = useTranslation();
  const { navigate, path } = useRoute();
  const [filter, setFilter] = useState(resourceKind || "all");
  const [apiFlows, setApiFlows] = useState([]);
  const [globalNodes, setGlobalNodes] = useState([]);
  const [globalSkills, setGlobalSkills] = useState([]);
  const [recentRuns, setRecentRuns] = useState([]);
  const [listError, setListError] = useState("");
  const [resourceError, setResourceError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [resourcesLoaded, setResourcesLoaded] = useState(false);
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);
  const [pendingImportFile, setPendingImportFile] = useState(/** @type {File | null} */ (null));
  const [dropHighlight, setDropHighlight] = useState(false);
  const [pipelineSearch, setPipelineSearch] = useState("");
  const [activityPanelOpen, setActivityPanelOpen] = useState(true);
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
  const [hideCommunityLinks, setHideCommunityLinks] = useState(false);
  const dragDepthRef = useRef(0);
  const mountIdRef = useRef(0);

  const loadFlows = useCallback(async () => {
    const myId = ++mountIdRef.current;
    setListError("");
    try {
      const rFlows = await fetch("/api/flows");
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
    setLoaded(true);
  }, []);

  const loadResources = useCallback(async () => {
    setResourceError("");
    setResourcesLoaded(false);
    try {
      const [nodesRes, skillsRes] = await Promise.all([
        fetch("/api/nodes"),
        fetch("/api/skills"),
      ]);
      const nodesJson = await nodesRes.json().catch(() => ({}));
      const skillsJson = await skillsRes.json().catch(() => ({}));
      if (!nodesRes.ok) throw new Error(nodesJson.error || "Nodes HTTP " + nodesRes.status);
      if (!skillsRes.ok) throw new Error(skillsJson.error || "Skills HTTP " + skillsRes.status);
      setGlobalNodes(Array.isArray(nodesJson.nodes) ? nodesJson.nodes : Array.isArray(nodesJson) ? nodesJson : []);
      setGlobalSkills(Array.isArray(skillsJson.skills) ? skillsJson.skills : []);
    } catch (e) {
      setGlobalNodes([]);
      setGlobalSkills([]);
      setResourceError(String(e.message || e));
    } finally {
      setResourcesLoaded(true);
    }
  }, []);

  useEffect(() => {
    setLoaded(false);
    loadFlows();
    loadResources();
  }, [loadFlows, loadResources]);

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

  useEffect(() => {
    if (resourceKind === "nodes" || resourceKind === "skills") {
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
    let changed = false;
    if (sp.get("tab") === "nodes") {
      navigate("/nodes");
      return;
    }
    if (sp.get("tab") === "skills") {
      navigate("/skills");
      return;
    }
    if (sp.get("tab") === "archived") {
      setFilter("archived");
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

  const filteredNodes = useMemo(
    () =>
      globalNodes.filter((n) => {
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
    [globalNodes, pipelineSearch, resourceFilter],
  );

  const filteredSkills = useMemo(
    () =>
      globalSkills.filter((s) => {
        const filterMatch = resourceFilter === "all" || s.source === resourceFilter;
        return filterMatch && resourceTextMatches(pipelineSearch, [
          s.name,
          s.id,
          s.description,
          s.sourceLabel,
          s.source,
          s.path,
        ]);
      }),
    [globalSkills, pipelineSearch, resourceFilter],
  );

  const isResourceTab = filter === "nodes" || filter === "skills";
  const selectedNode = useMemo(
    () => filteredNodes.find((n) => resourceKey(n) === selectedResourceKey) || filteredNodes[0] || null,
    [filteredNodes, selectedResourceKey],
  );
  const selectedSkill = useMemo(
    () => filteredSkills.find((s) => resourceKey(s) === selectedResourceKey) || filteredSkills[0] || null,
    [filteredSkills, selectedResourceKey],
  );
  const selectedSkillDetail = selectedSkill ? skillDetails[resourceKey(selectedSkill)] : null;
  const selectedNodeDetail = selectedNode ? nodeDetails[resourceKey(selectedNode)] : null;
  const selectedNodeFilePreview = selectedNode && nodeFilePath ? nodeFilePreviews[`${resourceKey(selectedNode)}:${nodeFilePath}`] : null;
  const searchPlaceholder =
    filter === "nodes"
      ? t("project:searchNodes")
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
    if (filter !== "nodes" || !selectedNode) return;
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
  }, [filter, selectedNode, nodeDetails]);

  useEffect(() => {
    if (filter !== "nodes") return;
    const files = Array.isArray(selectedNodeDetail?.files) ? selectedNodeDetail.files : [];
    setNodeFilePath((prev) => (prev && files.some((f) => f.path === prev) ? prev : files[0]?.path || ""));
  }, [filter, selectedNodeDetail]);

  useEffect(() => {
    if (filter !== "nodes" || !selectedNode || !nodeFilePath) return;
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
  }, [filter, selectedNode, nodeFilePath, nodeFilePreviews]);

  const openFlow = (f) => {
    navigate(preferredFlowUrl(f, "workspace"));
  };

  const openActivityRow = (row) => {
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
              {filter === "nodes"
                ? t("project:globalNodes")
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
                      filter === "nodes"
                        ? filteredNodes.length
                        : filter === "skills"
                          ? filteredSkills.length
                          : filteredFlows.length,
                  })
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
              {filter === "skills" ? <SkillHubPanel onChanged={loadResources} /> : null}
              <div className="af-resource-purpose">
                <span className="material-symbols-outlined">{filter === "nodes" ? "account_tree" : "extension"}</span>
                <div>
                  <h3>{filter === "nodes" ? t("project:nodesPurposeTitle") : t("project:skillsPurposeTitle")}</h3>
                  <p>{filter === "nodes" ? t("project:nodesPurposeDesc") : t("project:skillsPurposeDesc")}</p>
                </div>
              </div>
              <div className="af-resource-filter-row">
                {(filter === "nodes" ? NODE_FILTERS : SKILL_FILTERS).map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={"af-resource-filter" + (resourceFilter === item ? " af-resource-filter--active" : "")}
                    onClick={() => {
                      setResourceFilter(item);
                      setSelectedResourceKey("");
                    }}
                  >
                    {t(`project:resourceFilter.${item}`)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {filter === "nodes" ? (
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
                    {searchNorm ? t("project:noNodeMatch", { query: pipelineSearch.trim() }) : t("project:noNodes")}
                  </p>
                </div>
              )}
            </div>
          ) : filter === "skills" ? (
            <div className="af-resource-grid">
              {filteredSkills.length > 0 ? (
                filteredSkills.map((s) => (
                  <button
                    key={s.key || `${s.source}:${s.name}`}
                    type="button"
                    className={"af-resource-card" + (selectedSkill && resourceKey(s) === resourceKey(selectedSkill) ? " af-resource-card--active" : "")}
                    onClick={() => setSelectedResourceKey(resourceKey(s))}
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
                  </button>
                ))
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
            <div className="af-project-grid">
              {filteredFlows.length > 0 ? (
                filteredFlows.map((f) => (
                  <button
                    key={`${f.id}:${f.source ?? "user"}:${f.archived ? "a" : ""}`}
                    type="button"
                    className="af-project-card"
                    onClick={() => openFlow(f)}
                  >
                    <div className="af-project-card-body">
                      <span className={badgeClass(sourceBadgeMeta(f.source, t).tone)}>
                        <HighlightMatch query={pipelineSearch}>{sourceBadgeMeta(f.source, t).label}</HighlightMatch>
                      </span>
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
                    </div>
                  </button>
                ))
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
          )}
        </section>

        {isResourceTab ? (
          <aside className="af-resource-detail" aria-label={filter === "nodes" ? t("project:nodeDetail") : t("project:skillDetail")}>
            {filter === "nodes" && selectedNode ? (
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
                filteredRecentActivity.map((row) => (
                  <button
                    key={`${row.kind}-${row.flowId}-${row.flowSource}-${row.at}`}
                    type="button"
                    className="af-activity-row af-activity-row--action"
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
                ))
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
