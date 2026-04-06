#!/usr/bin/env node
/**
 * 批量导出 Figma 中名称以 img_export / icon_export 开头的节点为 PNG。
 *
 * 用法：
 *   node export-assets.mjs --restore-plan <path> --figma-token <token> --run-dir <dir> [--fetch-meta <json>]
 *
 * 输出（stdout JSON）：
 *   { stage, fileKey, exportDir, exported: [{ id, path, name }], totalRequested }
 *
 * 落盘：
 *   <runDir>/figma_exports/export_<safeId>.png — 每个导出节点的 2x PNG
 */

import fs from "node:fs";
import https from "node:https";
import path from "node:path";

// ── CLI 参数解析 ─────────────────────────────────────────────

function parseArgs(argv) {
  const args = { restorePlan: "", figmaToken: "", runDir: ".", fetchMeta: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--restore-plan" && argv[i + 1]) args.restorePlan = argv[++i];
    else if (argv[i] === "--figma-token" && argv[i + 1]) args.figmaToken = argv[++i];
    else if (argv[i] === "--run-dir" && argv[i + 1]) args.runDir = argv[++i];
    else if (argv[i] === "--fetch-meta" && argv[i + 1]) args.fetchMeta = argv[++i];
  }
  return args;
}

// ── HTTP 工具 ────────────────────────────────────────────────

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 400)}`));
        } else {
          resolve(data);
        }
      });
    }).on("error", reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        try { fs.unlinkSync(dest); } catch (_) { /* noop */ }
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve(dest)));
    }).on("error", (e) => {
      try { fs.unlinkSync(dest); } catch (_) { /* noop */ }
      reject(e);
    });
  });
}

// ── 节点树遍历：收集 img_export / icon_export 节点 ──────────

export function walkForExportNodes(node, out = []) {
  if (!node) return out;
  const name = node.name || "";
  if (/^(img_export|icon_export)/i.test(name) && node.id) {
    out.push({ id: node.id, name });
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) walkForExportNodes(child, out);
  }
  return out;
}

// ── 主逻辑 ───────────────────────────────────────────────────

export async function exportAssets({ restorePlan, figmaToken, runDir, fetchMeta }) {
  if (!figmaToken) throw new Error("figmaToken 为空");

  let fileKey = null;
  let treePath = null;

  if (fetchMeta) {
    try {
      const meta = JSON.parse(fetchMeta);
      fileKey = meta.fileKey || null;
      treePath = meta.treeJsonPath || null;
    } catch {
      throw new Error("fetchMeta 不是合法 JSON");
    }
  }

  let exportIds = [];
  if (restorePlan && fs.existsSync(restorePlan)) {
    try {
      const plan = JSON.parse(fs.readFileSync(restorePlan, "utf8"));
      if (!fileKey && plan.fileKey) fileKey = plan.fileKey;
      if (!treePath && plan.treeJsonPath) treePath = plan.treeJsonPath;
      if (Array.isArray(plan.exportNodeIds)) {
        exportIds = plan.exportNodeIds.map((x) =>
          typeof x === "string" ? { id: x, name: "" } : x,
        );
      }
    } catch (_) { /* noop */ }
  }

  if (!fileKey) {
    throw new Error(
      "缺少 fileKey：请提供 --fetch-meta（fetch 节点 stdout JSON）或在 restore_plan 中写入 fileKey",
    );
  }

  const headers = { "X-Figma-Token": figmaToken };
  const outDir = path.resolve(runDir, "figma_exports");
  fs.mkdirSync(outDir, { recursive: true });

  if (treePath && fs.existsSync(treePath)) {
    const doc = JSON.parse(fs.readFileSync(treePath, "utf8"));
    const found = walkForExportNodes(doc.document);
    const seen = new Set(exportIds.map((e) => e.id));
    for (const f of found) {
      if (!seen.has(f.id)) exportIds.push(f);
    }
  }

  const ids = [...new Set(exportIds.map((e) => e.id).filter(Boolean))];
  const saved = [];
  const BATCH_SIZE = 20;

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = ids.slice(i, i + BATCH_SIZE);
    const apiUrl =
      `https://api.figma.com/v1/images/${encodeURIComponent(fileKey)}` +
      `?ids=${encodeURIComponent(chunk.join(","))}&format=png&scale=2`;
    const imgMeta = JSON.parse(await httpsGet(apiUrl, headers));
    const images = imgMeta.images || {};

    for (const id of chunk) {
      const url = images[id];
      if (!url) continue;
      const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
      const dest = path.join(outDir, `export_${safeId}.png`);
      await downloadFile(url, dest);
      const meta = exportIds.find((e) => e.id === id);
      saved.push({ id, path: dest, name: meta?.name || "" });
    }
  }

  return {
    stage: "export_img_icon_assets",
    fileKey,
    exportDir: outDir,
    exported: saved,
    totalRequested: ids.length,
  };
}

// ── 入口 ─────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = await exportAssets(args);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;
if (isMain) main();
