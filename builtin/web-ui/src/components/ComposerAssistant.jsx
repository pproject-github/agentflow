import { useEffect, useState } from "react";
import { MarkdownDisplayContent } from "../displayRenderers.jsx";

export function ComposerAssistantPending({ label = "AgentFlow AI 正在处理" }) {
  return (
    <div className="af-workflow-assistant-pending" role="status" aria-label={label}>
      <span />
      <span />
      <span />
      <em>{label}</em>
    </div>
  );
}

export function ComposerAssistantTurn({
  role = "assistant",
  content = "",
  pending = false,
  pendingLabel = "AgentFlow AI 正在处理",
  error = false,
  copy = true,
}) {
  const [copied, setCopied] = useState(false);
  const text = String(content || "").trim();

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    if (!text || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (role === "user") {
    return (
      <section className="af-workflow-assistant-message af-workflow-assistant-message--user">
        <div className="af-workflow-assistant-message__meta">你</div>
        <div className="af-workflow-assistant-message__bubble">
          <MarkdownDisplayContent content={text} />
        </div>
      </section>
    );
  }

  return (
    <section className={`af-workflow-assistant-message af-workflow-assistant-message--assistant${error ? " af-workflow-assistant-message--error" : ""}`}>
      <div className="af-workflow-assistant-message__identity">
        <span className="material-symbols-outlined" aria-hidden>{error ? "error" : "auto_awesome"}</span>
        <strong>{error ? "执行遇到问题" : "AgentFlow AI"}</strong>
      </div>
      <div className="af-workflow-assistant-message__bubble">
        {text ? <MarkdownDisplayContent content={text} /> : null}
        {pending ? <ComposerAssistantPending label={pendingLabel} /> : null}
      </div>
      {copy && text && !error ? (
        <div className="af-workflow-assistant-actions">
          <button
            type="button"
            className="af-workflow-assistant-copy"
            data-copied={copied ? "true" : "false"}
            onClick={() => void handleCopy()}
            aria-label="复制回答"
          >
            <span className="material-symbols-outlined af-workflow-assistant-copy__idle" aria-hidden>content_copy</span>
            <span className="material-symbols-outlined af-workflow-assistant-copy__done" aria-hidden>check</span>
            <span className="af-workflow-assistant-copy__label">复制</span>
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function ComposerAssistantActivity({
  items = [],
  running = false,
  label = "执行过程",
  defaultOpen = false,
}) {
  const rows = (Array.isArray(items) ? items : [])
    .map((item, index) => ({
      id: String(item?.id || `${item?.kind || "activity"}-${index}`),
      kind: String(item?.kind || "activity"),
      label: String(item?.label || item?.kind || "Activity"),
      text: String(item?.text || item?.content || "").trim(),
    }))
    .filter((item) => item.text);

  if (!rows.length && !running) return null;
  return (
    <details className={`af-composer-assistant-activity${running ? " af-composer-assistant-activity--running" : ""}`} defaultOpen={defaultOpen}>
      <summary>
        <span className="af-composer-assistant-activity__pulse" aria-hidden />
        <strong>{label}</strong>
        <span>{running ? "进行中" : `已完成 ${rows.length} 项`}</span>
        <span className="material-symbols-outlined af-composer-assistant-activity__chevron" aria-hidden>expand_more</span>
      </summary>
      <div className="af-composer-assistant-activity__body">
        {rows.map((item) => (
          <article key={item.id} className={`af-composer-assistant-activity__item af-composer-assistant-activity__item--${item.kind}`}>
            <small>{item.label}</small>
            <pre>{item.text}</pre>
          </article>
        ))}
        {running && !rows.length ? (
          <p className="af-composer-assistant-activity__status">正在分析当前画布并生成执行步骤…</p>
        ) : null}
      </div>
    </details>
  );
}

export function ComposerAssistantInput({
  value = "",
  onChange,
  onSend,
  placeholder = "继续描述你想让 AI 调整什么…",
  disabled = false,
  busy = false,
}) {
  const canSend = !disabled && !busy && Boolean(String(value || "").trim());
  const handleKeyDown = (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent?.isComposing) return;
    event.preventDefault();
    if (canSend) onSend?.();
  };

  return (
    <div className="af-composer-sidebar-input af-composer-sidebar-input--assistant">
      <div className="af-workflow-assistant-composer">
        <textarea
          className="af-workflow-assistant-composer__input"
          value={value}
          rows={1}
          onChange={(event) => onChange?.(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || busy}
          aria-label="输入 AI Composer 要求"
        />
        <div className="af-workflow-assistant-composer__bottom">
          <small>{busy ? "AI 正在执行当前任务" : "Enter 发送 · Shift + Enter 换行"}</small>
          <button
            type="button"
            className="af-workflow-assistant-composer__send"
            disabled={!canSend}
            onClick={() => onSend?.()}
            aria-label="发送 AI Composer 对话"
          >
            <span className="material-symbols-outlined" aria-hidden>{busy ? "more_horiz" : "arrow_upward"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
