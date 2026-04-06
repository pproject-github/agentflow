/**
 * @param {EventTarget | null} el
 * @returns {boolean}
 */
export function isEditableFocus(el) {
  if (!el || !(el instanceof Element)) return false;
  if (el.closest('[contenteditable="true"]')) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

/**
 * @param {KeyboardEvent} e
 * @returns {boolean}
 */
export function isQuestionMarkShortcut(e) {
  return e.key === "?" || (e.key === "/" && e.shiftKey);
}

/** @returns {boolean} */
export function isMacPlatform() {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent || "");
}
