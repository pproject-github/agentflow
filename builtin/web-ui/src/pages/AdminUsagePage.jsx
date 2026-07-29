import { useCallback, useEffect, useMemo, useState } from "react";
import AdminRunDetailDrawer from "../components/AdminRunDetailDrawer.jsx";

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

function formatRunId(value) {
  const text = String(value || "").trim();
  if (!text) return "-";
  return text.length > 18 ? text.slice(0, 8) + "..." + text.slice(-6) : text;
}

function statusText(status) {
  const s = String(status || "unknown");
  if (s === "success") return "成功";
  if (s === "failed") return "失败";
  if (s === "running") return "运行中";
  if (s === "stopped") return "已停止";
  if (s === "interrupted") return "中断";
  return "未知";
}

export default function AdminUsagePage({ authUser }) {
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedRun, setSelectedRun] = useState(null);

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
  const trendChart = useMemo(() => {
    const width = 980;
    const height = 250;
    const margin = { top: 20, right: 24, bottom: 42, left: 42 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const rows = trend.length > 0 ? trend : [];
    const maxRuns = Math.max(1, ...rows.map((row) => Number(row.runs || 0)));
    const maxLine = Math.max(1, ...rows.flatMap((row) => [Number(row.users || 0), Number(row.pipelines || 0)]));
    const x = (index) => margin.left + (rows.length <= 1 ? innerWidth / 2 : (index * innerWidth) / (rows.length - 1));
    const yRuns = (value) => margin.top + innerHeight - (Math.max(0, Number(value || 0)) / maxRuns) * innerHeight;
    const yLine = (value) => margin.top + innerHeight - (Math.max(0, Number(value || 0)) / maxLine) * innerHeight;
    const linePath = (key) => rows.map((row, index) => `${index === 0 ? "M" : "L"} ${x(index)} ${yLine(row[key])}`).join(" ");
    return {
      width,
      height,
      margin,
      innerHeight,
      rows,
      x,
      yRuns,
      yLine,
      lineUsers: linePath("users"),
      linePipelines: linePath("pipelines"),
      barWidth: Math.min(34, Math.max(12, (innerWidth / Math.max(1, rows.length)) * 0.44)),
    };
  }, [trend]);
  const rates = usage?.usage || {};
  const totals = usage?.totals || {};
  const recentRuns = Array.isArray(usage?.recentRuns) ? usage.recentRuns : [];

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
            <span>上方看趋势，下方看最近 50 次具体运行。</span>
          </div>
        </div>
        <div className="af-admin-usage-chart" role="img" aria-label="最近 14 天运行趋势">
          <div className="af-admin-usage-chart__legend">
            <span><i className="af-admin-usage-chart__swatch af-admin-usage-chart__swatch--runs" />Runs</span>
            <span><i className="af-admin-usage-chart__swatch af-admin-usage-chart__swatch--users" />活跃用户</span>
            <span><i className="af-admin-usage-chart__swatch af-admin-usage-chart__swatch--pipelines" />活跃流水线</span>
          </div>
          <div className="af-admin-usage-chart__canvas">
            <svg viewBox={`0 0 ${trendChart.width} ${trendChart.height}`} preserveAspectRatio="xMidYMid meet">
              <line
                className="af-admin-usage-chart__axis"
                x1={trendChart.margin.left}
                y1={trendChart.margin.top + trendChart.innerHeight}
                x2={trendChart.width - trendChart.margin.right}
                y2={trendChart.margin.top + trendChart.innerHeight}
              />
              {[0.25, 0.5, 0.75, 1].map((tick) => (
                <line
                  key={tick}
                  className="af-admin-usage-chart__grid"
                  x1={trendChart.margin.left}
                  y1={trendChart.margin.top + trendChart.innerHeight - trendChart.innerHeight * tick}
                  x2={trendChart.width - trendChart.margin.right}
                  y2={trendChart.margin.top + trendChart.innerHeight - trendChart.innerHeight * tick}
                />
              ))}
              {trendChart.rows.map((row, index) => {
                const x = trendChart.x(index);
                const y = trendChart.yRuns(row.runs);
                const baseline = trendChart.margin.top + trendChart.innerHeight;
                const barHeight = Math.max(2, baseline - y);
                return (
                  <g key={row.date}>
                    <rect
                      className="af-admin-usage-chart__run-bar"
                      x={x - trendChart.barWidth / 2}
                      y={baseline - barHeight}
                      width={trendChart.barWidth}
                      height={barHeight}
                      rx="5"
                    >
                      <title>{`${row.date}: ${row.runs} runs`}</title>
                    </rect>
                    <text className="af-admin-usage-chart__value" x={x} y={baseline + 22}>{compactNumber(row.runs)}</text>
                    <text className="af-admin-usage-chart__date" x={x} y={baseline + 42}>{formatDateLabel(row.date)}</text>
                  </g>
                );
              })}
              {trendChart.rows.length > 0 ? (
                <>
                  <path className="af-admin-usage-chart__line af-admin-usage-chart__line--users" d={trendChart.lineUsers} />
                  <path className="af-admin-usage-chart__line af-admin-usage-chart__line--pipelines" d={trendChart.linePipelines} />
                  {trendChart.rows.map((row, index) => {
                    const x = trendChart.x(index);
                    return (
                      <g key={`${row.date}-points`}>
                        <circle className="af-admin-usage-chart__point af-admin-usage-chart__point--users" cx={x} cy={trendChart.yLine(row.users)} r="3.5" />
                        <circle className="af-admin-usage-chart__point af-admin-usage-chart__point--pipelines" cx={x} cy={trendChart.yLine(row.pipelines)} r="3.5" />
                      </g>
                    );
                  })}
                </>
              ) : null}
            </svg>
          </div>
        </div>
        <div className="af-project-admin-usage__table-wrap">
          <table className="af-project-admin-usage__table af-admin-usage-table--recent">
            <thead>
              <tr>
                <th>用户</th>
                <th>流水线</th>
                <th>运行时间</th>
                <th>状态</th>
                <th>耗时</th>
                <th>Run ID</th>
              </tr>
            </thead>
            <tbody>
              {recentRuns.length === 0 ? (
                <tr><td colSpan={6}>暂无运行明细</td></tr>
              ) : recentRuns.map((run) => (
                <tr
                  key={`${run.userId}:${run.flowSource}:${run.flowId}:${run.runId}:${run.at}`}
                  className="af-admin-usage-run-row"
                  role="button"
                  tabIndex={0}
                  title="查看 Run 过程与 Thinking"
                  onClick={() => setSelectedRun(run)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedRun(run);
                    }
                  }}
                >
                  <td>
                    <strong>{run.username || run.userId || "-"}</strong>
                    <span>{run.userId || "-"}</span>
                  </td>
                  <td>
                    <strong>{run.flowId || "-"}</strong>
                    <span>{run.runType === "workspace" ? "Workspace Run" : "Pipeline"} · {run.flowSource || "user"}</span>
                  </td>
                  <td>
                    <strong>{formatTime(run.at)}</strong>
                    {run.endedAt ? <span>结束 {formatTime(run.endedAt)}</span> : <span>未结束</span>}
                  </td>
                  <td>
                    <span className="af-project-admin-usage__chips">
                      <em>{statusText(run.status)}</em>
                    </span>
                  </td>
                  <td>{formatDurationShort(run.durationMs)}</td>
                  <td>
                    <span className="af-admin-usage-run-link">
                      <code className="af-admin-usage-run-id" title={run.runId}>{formatRunId(run.runId)}</code>
                      <span className="material-symbols-outlined" aria-hidden>open_in_new</span>
                    </span>
                  </td>
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

      {selectedRun ? (
        <AdminRunDetailDrawer run={selectedRun} onClose={() => setSelectedRun(null)} />
      ) : null}
    </main>
  );
}
