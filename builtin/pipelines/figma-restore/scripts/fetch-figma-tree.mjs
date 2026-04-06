#!/usr/bin/env node
/**
 * 获取 Figma 文件节点树与指定节点截图。
 *
 * 用法：
 *   node fetch-figma-tree.mjs --figma-url <url> --figma-token <token> --run-dir <dir>
 *
 * 输出（stdout JSON）：
 *   { stage, fileKey, nodeIdFromUrl, treeJsonPath, screenshotPath, screenshotImageUrl, version, name, lastModified }
 *
 * 落盘：
 *   <runDir>/figma_file.json        — 完整文件树 JSON
 *   <runDir>/figma_frame_screenshot.png — 目标节点或首个页面的 2x PNG 截图
 */

import fs from "node:fs";
import https from "node:https";
import path from "node:path";

// ── CLI 参数解析 ─────────────────────────────────────────────

function parseArgs(argv) {
  const args = { figmaUrl: "", figmaToken: "", runDir: "." };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--figma-url" && argv[i + 1]) args.figmaUrl = argv[++i];
    else if (argv[i] === "--figma-token" && argv[i + 1]) args.figmaToken = argv[++i];
    else if (argv[i] === "--run-dir" && argv[i + 1]) args.runDir = argv[++i];
  }
  return args;
}

// ── Figma URL 解析 ───────────────────────────────────────────

export function extractFileKey(url) {
  const m = String(url).match(/figma\.com\/(?:file|design)\/([^/?]+)/);
  return m ? m[1] : null;
}

export function extractNodeId(url) {
  const q = String(url).match(/[?&]node-id=([^&]+)/);
  if (!q) return null;
  return decodeURIComponent(q[1]).replace(/-/g, ":");
}

// ── HTTP 工具 ────────────────────────────────────────────────

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
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

// ── 主逻辑 ───────────────────────────────────────────────────

export async function fetchFigmaTree({ figmaUrl, figmaToken, runDir }) {
  if (!figmaToken) throw new Error("figmaToken 为空");

  const fileKey = extractFileKey(figmaUrl);
  if (!fileKey) throw new Error("无法从 figmaUrl 解析 file key");

  const nodeId = extractNodeId(figmaUrl);
  const headers = { "X-Figma-Token": figmaToken };
  const outDir = path.resolve(runDir);
  fs.mkdirSync(outDir, { recursive: true });

  const apiBase = `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}`;
  const fileJson = await httpsGet(apiBase, headers);
  const treePath = path.join(outDir, "figma_file.json");
  fs.writeFileSync(treePath, fileJson, "utf8");

  const doc = JSON.parse(fileJson);

  let shotIds = [];
  if (nodeId) {
    shotIds = [nodeId];
  } else if (doc.document?.children?.[0]) {
    shotIds = [doc.document.children[0].id];
  }

  let screenshotPath = null;
  let imageUrl = null;
  if (shotIds.length) {
    const imgApi =
      `https://api.figma.com/v1/images/${encodeURIComponent(fileKey)}` +
      `?ids=${encodeURIComponent(shotIds[0])}&format=png&scale=2`;
    const imgMeta = JSON.parse(await httpsGet(imgApi, headers));
    imageUrl = imgMeta.images?.[shotIds[0]] ?? null;
    if (imageUrl) {
      screenshotPath = path.join(outDir, "figma_frame_screenshot.png");
      await downloadFile(imageUrl, screenshotPath);
    }
  }

  return {
    stage: "fetch_figma_tree_and_screenshot",
    fileKey,
    nodeIdFromUrl: nodeId,
    treeJsonPath: treePath,
    screenshotPath,
    screenshotImageUrl: imageUrl,
    version: doc.version ?? null,
    name: doc.name ?? null,
    lastModified: doc.lastModified ?? null,
  };
}

// ── 入口 ─────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = await fetchFigmaTree(args);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;
if (isMain) main();
