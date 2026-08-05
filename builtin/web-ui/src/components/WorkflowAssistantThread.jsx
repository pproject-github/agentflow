import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  useMessagePartText,
} from "@assistant-ui/react";
import { useCallback } from "react";
import { MarkdownDisplayContent } from "../displayRenderers.jsx";

function convertWorkflowMessage(message, index) {
  const createdAt = message?.createdAt ? new Date(message.createdAt) : undefined;
  return {
    id: String(message?.id || `workflow-message-${index}-${message?.role || "assistant"}`),
    role: message?.role === "user" ? "user" : "assistant",
    content: [{ type: "text", text: String(message?.content || "") }],
    ...(createdAt && !Number.isNaN(createdAt.getTime()) ? { createdAt } : {}),
  };
}

function WorkflowAssistantMarkdownPart() {
  const { text } = useMessagePartText();
  return <MarkdownDisplayContent content={text} />;
}

function WorkflowAssistantPending() {
  return (
    <div className="af-workflow-assistant-pending" role="status" aria-label="正在分析">
      <span />
      <span />
      <span />
      <em>正在结合需求与代码分析</em>
    </div>
  );
}

function WorkflowAssistantUserMessage() {
  return (
    <MessagePrimitive.Root className="af-workflow-assistant-message af-workflow-assistant-message--user">
      <div className="af-workflow-assistant-message__meta">你</div>
      <div className="af-workflow-assistant-message__bubble">
        <MessagePrimitive.Parts components={{ Text: WorkflowAssistantMarkdownPart }} />
      </div>
    </MessagePrimitive.Root>
  );
}

function WorkflowAssistantReply() {
  return (
    <MessagePrimitive.Root className="af-workflow-assistant-message af-workflow-assistant-message--assistant">
      <div className="af-workflow-assistant-message__identity">
        <span className="material-symbols-outlined" aria-hidden>auto_awesome</span>
        <strong>AgentFlow AI</strong>
      </div>
      <div className="af-workflow-assistant-message__bubble">
        <MessagePrimitive.Parts
          components={{
            Text: WorkflowAssistantMarkdownPart,
            Empty: WorkflowAssistantPending,
          }}
        />
      </div>
      <ActionBarPrimitive.Root className="af-workflow-assistant-actions" hideWhenRunning>
        <ActionBarPrimitive.Copy className="af-workflow-assistant-copy" copiedDuration={1600} aria-label="复制回答">
          <span className="material-symbols-outlined af-workflow-assistant-copy__idle" aria-hidden>content_copy</span>
          <span className="material-symbols-outlined af-workflow-assistant-copy__done" aria-hidden>check</span>
          <span className="af-workflow-assistant-copy__label">复制</span>
        </ActionBarPrimitive.Copy>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function WorkflowAssistantComposer() {
  return (
    <ThreadPrimitive.ViewportFooter className="af-workflow-assistant-footer">
      <ComposerPrimitive.Root className="af-workflow-assistant-composer">
        <ComposerPrimitive.Input
          className="af-workflow-assistant-composer__input"
          rows={1}
          placeholder="询问需求状态、代码实现、调用链或风险…"
          aria-label="输入 Workflow 问题"
        />
        <div className="af-workflow-assistant-composer__bottom">
          <small>Enter 发送 · Shift + Enter 换行</small>
          <ComposerPrimitive.Send className="af-workflow-assistant-composer__send" aria-label="发送 Workflow 问题">
            <span className="material-symbols-outlined" aria-hidden>arrow_upward</span>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.ViewportFooter>
  );
}

export default function WorkflowAssistantThread({
  messages = [],
  running = false,
  error = "",
  sources = [],
  suggestions = [],
  onSend,
}) {
  const handleNew = useCallback(async (message) => {
    const text = (Array.isArray(message?.content) ? message.content : [])
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) await onSend?.(text);
  }, [onSend]);
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: convertWorkflowMessage,
    isRunning: running,
    isSendDisabled: running,
    onNew: handleNew,
    unstable_capabilities: { copy: true },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="af-workflow-assistant-thread">
        <ThreadPrimitive.Viewport className="af-workflow-assistant-viewport" autoScroll turnAnchor="bottom">
          {!messages.length ? (
            <section className="af-workflow-assistant-welcome">
              <div className="af-workflow-assistant-welcome__icon">
                <span className="material-symbols-outlined" aria-hidden>forum</span>
              </div>
              <strong>从这个需求开始提问</strong>
              <p>AI 会先读取 Workflow 上下文，再结合 Owner 绑定的代码快照回答。</p>
              <div className="af-workflow-assistant-suggestions">
                {suggestions.map((question) => (
                  <button key={question} type="button" disabled={running} onClick={() => void onSend?.(question)}>
                    <span>{question}</span>
                    <span className="material-symbols-outlined" aria-hidden>arrow_outward</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          <ThreadPrimitive.Messages>
            {({ message }) => message.role === "user"
              ? <WorkflowAssistantUserMessage />
              : <WorkflowAssistantReply />}
          </ThreadPrimitive.Messages>
          {sources.length ? (
            <details className="af-workflow-assistant-sources">
              <summary>
                <span className="material-symbols-outlined" aria-hidden>source</span>
                本次引用的代码版本
                <em>{sources.length}</em>
              </summary>
              <div className="af-workflow-assistant-sources__list">
                {sources.map((source) => (
                  <div key={source.workspaceId}>
                    <span>
                      <strong>{source.label}</strong>
                      <small>{source.available ? (source.selectedRef || "已解析") : "不可用"}</small>
                    </span>
                    <code>{source.available ? (source.commit?.slice(0, 12) || source.selectedRef) : source.reason}</code>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
          {error ? (
            <div className="af-workflow-assistant-error" role="alert">
              <span className="material-symbols-outlined" aria-hidden>error</span>
              <span>{error}</span>
            </div>
          ) : null}
          <WorkflowAssistantComposer />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
