/**
 * agentflow list-remote [--search <query>] [--sort popular|trending] [--json]
 * agentflow download <slug> [--output <dir>]
 */
import fs from "fs";
import path from "path";
import chalk from "chalk";
import { log } from "./log.mjs";
import { Table } from "./table.mjs";
import { queryFlows, queryFlowBySlug, downloadFlowFile, incrementDownload } from "./hub.mjs";

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

export async function hubDownload(argv) {
  const slug = argv.find((a) => !a.startsWith("--"));
  if (!slug) {
    throw new Error("Usage: agentflow download <slug> [--output <dir>]");
  }

  let outputDir = process.cwd();
  const outIdx = argv.indexOf("--output");
  if (outIdx >= 0 && argv[outIdx + 1]) outputDir = path.resolve(argv[outIdx + 1]);

  log.info("Looking up flow: " + chalk.bold(slug) + "...");
  const flow = await queryFlowBySlug(slug);
  if (!flow) {
    throw new Error("Flow not found: " + slug);
  }

  log.info("Downloading " + chalk.bold(flow.title) + " (" + flow.node_count + " nodes)...");
  const buffer = await downloadFlowFile(flow.yaml_key);

  const isZip = flow.yaml_key.endsWith(".zip");
  const ext = isZip ? ".zip" : ".yaml";
  const filename = slug + ext;
  const outputPath = path.join(outputDir, filename);

  fs.writeFileSync(outputPath, buffer);
  await incrementDownload(slug);
  log.info(chalk.green("✓") + " Saved: " + outputPath + " (" + (buffer.length / 1024).toFixed(1) + " KB)");

  if (isZip) {
    log.info(chalk.dim("  Unzip to use: unzip " + filename + " -d " + slug));
  }
}
