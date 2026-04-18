/**
 * agentflow list-remote [--search <query>] [--sort popular|trending] [--json]
 * agentflow download <slug|title> [--as <flowId>] [--raw [--output <dir>]]
 */
import fs from "fs";
import path from "path";
import chalk from "chalk";
import { log } from "./log.mjs";
import { Table } from "./table.mjs";
import { queryFlows, queryFlowBySlug, downloadFlowFile, incrementDownload } from "./hub.mjs";
import {
  unzipAndNormalizePipelineZip,
  suggestFlowIdFromZip,
  writePipelineTree,
  validateImportedFlowYaml,
} from "./flow-import.mjs";
import { resolveFlowDirForWrite, validateUserPipelineId } from "./flow-write.mjs";

export async function hubListRemote(argv) {
  let search = "";
  let sort = "popular";
  const jsonMode = argv.includes("--json");

  const searchIdx = argv.indexOf("--search");
  if (searchIdx >= 0 && argv[searchIdx + 1]) search = argv[searchIdx + 1];
  const sortIdx = argv.indexOf("--sort");
  if (sortIdx >= 0 && argv[sortIdx + 1]) sort = argv[sortIdx + 1];

  const flows = await queryFlows({ sort, search });

  if (jsonMode) {
    process.stdout.write(JSON.stringify(flows) + "\n");
    return;
  }

  if (flows.length === 0) {
    log.info("No flows found." + (search ? " (search: " + search + ")" : ""));
    return;
  }

  const table = new Table({
    head: ["Slug", "Title", "Author", "Downloads", "Nodes", "Tags"],
    style: { head: [] },
  });

  for (const f of flows) {
    table.push([
      f.slug,
      (f.title || "").slice(0, 30),
      f.profiles?.username || "-",
      String(f.downloads || 0),
      String(f.node_count || 0),
      (f.tags || []).join(", "),
    ]);
  }

  log.info("\n" + chalk.bold("AgentFlow Hub — " + (sort === "trending" ? "Trending" : "Popular")) + "\n");
  log.info(table.toString());
  log.info("\n" + chalk.dim("Download: agentflow download <slug>"));
}

/**
 * Derive a filesystem-safe user pipeline id from a free-form string.
 * Replaces non-alnum with underscore, strips leading digits/underscores/hyphens.
 * Returns null if nothing usable remains.
 * @param {string} s
 * @returns {string | null}
 */
function sanitizeToPipelineId(s) {
  if (!s || typeof s !== "string") return null;
  const cleaned = s.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^[-_]+|[-_]+$/g, "");
  if (!cleaned) return null;
  const leadDigitsStripped = cleaned.replace(/^[0-9]+/, "");
  const candidate = leadDigitsStripped || "flow_" + cleaned;
  const v = validateUserPipelineId(candidate);
  return v.ok ? v.flowId : null;
}

export async function hubDownload(argv) {
  const positional = argv.find((a) => !a.startsWith("--"));
  if (!positional) {
    throw new Error(
      "Usage: agentflow download <slug|title> [--user|--workspace] [--as <flowId>] [--raw [--output <dir>]]",
    );
  }

  const raw = argv.includes("--raw");
  let outputDir = process.cwd();
  const outIdx = argv.indexOf("--output");
  if (outIdx >= 0 && argv[outIdx + 1]) outputDir = path.resolve(argv[outIdx + 1]);

  let overrideId = null;
  const asIdx = argv.indexOf("--as");
  if (asIdx >= 0 && argv[asIdx + 1]) overrideId = argv[asIdx + 1];

  const wantWorkspace = argv.includes("--workspace");
  const wantUser = argv.includes("--user");
  if (wantWorkspace && wantUser) {
    throw new Error("--user and --workspace are mutually exclusive");
  }
  const flowSource = wantWorkspace ? "workspace" : "user";

  log.info("Looking up flow: " + chalk.bold(positional) + "...");
  const flow = await queryFlowBySlug(positional);
  if (!flow) {
    throw new Error("Flow not found: " + positional);
  }

  log.info("Downloading " + chalk.bold(flow.title) + " (" + flow.node_count + " nodes)...");
  const buffer = await downloadFlowFile(flow.yaml_key);
  const isZip = flow.yaml_key.endsWith(".zip");
  await incrementDownload(flow.slug);

  // ─── Raw mode: just save the artifact to outputDir. ───
  if (raw) {
    const ext = isZip ? ".zip" : ".yaml";
    const filename = flow.slug + ext;
    const outputPath = path.join(outputDir, filename);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, buffer);
    log.info(chalk.green("✓") + " Saved: " + outputPath + " (" + (buffer.length / 1024).toFixed(1) + " KB)");
    if (isZip) {
      log.info(chalk.dim("  Unzip to use: unzip " + filename + " -d " + flow.slug));
    }
    return;
  }

  // ─── Default: install into pipelines dir (user or workspace). ───
  let files;
  if (isZip) {
    const un = unzipAndNormalizePipelineZip(buffer);
    if (!un.ok) throw new Error("Unzip failed: " + un.error);
    files = un.files;
  } else {
    const text = buffer.toString("utf8");
    const v = validateImportedFlowYaml(text);
    if (!v.ok) throw new Error("Invalid flow.yaml: " + v.error);
    files = new Map([["flow.yaml", buffer]]);
  }

  // ─── Determine target flowId. ───
  const candidates = [];
  if (overrideId) candidates.push(overrideId);
  if (isZip) {
    const s = suggestFlowIdFromZip(buffer);
    if (s.ok && s.suggestedFlowId) candidates.push(s.suggestedFlowId);
  }
  const fromTitle = sanitizeToPipelineId(flow.title);
  if (fromTitle) candidates.push(fromTitle);
  const fromSlug = sanitizeToPipelineId(flow.slug);
  if (fromSlug) candidates.push(fromSlug);

  let flowId = null;
  let lastError = null;
  for (const c of candidates) {
    const v = validateUserPipelineId(c);
    if (!v.ok) {
      lastError = v.error;
      continue;
    }
    flowId = v.flowId;
    break;
  }
  if (!flowId) {
    throw new Error("Could not derive a valid pipeline id" + (lastError ? ": " + lastError : ""));
  }

  const res = writePipelineTree(process.cwd(), flowId, flowSource, files);
  if (!res.success) {
    if (/已存在/.test(res.error || "")) {
      throw new Error(
        "Target pipeline already exists: " + flowId +
          ". Use `--as <newId>` to install under a different name, or `--raw` to just save the file.",
      );
    }
    throw new Error("Install failed: " + res.error);
  }

  const dirInfo = resolveFlowDirForWrite(process.cwd(), flowId, flowSource);
  const scopeLabel = flowSource === "workspace" ? "workspace" : "user";
  log.info(
    chalk.green("✓") + " Installed [" + scopeLabel + "]: " + chalk.bold(flowId) +
      "  (" + (buffer.length / 1024).toFixed(1) + " KB)",
  );
  if (dirInfo.flowDir) {
    log.info(chalk.dim("  Path: " + dirInfo.flowDir));
  }
  log.info(chalk.dim("  Run with: agentflow apply " + flowId));
}
