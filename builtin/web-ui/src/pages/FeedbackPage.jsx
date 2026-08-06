import { useCallback, useEffect, useState } from "react";
import { useRoute } from "../routeContext.jsx";
import LoadingState from "../components/LoadingState.jsx";

function formatFeedbackTime(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "short",
      timeStyle: "medium",
    }).format(new Date(t));
  } catch {
    return String(iso);
  }
}

export default function FeedbackPage({ authUser }) {
  const { navigate } = useRoute();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(() => Boolean(authUser?.isAdmin));
  const [listError, setListError] = useState("");

  const isAdmin = Boolean(authUser?.isAdmin);

  const loadFeedback = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setListError("");
    try {
      const res = await fetch("/api/feedback");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "加载失败");
      setItems(Array.isArray(json.feedback) ? json.feedback : []);
    } catch (e) {
      setListError(String(e.message || e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadFeedback();
  }, [loadFeedback]);

  const submit = async (event) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          content,
          pageUrl: window.location.href,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "提交失败");
      setSubmitted(true);
      setTitle("");
      setContent("");
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  if (isAdmin) {
    return (
      <main className="af-feedback-page">
        <section className="af-feedback-panel af-feedback-panel--admin">
          <div className="af-feedback-head">
            <div>
              <span className="af-feedback-eyebrow">Feedback</span>
              <h1>意见反馈</h1>
              <p>查看用户提交的问题、建议和功能需求。</p>
            </div>
            <div className="af-feedback-admin-actions">
              <button type="button" className="af-feedback-back" onClick={() => void loadFeedback()} disabled={loading}>
                <span className="material-symbols-outlined" aria-hidden>{loading ? "hourglass_empty" : "refresh"}</span>
                {loading ? "刷新中..." : "刷新"}
              </button>
              <button type="button" className="af-feedback-back" onClick={() => navigate("/projects")}>
                <span className="material-symbols-outlined" aria-hidden>arrow_back</span>
                返回
              </button>
            </div>
          </div>

          {listError ? <p className="af-err af-feedback-error">{listError}</p> : null}
          <div className="af-feedback-list af-feedback-list--page">
            {loading ? <LoadingState title="正在读取反馈" detail="同步用户提交的问题与建议…" rows={3} /> : items.length > 0 ? items.map((item) => (
              <article key={item.id} className="af-feedback-item">
                <header className="af-feedback-item__head">
                  <div>
                    <h3>{item.title || "未命名反馈"}</h3>
                    <p>
                      <span>{item.username || item.userId || "unknown"}</span>
                      <span>{formatFeedbackTime(item.createdAt)}</span>
                    </p>
                  </div>
                  {item.contact ? <span className="af-feedback-item__contact">{item.contact}</span> : null}
                </header>
                <p className="af-feedback-item__content">{item.content}</p>
                {item.pageUrl ? <code className="af-feedback-item__url">{item.pageUrl}</code> : null}
              </article>
            )) : (
              <div className="af-feedback-empty">暂无反馈</div>
            )}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="af-feedback-page">
      <section className="af-feedback-panel">
        <div className="af-feedback-head">
          <div>
            <span className="af-feedback-eyebrow">Feedback</span>
            <h1>意见反馈</h1>
            <p>提交使用中遇到的问题、改进建议或功能需求，管理员会在这里统一查看。</p>
          </div>
          <button type="button" className="af-feedback-back" onClick={() => navigate("/projects")}>
            <span className="material-symbols-outlined" aria-hidden>arrow_back</span>
            返回
          </button>
        </div>

        {submitted ? (
          <div className="af-feedback-success" role="status">
            <span className="material-symbols-outlined" aria-hidden>check_circle</span>
            <div>
              <strong>已提交</strong>
              <span>感谢反馈，管理员可以在意见反馈页查看这条记录。</span>
            </div>
          </div>
        ) : null}

        <form className="af-feedback-form" onSubmit={submit}>
          <label className="af-feedback-field">
            <span>标题</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="一句话说明问题或建议"
              maxLength={120}
              required
            />
          </label>
          <label className="af-feedback-field">
            <span>反馈内容</span>
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="描述具体场景、期望表现、实际表现或复现步骤"
              maxLength={5000}
              rows={9}
              required
            />
          </label>
          {error ? <p className="af-err af-feedback-error">{error}</p> : null}
          <div className="af-feedback-actions">
            <button type="submit" className="af-feedback-submit" disabled={submitting || !title.trim() || !content.trim()}>
              <span className="material-symbols-outlined" aria-hidden>{submitting ? "hourglass_empty" : "send"}</span>
              {submitting ? "提交中..." : "提交反馈"}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
