/**
 * 追踪项的文件形态：`trackers/<id>.md`，frontmatter 是结构化核心，正文是自由区。
 *
 * 为什么要两层：
 *
 * - **frontmatter** 会被机器消费——跑道按 due 画、告警按 state 触发、协作视图按 owner 找人。
 *   写坏了是静默故障（`state: "警告"` 会被当成「没什么可报告的」），所以必须校验。
 * - **正文**只给人看：任务怎么拆、调研到哪、还有什么没确认。它没有固定形状，
 *   正好是自由文本擅长的，也正好是 agent 和人都能直接改的。
 *
 * 同一个文件里，机器读的部分有契约，人读的部分没有。这样 agent 拿到整个目录当上下文时，
 * 它能自由地写正文，却改不动会影响告警的那几个字段——那几个字段要过 `track sync` 的校验。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import yaml from "js-yaml";

/** frontmatter 里认识的键。多出来的原样带上——多维展示靠的就是它们 */
const CORE_KEYS = ["id", "title", "state", "owner", "due", "current", "required", "evidence", "source"];

/**
 * 日期一律写成本地的 `YYYY-MM-DD`。
 *
 * 板上的 `due` 是 ISO 时刻（本地零点解释出来的），直接写进文件会变成 `2025-10-31T16:00:00.000Z`
 * ——人打开看到的是**前一天**。截止日是「日子」，不是「时刻」，文件里就该是日子。
 */
function asDay(value) {
  if (value instanceof Date) return localDay(value);
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const at = Date.parse(text);
  return Number.isFinite(at) ? localDay(new Date(at)) : text;
}

function localDay(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 把 `---\n...\n---` 和正文分开。没有 frontmatter 的文件不是追踪项，跳过 */
export function splitDoc(text = "") {
  const match = String(text).match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n([\s\S]*))?$/);
  if (!match) return null;
  let meta = {};
  try {
    const parsed = yaml.load(match[1]);
    meta = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return { error: `frontmatter 不是合法 YAML：${(e && e.message) || e}` };
  }
  return { meta, body: String(match[2] || "").trim() };
}

/**
 * 读一个 trackers 目录，产出条目。
 *
 * 正文**不进条目**：分片是给页面和告警读的，把整篇笔记塞进去会让它膨胀，而页面也渲染不了。
 * 条目上只留一个 `doc` 指回文件——想看细节就去看文件，那才是它该待的地方。
 */
export function readTrackerDocs(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  } catch (e) {
    return { rows: [], errors: [`读不到目录 ${dir}：${(e && e.message) || e}`] };
  }

  const rows = [];
  const errors = [];
  const notes = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let text = "";
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch (e) {
      errors.push(`${name}：读不出来（${(e && e.message) || e}）`);
      continue;
    }
    const split = splitDoc(text);
    if (!split) { notes.push(`${name} 没有 frontmatter，跳过`); continue; }
    if (split.error) { errors.push(`${name}：${split.error}`); continue; }

    // 文件名即 id 的默认值：人新建一个文件就有了 id，不用再抄一遍
    const id = String(split.meta.id || name.replace(/\.md$/, "")).trim();
    const row = { ...split.meta, id };
    for (const key of Object.keys(row)) {
      // YAML 会把 due 解析成 Date，写回 JSON 前统一成日期串
      if (row[key] instanceof Date) row[key] = row[key].toISOString().slice(0, 10);
    }
    // 正文留在文件里，条目上只留指针
    row.doc = name;
    if (split.body) row.docLines = split.body.split(/\r?\n/).length;
    rows.push(row);
  }
  return { rows, errors, notes };
}

/** 把一条条目写成文件。已有正文原样保留——agent 改 frontmatter 不该抹掉人写的笔记 */
export function writeTrackerDoc(dir, row = {}, body = "") {
  const id = String(row.id || "").trim();
  if (!id) return { ok: false, error: "缺 id" };
  const file = path.join(dir, `${id}.md`);

  let keep = body;
  if (!keep) {
    try {
      const split = splitDoc(fs.readFileSync(file, "utf-8"));
      if (split && !split.error) keep = split.body;
    } catch { /* 新文件，没有正文可留 */ }
  }

  const meta = {};
  const put = (key, value) => {
    if (value === undefined || value === null || value === "") return;
    // `settled: false` 是默认值，写进文件只是噪音——人打开看到的该是他需要管的东西
    if (value === false) return;
    meta[key] = key === "due" ? asDay(value) : value;
  };
  for (const key of CORE_KEYS) put(key, row[key]);
  for (const [key, value] of Object.entries(row)) {
    if (key in meta || key === "doc" || key === "docLines") continue;
    put(key, value);
  }

  fs.mkdirSync(dir, { recursive: true });
  const front = yaml.dump(meta, { lineWidth: 100, noRefs: true }).trimEnd();
  fs.writeFileSync(file, `---\n${front}\n---\n\n${keep || "<!-- 任务拆解、调研、待确认的事写在这儿。agent 和人都可以改 -->"}\n`, "utf-8");
  return { ok: true, path: file };
}

/**
 * 机器写完文件立刻自己提交。
 *
 * 不提交的话，下一个提交的人会「认领」所有机器写的行——`git blame` 把它们全算成人改的，
 * 门禁当场变成一堵墙。这是实测撞出来的：一次 `track export` + 一次人工 `commit -a`，
 * 之后每个字段都被当成人工判断。
 *
 * 不是 git 仓库就跳过，不报错：文件形态本来就该在没有 git 的地方也能用。
 */
/** 这个目录自己是不是一个 git 仓库根（而不是嵌在别人的仓库里） */
function isOwnRepo(dir) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return Boolean(top) && fs.realpathSync(top) === fs.realpathSync(dir);
  } catch {
    return false;
  }
}

/**
 * 把板目录变成 git 仓库。
 *
 * 不是可选项：**门禁靠 `git blame` 分辨哪些字段是人改的**。没有 git 的话
 * `humanEditedFields` 返回空集，门禁降级成「不拦」——人工判断就再也保不住了。
 *
 * 已经是仓库就什么都不做。
 */
export function ensureGitRepo(dir) {
  try {
    // 必须比对顶层目录：板目录可能嵌在别的仓库里（数据根放在某个 repo 下面很常见），
    // 只问 `--git-dir` 的话会认到**父仓库**，于是 blame 把所有行算到父仓库的提交者头上，
    // 门禁分不清人和机器，再次失效
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top && fs.realpathSync(top) === fs.realpathSync(dir)) return true;
  } catch { /* 还不是仓库 */ }
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    return true;
  } catch {
    return false; // 没装 git，门禁会降级成不拦，但建板本身不该因此失败
  }
}

export function autoCommit(dir, message) {
  // 同样要比对顶层：认到父仓库的话，`git add -A .` 会把父仓库的改动一起提交
  if (!isOwnRepo(dir)) return false;
  try {
    execFileSync("git", ["add", "-A", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", [
      "-c", "user.name=agentflow", "-c", "user.email=agentflow@local",
      "commit", "-q", "-m", message,
    ], { cwd: dir, stdio: "ignore" });
    return true;
  } catch {
    return false; // 没有改动可提交
  }
}
