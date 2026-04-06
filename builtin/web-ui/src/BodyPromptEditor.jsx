import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  buildPlaceholderMenuItems,
  filterPlaceholderMenuItems,
  getBodyHighlightSegments,
  parseOpenPlaceholderContext,
  segmentsToBackdropHtml,
  validateBodyPlaceholders,
} from "./bodyPlaceholders.js";
import { getCaretViewportRect } from "./textareaCaret.js";

/**
 * @param {{
 *   value: string,
 *   onChange: (next: string) => void,
 *   disabled?: boolean,
 *   placeholder?: string,
 *   rows?: number,
 *   textareaClassName: string,
 *   ioSlots: { inputs?: { name?: string, type?: string }[], outputs?: { name?: string, type?: string }[] },
 *   variant?: "drawer" | "expand",
 * }} props
 */
export function BodyPromptEditor({
  value,
  onChange,
  disabled,
  placeholder,
  rows = 8,
  textareaClassName,
  ioSlots,
  variant = "drawer",
}) {
  const issuesId = useId();
  const taRef = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  const backdropRef = useRef(/** @type {HTMLPreElement | null} */ (null));
  const [cursor, setCursor] = useState(0);
  const [menuHighlight, setMenuHighlight] = useState(0);
  const [menuPop, setMenuPop] = useState(/** @type {{ top: number, left: number } | null} */ (null));

  const invalidRanges = useMemo(() => validateBodyPlaceholders(value, ioSlots), [value, ioSlots]);
  const hasInvalid = invalidRanges.length > 0;

  const segments = useMemo(() => getBodyHighlightSegments(value, ioSlots), [value, ioSlots]);
  const backdropHtml = useMemo(() => segmentsToBackdropHtml(segments), [segments]);

  const openCtx = useMemo(
    () => (disabled ? null : parseOpenPlaceholderContext(value, cursor)),
    [value, cursor, disabled],
  );

  const menuItems = useMemo(() => {
    if (!openCtx) return [];
    const all = buildPlaceholderMenuItems(ioSlots);
    return filterPlaceholderMenuItems(all, openCtx.query);
  }, [openCtx, ioSlots]);

  useEffect(() => {
    setMenuHighlight((h) => {
      const max = Math.max(0, menuItems.length - 1);
      return Math.min(Math.max(0, h), max);
    });
  }, [menuItems.length]);

  const updateMenuPopPosition = useCallback(() => {
    const ta = taRef.current;
    if (!ta || !openCtx || menuItems.length === 0) {
      setMenuPop(null);
      return;
    }
    const caret = getCaretViewportRect(ta, cursor);
    if (!caret) {
      setMenuPop(null);
      return;
    }
    const pad = 4;
    const estRow = 44;
    const maxH = 13.5 * 16;
    const estH = Math.min(menuItems.length * estRow + 8, maxH);
    let top = caret.bottom + pad;
    if (top + estH > window.innerHeight - 8) {
      top = Math.max(8, caret.top - estH - pad);
    }
    const menuW = 288;
    let left = caret.left;
    left = Math.max(8, Math.min(left, window.innerWidth - menuW - 8));
    setMenuPop({ top, left });
  }, [openCtx, menuItems.length, cursor]);

  useLayoutEffect(() => {
    if (!openCtx || menuItems.length === 0) {
      setMenuPop(null);
      return;
    }
    const id = requestAnimationFrame(() => updateMenuPopPosition());
    return () => cancelAnimationFrame(id);
  }, [openCtx, menuItems.length, cursor, value, updateMenuPopPosition]);

  useEffect(() => {
    if (!openCtx || menuItems.length === 0) return;
    const onWin = () => updateMenuPopPosition();
    window.addEventListener("scroll", onWin, true);
    window.addEventListener("resize", onWin);
    return () => {
      window.removeEventListener("scroll", onWin, true);
      window.removeEventListener("resize", onWin);
    };
  }, [openCtx, menuItems.length, updateMenuPopPosition]);

  const insertPick = useCallback(
    (insert) => {
      if (!openCtx) return;
      const { atIndex } = openCtx;
      const next = value.slice(0, atIndex) + "${" + insert + "}" + value.slice(cursor);
      onChange(next);
      const newPos = atIndex + insert.length + 3;
      queueMicrotask(() => {
        const el = taRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(newPos, newPos);
        }
        setCursor(newPos);
      });
    },
    [openCtx, value, cursor, onChange],
  );

  const syncScroll = useCallback(() => {
    const ta = taRef.current;
    const bd = backdropRef.current;
    if (!ta || !bd) return;
    bd.scrollTop = ta.scrollTop;
    bd.scrollLeft = ta.scrollLeft;
    if (openCtx && menuItems.length > 0) {
      queueMicrotask(() => updateMenuPopPosition());
    }
  }, [openCtx, menuItems.length, updateMenuPopPosition]);

  const onKeyDown = useCallback(
    (e) => {
      if (disabled) return;
      if (openCtx && menuItems.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMenuHighlight((h) => (h + 1) % menuItems.length);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setMenuHighlight((h) => (h - 1 + menuItems.length) % menuItems.length);
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const pick = menuItems[menuHighlight];
          if (pick) insertPick(pick.insert);
        }
      }
    },
    [disabled, openCtx, menuItems, menuHighlight, insertPick],
  );

  return (
    <div className={"af-body-prompt-editor" + (variant === "expand" ? " af-body-prompt-editor--expand" : "")}>
      <div className="af-body-prompt-stack">
        <pre
          ref={backdropRef}
          className={"af-body-prompt-backdrop " + textareaClassName}
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: backdropHtml + "\n" }}
        />
        <textarea
          ref={taRef}
          className={"af-body-prompt-textarea " + textareaClassName}
          rows={rows}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          aria-invalid={hasInvalid}
          aria-describedby={hasInvalid ? issuesId : undefined}
          onChange={(e) => {
            onChange(e.target.value);
            setCursor(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => {
            const t = e.target;
            if (t instanceof HTMLTextAreaElement) setCursor(t.selectionStart ?? 0);
          }}
          onClick={(e) => {
            const t = e.target;
            if (t instanceof HTMLTextAreaElement) setCursor(t.selectionStart ?? 0);
          }}
          onKeyUp={(e) => {
            const t = e.target;
            if (t instanceof HTMLTextAreaElement) setCursor(t.selectionStart ?? t.value.length);
          }}
          onKeyDown={onKeyDown}
          onScroll={syncScroll}
        />
      </div>
      {openCtx && menuItems.length > 0 && menuPop
        ? createPortal(
            <ul
              className="af-body-ph-menu af-body-ph-menu--pop af-composer-mention-menu"
              role="listbox"
              aria-label="占位符：输入输出槽位"
              style={{
                position: "fixed",
                top: menuPop.top,
                left: menuPop.left,
                right: "auto",
                bottom: "auto",
                margin: 0,
                zIndex: 20000,
              }}
            >
              {menuItems.map((it, i) => (
                <li key={`${it.section}-${it.insert}`} role="option" aria-selected={i === menuHighlight}>
                  <button
                    type="button"
                    className={
                      "af-composer-mention-item" + (i === menuHighlight ? " af-composer-mention-item--active" : "")
                    }
                    onMouseDown={(ev) => ev.preventDefault()}
                    onMouseEnter={() => setMenuHighlight(i)}
                    onClick={() => insertPick(it.insert)}
                  >
                    <span className="af-composer-mention-id">{`\${${it.insert}}`}</span>
                    {it.subtitle ? <span className="af-composer-mention-sub">{it.subtitle}</span> : null}
                  </button>
                </li>
              ))}
            </ul>,
            document.body,
          )
        : null}
      {hasInvalid ? (
        <p id={issuesId} className="af-body-ph-issues" role="status">
          {invalidRanges.map((r) => r.message).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}
