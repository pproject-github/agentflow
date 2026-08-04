import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRoute } from "../routeContext.jsx";

const WORKFLOW_VIEW_STORAGE_KEY = "agentflow.workflows.scopeView";
const TIMELINE_WINDOW_SIZE = 8;
const TIMELINE_WINDOW_MAX = 24;

function loadWorkflowView() {
  if (typeof localStorage === "undefined") return "personal";
  try {
    return localStorage.getItem(WORKFLOW_VIEW_STORAGE_KEY) === "team" ? "team" : "personal";
  } catch {
    return "personal";
  }
}

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

function formatTimelineDate(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "日期待定";
  return new Date(timestamp).toLocaleDateString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function timelineDimensions(entry) {
  return Object.values(entry?.dimensions || {})
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" · ");
}

function timelineStatus(entry) {
  const total = Number(entry?.workflowCount || 0);
  const completed = Number(entry?.completedCount || 0);
  if (total > 0 && completed >= total) return { key: "completed", label: "已完成" };
  const timestamp = Date.parse(String(entry?.date || ""));
  if (Number.isFinite(timestamp) && timestamp < Date.now()) return { key: "overdue", label: "已到期" };
  return { key: "planned", label: "计划中" };
}

function dateFromToday(offsetDays) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function initialTimelineWindow(entries) {
  const total = Array.isArray(entries) ? entries.length : 0;
  if (total <= TIMELINE_WINDOW_SIZE) return { start: 0, end: total };
  const now = Date.now();
  let anchor = entries.findIndex((entry) => {
    const timestamp = Date.parse(String(entry?.date || ""));
    return Number.isFinite(timestamp) && timestamp >= now;
  });
  if (anchor < 0) anchor = total - 1;
  const start = Math.max(0, Math.min(anchor - 3, total - TIMELINE_WINDOW_SIZE));
  return { start, end: Math.min(total, start + TIMELINE_WINDOW_SIZE) };
}

function createWorkflowDemo() {
  const versions = [
    {
      key: "prd-flow:version:android-5.62.0",
      kind: "version",
      id: "android-5.62.0",
      title: "Likee Android 5.62.0",
      date: dateFromToday(-12),
      source: "prd-flow",
      dimensions: { platform: "Android" },
    },
    {
      key: "prd-flow:version:android-5.63.0",
      kind: "version",
      id: "android-5.63.0",
      title: "Likee Android 5.63.0",
      date: dateFromToday(6),
      source: "prd-flow",
      dimensions: { platform: "Android" },
    },
    {
      key: "prd-flow:version:ios-5.63.0",
      kind: "version",
      id: "ios-5.63.0",
      title: "Likee iOS 5.63.0",
      date: dateFromToday(10),
      source: "prd-flow",
      dimensions: { platform: "iOS" },
    },
    {
      key: "prd-flow:milestone:august-gray",
      kind: "milestone",
      id: "august-gray",
      title: "8 月灰度窗口",
      date: dateFromToday(18),
      source: "prd-flow",
      dimensions: { channel: "灰度" },
    },
    ...Array.from({ length: 12 }, (_, index) => ({
      key: `prd-flow:version:android-5.${50 + index}.0`,
      kind: "version",
      id: `android-5.${50 + index}.0`,
      title: `Likee Android 5.${50 + index}.0`,
      date: dateFromToday(-180 + index * 14),
      source: "prd-flow",
      dimensions: { platform: "Android" },
    })),
    ...Array.from({ length: 8 }, (_, index) => ({
      key: `prd-flow:version:android-5.${64 + index}.0`,
      kind: "version",
      id: `android-5.${64 + index}.0`,
      title: `Likee Android 5.${64 + index}.0`,
      date: dateFromToday(32 + index * 14),
      source: "prd-flow",
      dimensions: { platform: "Android" },
    })),
  ];
  const byKey = Object.fromEntries(versions.map((entry) => [entry.key, entry]));
  const demoWorkflows = [
    {
      id: "demo-1", tapdId: "1020124", title: "Likee Android AI Runtime Hook Skill 搭建",
      pointer: "继续实现 Android Action 与通用 Hook 多层注入平台", phase: "IMPLEMENTATION_IN_PROGRESS",
      state: "active", role: "owner", ownerUsername: "wangfang", issueCount: 2, platforms: ["android"],
      actionCount: 5, completedActionCount: 4, latestAction: { title: "Android 实现协议已确认", at: new Date().toISOString() },
      timeline: [byKey["prd-flow:version:android-5.63.0"]], demo: true,
    },
    {
      id: "demo-2", tapdId: "1013667", title: "激励视频增收方案",
      pointer: "检查并选择 TAPD 未解决 Bug", phase: "BUG_SELECTION_READY",
      state: "blocked", role: "viewer", ownerUsername: "surujija", issueCount: 18, platforms: ["android", "ios"],
      actionCount: 33, completedActionCount: 32, latestAction: { title: "等待版本风险确认", at: new Date().toISOString() },
      timeline: [byKey["prd-flow:version:android-5.63.0"], byKey["prd-flow:version:ios-5.63.0"]], demo: true,
    },
    {
      id: "demo-3", tapdId: "1133202860001018940", title: "Likee Android 5.62.0",
      pointer: "发版上下文已同步", phase: "RELEASED",
      state: "completed", role: "editor", ownerUsername: "chenjunlun", issueCount: 1, platforms: ["ios"],
      actionCount: 1, completedActionCount: 1, latestAction: { title: "版本发布完成", at: dateFromToday(-12) },
      timeline: [byKey["prd-flow:version:android-5.62.0"]], demo: true,
    },
    {
      id: "demo-4", tapdId: "1015046", title: "Remote Config 拉取频控",
      pointer: "双端方案进入提测准备", phase: "SUBMIT_TEST",
      state: "active", role: "owner", ownerUsername: "alice", issueCount: 4, platforms: ["android", "ios"],
      actionCount: 8, completedActionCount: 6, latestAction: { title: "测试用例已归档", at: new Date().toISOString() },
      timeline: [byKey["prd-flow:version:ios-5.63.0"], byKey["prd-flow:milestone:august-gray"]], demo: true,
    },
    {
      id: "demo-5", tapdId: "1027788", title: "直播间礼物动效治理",
      pointer: "等待确认目标版本", phase: "PLANNING",
      state: "active", role: "editor", ownerUsername: "bob", issueCount: 3, platforms: ["all"],
      actionCount: 4, completedActionCount: 1, latestAction: { title: "技术方案评审中", at: new Date().toISOString() },
      timeline: [], demo: true,
    },
    ...versions.slice(4).map((entry, index) => ({
      id: `demo-timeline-${index + 1}`,
      tapdId: `DEMO-${String(index + 1).padStart(3, "0")}`,
      title: `${entry.title} 版本事项`,
      pointer: index < 12 ? "历史版本事项已归档" : "等待进入版本排期",
      phase: index < 12 ? "RELEASED" : "PLANNING",
      state: index < 12 ? "completed" : "active",
      role: index % 3 === 0 ? "owner" : "editor",
      ownerUsername: index % 3 === 0 ? "wangfang" : "demo-user",
      issueCount: (index % 4) + 1,
      platforms: ["android"],
      actionCount: 4,
      completedActionCount: index < 12 ? 4 : 1,
      latestAction: { title: index < 12 ? "版本归档完成" : "版本排期已同步", at: entry.date },
      timeline: [entry],
      demo: true,
    })),
  ];
  const demoTimeline = versions.map((entry) => {
    const matched = demoWorkflows.filter((workflow) => workflow.timeline.some((item) => item.key === entry.key));
    return {
      ...entry,
      workflowCount: matched.length,
      completedCount: matched.filter((workflow) => workflow.state === "completed").length,
      blockedCount: matched.filter((workflow) => workflow.state === "blocked").length,
      workflowIds: matched.map((workflow) => workflow.id),
    };
  }).sort((left, right) => Date.parse(left.date) - Date.parse(right.date));
  return { workflows: demoWorkflows, timeline: demoTimeline, unassignedCount: 1 };
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
  const [timeline, setTimeline] = useState([]);
  const [unassignedCount, setUnassignedCount] = useState(0);
  const [timelineKey, setTimelineKey] = useState("all");
  const [view, setView] = useState(loadWorkflowView);
  const [team, setTeam] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [state, setState] = useState("all");
  const [demoMode, setDemoMode] = useState(false);
  const [timelineWindow, setTimelineWindow] = useState({ start: 0, end: 0 });
  const timelineRailRef = useRef(null);
  const timelineAnchorRef = useRef(null);
  const timelineLoadingRef = useRef(false);
  const timelineUnlockTimerRef = useRef(0);
  const timelineScrollFrameRef = useRef(0);

  const loadWorkflows = useCallback(async () => {
    setDemoMode(false);
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/prd-workflows?view=${encodeURIComponent(view)}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "读取迭代列表失败");
      const nextWorkflows = Array.isArray(payload.workflows) ? payload.workflows : [];
      const nextTimeline = Array.isArray(payload.timeline) ? payload.timeline : [];
      setWorkflows(nextWorkflows);
      setTimeline(nextTimeline);
      setUnassignedCount(Number(payload.unassignedCount || 0));
      setTimelineKey((current) => (
        current === "all"
        || (current === "unassigned" && Number(payload.unassignedCount || 0) > 0)
        || nextTimeline.some((entry) => entry.key === current)
          ? current
          : "all"
      ));
      setTeam(payload.team || null);
    } catch (loadError) {
      setError(String(loadError.message || loadError));
      setWorkflows([]);
      setTimeline([]);
      setUnassignedCount(0);
      setTimelineKey("all");
      setTeam(null);
    } finally {
      setLoading(false);
    }
  }, [view]);

  const loadDemo = useCallback(() => {
    const demo = createWorkflowDemo();
    setWorkflows(demo.workflows);
    setTimeline(demo.timeline);
    setUnassignedCount(demo.unassignedCount);
    setTimelineKey("all");
    setQuery("");
    setScope("all");
    setState("all");
    setError("");
    setDemoMode(true);
  }, []);

  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  useEffect(() => {
    try {
      localStorage.setItem(WORKFLOW_VIEW_STORAGE_KEY, view);
    } catch {
      /* ignore storage failures */
    }
  }, [view]);

  useEffect(() => {
    setTimelineWindow(initialTimelineWindow(timeline));
  }, [timeline]);

  useLayoutEffect(() => {
    const anchor = timelineAnchorRef.current;
    const rail = timelineRailRef.current;
    if (!rail) return;
    if (anchor) {
      timelineAnchorRef.current = null;
      const anchorNode = Array.from(rail.children).find((node) => node.dataset.timelineKey === anchor.key);
      if (anchorNode) {
        rail.scrollLeft = anchor.scrollLeft + anchorNode.offsetLeft - anchor.offsetLeft;
      }
    }
    window.clearTimeout(timelineUnlockTimerRef.current);
    timelineUnlockTimerRef.current = window.setTimeout(() => {
      timelineLoadingRef.current = false;
    }, 80);
  }, [timelineWindow]);

  useEffect(() => () => {
    window.clearTimeout(timelineUnlockTimerRef.current);
    window.cancelAnimationFrame(timelineScrollFrameRef.current);
  }, []);

  const visibleTimeline = useMemo(
    () => timeline.slice(timelineWindow.start, timelineWindow.end),
    [timeline, timelineWindow],
  );
  const hasEarlierTimeline = timelineWindow.start > 0;
  const hasLaterTimeline = timelineWindow.end < timeline.length;

  const loadEarlierTimeline = useCallback(() => {
    if (!hasEarlierTimeline || timelineLoadingRef.current) return;
    timelineLoadingRef.current = true;
    const rail = timelineRailRef.current;
    const anchorNode = rail?.querySelector("[data-timeline-key]");
    timelineAnchorRef.current = anchorNode ? {
      key: anchorNode.dataset.timelineKey,
      offsetLeft: anchorNode.offsetLeft,
      scrollLeft: rail.scrollLeft,
    } : null;
    setTimelineWindow((current) => ({
      start: Math.max(0, current.start - TIMELINE_WINDOW_SIZE),
      end: Math.min(current.end, Math.max(0, current.start - TIMELINE_WINDOW_SIZE) + TIMELINE_WINDOW_MAX),
    }));
  }, [hasEarlierTimeline]);

  const loadLaterTimeline = useCallback(() => {
    if (!hasLaterTimeline || timelineLoadingRef.current) return;
    timelineLoadingRef.current = true;
    const rail = timelineRailRef.current;
    const anchorNodes = rail?.querySelectorAll("[data-timeline-key]");
    const anchorNode = anchorNodes?.[anchorNodes.length - 1];
    timelineAnchorRef.current = anchorNode ? {
      key: anchorNode.dataset.timelineKey,
      offsetLeft: anchorNode.offsetLeft,
      scrollLeft: rail.scrollLeft,
    } : null;
    setTimelineWindow((current) => ({
      start: Math.max(current.start, Math.min(timeline.length, current.end + TIMELINE_WINDOW_SIZE) - TIMELINE_WINDOW_MAX),
      end: Math.min(timeline.length, current.end + TIMELINE_WINDOW_SIZE),
    }));
  }, [hasLaterTimeline, timeline.length]);

  const handleTimelineScroll = useCallback((event) => {
    const rail = event.currentTarget;
    if (timelineScrollFrameRef.current) return;
    timelineScrollFrameRef.current = window.requestAnimationFrame(() => {
      timelineScrollFrameRef.current = 0;
      if (timelineLoadingRef.current) return;
      if (rail.scrollLeft <= 32) loadEarlierTimeline();
      else if (rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 32) loadLaterTimeline();
    });
  }, [loadEarlierTimeline, loadLaterTimeline]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return workflows.filter((workflow) => {
      if (timelineKey === "unassigned" && (workflow.timeline || []).length > 0) return false;
      if (timelineKey !== "all" && timelineKey !== "unassigned" && !(workflow.timeline || []).some((entry) => entry.key === timelineKey)) return false;
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
        ...(workflow.timeline || []).flatMap((entry) => [
          entry.title,
          entry.kind,
          entry.date,
          ...Object.values(entry.dimensions || {}),
        ]),
      ].some((value) => String(value || "").toLowerCase().includes(keyword));
    });
  }, [query, scope, state, timelineKey, workflows]);

  return (
    <div className="af-settings-page af-workflows-page">
      <div className="af-settings-body">
        <div className="af-settings-inner af-workflows-inner">
          <section className="af-settings-hero af-workflows-hero">
            <div>
              <span className="af-workflows-eyebrow">Workflow Dashboard</span>
              <h1 className="af-settings-h1">迭代</h1>
              <p className="af-settings-lead">{view === "team" ? `汇总${team?.name ? `「${team.name}」` : "当前团队"}的需求 Workflow，按负责人追踪进度与风险。` : "集中查看我创建和参与的需求 Workflow，追踪阶段、Action 进度与最新动态。"}</p>
            </div>
            <div className="af-workflows-hero-actions">
              <button
                type="button"
                className="af-workflows-guide-link"
                onClick={() => navigate("/workflow-report")}
              >
                <span className="material-symbols-outlined" aria-hidden>integration_instructions</span>
                接入说明
              </button>
              <div className="af-scope-switch" aria-label="迭代视图">
                <button type="button" className={view === "personal" ? "is-active" : ""} onClick={() => setView("personal")}>个人迭代</button>
                <button type="button" className={view === "team" ? "is-active" : ""} onClick={() => setView("team")}>团队迭代</button>
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
          </section>

          {timeline.length > 0 || unassignedCount > 0 ? (
            <section className="af-workflows-timeline" aria-label="迭代时间线">
              <div className="af-workflows-timeline__heading">
                <div>
                  <span>迭代时间线</span>
                  <strong>按排期归属汇总</strong>
                  {demoMode ? <em>本地示例</em> : null}
                </div>
                <div className="af-workflows-timeline__actions">
                  {timelineKey !== "all" ? <button type="button" onClick={() => setTimelineKey("all")}>查看全部</button> : null}
                  {demoMode ? <button type="button" onClick={() => void loadWorkflows()}>退出示例</button> : null}
                </div>
              </div>
              <div
                className="af-workflows-timeline__rail"
                ref={timelineRailRef}
                onScroll={handleTimelineScroll}
              >
                {visibleTimeline.map((entry) => {
                  const dimensionText = timelineDimensions(entry);
                  const status = timelineStatus(entry);
                  return (
                    <button
                      type="button"
                      key={entry.key}
                      data-timeline-key={entry.key}
                      className={`is-${status.key}${timelineKey === entry.key ? " is-active" : ""}`}
                      aria-pressed={timelineKey === entry.key}
                      onClick={() => setTimelineKey((current) => current === entry.key ? "all" : entry.key)}
                    >
                      <span className="af-workflows-timeline__date">
                        {formatTimelineDate(entry.date)}
                        <em>{status.label}</em>
                      </span>
                      <strong>{entry.title || entry.id}</strong>
                      <small>{[
                        dimensionText,
                        `${entry.workflowCount || 0} 项`,
                        entry.completedCount ? `${entry.completedCount} 项已完成` : "",
                        entry.blockedCount ? `${entry.blockedCount} 项需关注` : "",
                      ].filter(Boolean).join(" · ")}</small>
                    </button>
                  );
                })}
                {unassignedCount > 0 && !hasLaterTimeline ? (
                  <button
                    type="button"
                    className={`af-workflows-timeline__unassigned${timelineKey === "unassigned" ? " is-active" : ""}`}
                    aria-pressed={timelineKey === "unassigned"}
                    onClick={() => setTimelineKey((current) => current === "unassigned" ? "all" : "unassigned")}
                  >
                    <span className="af-workflows-timeline__date">未排期</span>
                    <strong>未归属</strong>
                    <small>{unassignedCount} 项 Workflow</small>
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

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
              <button type="button" className="af-workflows-demo-button" onClick={loadDemo}>
                <span className="material-symbols-outlined" aria-hidden>science</span>
                载入本地示例时间线
              </button>
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
                    <div className="af-workflow-card__meta">
                      <span>{workflow.phase || "未识别阶段"}</span>
                      <span>{workflow.issueCount || 0} Issues</span>
                      {(workflow.platforms || []).map((platform) => (
                        <span key={platform}>{platformLabel(platform)}</span>
                      ))}
                      {(workflow.timeline || []).map((entry) => (
                        <span key={entry.key}>{entry.title || entry.id}</span>
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
                    onClick={() => { if (!workflow.demo) navigate(workflowUrl(workflow)); }}
                    disabled={workflow.demo}
                  >
                    {workflow.demo ? "示例数据" : "打开 Workflow"}
                    <span className="material-symbols-outlined" aria-hidden>{workflow.demo ? "science" : "arrow_forward"}</span>
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
