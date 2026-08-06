import { useCallback, useEffect, useMemo, useState } from "react";
import { useRoute } from "../routeContext.jsx";
import { scheduleTargetLabel, scheduleTargetUrl } from "../scheduleNavigation.js";
import LoadingState from "../components/LoadingState.jsx";

function formatDate(value) {
  if (!value) return "-";
  const time = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(time)) return String(value);
  return new Date(time).toLocaleString();
}

function sourceLabel(schedule) {
  return schedule?.kind === "workspace" ? "Workspace" : "Pipeline";
}

function statusLabel(schedule) {
  if (schedule?.running) return "运行中";
  if (!schedule?.enabled) return "已停用";
  const status = String(schedule?.lastStatus || "").trim();
  if (!status || status === "armed" || status === "enabled") return "已启用";
  if (status === "success") return "上次成功";
  if (status === "failed") return "上次失败";
  if (status === "invalid") return "配置异常";
  if (status.startsWith("skipped")) return "已跳过";
  return status;
}

export default function SchedulesPage() {
  const { navigate } = useRoute();
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatingKey, setUpdatingKey] = useState("");

  const loadSchedules = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/schedules");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "读取定时任务失败");
      setSchedules(Array.isArray(json.schedules) ? json.schedules : []);
    } catch (e) {
      setError(String(e.message || e));
      setSchedules([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSchedules();
  }, [loadSchedules]);

  const toggleSchedule = useCallback(async (schedule) => {
    const key = `${schedule.kind}:${schedule.flowSource || "user"}:${schedule.flowId || ""}:${schedule.scheduleNodeId || ""}`;
    setUpdatingKey(key);
    setError("");
    try {
      const res = await fetch("/api/schedule/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: schedule.kind,
          flowId: schedule.flowId,
          flowSource: schedule.flowSource || "user",
          scheduleNodeId: schedule.scheduleNodeId || "",
          enabled: !schedule.enabled,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) throw new Error(json.error || "更新定时任务失败");
      await loadSchedules();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setUpdatingKey("");
    }
  }, [loadSchedules]);

  const counts = useMemo(() => {
    const enabled = schedules.filter((item) => item.enabled).length;
    const workspace = schedules.filter((item) => item.kind === "workspace").length;
    return { total: schedules.length, enabled, workspace, pipeline: schedules.length - workspace };
  }, [schedules]);

  return (
    <div className="af-settings-page af-schedules-page">
      <div className="af-settings-top">
        <div className="af-settings-crumb">
          <span className="af-settings-crumb-muted">AgentFlow</span>
          <span className="af-settings-crumb-sep">/</span>
          <span className="af-settings-crumb-active">定时任务</span>
        </div>
        <button type="button" className="af-schedules-refresh" onClick={() => void loadSchedules()} disabled={loading}>
          <span className="material-symbols-outlined" aria-hidden>{loading ? "hourglass_empty" : "refresh"}</span>
          刷新
        </button>
      </div>
      <div className="af-settings-body">
        <div className="af-settings-inner">
          <section className="af-settings-hero">
            <h1 className="af-settings-h1">定时任务</h1>
            <p className="af-settings-lead">统一查看服务器上的 Pipeline 定时任务和 Workspace Scheduled Run，并在这里快捷启停。</p>
          </section>

          <div className="af-schedules-summary" aria-label="定时任务汇总">
            <div><span>全部</span><strong>{counts.total}</strong></div>
            <div><span>启用中</span><strong>{counts.enabled}</strong></div>
            <div><span>Workspace</span><strong>{counts.workspace}</strong></div>
            <div><span>Pipeline</span><strong>{counts.pipeline}</strong></div>
          </div>

          {error ? <div className="af-schedules-error">{error}</div> : null}
          {loading ? <LoadingState title="正在读取定时任务" detail="同步 Pipeline 与 Workspace 调度状态…" rows={3} /> : null}
          {!loading && schedules.length === 0 ? <div className="af-schedules-empty">暂无定时任务</div> : null}

          {!loading ? <div className="af-schedules-list">
            {schedules.map((schedule) => {
              const key = `${schedule.kind}:${schedule.flowSource || "user"}:${schedule.flowId || ""}:${schedule.scheduleNodeId || ""}`;
              const busy = updatingKey === key;
              const targetUrl = scheduleTargetUrl(schedule);
              return (
                <article key={key} className="af-schedule-card">
                  <div className="af-schedule-card__main">
                    <div className="af-schedule-card__title-row">
                      <strong>{schedule.label || schedule.flowId || "-"}</strong>
                      <span className={`af-schedule-badge af-schedule-badge--${schedule.kind || "pipeline"}`}>{sourceLabel(schedule)}</span>
                      <span className={`af-schedule-state ${schedule.enabled ? "af-schedule-state--on" : "af-schedule-state--off"}`}>
                        {statusLabel(schedule)}
                      </span>
                    </div>
                    <div className="af-schedule-card__meta">
                      <span>{schedule.flowId || "-"}</span>
                      <span>{schedule.flowSource || "user"}</span>
                      {schedule.scheduleNodeId ? <span>{schedule.scheduleNodeId}</span> : null}
                    </div>
                    <div className="af-schedule-card__grid">
                      <div><span>Cron</span><strong>{schedule.cron || "-"}</strong></div>
                      <div><span>时区</span><strong>{schedule.timezone || "Asia/Shanghai"}</strong></div>
                      <div><span>下次执行</span><strong>{formatDate(schedule.nextRunAt)}</strong></div>
                      <div><span>最近执行</span><strong>{formatDate(schedule.lastTriggeredAt)}</strong></div>
                    </div>
                    {schedule.lastError ? <p className="af-schedule-card__error">{schedule.lastError}</p> : null}
                  </div>
                  <div className="af-schedule-card__actions">
                    {targetUrl ? (
                      <button
                        type="button"
                        className="af-schedule-open"
                        title={scheduleTargetLabel(schedule)}
                        onClick={() => navigate(targetUrl)}
                      >
                        <span className="material-symbols-outlined" aria-hidden>open_in_new</span>
                        {scheduleTargetLabel(schedule)}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={schedule.enabled ? "af-schedule-toggle af-schedule-toggle--on" : "af-schedule-toggle af-schedule-toggle--off"}
                      disabled={busy}
                      aria-pressed={schedule.enabled}
                      title={schedule.enabled ? "点击停用" : "点击启用"}
                      onClick={() => void toggleSchedule(schedule)}
                    >
                      <span className="material-symbols-outlined" aria-hidden>{busy ? "hourglass_empty" : schedule.enabled ? "toggle_on" : "toggle_off"}</span>
                      {schedule.enabled ? "已启用" : "已停用"}
                    </button>
                  </div>
                </article>
              );
            })}
          </div> : null}
        </div>
      </div>
    </div>
  );
}
