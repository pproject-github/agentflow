/**
 * 测量 textarea 内某字符索引处的光标在视口中的位置（用于 popover 定位）。
 * 通过离屏镜像 div 模拟换行，与等宽/比例字体下多数场景一致。
 * @param {HTMLTextAreaElement} textarea
 * @param {number} position selectionStart / selectionEnd
 * @returns {{ top: number, left: number, bottom: number, height: number } | null}
 */
export function getCaretViewportRect(textarea, position) {
  if (!textarea || position < 0) return null;
  const pos = Math.min(position, textarea.value.length);
  const cs = getComputedStyle(textarea);
  const div = document.createElement("div");
  div.setAttribute("aria-hidden", "true");
  div.style.visibility = "hidden";
  div.style.position = "fixed";
  div.style.top = "0";
  div.style.left = "-99999px";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";
  div.style.overflow = "hidden";
  const w = textarea.clientWidth;
  if (w <= 0) return null;
  div.style.width = `${w}px`;
  div.style.font = cs.font;
  div.style.lineHeight = cs.lineHeight;
  div.style.padding = cs.padding;
  div.style.border = cs.border;
  div.style.boxSizing = cs.boxSizing;
  div.style.letterSpacing = cs.letterSpacing;
  div.style.textIndent = cs.textIndent;
  div.style.tabSize = cs.tabSize || "8";
  div.textContent = textarea.value.slice(0, pos);
  const span = document.createElement("span");
  span.textContent = "\u200b";
  div.appendChild(span);
  document.body.appendChild(div);
  const rect = span.getBoundingClientRect();
  const lh = parseFloat(cs.lineHeight);
  const height = Number.isFinite(lh) && lh > 0 ? lh : rect.height || 16;
  document.body.removeChild(div);
  return {
    top: rect.top,
    left: rect.left,
    bottom: rect.bottom,
    height,
  };
}
