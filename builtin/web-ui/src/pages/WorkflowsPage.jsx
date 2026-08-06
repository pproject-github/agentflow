import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRoute } from "../routeContext.jsx";
import { WORKFLOW_CHECKLIST_DEMO_ACTION, withWorkflowChecklistProgress } from "../workflowChecklistDemo.js";

const WORKFLOW_VIEW_STORAGE_KEY = "agentflow.workflows.scopeView";
const TIMELINE_WINDOW_SIZE = 8;
const TIMELINE_WINDOW_MAX = 24;
const WORKFLOW_PAGE_SIZES = [20, 50, 100];

function loadWorkflowView() {
  if (typeof localStorage === "undefined") return "personal";
  try {
    return localStorage.getItem(WORKFLOW_VIEW_STORAGE_KEY) === "team" ? "team" : "personal";
  } catch {
    return "personal";
  }
}

function isLocalWorkflowRuntime() {
  if (typeof window === "undefined") return false;
  return ["127.0.0.1", "localhost", "::1"].includes(String(window.location.hostname || "").toLowerCase());
}

function loadWorkflowPageState() {
  const params = typeof window === "undefined"
    ? new URLSearchParams()
    : new URLSearchParams(window.location.search);
  const storedView = loadWorkflowView();
  const view = params.get("view") === "team"
    ? "team"
    : params.get("view") === "personal"
      ? "personal"
      : storedView;
  const scope = ["owned", "collaborating"].includes(params.get("scope"))
    ? params.get("scope")
    : "all";
  const state = ["active", "completed", "blocked"].includes(params.get("state"))
    ? params.get("state")
    : "all";
  const requestedPageSize = Number.parseInt(params.get("pageSize") || "20", 10);
  const requestedDemo = params.get("demo");
  return {
    view,
    demo: view === "personal" && (
      requestedDemo === "1"
      || (requestedDemo === null && isLocalWorkflowRuntime())
    ),
    timelineKey: params.has("timelineKey") ? String(params.get("timelineKey") || "all") : "",
    query: String(params.get("q") || ""),
    scope,
    state,
    page: Math.max(1, Number.parseInt(params.get("page") || "1", 10) || 1),
    pageSize: WORKFLOW_PAGE_SIZES.includes(requestedPageSize) ? requestedPageSize : 20,
  };
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

function defaultTimelineKey(entries) {
  const rows = (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const rawDate = String(entry?.endDate || entry?.end || entry?.date || "");
      const timestamp = Date.parse(rawDate);
      return {
        entry,
        timestamp: Number.isFinite(timestamp) && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
          ? timestamp + (24 * 60 * 60 * 1000) - 1
          : timestamp,
      };
    })
    .filter(({ entry, timestamp }) => entry?.key && Number.isFinite(timestamp));
  const next = rows.filter(({ timestamp }) => timestamp >= Date.now()).sort((left, right) => left.timestamp - right.timestamp)[0];
  if (next) return next.entry.key;
  return rows.sort((left, right) => right.timestamp - left.timestamp)[0]?.entry?.key || "all";
}

function paginationItems(page, totalPages) {
  const pages = Array.from(new Set([1, totalPages, page - 1, page, page + 1]
    .filter((value) => value >= 1 && value <= totalPages)))
    .sort((left, right) => left - right);
  const items = [];
  pages.forEach((value, index) => {
    if (index > 0 && value - pages[index - 1] > 1) items.push(`gap-${value}`);
    items.push(value);
  });
  return items;
}

function createWorkflowDemo() {
  const versions = [
    {
      key: "prd-flow:version:demo-5.62.0",
      kind: "version",
      id: "demo-5.62.0",
      title: "Likee Android&iOS 5.62.0",
      date: dateFromToday(-12),
      source: "prd-flow",
      dimensions: { platform: ["Android", "iOS"] },
    },
    {
      key: "prd-flow:version:demo-5.63.0",
      kind: "version",
      id: "demo-5.63.0",
      title: "Likee Android&iOS 5.63.0",
      date: dateFromToday(6),
      source: "prd-flow",
      dimensions: { platform: ["Android", "iOS"] },
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
      key: `prd-flow:version:demo-5.${50 + index}.0`,
      kind: "version",
      id: `demo-5.${50 + index}.0`,
      title: `Likee Android 5.${50 + index}.0`,
      date: dateFromToday(-180 + index * 14),
      source: "prd-flow",
      dimensions: { platform: "Android" },
    })),
    ...Array.from({ length: 8 }, (_, index) => ({
      key: `prd-flow:version:demo-5.${64 + index}.0`,
      kind: "version",
      id: `demo-5.${64 + index}.0`,
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
      timeline: [byKey["prd-flow:version:demo-5.63.0"]], demo: true,
    },
    {
      id: "demo-2", tapdId: "1013667", title: "激励视频增收方案",
      pointer: "检查并选择 TAPD 未解决 Bug", phase: "BUG_SELECTION_READY",
      state: "blocked", role: "viewer", ownerUsername: "surujija", issueCount: 18, platforms: ["android", "ios"],
      actionCount: 33, completedActionCount: 32, latestAction: { title: "等待版本风险确认", at: new Date().toISOString() },
      timeline: [byKey["prd-flow:version:demo-5.63.0"]], demo: true,
    },
    {
      id: "demo-3", tapdId: "1133202860001018940", title: "Likee Android 5.62.0",
      pointer: "发版上下文已同步", phase: "RELEASED",
      state: "completed", role: "reporter", ownerUsername: "chenjunlun", issueCount: 1, platforms: ["ios"],
      actionCount: 1, completedActionCount: 1, latestAction: { title: "版本发布完成", at: dateFromToday(-12) },
      timeline: [byKey["prd-flow:version:demo-5.62.0"]], demo: true,
    },
    {
      id: "demo-4", tapdId: "1015046", title: "Remote Config 拉取频控",
      pointer: "双端方案进入提测准备", phase: "SUBMIT_TEST",
      state: "active", role: "owner", ownerUsername: "alice", issueCount: 4, platforms: ["android", "ios"],
      actionCount: 8, completedActionCount: 6, latestAction: { title: "测试用例已归档", at: new Date().toISOString() },
      timeline: [byKey["prd-flow:version:demo-5.63.0"], byKey["prd-flow:milestone:august-gray"]], demo: true,
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
      role: index % 3 === 0 ? "owner" : "reporter",
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
  if (role === "reporter" || role === "editor") return "可上报";
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

function workflowUrl(workflow, returnTo = "/workflows") {
  const query = new URLSearchParams({
    view: "workflow",
    tapdId: String(workflow?.tapdId || ""),
    returnTo,
  });
  const projectBindings = Array.isArray(workflow?.projectBindings) ? workflow.projectBindings : [];
  if (projectBindings.length === 1) {
    const project = projectBindings[0];
    if (project.flowId) query.set("flowId", String(project.flowId));
    if (project.flowSource) query.set("flowSource", String(project.flowSource));
    if (project.workspaceId) query.set("workspaceId", String(project.workspaceId));
    if (project.archived) query.set("archived", "1");
  }
  if (workflow?.demo) query.set("workflowDemo", "1");
  return `/workspace?${query.toString()}`;
}

function createWorkflowDemoSnapshot(workflow) {
  const tapdId = String(workflow?.tapdId || "DEMO");
  const platform = platformLabel(workflow?.platforms?.[0] || "all") || "双端";
  const timelineEntry = workflow?.timeline?.[0] || {};
  const actionTemplates = [
    ["方案已确认", "需求范围和实现方案已完成确认。"],
    ["研发任务已创建", "Issue 与研发分支信息已经同步。"],
    ["实现进度已更新", "实现状态和当前风险已归档。"],
    ["测试状态已更新", "自测、提测状态已经同步。"],
    ["版本归属已确认", "版本排期和发布上下文已经确认。"],
  ];
  const visibleActionCount = Math.min(5, Math.max(1, Number(workflow?.actionCount || 1)));
  const completedRatio = Number(workflow?.actionCount || 0) > 0
    ? Number(workflow?.completedActionCount || 0) / Number(workflow.actionCount)
    : 0;
  const completedSlots = Math.round(visibleActionCount * completedRatio);
  const checklistAction = withWorkflowChecklistProgress(WORKFLOW_CHECKLIST_DEMO_ACTION);
  const checklistIndex = Math.min(3, visibleActionCount - 1);
  const actions = actionTemplates.slice(0, visibleActionCount).map(([title, detail], index) => ({
    id: `demo-action-${index + 1}`,
    actionId: `demo-action-${index + 1}`,
    stageKey: ["plan", "issue", "implementation", "test", "release"][index],
    title,
    detail,
    status: index < completedSlots ? "done" : index === completedSlots ? "current" : "pending",
    issueKey: `demo-${tapdId.toLowerCase()}`,
    platform,
    updatedAt: new Date(Date.now() - (visibleActionCount - index) * 45 * 60 * 1000).toISOString(),
    ...(index === checklistIndex ? {
      source: checklistAction.source,
      actionKey: checklistAction.key,
      checklist: checklistAction.checklist,
    } : {}),
  }));
  return {
    revision: `demo-${tapdId}`,
    phase: workflow?.phase || "PLANNING",
    pointer: workflow?.pointer || workflow?.latestAction?.title || "本地 Workflow 示例",
    actions,
    issues: Array.from({ length: Math.min(4, Math.max(1, Number(workflow?.issueCount || 1))) }, (_, index) => ({
      key: `demo-${tapdId.toLowerCase()}-${index + 1}`,
      title: index === 0 ? workflow?.title || "示例研发事项" : `子任务 ${index + 1}`,
      platform,
      status: workflow?.state === "completed" ? "done" : index === 0 ? "in_progress" : "pending",
      epicKey: "示例需求",
    })),
    globalState: {
      title: workflow?.title || `TAPD ${tapdId}`,
      status: { label: stateLabel(workflow?.state) },
      workflow: { namespace: "tapd", id: tapdId },
      sections: {
        version: {
          title: "版本归属",
          fields: {
            version: { label: "版本", type: "text", value: timelineEntry.title || "待归属" },
            date: { label: "版本日期", type: "text", value: timelineEntry.date || "待确认" },
            platform: { label: "平台", type: "chips", value: [platform] },
          },
        },
        progress: {
          title: "研发进度",
          fields: {
            actions: { label: "Action", type: "text", value: `${workflow?.completedActionCount || 0}/${workflow?.actionCount || 0}` },
            issues: { label: "Issues", type: "text", value: String(workflow?.issueCount || 0) },
            owner: { label: "Owner", type: "user", value: workflow?.ownerUsername || "demo-user" },
          },
        },
      },
    },
    runtimeEvents: actions.map((action) => ({ ...action, type: "demo-runtime-event" })),
    demo: true,
  };
}

function openWorkflow(navigate, workflow) {
  if (workflow?.demo) {
    try {
      window.sessionStorage.setItem(
        `agentflow.workflow.demo:${workflow.tapdId}`,
        JSON.stringify(createWorkflowDemoSnapshot(workflow)),
      );
    } catch {
      /* the detail page will show a local-example error when storage is unavailable */
    }
  }
  const returnTo = typeof window === "undefined"
    ? "/workflows"
    : `${window.location.pathname}${window.location.search}`;
  navigate(workflowUrl(workflow, returnTo));
}

export default function WorkflowsPage() {
  const { navigate } = useRoute();
  const [initialPageState] = useState(loadWorkflowPageState);
  const [initialDemo] = useState(() => initialPageState.demo ? createWorkflowDemo() : null);
  const [workflows, setWorkflows] = useState(() => initialDemo?.workflows || []);
  const [timeline, setTimeline] = useState(() => initialDemo?.timeline || []);
  const [unassignedCount, setUnassignedCount] = useState(() => initialDemo?.unassignedCount || 0);
  const [availableCount, setAvailableCount] = useState(() => initialDemo?.workflows?.length || 0);
  const [timelineKey, setTimelineKey] = useState(() => {
    if (!initialDemo) return initialPageState.timelineKey;
    if (initialPageState.timelineKey === "all") return "all";
    if (initialPageState.timelineKey === "unassigned") return "unassigned";
    if (initialDemo.timeline.some((entry) => entry.key === initialPageState.timelineKey)) return initialPageState.timelineKey;
    return defaultTimelineKey(initialDemo.timeline);
  });
  const [view, setView] = useState(initialPageState.view);
  const [team, setTeam] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState(initialPageState.query);
  const [serverQuery, setServerQuery] = useState(initialPageState.query);
  const [scope, setScope] = useState(initialPageState.scope);
  const [state, setState] = useState(initialPageState.state);
  const [page, setPage] = useState(initialPageState.page);
  const [pageSize, setPageSize] = useState(initialPageState.pageSize);
  const [pagination, setPagination] = useState({
    page: initialPageState.page,
    pageSize: initialPageState.pageSize,
    total: 0,
    totalPages: 1,
    hasPrevious: false,
    hasNext: false,
  });
  const [demoMode, setDemoMode] = useState(initialPageState.demo);
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
      const params = new URLSearchParams({
        view,
        q: serverQuery,
        scope,
        state,
        page: String(page),
        pageSize: String(pageSize),
      });
      if (timelineKey) params.set("timelineKey", timelineKey);
      const response = await fetch(`/api/prd-workflows?${params.toString()}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "读取迭代列表失败");
      const nextWorkflows = Array.isArray(payload.workflows) ? payload.workflows : [];
      const nextTimeline = Array.isArray(payload.timeline) ? payload.timeline : [];
      setWorkflows(nextWorkflows);
      setTimeline(nextTimeline);
      setUnassignedCount(Number(payload.unassignedCount || 0));
      setAvailableCount(Number(payload.availableCount || 0));
      setTimelineKey(String(payload.selectedTimelineKey || payload.defaultTimelineKey || "all"));
      const nextPagination = payload.pagination && typeof payload.pagination === "object"
        ? payload.pagination
        : { page: 1, pageSize, total: nextWorkflows.length, totalPages: 1, hasPrevious: false, hasNext: false };
      setPagination(nextPagination);
      if (Number(nextPagination.page) !== page) setPage(Number(nextPagination.page) || 1);
      setTeam(payload.team || null);
    } catch (loadError) {
      setError(String(loadError.message || loadError));
      setWorkflows([]);
      setTimeline([]);
      setUnassignedCount(0);
      setAvailableCount(0);
      setTeam(null);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, scope, serverQuery, state, timelineKey, view]);

  const loadDemo = useCallback(() => {
    const demo = createWorkflowDemo();
    setWorkflows(demo.workflows);
    setTimeline(demo.timeline);
    setUnassignedCount(demo.unassignedCount);
    setAvailableCount(demo.workflows.length);
    setTimelineKey(defaultTimelineKey(demo.timeline));
    setQuery("");
    setServerQuery("");
    setScope("all");
    setState("all");
    setPage(1);
    setError("");
    setDemoMode(true);
  }, []);

  const exitDemo = useCallback(() => {
    setDemoMode(false);
    setTimelineKey("");
    setPage(1);
  }, []);

  useEffect(() => {
    if (demoMode) return;
    void loadWorkflows();
  }, [demoMode, loadWorkflows]);

  useEffect(() => {
    const timer = window.setTimeout(() => setServerQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    try {
      localStorage.setItem(WORKFLOW_VIEW_STORAGE_KEY, view);
    } catch {
      /* ignore storage failures */
    }
  }, [view]);

  useEffect(() => {
    if (view === "team" && demoMode) return;
    const params = new URLSearchParams({
      view,
      page: String(page),
      pageSize: String(pageSize),
    });
    if (timelineKey) params.set("timelineKey", timelineKey);
    if (query.trim()) params.set("q", query.trim());
    if (scope !== "all") params.set("scope", scope);
    if (state !== "all") params.set("state", state);
    if (demoMode) params.set("demo", "1");
    else if (view === "personal" && isLocalWorkflowRuntime()) params.set("demo", "0");
    window.history.replaceState({}, "", `/workflows?${params.toString()}`);
  }, [demoMode, page, pageSize, query, scope, state, timelineKey, view]);

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

  const selectedTimelineEntry = useMemo(
    () => timeline.find((entry) => entry.key === timelineKey) || null,
    [timeline, timelineKey],
  );

  const filtered = useMemo(() => {
    if (!demoMode) return workflows;
    const keyword = query.trim().toLowerCase();
    return workflows.filter((workflow) => {
      if (timelineKey === "unassigned" && (workflow.timeline || []).length > 0) return false;
      if (timelineKey !== "all" && timelineKey !== "unassigned") {
        const workflowId = String(workflow?.id || workflow?.tapdId || "");
        const selectedWorkflowIds = Array.isArray(selectedTimelineEntry?.workflowIds) ? selectedTimelineEntry.workflowIds : [];
        const belongsToSelectedTimeline = selectedWorkflowIds.length > 0
          ? selectedWorkflowIds.includes(workflowId)
          : (workflow.timeline || []).some((entry) => entry.key === timelineKey);
        if (!belongsToSelectedTimeline) return false;
      }
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
  }, [demoMode, query, scope, selectedTimelineEntry, state, timelineKey, workflows]);
  const displayedWorkflows = demoMode
    ? filtered.slice((page - 1) * pageSize, page * pageSize)
    : workflows;
  const visiblePagination = demoMode
    ? {
        page,
        pageSize,
        total: filtered.length,
        totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
        hasPrevious: page > 1,
        hasNext: page < Math.max(1, Math.ceil(filtered.length / pageSize)),
      }
    : pagination;

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
              {view === "personal" ? (
                <button
                  type="button"
                  className={`af-workflows-guide-link af-workflows-demo-toggle${demoMode ? " is-active" : ""}`}
                  onClick={demoMode ? exitDemo : loadDemo}
                >
                  <span className="material-symbols-outlined" aria-hidden>{demoMode ? "close" : "science"}</span>
                  {demoMode ? "退出示例" : "本地示例"}
                </button>
              ) : null}
              <div className="af-scope-switch" aria-label="迭代视图">
                <button type="button" className={view === "personal" ? "is-active" : ""} onClick={() => { setView("personal"); setTimelineKey(""); setPage(1); }}>个人迭代</button>
                <button type="button" className={view === "team" ? "is-active" : ""} onClick={() => { setDemoMode(false); setView("team"); setTimelineKey(""); setPage(1); }}>团队迭代</button>
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
                  {timelineKey !== "all" ? <button type="button" onClick={() => { setTimelineKey("all"); setPage(1); }}>查看全部</button> : null}
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
                      onClick={() => { setTimelineKey(entry.key); setPage(1); }}
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
                    onClick={() => { setTimelineKey("unassigned"); setPage(1); }}
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
                onChange={(event) => { setQuery(event.target.value); setPage(1); }}
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
                  onClick={() => { setScope(value); setPage(1); }}
                >
                  {label}
                </button>
              ))}
            </div>
            <select value={state} onChange={(event) => { setState(event.target.value); setPage(1); }} aria-label="迭代状态">
              <option value="all">全部状态</option>
              <option value="active">进行中</option>
              <option value="completed">已完成</option>
              <option value="blocked">需关注</option>
            </select>
          </section>

          {error ? <div className="af-workflows-message af-workflows-message--error">{error}</div> : null}
          {loading ? <div className="af-workflows-message">正在读取迭代...</div> : null}
          {!loading && !error && availableCount === 0 ? (
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
          {!loading && availableCount > 0 && visiblePagination.total === 0 ? (
            <div className="af-workflows-message">没有符合当前筛选条件的迭代。</div>
          ) : null}

          <div className="af-workflows-list">
            {displayedWorkflows.map((workflow) => {
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
                    <h2>{workflow.title || `TAPD ${workflow.tapdId}`}</h2>
                    <div className="af-workflow-card__meta">
                      <span>{workflow.phase || "未识别阶段"}</span>
                      <span>{workflow.issueCount || 0} Issues</span>
                      {(workflow.platforms || []).map((platform) => (
                        <span key={platform}>{platformLabel(platform)}</span>
                      ))}
                      {(workflow.timeline || []).map((entry) => (
                        <span key={entry.key}>{entry.title || entry.id}</span>
                      ))}
                      {(workflow.projectBindings || []).map((project) => (
                        <span key={project.workspaceId}>Project · {project.label || project.flowId}</span>
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
                    onClick={() => openWorkflow(navigate, workflow)}
                  >
                    {workflow.demo ? "查看示例" : "打开 Workflow"}
                    <span className="material-symbols-outlined" aria-hidden>{workflow.demo ? "science" : "arrow_forward"}</span>
                  </button>
                </article>
              );
            })}
          </div>
          {!loading && !error && visiblePagination.total > 0 ? (
            <nav className="af-workflows-pagination" aria-label="Workflow 列表分页">
              <span>共 {visiblePagination.total} 项</span>
              <div className="af-workflows-pagination__pages">
                <button
                  type="button"
                  disabled={!visiblePagination.hasPrevious}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  aria-label="上一页"
                >
                  <span className="material-symbols-outlined" aria-hidden>chevron_left</span>
                </button>
                {paginationItems(visiblePagination.page, visiblePagination.totalPages).map((item) => (
                  typeof item === "string"
                    ? <span key={item} className="af-workflows-pagination__gap">…</span>
                    : (
                      <button
                        type="button"
                        key={item}
                        className={visiblePagination.page === item ? "is-active" : ""}
                        aria-current={visiblePagination.page === item ? "page" : undefined}
                        onClick={() => setPage(item)}
                      >
                        {item}
                      </button>
                    )
                ))}
                <button
                  type="button"
                  disabled={!visiblePagination.hasNext}
                  onClick={() => setPage((current) => Math.min(visiblePagination.totalPages, current + 1))}
                  aria-label="下一页"
                >
                  <span className="material-symbols-outlined" aria-hidden>chevron_right</span>
                </button>
              </div>
              <label>
                每页
                <select
                  value={pageSize}
                  onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}
                  aria-label="每页数量"
                >
                  {WORKFLOW_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                </select>
                项
              </label>
            </nav>
          ) : null}
        </div>
      </div>
    </div>
  );
}
