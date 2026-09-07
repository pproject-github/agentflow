import { useCallback, useEffect, useState } from "react";
import { useRoute } from "../routeContext.jsx";
import LoadingState from "../components/LoadingState.jsx";

function formatTime(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? new Date(time).toLocaleString("zh-CN") : "-";
}

function approvalTitle(item) {
  if (item?.value?.title) return String(item.value.title);
  const reason = String(item?.reason || "").trim();
  const labels = {
    report_publication: "报告发布审批",
    plan_confirmation: "Plan 确认",
    release: "发布审批",
  };
  return labels[reason] || reason || "流程审批";
}

export default function ApprovalsPage() {
  const { navigate } = useRoute();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [submittingId, setSubmittingId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/workspace/my-approvals");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "读取我的审批失败");
      setItems(Array.isArray(payload.approvals) ? payload.approvals : []);
    } catch (cause) {
      setError(String(cause?.message || cause));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const decide = useCallback(async (item, approved) => {
    const key = String(item.interruptId || item.runId || "");
    if (!key || submittingId) return;
    setSubmittingId(key);
    setError("");
    try {
      const response = await fetch(`/api/v1/flows/${encodeURIComponent(item.flowId || "")}/runs/${encodeURIComponent(item.runId || "")}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          interruptId: item.interruptId || "",
          input: {
            approved: Boolean(approved),
            decision: approved ? "approve" : "reject",
          },
          idempotencyKey: `approval-${item.interruptId || item.runId}-${approved ? "approve" : "reject"}`,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "提交审批失败");
      setItems((current) => current.filter((entry) => entry !== item));
    } catch (cause) {
      setError(String(cause?.message || cause));
    } finally {
      setSubmittingId("");
    }
  }, [submittingId]);

  return (
    <main className="af-approvals-page">
      <section className="af-approvals-panel">
        <header className="af-approvals-head">
          <div>
            <span className="af-approvals-eyebrow">Inbox</span>
            <h1>我的审批</h1>
            <p>查看审批内容，并直接处理分配给你的流程中断。</p>
          </div>
          <button type="button" className="af-approvals-refresh" onClick={() => void load()} disabled={loading}>
            <span className="material-symbols-outlined" aria-hidden>{loading ? "hourglass_empty" : "refresh"}</span>
            {loading ? "刷新中..." : "刷新"}
          </button>
        </header>

        {error ? <p className="af-approvals-error">{error}</p> : null}
        {loading ? <LoadingState title="正在读取我的审批" detail="同步待确认的流程中断..." rows={3} /> : null}
        {!loading && !error && items.length === 0 ? (
          <div className="af-approvals-empty">
            <span className="material-symbols-outlined" aria-hidden>task_alt</span>
            <strong>暂无待审批</strong>
            <span>当流程把你设置为审批人后，待办会显示在这里。</span>
          </div>
        ) : null}
        {!loading && items.length > 0 ? (
          <div className="af-approvals-list">
            {items.map((item) => (
              <article className="af-approval-card" key={item.interruptId || item.runId}>
                <div className="af-approval-card__main">
                  <div className="af-approval-card__title-row">
                    <h2>{approvalTitle(item)}</h2>
                    <span className="af-approval-status">待审批</span>
                  </div>
                  <p className="af-approval-card__meta">
                    <span>{item.flowId || "未命名流程"}</span>
                    <span>发起人：{item.requestedBy || "-"}</span>
                    <span>{formatTime(item.createdAt)}</span>
                  </p>
                  <p className="af-approval-card__preview">{String(item.value?.content || "").slice(0, 180) || "等待人工确认"}</p>
                </div>
                <div className="af-approval-card__actions">
                  <button
                    type="button"
                    className="af-approval-open"
                    onClick={() => navigate(`/workspace?flowId=${encodeURIComponent(item.flowId || "")}`)}
                  >
                    打开流程
                  </button>
                  <button
                    type="button"
                    className="af-approval-approve"
                    disabled={Boolean(submittingId)}
                    onClick={() => void decide(item, true)}
                  >
                    {submittingId === (item.interruptId || item.runId) ? "提交中..." : "同意"}
                  </button>
                  <button
                    type="button"
                    className="af-approval-reject"
                    disabled={Boolean(submittingId)}
                    onClick={() => void decide(item, false)}
                  >
                    驳回
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}
