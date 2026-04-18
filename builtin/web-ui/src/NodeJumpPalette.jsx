import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

function scoreEntry(entry, needle) {
  if (!needle) return 1;
  const q = needle.toLowerCase();
  const id = (entry.id || "").toLowerCase();
  const label = (entry.label || "").toLowerCase();
  const def = (entry.definitionId || "").toLowerCase();
  if (id === q) return 100;
  if (id.startsWith(q)) return 80;
  if (id.includes(q)) return 60;
  if (label.startsWith(q)) return 40;
  if (label.includes(q)) return 30;
  if (def.includes(q)) return 15;
  return 0;
}

/**
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   onJump: (id: string) => void,
 *   nodes: Array<{ id: string, data: { label?: string, definitionId?: string, schemaType?: string } }>,
 * }} props
 */
export function NodeJumpPalette({ open, onClose, onJump, nodes }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const listRef = useRef(/** @type {HTMLUListElement | null} */ (null));

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const entries = useMemo(() => {
    const list = (nodes || []).map((n) => ({
      id: n.id,
      label: n.data?.label || "",
      definitionId: n.data?.definitionId || "",
      schemaType: n.data?.schemaType || "",
    }));
    const q = query.trim();
    const scored = list
      .map((e) => ({ e, s: scoreEntry(e, q) }))
      .filter((x) => x.s > 0);
    scored.sort((a, b) => b.s - a.s || a.e.id.localeCompare(b.e.id));
    return scored.slice(0, 50).map((x) => x.e);
  }, [nodes, query]);

  useEffect(() => {
    if (active >= entries.length) setActive(0);
  }, [entries.length, active]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${active}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const commit = (idx) => {
    const e = entries[idx];
    if (!e) return;
    onJump(e.id);
    onClose();
  };

  const onKey = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      onClose();
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setActive((i) => Math.min(entries.length - 1, i + 1));
      return;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      commit(active);
    }
  };

  return (
    <div
      className="af-jump-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="af-jump-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("flow:jumpPalette.title")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="af-jump-panel__input-wrap">
          <span className="af-jump-panel__icon material-symbols-outlined" aria-hidden>
            search
          </span>
          <input
            ref={inputRef}
            type="text"
            className="af-jump-panel__input"
            placeholder={t("flow:jumpPalette.placeholder")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
            spellCheck={false}
            autoComplete="off"
          />
          <span className="af-jump-panel__count">{entries.length}</span>
        </div>
        {entries.length === 0 ? (
          <div className="af-jump-panel__empty">{t("flow:jumpPalette.empty")}</div>
        ) : (
          <ul ref={listRef} className="af-jump-panel__list" role="listbox">
            {entries.map((e, i) => (
              <li
                key={e.id}
                data-idx={i}
                role="option"
                aria-selected={i === active}
                className={
                  "af-jump-panel__item" +
                  (i === active ? " af-jump-panel__item--active" : "")
                }
                onMouseEnter={() => setActive(i)}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  commit(i);
                }}
              >
                <span className="af-jump-panel__id">{e.id}</span>
                {e.label && e.label !== e.id && (
                  <span className="af-jump-panel__label">{e.label}</span>
                )}
                {e.definitionId && (
                  <span className="af-jump-panel__tag">{e.definitionId}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="af-jump-panel__hint">
          <span><kbd className="af-kbd">↑</kbd><kbd className="af-kbd">↓</kbd> {t("flow:jumpPalette.hintNavigate")}</span>
          <span><kbd className="af-kbd">Enter</kbd> {t("flow:jumpPalette.hintJump")}</span>
          <span><kbd className="af-kbd">Esc</kbd> {t("flow:jumpPalette.hintClose")}</span>
        </div>
      </div>
    </div>
  );
}
