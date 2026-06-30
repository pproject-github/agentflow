import { useState } from "react";
import { useRoute } from "../routeContext.jsx";

export default function FeedbackPage() {
  const { navigate } = useRoute();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);

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

  return (
    <main className="af-feedback-page">
      <section className="af-feedback-panel">
        <div className="af-feedback-head">
          <div>
            <span className="af-feedback-eyebrow">Feedback</span>
            <h1>意见反馈</h1>
            <p>提交使用中遇到的问题、改进建议或功能需求，管理员会在设置页统一查看。</p>
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
              <span>感谢反馈，管理员可以在设置页查看这条记录。</span>
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
