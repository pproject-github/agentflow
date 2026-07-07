import { useCallback, useEffect, useMemo, useState } from "react";

function compactNumber(value) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.max(0, Number(value || 0)));
}

function formatPercent(value) {
  return `${Math.round(Math.max(0, Math.min(1, Number(value || 0))) * 100)}%`;
}

function formatDurationShort(ms) {
  const value = Math.max(0, Number(ms || 0));
  if (!value) return "-";
  const sec = Math.round(value / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hour = Math.round(min / 60);
  if (hour < 48) return `${hour}h`;
  return `${Math.round(hour / 24)}d`;
}

function formatDateLabel(date) {
  const text = String(date || "");
  return text.includes("-") ? text.slice(5) : text;
}

function formatTime(value) {
  if (!value) return "无运行记录";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(Number(value)));
  } catch {
    return String(value);
  }
}

export default function AdminUsagePage({ authUser }) {
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadUsage = useCallback(async () => {
    if (!authUser?.isAdmin) return;
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/admin/usage-dashboard");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "HTTP " + r.status);
      setUsage(j);
    } catch (e) {
      setUsage(null);
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [authUser?.isAdmin]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const trend = Array.isArray(usage?.dailyTrend) ? usage.dailyTrend : [];
  const maxDailyRuns = useMemo(() => Math.max(1, ...trend.map((row) => Number(row.runs || 0))), [trend]);
  const rates = usage?.usage || {};
  const totals = usage?.totals || {};

  if (!authUser?.isAdmin) {
    return (
      <main className="af-admin-usage-page">
        <section className="af-project-admin-usage">
          <div className="af-project-admin-usage__head">
            <div>
              <strong>管理看板</strong>
              <span>需要管理员权限。</span>
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="af-admin-usage-page">
      <section className="af-admin-usage-hero">
        <div>
          <p className="af-admin-usage-eyebrow">Admin / Usage</p>
          <h1>管理看板</h1>
          <p>重点观察使用率、每日趋势、成功率与各用户流水线活跃度。</p>
        </div>
        <button type="button" onClick={() => void loadUsage()} disabled={loading}>
          <span className="material-symbols-outlined" aria-hidden>refresh</span>
          {loading ? "刷新中" : "刷新"}
        </button>
      </section>

      {error ? <div className="af-project-admin-usage__error">{error}</div> : null}

      <section className="af-admin-usage-rate-grid" aria-label="使用率">
        <div>
          <span>7日活跃用户率</span>
          <strong>{formatPercent(rates.activeUserRate)}</strong>
          <em>{compactNumber(rates.activeUsers)} / {compactNumber(totals.users)} users</em>
        </div>
        <div>
          <span>7日流水线使用率</span>
          <strong>{formatPercent(rates.activePipelineRate)}</strong>
          <em>{compactNumber(rates.activePipelines)} / {compactNumber(totals.activePipelines)} active</em>
        </div>
        <div>
          <span>7日 Run</span>
          <strong>{compactNumber(rates.runs)}</strong>
          <em>{compactNumber(rates.avgRunsPerDay)} / day</em>
        </div>
        <div>
          <span>7日成功率</span>
          <strong>{formatPercent(rates.successRate)}</strong>
          <em>失败率 {formatPercent(rates.failureRate)} · avg {formatDurationShort(rates.avgDurationMs)}</em>
        </div>
      </section>

      <section className="af-project-admin-usage af-admin-usage-trend">
        <div className="af-project-admin-usage__head">
          <div>
            <strong>每日趋势</strong>
            <span>最近 14 天 Run 数、活跃用户和活跃流水线。</span>
          </div>
        </div>
        <div className="af-admin-usage-chart">
          {trend.map((row) => {
            const height = Math.max(4, Math.round((Number(row.runs || 0) / maxDailyRuns) * 100));
            return (
              <div className="af-admin-usage-chart__day" key={row.date}>
                <div className="af-admin-usage-chart__bar-wrap" title={`${row.date}: ${row.runs} runs`}>
                  <span className="af-admin-usage-chart__bar" style={{ height: `${height}%` }} />
                </div>
                <strong>{compactNumber(row.runs)}</strong>
                <span>{formatDateLabel(row.date)}</span>
              </div>
            );
          })}
        </div>
        <div className="af-project-admin-usage__table-wrap">
          <table className="af-project-admin-usage__table af-admin-usage-table--trend">
            <thead>
              <tr>
                <th>日期</th>
                <th>Runs</th>
                <th>活跃用户</th>
                <th>活跃流水线</th>
                <th>成功 / 失败</th>
                <th>平均耗时</th>
              </tr>
            </thead>
            <tbody>
              {trend.length === 0 ? (
                <tr><td colSpan={6}>暂无趋势数据</td></tr>
              ) : trend.map((row) => (
                <tr key={row.date}>
                  <td><strong>{row.date}</strong></td>
                  <td><strong>{compactNumber(row.runs)}</strong></td>
                  <td>{compactNumber(row.users)}</td>
                  <td>{compactNumber(row.pipelines)}</td>
                  <td>
                    <span className="af-project-admin-usage__chips">
                      <em>成功 {compactNumber(row.success)}</em>
                      <em>失败 {compactNumber((row.failed || 0) + (row.stopped || 0) + (row.interrupted || 0) + (row.unknown || 0))}</em>
                      <em>运行中 {compactNumber(row.running)}</em>
                    </span>
                  </td>
                  <td>{formatDurationShort(row.avgDurationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="af-project-admin-usage">
        <div className="af-project-admin-usage__head">
          <div>
            <strong>用户使用明细</strong>
            <span>按用户汇总 Pipeline 数、Run 次数和最近运行。</span>
          </div>
        </div>
        <div className="af-project-admin-usage__table-wrap">
          <table className="af-project-admin-usage__table">
            <thead>
              <tr>
                <th>User</th>
                <th>Pipeline</th>
                <th>Runs</th>
                <th>状态</th>
                <th>最近运行</th>
              </tr>
            </thead>
            <tbody>
              {loading && !usage ? (
                <tr><td colSpan={5}>正在加载...</td></tr>
              ) : (usage?.users || []).length === 0 ? (
                <tr><td colSpan={5}>暂无用户数据</td></tr>
              ) : (
                (usage?.users || []).map((row) => (
                  <tr key={row.userId}>
                    <td>
                      <strong>{row.username || row.userId}</strong>
                      <span>{row.userId}{row.isAdmin ? " · admin" : ""}</span>
                    </td>
                    <td>
                      <strong>{compactNumber(row.pipelines?.total)}</strong>
                      <span>{compactNumber(row.pipelines?.active)} active / {compactNumber(row.pipelines?.archived)} archived</span>
                    </td>
                    <td>
                      <strong>{compactNumber(row.runs?.total)}</strong>
                      <span>avg {formatDurationShort(row.runs?.avgDurationMs)}</span>
                    </td>
                    <td>
                      <span className="af-project-admin-usage__chips">
                        <em>成功 {compactNumber(row.runs?.success)}</em>
                        <em>失败 {compactNumber(row.runs?.failed)}</em>
                        <em>运行中 {compactNumber(row.runs?.running)}</em>
                      </span>
                    </td>
                    <td>
                      {row.runs?.lastRunAt ? (
                        <>
                          <strong>{row.runs?.lastRunFlowId || "-"}</strong>
                          <span>{row.runs?.lastRunStatus || "unknown"} · {formatTime(row.runs.lastRunAt)}</span>
                        </>
                      ) : (
                        <span>无运行记录</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
