import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function assetPathFromHtml(indexHtml, pattern, label, distDir) {
  const match = indexHtml.match(pattern);
  if (!match?.[1]) throw new Error(`AgentFlow Web UI ${label} asset is missing; run npm run build:web-ui first`);
  const assetPath = path.join(distDir, match[1].replace(/^\/+/, ""));
  if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
    throw new Error(`AgentFlow Web UI ${label} asset not found: ${assetPath}`);
  }
  return assetPath;
}

function safeInlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function safeInlineScript(source) {
  return String(source).replace(/<\/script/gi, "<\\/script");
}

function safeInlineStyle(source) {
  return String(source).replace(/<\/style/gi, "<\\/style");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build one self-contained, read-only HTML snapshot using the production Web UI bundle.
 * No local HTTP server or AgentFlow process is required after this function returns.
 */
export function writeStaticFlowPreview({
  flowId,
  flowPath,
  nodeCatalog,
  outputPath,
  distDir,
}) {
  const indexPath = path.join(distDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new Error(`AgentFlow Web UI build not found: ${indexPath}; run npm run build:web-ui first`);
  }
  const indexHtml = fs.readFileSync(indexPath, "utf-8");
  const scriptPath = assetPathFromHtml(
    indexHtml,
    /<script[^>]+src=["']([^"']+\.js)["'][^>]*><\/script>/i,
    "JavaScript",
    distDir,
  );
  const stylePath = assetPathFromHtml(
    indexHtml,
    /<link[^>]+href=["']([^"']+\.css)["'][^>]*>/i,
    "CSS",
    distDir,
  );
  const flowYaml = fs.readFileSync(flowPath, "utf-8");
  const payload = {
    format: "agentflow-static-preview-v1",
    flow: { id: String(flowId || "local-preview"), source: "preview", archived: false },
    flowYaml,
    nodeCatalog: nodeCatalog && typeof nodeCatalog === "object" ? nodeCatalog : { nodes: [] },
    revision: crypto.createHash("sha256").update(flowYaml).digest("hex").slice(0, 24),
  };
  const appScript = safeInlineScript(fs.readFileSync(scriptPath, "utf-8"));
  const appStyle = safeInlineStyle(fs.readFileSync(stylePath, "utf-8"));
  const title = `${escapeHtml(flowId || "Flow")} · AgentFlow Preview`;
  const html = `<!doctype html>
<html class="af-dark" lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="generator" content="AgentFlow static Flow preview" />
    <title>${title}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" rel="stylesheet" />
    <style>${appStyle}</style>
    <script>window.__AGENTFLOW_STATIC_FLOW_PREVIEW__=${safeInlineJson(payload)};</script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">${appScript}</script>
  </body>
</html>
`;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, "utf-8");
  return {
    outputPath,
    bytes: Buffer.byteLength(html),
    revision: payload.revision,
  };
}
