/**
 * HTML 转义。
 *
 * 单独成模块是为了让 PRD workflow 那套服务端渲染不必反向依赖 ui-server——它和
 * `injectHtmlBaseHref` 是仅有的两个使用者，各自 import 一份比互相牵扯干净。
 */

/**
 * 转义成可以放进属性值的文本。
 * @param {unknown} value
 * @returns {string}
 */
export function htmlEscapeAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
