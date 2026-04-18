/**
 * Reads intermediate + output files for a given node instance across all execution rounds.
 * Used by the UI run-mode sidebar to show prompt, result, and output content per execId.
 */
import fs from "fs";
import path from "path";
import { getWorkspaceRunBuildRoot } from "./paths.mjs";

/**
 * @param {string} workspaceRoot
 * @param {string} flowId
 * @param {string} instanceId
 * @param {string} [runId] - specific uuid; if empty, picks the latest run
 * @returns {{ ok: boolean, rounds: Array, runId?: string, error?: string }}
 */
export function getNodeExecContext(workspaceRoot, flowId, instanceId, runId) {
  const runBuildRoot = getWorkspaceRunBuildRoot(workspaceRoot);
  const flowRunDir = path.join(runBuildRoot, flowId);
  if (!fs.existsSync(flowRunDir)) return { ok: true, rounds: [], runId: "" };

  let uuid = runId;
  if (!uuid) {
    const entries = fs.readdirSync(flowRunDir).filter((e) => {
      const s = fs.statSync(path.join(flowRunDir, e));
      return s.isDirectory();
    });
    entries.sort((a, b) => b.localeCompare(a));
    uuid = entries[0] || "";
  }
  if (!uuid) return { ok: true, rounds: [], runId: "" };

  const runDir = path.join(flowRunDir, uuid);
  const interDir = path.join(runDir, "intermediate", instanceId);
  const outDir = path.join(runDir, "output", instanceId);

  const rounds = collectRounds(interDir, outDir, instanceId);

  return { ok: true, rounds, runId: uuid };
}

function collectRounds(interDir, outDir, instanceId) {
  const roundMap = new Map();
  const currentBasename = `${instanceId}.result.md`;

  if (fs.existsSync(interDir)) {
    const files = fs.readdirSync(interDir);
    for (const f of files) {
      const fp = path.join(interDir, f);
      if (!fs.statSync(fp).isFile()) continue;

      if (f === currentBasename) {
        ensureRound(roundMap, "current");
        roundMap.get("current").resultFile = fp;
        continue;
      }

      const promptCurrentName = `${instanceId}.prompt.md`;
      if (f === promptCurrentName) {
        ensureRound(roundMap, "current");
        roundMap.get("current").promptFile = fp;
        continue;
      }

      const cacheCurrentName = `${instanceId}.cache.json`;
      if (f === cacheCurrentName) {
        ensureRound(roundMap, "current");
        roundMap.get("current").cacheFile = fp;
        continue;
      }

      const backupResult = f.match(new RegExp(`^${escRe(instanceId)}\\.result_(\\d+)\\.md$`));
      if (backupResult) {
        const eid = backupResult[1];
        ensureRound(roundMap, eid);
        roundMap.get(eid).resultFile = fp;
        continue;
      }

      const backupPrompt = f.match(new RegExp(`^${escRe(instanceId)}\\.prompt_(\\d+)\\.md$`));
      if (backupPrompt) {
        const eid = backupPrompt[1];
        ensureRound(roundMap, eid);
        roundMap.get(eid).promptFile = fp;
        continue;
      }
    }
  }

  if (fs.existsSync(outDir)) {
    const files = fs.readdirSync(outDir);
    const prefix = `node_${instanceId}_`;
    for (const f of files) {
      const fp = path.join(outDir, f);
      if (!fs.statSync(fp).isFile()) continue;
      if (!f.startsWith(prefix)) continue;

      const backupOut = f.match(
        new RegExp(`^${escRe(prefix)}(.+?)_(\\d+)(\\.[a-zA-Z0-9]+)$`),
      );
      if (backupOut) {
        const slot = backupOut[1];
        const eid = backupOut[2];
        ensureRound(roundMap, eid);
        const r = roundMap.get(eid);
        if (!r.outputFiles) r.outputFiles = [];
        r.outputFiles.push({ slot, path: fp });
        continue;
      }

      const currentOut = f.match(new RegExp(`^${escRe(prefix)}(.+)(\\.[a-zA-Z0-9]+)$`));
      if (currentOut) {
        const slot = currentOut[1];
        ensureRound(roundMap, "current");
        const r = roundMap.get("current");
        if (!r.outputFiles) r.outputFiles = [];
        r.outputFiles.push({ slot, path: fp });
      }
    }
  }

  const result = [];
  for (const [key, data] of roundMap) {
    const round = { execId: key === "current" ? "latest" : key };

    if (data.resultFile) {
      const raw = safeRead(data.resultFile);
      const fm = parseResultFrontmatter(raw);
      round.status = fm.status || null;
      round.finishedAt = fm.finishedAt || null;
      round.message = fm.message || null;
    }

    if (data.cacheFile) {
      try {
        const cacheRaw = safeRead(data.cacheFile, 200000);
        const cacheJson = JSON.parse(cacheRaw);
        if (cacheJson.cacheInputInfo) {
          const inputInfo = typeof cacheJson.cacheInputInfo === "string"
            ? JSON.parse(cacheJson.cacheInputInfo)
            : cacheJson.cacheInputInfo;
          if (Array.isArray(inputInfo.inputPaths)) {
            round.inputs = inputInfo.inputPaths
              .filter((p) => p.slot !== "upstreamMd5")
              .map((p) => ({ slot: p.slot, value: p.value ?? "" }));
          }
        }
      } catch {
        /* ignore parse errors */
      }
    }

    if (data.promptFile) {
      round.prompt = safeRead(data.promptFile, 50000);
    }

    if (data.outputFiles && data.outputFiles.length > 0) {
      round.outputs = data.outputFiles.map((o) => readOutputForUi(o.path, o.slot));
    }

    result.push(round);
  }

  result.sort((a, b) => {
    if (a.execId === "latest") return 1;
    if (b.execId === "latest") return -1;
    return Number(a.execId) - Number(b.execId);
  });

  return result;
}

function ensureRound(map, key) {
  if (!map.has(key)) map.set(key, {});
}

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TEXT_MAX = 50000;
const BINARY_MAX = 5 * 1024 * 1024;

function safeRead(fp, maxLen) {
  try {
    const cap = maxLen != null && maxLen > 0 ? maxLen : TEXT_MAX;
    const st = fs.statSync(fp);
    if (st.size > cap) {
      const fd = fs.openSync(fp, "r");
      try {
        const buf = Buffer.alloc(Math.min(cap + 4, st.size));
        fs.readSync(fd, buf, 0, buf.length, 0);
        return buf.toString("utf-8").slice(0, cap) + "\n…(truncated)";
      } finally {
        fs.closeSync(fd);
      }
    }
    let content = fs.readFileSync(fp, "utf-8");
    if (content.length > cap) content = content.slice(0, cap) + "\n…(truncated)";
    return content;
  } catch {
    return "";
  }
}

/**
 * Sniff binary image / common formats from the first bytes (handles e.g. PNG written under a .md path).
 * @param {Buffer} buf
 * @returns {{ mime: string, displayKind: string } | null}
 */
function sniffBinaryKind(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: "image/png", displayKind: "image" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg", displayKind: "image" };
  }
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { mime: "image/gif", displayKind: "image" };
  }
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return { mime: "image/webp", displayKind: "image" };
  }
  if (buf.length >= 2 && buf.toString("ascii", 0, 2) === "BM") {
    return { mime: "image/bmp", displayKind: "image" };
  }
  return null;
}

function extMime(ext) {
  const e = (ext || "").toLowerCase();
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".json": "application/json",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
  };
  return map[e] || null;
}

function isLikelyJsonText(s) {
  const t = (s || "").trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} fp
 * @param {string} slot
 * @returns {{ slot: string, content: string, encoding: string, mimeType?: string, displayKind: string }}
 */
function readOutputForUi(fp, slot) {
  try {
    const st = fs.statSync(fp);
    const ext = path.extname(fp);
    const readSize = Math.min(st.size, BINARY_MAX);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(fp, "r");
    try {
      fs.readSync(fd, buf, 0, readSize, 0);
    } finally {
      fs.closeSync(fd);
    }

    const sniffed = sniffBinaryKind(buf);
    if (sniffed) {
      const truncated = st.size > BINARY_MAX;
      return {
        slot,
        content: buf.toString("base64"),
        encoding: "base64",
        mimeType: sniffed.mime,
        displayKind: sniffed.displayKind,
        ...(truncated ? { truncated: true } : {}),
      };
    }

    let text = buf.toString("utf8");
    const cap = TEXT_MAX;
    let truncatedText = false;
    if (text.length > cap) {
      text = text.slice(0, cap);
      truncatedText = true;
    } else if (st.size > readSize) {
      truncatedText = true;
    }

    const mimeFromExt = extMime(ext);
    let displayKind = "text";
    if (mimeFromExt === "application/json" || isLikelyJsonText(text)) {
      displayKind = "json";
    } else if (mimeFromExt === "text/markdown" || ext === ".md" || ext === ".markdown") {
      displayKind = "markdown";
    }

    const out = {
      slot,
      content: truncatedText ? text + "\n…(truncated)" : text,
      encoding: "utf-8",
      displayKind,
    };
    if (mimeFromExt) out.mimeType = mimeFromExt;
    return out;
  } catch {
    return { slot, content: "", encoding: "utf-8", displayKind: "text" };
  }
}

function parseResultFrontmatter(raw) {
  const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const obj = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(": ");
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 2).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    obj[k] = v;
  }
  return obj;
}
