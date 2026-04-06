/** 当前时间 hh:MM:ss（24 小时） */
export function formatTimeHHMMSS() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/** 耗时展示：<1 分钟只展示秒，<1 小时展示分秒，>=1 小时展示时分秒 */
export function formatDuration(ms) {
  if (ms < 0 || !Number.isFinite(ms)) return "0s";
  const sec = Math.floor(ms / 1000) % 60;
  const min = Math.floor(ms / 60000) % 60;
  const hour = Math.floor(ms / 3600000);
  if (hour > 0) return `${hour}h ${min}m ${sec}s`;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

const SAVE_CURSOR = "\x1b[s";
const RESTORE_CURSOR = "\x1b[u";

/** 在终端右下角写入一行文字（需 TTY）。pos 为从右往左的字符数，默认 8（hh:MM:ss） */
export function writeBottomRight(stream, text, pos = 8) {
  if (!stream.isTTY || stream.columns == null || stream.rows == null) return;
  const cols = stream.columns || 80;
  const rows = stream.rows || 24;
  const col = Math.max(1, cols - pos);
  stream.write(SAVE_CURSOR + `\x1b[${rows};${col}H` + text + RESTORE_CURSOR);
}

/** 对多行文本每行前加前缀后写入 stream */
export function writeWithPrefix(stream, text, prefix, contentColor = null) {
  if (!text || !prefix) {
    if (text) stream.write(contentColor ? contentColor(text) : text);
    return;
  }
  const lines = text.split("\n");
  const out = lines.map((line) => prefix + (contentColor ? contentColor(line) : line)).join("\n");
  stream.write(out + (text.endsWith("\n") ? "" : "\n"));
}
