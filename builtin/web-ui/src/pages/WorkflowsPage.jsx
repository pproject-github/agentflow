import { useCallback, useEffect, useMemo, useState } from "react";
import { useRoute } from "../routeContext.jsx";

function formatDate(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "-";
  return new Date(timestamp).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function roleLabel(role) {
  if (role === "owner") return "我创建的";
  if (role === "editor") return "协作编辑";
  if (role === "viewer") return "只读协作";
  return "可访问";
}

function stateLabel(state) {
  if (state === "completed") return "已完成";
  if (state === "blocked") return "需关注";
  return "进行中";
}

function platformLabel(platform) {
  const value = String(platform || "").toLowerCase();
  if (value === "android") return "Android";
  if (value === "ios") return "iOS";
  if (["all", "both", "cross-platform", "cross_platform"].includes(value)) return "双端";
  return platform || "";
}

function workflowUrl(workflow) {
  const query = new URLSearchParams({
    view: "workflow",
    tapdId: String(workflow?.tapdId || ""),
  });
  return `/workspace?${query.toString()}`;
}

export default function WorkflowsPage() {
  const { navigate } = useRoute();
  const [workflows, setWorkflows] = useState([]);
  const [view, setView] = useState("personal");
  const [team, setTeam] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [state, setState] = useState("all");

  const loadWorkflows = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/prd-workflows?view=${encodeURIComponent(view)}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "读取迭代列表失败");
      setWorkflows(Array.isArray(payload.workflows) ? payload.workflows : []);
      setTeam(payload.team || null);
    } catch (loadError) {
      setError(String(loadError.message || loadError));
      setWorkflows([]);
      setTeam(null);
    } finally {
      setLoading(false);
    }
  }, [view]);

  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  const counts = useMemo(() => ({
    total: workflows.length,
    owned: workflows.filter((workflow) => workflow.role === "owner").length,
    collaborating: workflows.filter((workflow) => workflow.role !== "owner").length,
    attention: workflows.filter((workflow) => workflow.state === "blocked").length,
  }), [workflows]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return workflows.filter((workflow) => {
      if (scope === "owned" && workflow.role !== "owner") return false;
      if (scope === "collaborating" && workflow.role === "owner") return false;
      if (state !== "all" && workflow.state !== state) return false;
      if (!keyword) return true;
      return [
        workflow.tapdId,
        workflow.title,
        workflow.pointer,
        workflow.phase,
        workflow.ownerUsername,
        workflow.latestAction?.title,
      ].some((value) => String(value || "").toLowerCase().includes(keyword));
    });
  }, [query, scope, state, workflows]);

  return (
    <div className="af-settings-page af-workflows-page">
      <div className="af-settings-top">
        <div className="af-settings-crumb">
          <span className="af-settings-crumb-muted">AgentFlow</span>
          <span className="af-settings-crumb-sep">/</span>
          <span className="af-settings-crumb-active">迭代</span>
        </div>
        <button
          type="button"
          className="af-schedules-refresh"
          onClick={() => void loadWorkflows()}
          disabled={loading}
        >
          <span className="material-symbols-outlined" aria-hidden>{loading ? "hourglass_empty" : "refresh"}</span>
          刷新
        </button>
      </div>

      <div className="af-settings-body">
        <div className="af-settings-inner af-workflows-inner">
          <section className="af-settings-hero af-workflows-hero">
            <div>
              <span className="af-workflows-eyebrow">Workflow Dashboard</span>
              <h1 className="af-settings-h1">迭代</h1>
              <p className="af-settings-lead">{view === "team" ? `汇总${team?.name ? `「${team.name}」` : "当前团队"}的需求 Workflow，按负责人追踪进度与风险。` : "集中查看我创建和参与的需求 Workflow，追踪阶段、Action 进度与最新动态。"}</p>
            </div>
            <div className="af-scope-switch" aria-label="迭代视图">
              <button type="button" className={view === "personal" ? "is-active" : ""} onClick={() => setView("personal")}>个人迭代</button>
              <button type="button" className={view === "team" ? "is-active" : ""} onClick={() => setView("team")}>团队迭代</button>
            </div>
          </section>

          <div className="af-workflows-summary" aria-label="迭代汇总">
            <div><span>全部迭代</span><strong>{counts.total}</strong></div>
            <div><span>我创建的</span><strong>{counts.owned}</strong></div>
            <div><span>参与协作</span><strong>{counts.collaborating}</strong></div>
            <div className={counts.attention ? "is-attention" : ""}><span>需关注</span><strong>{counts.attention}</strong></div>
          </div>

          <section className="af-workflows-toolbar" aria-label="迭代筛选">
            <label className="af-workflows-search">
              <span className="material-symbols-outlined" aria-hidden>search</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索 TAPD、需求、阶段或成员"
                aria-label="搜索迭代"
              />
            </label>
            <div className="af-workflows-segments" aria-label="协作范围">
              {[
                ["all", "全部"],
                ["owned", "我创建的"],
                ["collaborating", "与我协作"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={scope === value ? "is-active" : ""}
                  aria-pressed={scope === value}
                  onClick={() => setScope(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <select value={state} onChange={(event) => setState(event.target.value)} aria-label="迭代状态">
              <option value="all">全部状态</option>
              <option value="active">进行中</option>
              <option value="completed">已完成</option>
              <option value="blocked">需关注</option>
            </select>
          </section>

          {error ? <div className="af-workflows-message af-workflows-message--error">{error}</div> : null}
          {loading ? <div className="af-workflows-message">正在读取迭代...</div> : null}
          {!loading && !error && workflows.length === 0 ? (
            <div className="af-workflows-empty">
              <span className="material-symbols-outlined" aria-hidden>timeline</span>
              <strong>{view === "team" && !team ? "尚未加入团队" : "暂无迭代"}</strong>
              <p>{view === "team" && !team ? "请联系超级管理员完成团队划分。" : "当 prd-flow 上报 Workflow 后，它会出现在这里。"}</p>
            </div>
          ) : null}
          {!loading && workflows.length > 0 && filtered.length === 0 ? (
            <div className="af-workflows-message">没有符合当前筛选条件的迭代。</div>
          ) : null}

          <div className="af-workflows-list">
            {filtered.map((workflow) => {
              const progress = workflow.actionCount > 0
                ? Math.round((workflow.completedActionCount / workflow.actionCount) * 100)
                : 0;
              return (
                <article key={workflow.id || workflow.tapdId} className="af-workflow-card">
                  <div className="af-workflow-card__identity">
                    <div className="af-workflow-card__title-row">
                      <span className="af-workflow-tapd">TAPD {workflow.tapdId}</span>
                      <span className={`af-workflow-state af-workflow-state--${workflow.state || "active"}`}>
                        {stateLabel(workflow.state)}
                      </span>
                      <span className="af-workflow-role">{roleLabel(workflow.role)}</span>
                      {workflow.shareActive ? (
                        <span className="af-workflow-shared">
                          <span className="material-symbols-outlined" aria-hidden>link</span>
                          已分享
                        </span>
                      ) : null}
                    </div>
                    <h2>{workflow.title || workflow.pointer || `需求 ${workflow.tapdId}`}</h2>
                    <p>{workflow.pointer || "等待 Workflow 上报当前状态"}</p>
                    <div className="af-workflow-card__meta">
                      <span>{workflow.phase || "未识别阶段"}</span>
                      <span>{workflow.issueCount || 0} Issues</span>
                      {(workflow.platforms || []).map((platform) => (
                        <span key={platform}>{platformLabel(platform)}</span>
                      ))}
                      <span>Owner · {workflow.ownerUsername || workflow.ownerId || "-"}</span>
                      {view === "team" && workflow.teamName ? <span>团队 · {workflow.teamName}</span> : null}
                    </div>
                  </div>

                  <div className="af-workflow-card__progress">
                    <div>
                      <span>Action 进度</span>
                      <strong>{workflow.completedActionCount || 0}/{workflow.actionCount || 0}</strong>
                    </div>
                    <div className="af-workflow-progress" aria-label={`Action 完成度 ${progress}%`}>
                      <span style={{ width: `${progress}%` }} />
                    </div>
                    <small>{progress}%</small>
                  </div>

                  <div className="af-workflow-card__latest">
                    <span>最新动态</span>
                    <strong>{workflow.latestAction?.title || "暂无 Action 记录"}</strong>
                    <small>{formatDate(workflow.latestAction?.at || workflow.updatedAt)}</small>
                  </div>

                  <button
                    type="button"
                    className="af-workflow-open"
                    onClick={() => navigate(workflowUrl(workflow))}
                  >
                    打开 Workflow
                    <span className="material-symbols-outlined" aria-hidden>arrow_forward</span>
                  </button>
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
