import { useEffect, useRef } from "react";
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
            快捷键
          </h2>
          <button type="button" className="af-shortcuts-panel__close af-icon-btn" onClick={onClose} aria-label="关闭">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="af-shortcuts-panel__body">
          <section className="af-shortcuts-section">
            <h3 className="af-shortcuts-cat">常规</h3>
            <ul className="af-shortcuts-list">
              <li className="af-shortcuts-row">
                <span className="af-shortcuts-row__label">
                  保存；节点属性侧栏打开时先提交节点再保存 flow
                </span>
                <KeyCombo keys={[mod, "S"]} />
              </li>
              <li className="af-shortcuts-row">
                <span className="af-shortcuts-row__label">快捷键</span>
                <KeyCombo keys={["?"]} />
              </li>
            </ul>
          </section>

          <section className="af-shortcuts-section">
            <h3 className="af-shortcuts-cat">画布</h3>
            <ul className="af-shortcuts-list">
              <li className="af-shortcuts-row">
                <span className="af-shortcuts-row__label">选择工具</span>
                <KeyCombo keys={["V"]} />
              </li>
              <li className="af-shortcuts-row">
                <span className="af-shortcuts-row__label">平移工具</span>
                <KeyCombo keys={["H"]} />
              </li>
              <li className="af-shortcuts-row">
                <span className="af-shortcuts-row__label">按住空格临时平移</span>
                <KeyCombo keys={["Space"]} />
              </li>
              <li className="af-shortcuts-row">
                <span className="af-shortcuts-row__label">全选所有节点</span>
                <KeyCombo keys={[mod, "A"]} />
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
