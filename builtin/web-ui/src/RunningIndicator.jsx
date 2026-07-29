import { useEffect, useRef, useState } from "react";
import { useRoute } from "./routeContext.jsx";

const RECENT_RUNS_CHANNEL = "agentflow:recent-runs:v1";
const RECENT_RUNS_LOCK = "agentflow:recent-runs:poller";
const POLL_INTERVAL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 8_000;
const LEADER_RETRY_MS = 2_000;
const PRESENCE_INTERVAL_MS = 5_000;
const PRESENCE_TTL_MS = 16_000;
const FAILURE_BACKOFF_MS = [10_000, 30_000, 60_000];

function retryDelay(failureCount) {
  return FAILURE_BACKOFF_MS[Math.min(Math.max(failureCount - 1, 0), FAILURE_BACKOFF_MS.length - 1)];
}

function createTabId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function formatSyncTime(value) {
  if (!value) return "暂无成功记录";
  try {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "暂无成功记录";
  }
}

export default function RunningIndicator() {
  const { navigate, path } = useRoute();
  const [runs, setRuns] = useState([]);
  const [open, setOpen] = useState(false);
  const [tabCount, setTabCount] = useState(1);
  const [syncHealth, setSyncHealth] = useState({
    status: "idle",
    failureCount: 0,
    lastSuccessAt: 0,
    message: "",
  });
  const retryRef = useRef(() => {});

  useEffect(() => {
    let cancelled = false;
    let isLeader = false;
    let leadershipPending = false;
    let releaseLeadership = null;
    let pollTimer = 0;
    let leaderRetryTimer = 0;
    let presenceTimer = 0;
    let peerCleanupTimer = 0;
    let activeRequest = null;
    let failureCount = 0;
    let lastSuccessAt = 0;
    const tabId = createTabId();
    const peers = new Map();
    const channel = typeof BroadcastChannel === "function"
      ? new BroadcastChannel(RECENT_RUNS_CHANNEL)
      : null;

    const post = (message) => {
      try {
        channel?.postMessage({ ...message, tabId, sentAt: Date.now() });
      } catch {
        // BroadcastChannel 失败时，本标签页仍可独立刷新。
      }
    };

    const refreshTabCount = () => {
      const cutoff = Date.now() - PRESENCE_TTL_MS;
      for (const [peerId, seenAt] of peers) {
        if (seenAt < cutoff) peers.delete(peerId);
      }
      setTabCount(1 + peers.size);
    };

    const announcePresence = (type = "presence") => {
      post({ type, visible: !document.hidden });
    };

    const applyRemoteState = (message) => {
      if (cancelled) return;
      if (Array.isArray(message.runs)) setRuns(message.runs);
      if (message.syncHealth && typeof message.syncHealth === "object") {
        const next = message.syncHealth;
        failureCount = Number(next.failureCount) || 0;
        lastSuccessAt = Number(next.lastSuccessAt) || 0;
        setSyncHealth(next);
      }
    };

    const publishState = (payload) => {
      applyRemoteState(payload);
      post({ type: "state", ...payload });
    };

    const clearPollTimer = () => {
      if (!pollTimer) return;
      window.clearTimeout(pollTimer);
      pollTimer = 0;
    };

    const schedulePoll = (delay) => {
      clearPollTimer();
      if (cancelled || !isLeader || document.hidden) return;
      pollTimer = window.setTimeout(() => {
        pollTimer = 0;
        void load();
      }, Math.max(0, delay));
    };

    const load = async () => {
      if (cancelled || !isLeader || document.hidden || activeRequest) return;

      const request = new AbortController();
      activeRequest = request;
      let timedOut = false;
      const timeoutId = window.setTimeout(() => {
        timedOut = true;
        request.abort();
      }, REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch("/api/pipeline-recent-runs", { signal: request.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (cancelled || !isLeader || document.hidden) return;

        failureCount = 0;
        lastSuccessAt = Date.now();
        const list = Array.isArray(data.runs) ? data.runs : [];
        publishState({
          runs: list.filter((item) => item && item.status === "running"),
          syncHealth: {
            status: "ok",
            failureCount: 0,
            lastSuccessAt,
            message: "",
          },
        });
        schedulePoll(POLL_INTERVAL_MS);
      } catch (error) {
        const intentionallyStopped = request.signal.aborted && !timedOut;
        if (cancelled || !isLeader || document.hidden || intentionallyStopped) return;

        failureCount += 1;
        publishState({
          syncHealth: {
            status: "delayed",
            failureCount,
            lastSuccessAt,
            message: timedOut
              ? "运行状态同步超过 8 秒未响应"
              : `运行状态同步失败：${String(error?.message || error)}`,
          },
        });
        schedulePoll(retryDelay(failureCount));
      } finally {
        window.clearTimeout(timeoutId);
        if (activeRequest === request) activeRequest = null;
      }
    };

    const stopPolling = () => {
      clearPollTimer();
      if (activeRequest) {
        activeRequest.abort();
        activeRequest = null;
      }
    };

    const relinquishLeadership = () => {
      stopPolling();
      if (releaseLeadership) {
        const release = releaseLeadership;
        releaseLeadership = null;
        release();
      }
      isLeader = false;
    };

    const scheduleLeaderAttempt = (delay = LEADER_RETRY_MS) => {
      if (leaderRetryTimer) window.clearTimeout(leaderRetryTimer);
      if (cancelled || document.hidden || isLeader || leadershipPending) return;
      leaderRetryTimer = window.setTimeout(() => {
        leaderRetryTimer = 0;
        void attemptLeadership();
      }, delay);
    };

    const becomeFallbackLeader = () => {
      if (cancelled || document.hidden || isLeader) return;
      isLeader = true;
      schedulePoll(0);
    };

    const attemptLeadership = async () => {
      if (cancelled || document.hidden || isLeader || leadershipPending) return;

      if (!navigator.locks?.request) {
        // 老浏览器无法跨标签页选主，但仍保证后台页不轮询、单页请求不重叠。
        becomeFallbackLeader();
        return;
      }

      leadershipPending = true;
      try {
        await navigator.locks.request(
          RECENT_RUNS_LOCK,
          { mode: "exclusive", ifAvailable: true },
          async (lock) => {
            leadershipPending = false;
            if (!lock || cancelled || document.hidden) {
              scheduleLeaderAttempt();
              return;
            }

            isLeader = true;
            schedulePoll(0);
            await new Promise((resolve) => {
              releaseLeadership = resolve;
            });
            releaseLeadership = null;
            isLeader = false;
          },
        );
      } catch {
        leadershipPending = false;
      } finally {
        scheduleLeaderAttempt();
      }
    };

    const retryNow = () => {
      if (cancelled) return;
      if (isLeader) {
        failureCount = 0;
        schedulePoll(0);
        return;
      }
      post({ type: "retry" });
      scheduleLeaderAttempt(0);
    };
    retryRef.current = retryNow;

    if (channel) {
      channel.onmessage = (event) => {
        const message = event.data;
        if (!message || message.tabId === tabId) return;

        if (message.type === "hello" || message.type === "presence") {
          peers.set(message.tabId, Date.now());
          refreshTabCount();
          if (message.type === "hello") announcePresence();
          return;
        }
        if (message.type === "bye") {
          peers.delete(message.tabId);
          refreshTabCount();
          scheduleLeaderAttempt(0);
          return;
        }
        if (message.type === "state") {
          peers.set(message.tabId, Date.now());
          refreshTabCount();
          applyRemoteState(message);
          return;
        }
        if (message.type === "retry" && isLeader) {
          failureCount = 0;
          schedulePoll(0);
        }
      };
    }

    const handleVisibilityChange = () => {
      announcePresence();
      if (document.hidden) {
        relinquishLeadership();
      } else {
        scheduleLeaderAttempt(0);
      }
    };
    const handlePageHide = () => {
      announcePresence("bye");
      relinquishLeadership();
    };
    const handlePageShow = () => {
      announcePresence("hello");
      scheduleLeaderAttempt(0);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    announcePresence("hello");
    presenceTimer = window.setInterval(announcePresence, PRESENCE_INTERVAL_MS);
    peerCleanupTimer = window.setInterval(refreshTabCount, PRESENCE_INTERVAL_MS);
    scheduleLeaderAttempt(0);

    return () => {
      cancelled = true;
      retryRef.current = () => {};
      announcePresence("bye");
      relinquishLeadership();
      if (leaderRetryTimer) window.clearTimeout(leaderRetryTimer);
      if (presenceTimer) window.clearInterval(presenceTimer);
      if (peerCleanupTimer) window.clearInterval(peerCleanupTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
      channel?.close();
    };
  }, []);

  const goTo = (run) => {
    const sp = new URLSearchParams({ flowId: run.flowId, flowSource: run.flowSource || "workspace" });
    navigate(`/flow?${sp.toString()}`);
    setOpen(false);
  };

  const currentQS = path === "/flow" ? new URLSearchParams(window.location.search) : null;
  const currentFlowId = currentQS?.get("flowId") || "";
  const delayed = syncHealth.status === "delayed";
  const coordinated = tabCount > 1;
  const single = runs.length === 1;

  // 多标签页协调成功属于后台正常状态，不需要常驻占用界面。
  // 仅在确实有运行任务或同步异常时展示全局指示器。
  if (runs.length === 0 && !delayed) return null;

  const label = delayed
    ? "状态同步延迟"
    : runs.length > 0
      ? single
        ? runs[0].flowId
        : `${runs.length} running`
      : "";

  const title = delayed
    ? `${syncHealth.message}${coordinated ? `；检测到 ${tabCount} 个 AgentFlow 标签页` : ""}`
    : coordinated
      ? `已合并 ${tabCount} 个 AgentFlow 标签页的运行状态同步`
      : single
        ? `${runs[0].flowId} 运行中，点击跳转`
        : `${runs.length} 个 pipeline 运行中`;

  const handleButtonClick = () => {
    if (!delayed && !coordinated && single) {
      goTo(runs[0]);
      return;
    }
    setOpen((value) => !value);
  };

  return (
    <div
      className={
        "af-run-indicator" +
        (delayed ? " af-run-indicator--delayed" : "") +
        (coordinated ? " af-run-indicator--coordinated" : "")
      }
      role="status"
      aria-live="polite"
    >
      {open && (
        <div className="af-run-indicator__menu" onMouseLeave={() => setOpen(false)}>
          {(delayed || coordinated) && (
            <div className="af-run-indicator__sync">
              <div className="af-run-indicator__sync-title">
                {delayed ? "运行状态同步延迟" : "多标签页同步已合并"}
              </div>
              <div className="af-run-indicator__sync-copy">
                {coordinated
                  ? `检测到 ${tabCount} 个 AgentFlow 标签页。当前只由一个可见标签页请求运行状态，后台页面不会重复建立连接。`
                  : "运行状态接口暂未及时返回，已停止重复请求并自动降低刷新频率。"}
              </div>
              {delayed && (
                <div className="af-run-indicator__sync-meta">
                  最近成功：{formatSyncTime(syncHealth.lastSuccessAt)}
                </div>
              )}
              {delayed && (
                <button
                  type="button"
                  className="af-run-indicator__retry"
                  onClick={(event) => {
                    event.stopPropagation();
                    retryRef.current();
                  }}
                >
                  立即重试
                </button>
              )}
            </div>
          )}
          {runs.map((run) => (
            <button
              key={`${run.flowId}:${run.runId}`}
              type="button"
              className={
                "af-run-indicator__item" +
                (run.flowId === currentFlowId ? " af-run-indicator__item--current" : "")
              }
              onClick={() => goTo(run)}
              title={`${run.flowId} · ${run.runId}`}
            >
              <span className="af-run-indicator__dot" />
              <span className="af-run-indicator__flow">{run.flowId}</span>
              <span className="af-run-indicator__run">{run.runId.slice(0, 12)}</span>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className="af-run-indicator__btn"
        onClick={handleButtonClick}
        title={title}
      >
        <span className="af-run-indicator__pulse" />
        <span className="af-run-indicator__label">{label}</span>
      </button>
    </div>
  );
}
