import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatRelativeTimeZh,
  loadOpenedEntries,
  mergeRecentActivity,
} from "../pipelineRecent.js";
import { ImportFlowModal } from "../ImportFlowModal.jsx";
import { NewPipelineModal } from "../NewPipelineModal.jsx";
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

function sourceBadgeMeta(source) {
  if (source === "builtin") return { label: "Built-in", tone: "muted" };
  if (source === "workspace") return { label: "Workspace", tone: "secondary" };
  return { label: "User", tone: "primary" };
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

const DEFAULT_PIPELINE_CARD_DESC = "打开以在节点画布中编辑此流水线。";

/** @param {{ description?: string }} f */
function pipelineCardDescription(f) {
  const d = f.description != null ? String(f.description).trim() : "";
  return d !== "" ? d : DEFAULT_PIPELINE_CARD_DESC;
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
 */
function flowSearchHaystack(f) {
  const parts = [String(f.id), pipelineCardDescription(f), sourcePathHint(f), sourceBadgeMeta(f.source).label];
  if (f.archived) parts.push("Archived");
  return parts.join("\n").toLowerCase();
}

/**
 * @param {{ source?: string, id: string, archived?: boolean, description?: string }} f
 * @param {string} q normalized lowercase trimmed query
 */
function flowMatchesSearch(f, q) {
  if (!q) return true;
  return flowSearchHaystack(f).includes(q);
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

export default function ProjectsPage() {
  const { navigate, path } = useRoute();
  const [filter, setFilter] = useState("all");
  const [apiFlows, setApiFlows] = useState([]);
  const [recentRuns, setRecentRuns] = useState([]);
  const [listError, setListError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);
  const [pendingImportFile, setPendingImportFile] = useState(/** @type {File | null} */ (null));
  const [dropHighlight, setDropHighlight] = useState(false);
  const [pipelineSearch, setPipelineSearch] = useState("");
  const [activityPanelOpen, setActivityPanelOpen] = useState(true);
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

  useEffect(() => {
    setLoaded(false);
    loadFlows();
  }, [loadFlows]);

  /** 从 /flow?new=1 重定向到 /projects?new=1 时打开弹框；?tab=archived 切换归档标签；随后去掉查询串 */
  useEffect(() => {
    if (path !== "/projects" && path !== "/") return;
    const sp = new URLSearchParams(window.location.search);
    let changed = false;
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
  }, [path]);

  const displayedFlows = useMemo(
    () => apiFlows.filter((f) => (filter === "archived" ? f.archived : !f.archived)),
    [apiFlows, filter],
  );

  const searchNorm = pipelineSearch.trim().toLowerCase();

  const filteredFlows = useMemo(
    () => displayedFlows.filter((f) => flowMatchesSearch(f, searchNorm)),
    [displayedFlows, searchNorm],
  );

  const recentActivity = useMemo(
    () => mergeRecentActivity(recentRuns, loadOpenedEntries(), apiFlows),
    [recentRuns, apiFlows, path],
  );

  const filteredRecentActivity = useMemo(
    () => recentActivity.filter((row) => activityMatchesSearch(pipelineSearch, row)),
    [recentActivity, pipelineSearch],
  );

  const openFlow = (f) => {
    const src = f.source ?? "user";
    const q = new URLSearchParams({
      flowId: f.id,
      flowSource: src,
    });
    if (f.archived) q.set("flowArchived", "1");
    navigate(`/flow?${q.toString()}`);
  };

  const openActivityRow = (row) => {
    navigate(
      `/flow?flowId=${encodeURIComponent(row.flowId)}&flowSource=${encodeURIComponent(row.flowSource)}`,
    );
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
        <div className="af-projects-tabs">
          <button
            type="button"
            className={filter === "all" ? "af-tab af-tab--active" : "af-tab"}
            onClick={() => setFilter("all")}
          >
            All
          </button>
          <button
            type="button"
            className={filter === "archived" ? "af-tab af-tab--active" : "af-tab"}
            onClick={() => setFilter("archived")}
          >
            Archived
          </button>
        </div>
        <div className="af-projects-top-right">
          <div className="af-search-wrap">
            <span className="material-symbols-outlined af-search-icon">search</span>
            <input
              className={"af-search" + (pipelineSearch.trim() ? " af-search--has-clear" : "")}
              type="search"
              placeholder="SEARCH PIPELINES..."
              aria-label="Search pipelines"
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
          <button
            type="button"
            className={"af-icon-btn" + (activityPanelOpen ? " af-icon-btn--active" : "")}
            aria-label="展开或收起最近打开或最近运行"
            aria-expanded={activityPanelOpen}
            aria-controls="af-recent-activity-panel"
            onClick={() => setActivityPanelOpen((v) => !v)}
          >
            <span className="material-symbols-outlined">notifications</span>
          </button>
          <button type="button" className="af-btn-primary af-create-btn" onClick={() => setNewPipelineOpen(true)}>
            Create New Project
          </button>
        </div>
      </header>

      <div className="af-projects-body">
        <section className="af-projects-main">
          <header className="af-projects-section-head">
            <h2 className="af-projects-h2">{filter === "archived" ? "Archived Pipelines" : "Active Projects"}</h2>
            <p className="af-projects-sub">
              {searchNorm
                ? `筛选结果：${filteredFlows.length} 条（匹配标题、描述、路径与标签）`
                : filter === "archived"
                  ? "已归档的流水线仍可打开与编辑；文件位于各 pipelines 目录下的 _archived。"
                  : "Manage your distributed node architectures and monitoring pipelines. 可将 flow.yaml 或 .zip 拖入本页导入分享流程。"}
            </p>
            {listError ? <p className="af-err af-projects-api-hint">{listError}</p> : null}
          </header>

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
                    <span className={badgeClass(sourceBadgeMeta(f.source).tone)}>
                      <HighlightMatch query={pipelineSearch}>{sourceBadgeMeta(f.source).label}</HighlightMatch>
                    </span>
                    {f.archived ? (
                      <span className={badgeClass("muted")}>
                        <HighlightMatch query={pipelineSearch}>Archived</HighlightMatch>
                      </span>
                    ) : null}
                    <h3 className="af-project-title">
                      <HighlightMatch query={pipelineSearch}>{f.id}</HighlightMatch>
                    </h3>
                    <p className="af-project-desc">
                      <HighlightMatch query={pipelineSearch}>{pipelineCardDescription(f)}</HighlightMatch>
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
                <p className="af-projects-empty">加载流水线列表…</p>
              </div>
            ) : displayedFlows.length === 0 ? (
              <div className="af-projects-empty-block">
                <p className="af-projects-empty">
                  {filter === "archived"
                    ? "暂无归档项目。"
                    : apiFlows.length > 0
                      ? "暂无未归档流水线；已归档项在 Archived 标签中查看。"
                      : listError
                        ? "未能加载流水线列表。"
                        : "当前工作区暂无流水线。"}
                </p>
                {!listError && apiFlows.length === 0 && filter === "all" ? (
                  <p className="af-projects-empty-hint">
                    在仓库根目录执行 <code className="af-projects-empty-code">agentflow ui</code> 并确认工作区包含{" "}
                    <code className="af-projects-empty-code">.agentflow/pipelines</code> 或用户目录下的流水线；亦可点击
                    New Pipeline 新建。
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="af-projects-empty-block">
                <p className="af-projects-empty">
                  未找到与「{pipelineSearch.trim()}」匹配的流水线。可尝试其他关键词，或点击清除搜索。
                </p>
              </div>
            )}

            <button type="button" className="af-project-add" onClick={() => setNewPipelineOpen(true)}>
              <span className="material-symbols-outlined af-project-add-icon">add_circle</span>
              <span className="af-project-add-label">New Pipeline</span>
            </button>
          </div>
        </section>

        <aside
          id="af-recent-activity-panel"
          className={"af-activity" + (!activityPanelOpen ? " af-activity--hidden" : "")}
          aria-hidden={!activityPanelOpen}
          aria-label="最近打开或最近运行"
        >
          <h2 className="af-activity-title">
            <span className="af-activity-bullet" />
            最近打开或最近运行
          </h2>
          <div className="af-activity-list">
            {filteredRecentActivity.length === 0 ? (
              <p className="af-activity-empty">
                {recentActivity.length === 0 ? "暂无打开或运行记录" : "暂无与关键词匹配的最近记录"}
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
                    <span className="af-activity-time">{formatRelativeTimeZh(row.at)}</span>
                  </div>
                  <div className="af-activity-meta">
                    <span className={activityIconKind(row.kind)}>{row.kind === "executed" ? "play_arrow" : "visibility"}</span>
                    <p className="af-activity-text">
                      {row.kind === "executed" ? "最近运行" : "最近打开"} · {formatRelativeTimeZh(row.at)}
                    </p>
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>
      </div>

      <NewPipelineModal
        open={newPipelineOpen}
        onClose={() => setNewPipelineOpen(false)}
        onCreated={async (flow) => {
          setNewPipelineOpen(false);
          await loadFlows();
          const src = flow.source ?? "user";
          navigate(
            `/flow?flowId=${encodeURIComponent(flow.id)}&flowSource=${encodeURIComponent(src)}`,
          );
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
            navigate(
              `/flow?flowId=${encodeURIComponent(flow.id)}&flowSource=${encodeURIComponent(src)}`,
            );
          }}
        />
      ) : null}
    </div>
  );
}
