import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { isMacPlatform } from "./hotkeyUtils.js";

function Kbd({ children }) {
  return <kbd className="af-kbd">{children}</kbd>;
}

function KeyCombo({ keys }) {
  return (
    <span className="af-shortcuts-keys">
      {keys.map((k, i) => (
        <span key={i}>
          {i > 0 ? <span className="af-shortcuts-keys__plus">+</span> : null}
          <Kbd>{k}</Kbd>
        </span>
      ))}
    </span>
  );
}

/**
 * @param {{ open: boolean, onClose: () => void }} props
 */
export function KeyboardShortcutsModal({ open, onClose }) {
  const { t } = useTranslation();
  const panelRef = useRef(/** @type {HTMLDivElement | null} */ (null));

  useEffect(() => {
    if (!open) return;
    const t = requestAnimationFrame(() => panelRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, [open]);

  if (!open) return null;

  const mac = isMacPlatform();
  const mod = mac ? "⌘" : "Ctrl";

  return (
    <div
      className="af-shortcuts-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="af-shortcuts-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="af-shortcuts-title"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="af-shortcuts-panel__head">
          <h2 id="af-shortcuts-title" className="af-shortcuts-panel__title">
            {t("flow:shortcuts.title")}
          </h2>
          <button type="button" className="af-shortcuts-panel__close af-icon-btn" onClick={onClose} aria-label={t("common:common.close")}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="af-shortcuts-panel__body">
          <section className="af-shortcuts-section">
            <h3 className="af-shortcuts-cat">{t("flow:shortcuts.general")}</h3>
            <ul className="af-shortcuts-list">
              <li className="af-shortcuts-row">
                <span className="af-shortcuts-row__label">
                  {t("flow:shortcuts.saveDesc")}
                </span>
                <KeyCombo keys={[mod, "S"]} />
              </li>
              <li className="af-shortcuts-row">
                <span className="af-shortcuts-row__label">{t("flow:shortcuts.shortcutsLabel")}</span>
                <KeyCombo keys={["?"]} />
              </li>
              <li className="af-shortcuts-row">
                <span className="af-shortcuts-row__label">{t("flow:shortcuts.jumpToNode")}</span>
                <KeyCombo keys={[mod, "K"]} />
              </li>
            </ul>
          </section>

          <section className="af-shortcuts-section">
            <h3 className="af-shortcuts-cat">{t("flow:shortcuts.canvas")}</h3>
            <ul className="af-shortcuts-list">
              <li className="af-shortcuts-row">
                <span className="af-shortcuts-row__label">{t("flow:shortcuts.selectTool")}</span>
                <KeyCombo keys={["V"]} />
              </li>
              <li className="af-shortcuts-row">
                <span className="af-shortcuts-row__label">{t("flow:shortcuts.panTool")}</span>
                <KeyCombo keys={["H"]} />
              </li>
              <li className="af-shortcuts-row">
                <span className="af-shortcuts-row__label">{t("flow:shortcuts.holdSpacePan")}</span>
                <KeyCombo keys={["Space"]} />
              </li>
              <li className="af-shortcuts-row">
                <span className="af-shortcuts-row__label">{t("flow:shortcuts.selectAll")}</span>
                <KeyCombo keys={[mod, "A"]} />
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
