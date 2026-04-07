import ReactMarkdown from "react-markdown";
import { useTranslation } from "react-i18next";

/**
 * Rich display for node-exec-context API payloads (markdown / JSON / images).
 * Backward compatible with legacy `{ slot, content }` only.
 */

function inferLegacyKind(o) {
  if (o.displayKind === "image" || (o.encoding === "base64" && o.mimeType?.startsWith("image/"))) {
    return "image";
  }
  if (o.displayKind === "json" || o.mimeType === "application/json") return "json";
  if (o.displayKind === "markdown" || o.mimeType === "text/markdown") return "markdown";
  if (o.displayKind === "text") return "text";

  const c = (o.content || "").trim();
  if (c && (c.startsWith("{") || c.startsWith("["))) {
    try {
      JSON.parse(c);
      return "json";
    } catch {
      /* fall through */
    }
  }
  return "text";
}

function formatPill(o) {
  const kind = inferLegacyKind(o);
  if (kind === "image") {
    const sub = (o.mimeType || "image/png").split("/")[1];
    return sub ? sub.toUpperCase() : "IMAGE";
  }
  if (kind === "json") return "JSON";
  if (kind === "markdown") return "MD";
  return null;
}

function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text.trim()), null, 2);
  } catch {
    return text;
  }
}

export function RunContextPromptBody({ text }) {
  const { t } = useTranslation();
  const body = text || "";
  if (!body.trim()) {
    return <div className="af-run-ctx-hint">{t("flow:runContext.empty")}</div>;
  }
  return (
    <div className="af-run-ctx-md">
      <ReactMarkdown>{body}</ReactMarkdown>
    </div>
  );
}

export function RunContextOutputBody({ o }) {
  const { t } = useTranslation();
  const kind = inferLegacyKind(o);

  if (kind === "image" || (o.encoding === "base64" && o.mimeType?.startsWith("image/"))) {
    const mime = o.mimeType || "image/png";
    const src = `data:${mime};base64,${o.content || ""}`;
    return (
      <div className="af-run-ctx-media">
        <img className="af-run-ctx-img" src={src} alt={o.slot || "output"} loading="lazy" />
        {o.truncated ? <div className="af-run-ctx-hint">{t("flow:runContext.imageTruncated")}</div> : null}
      </div>
    );
  }

  if (kind === "json") {
    return <pre className="af-run-ctx-pre">{prettyJson(o.content || "")}</pre>;
  }

  if (kind === "markdown") {
    const body = o.content || "";
    if (!body.trim()) {
      return <div className="af-run-ctx-hint">{t("flow:runContext.empty")}</div>;
    }
    return (
      <div className="af-run-ctx-md">
        <ReactMarkdown>{body}</ReactMarkdown>
      </div>
    );
  }

  return <pre className="af-run-ctx-pre">{o.content != null && o.content !== "" ? o.content : t("flow:runContext.empty")}</pre>;
}

export function runContextOutputFormatPill(o) {
  return formatPill(o);
}

