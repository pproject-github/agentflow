/**
 * agentflow publish <FlowName> [--title <title>] [--description <desc>] [--tags <t1,t2>]
 *
 * Reads flow.yaml (or zips the flow directory if scripts/ exists),
 * uploads to Hub, and inserts the flow record.
 */
import fs from "fs";
import path from "path";
import chalk from "chalk";
import { zipSync } from "fflate";
import yaml from "js-yaml";
import { log } from "./log.mjs";
import { isRuntimeArtifactPath, readWorkspaceGraphFiles } from "./workspace-flow-store.mjs";
import { readPipelineListDescription } from "./catalog-flows.mjs";
import { isFlowDir } from "./paths.mjs";
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

/**
 * 打包时要带上的文件。
 *
 * 排掉两类：点文件（.git、.DS_Store 之类），以及**运行产物**——`workspace.state.json`
 * 和 `nodes/<id>/history.md` 装的是上一次运行的真实产出，发布一张流程图不该顺手把内网
 * 业务内容一起发出去。
 *
 * 用 fflate 在进程内打包，不再 shell 出去调 `zip`：那个二进制不是每台机器都有，而且
 * 拼命令行意味着目录名里的引号能改写命令。
 */
export function collectPublishableFlowFiles(flowDir) {
  const root = path.resolve(flowDir);
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile() && !isRuntimeArtifactPath(rel)) out.push({ rel, abs });
    }
  };
  walk(root, "");
  return out;
}

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

  // Hub 的线上格式仍要求包里有 flow.yaml（下载与导入两侧都按它认包），而代码化的流程
  // 目录里没有这个文件。这里补一个只带说明的空壳，真正的图照旧以 workspace.flow.js 发出去；
  // 装回来时 isFlowDir 优先认代码，yaml 只是让旧的收包逻辑还能工作。
  const flowYamlPath = path.join(flowDir, "flow.yaml");
  const hasYaml = fs.existsSync(flowYamlPath);
  if (!hasYaml && !isFlowDir(flowDir)) {
    throw new Error("Not a flow directory: " + flowDir);
  }

  const yamlContent = hasYaml ? fs.readFileSync(flowYamlPath, "utf8") : "";
  const listDescription = readPipelineListDescription(flowDir);
  const nodeCount = hasYaml
    ? countNodes(yamlContent)
    : Object.keys(readWorkspaceGraphFiles(flowDir).graph?.instances || {}).length;

  let flowDesc = listDescription || null;
  if (!flowDesc && hasYaml) {
    try {
      const doc = yaml.load(yamlContent);
      if (doc?.ui?.description) flowDesc = doc.ui.description;
    } catch {}
  }

  const title = titleOpt || flowName;
  const description = descOpt || flowDesc || null;
  const tags = tagsOpt ? tagsOpt.split(",").map((s) => s.trim()).filter(Boolean) : [];

  const packaged = collectPublishableFlowFiles(flowDir);
  const hasExtras = packaged.some((entry) => entry.rel !== "flow.yaml");
  // 包里必须有 flow.yaml：下载侧和 flow-import 都按它认包。代码化的流程目录没有，补一个。
  const synthesizedYaml = hasYaml
    ? ""
    : yaml.dump({ instances: {}, edges: [], ui: { nodePositions: {}, ...(flowDesc ? { description: flowDesc } : {}) } }, { lineWidth: -1 });

  // Check if this author already published a flow with this title — update instead of insert.
  const existing = await findFlowByAuthorAndTitle(session.access_token, user.id, title);

  let fileBuffer, fileKey, contentType;
  const ext = hasExtras ? ".zip" : ".yaml";
  const slug = existing?.slug || slugify(title) + "-" + Date.now().toString(36);
  fileKey = `${user.id}/${slug}${ext}`;

  if (hasExtras) {
    log.info(`Flow has scripts/extras — creating zip (${packaged.length} files)...`);
    const entries = Object.fromEntries(
      packaged.map((entry) => [entry.rel, new Uint8Array(fs.readFileSync(entry.abs))]),
    );
    if (!hasYaml) entries["flow.yaml"] = new Uint8Array(Buffer.from(synthesizedYaml, "utf8"));
    fileBuffer = Buffer.from(zipSync(entries, { level: 6 }));
    contentType = "application/zip";
  } else {
    fileBuffer = Buffer.from(hasYaml ? yamlContent : synthesizedYaml, "utf8");
    contentType = "text/yaml";
  }

  // Updating：先删老 artifact 再 INSERT 新文件。
  // Supabase Storage 的 bucket 策略多数只放行 INSERT；x-upsert=true 走 UPDATE 路径
  // 会被拒成 "new row violates row-level security policy"。DELETE + INSERT 最稳：
  // 不论扩展名是否变，老对象先清掉，再走纯 INSERT。
  if (existing && existing.yaml_key) {
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
