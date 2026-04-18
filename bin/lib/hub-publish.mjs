/**
 * agentflow publish <FlowName> [--title <title>] [--description <desc>] [--tags <t1,t2>]
 *
 * Reads flow.yaml (or zips the flow directory if scripts/ exists),
 * uploads to Hub, and inserts the flow record.
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import chalk from "chalk";
import yaml from "js-yaml";
import { log } from "./log.mjs";
import {
  getStoredSession,
  getUserProfile,
  uploadToStorage,
  insertFlow,
  findFlowByAuthorAndTitle,
  updateFlow,
  deleteStorageObject,
} from "./hub.mjs";
import { getFlowDir } from "./workspace.mjs";

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function countNodes(yamlContent) {
  try {
    const doc = yaml.load(yamlContent);
    if (doc?.nodes && Array.isArray(doc.nodes)) return doc.nodes.length;
    if (doc?.pipeline?.nodes && Array.isArray(doc.pipeline.nodes)) return doc.pipeline.nodes.length;
    return 0;
  } catch {
    return 0;
  }
}

export async function hubPublish(workspaceRoot, argv) {
  // Auth check
  const session = await getStoredSession();
  if (!session?.access_token) {
    throw new Error("Not logged in. Run: agentflow login");
  }
  const user = await getUserProfile(session.access_token);
  if (!user?.id) {
    throw new Error("Session expired. Run: agentflow login");
  }

  // Parse args
  const flowName = argv.find((a) => !a.startsWith("--"));
  if (!flowName) {
    throw new Error("Usage: agentflow publish <FlowName> [--title <title>] [--description <desc>] [--tags <t1,t2>]");
  }

  let titleOpt, descOpt, tagsOpt;
  const titleIdx = argv.indexOf("--title");
  if (titleIdx >= 0 && argv[titleIdx + 1]) titleOpt = argv[titleIdx + 1];
  const descIdx = argv.indexOf("--description");
  if (descIdx >= 0 && argv[descIdx + 1]) descOpt = argv[descIdx + 1];
  const tagsIdx = argv.indexOf("--tags");
  if (tagsIdx >= 0 && argv[tagsIdx + 1]) tagsOpt = argv[tagsIdx + 1];

  // Find flow directory
  const flowDir = getFlowDir(workspaceRoot, flowName);
  if (!flowDir) {
    throw new Error("Flow not found: " + flowName);
  }

  const flowYamlPath = path.join(flowDir, "flow.yaml");
  if (!fs.existsSync(flowYamlPath)) {
    throw new Error("flow.yaml not found in " + flowDir);
  }

  const yamlContent = fs.readFileSync(flowYamlPath, "utf8");
  const nodeCount = countNodes(yamlContent);

  // Auto-read metadata from flow.yaml
  let flowDesc = null;
  try {
    const doc = yaml.load(yamlContent);
    if (doc?.ui?.description) flowDesc = doc.ui.description;
  } catch {}

  const title = titleOpt || flowName;
  const description = descOpt || flowDesc || null;
  const tags = tagsOpt ? tagsOpt.split(",").map((s) => s.trim()).filter(Boolean) : [];

  // Check if flow directory has scripts/ or other files beyond flow.yaml
  const entries = fs.readdirSync(flowDir);
  const hasExtras = entries.some((e) => e !== "flow.yaml" && e !== ".DS_Store");

  // Check if this author already published a flow with this title — update instead of insert.
  const existing = await findFlowByAuthorAndTitle(session.access_token, user.id, title);

  let fileBuffer, fileKey, contentType;
  const ext = hasExtras ? ".zip" : ".yaml";
  const slug = existing?.slug || slugify(title) + "-" + Date.now().toString(36);
  fileKey = `${user.id}/${slug}${ext}`;

  if (hasExtras) {
    log.info("Flow has scripts/extras — creating zip...");
    const zipPath = path.join(flowDir, ".hub-upload.zip");
    try {
      execSync(`cd "${flowDir}" && zip -r "${zipPath}" . -x ".*"`, { stdio: "pipe" });
      fileBuffer = fs.readFileSync(zipPath);
      contentType = "application/zip";
    } finally {
      try { fs.unlinkSync(zipPath); } catch {}
    }
  } else {
    fileBuffer = Buffer.from(yamlContent, "utf8");
    contentType = "text/yaml";
  }

  // If updating and the file extension changed (yaml ↔ zip), delete the old artifact.
  if (existing && existing.yaml_key && existing.yaml_key !== fileKey) {
    log.info("Removing old artifact: " + existing.yaml_key);
    await deleteStorageObject(session.access_token, existing.yaml_key);
  }

  log.info("Uploading " + (hasExtras ? "zip" : "flow.yaml") + " (" + (fileBuffer.length / 1024).toFixed(1) + " KB)...");
  await uploadToStorage(session.access_token, fileKey, fileBuffer, contentType);

  if (existing) {
    log.info("Updating existing flow record...");
    await updateFlow(session.access_token, existing.id, {
      description,
      tags,
      yaml_key: fileKey,
      node_count: nodeCount,
    });
    log.info(chalk.green("✓") + " Updated: " + chalk.bold(title));
  } else {
    log.info("Publishing flow record...");
    await insertFlow(session.access_token, {
      slug,
      author_id: user.id,
      title,
      description,
      tags,
      yaml_key: fileKey,
      node_count: nodeCount,
    });
    log.info(chalk.green("✓") + " Published: " + chalk.bold(title));
  }

  log.info("  slug: " + slug);
  log.info("  nodes: " + nodeCount);
  if (hasExtras) log.info("  type: zip (includes scripts)");
  log.info("  " + chalk.dim("View at: https://agentflow-hub.com/flows/" + slug));
}
