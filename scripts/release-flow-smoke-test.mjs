#!/usr/bin/env node
/**
 * 顺序触发 Likee Android 发版流程节点并轮询终态。
 * 用法: node scripts/release-flow-smoke-test.mjs [--base http://127.0.0.1:8765] [--workspace likee-android-local] [--version 1.0.0]
 */
import fs from "node:fs";

const args = process.argv.slice(2);
function arg(name, fallback = "") {
  const i = args.indexOf(name);
  return i >= 0 ? String(args[i + 1] || "") : fallback;
}

const BASE = arg("--base", "http://127.0.0.1:8765");
const WORKSPACE = arg("--workspace", "likee-android-local");
const VERSION = arg("--version", "1.0.0");
const BATCH = arg("--batch", "initial");
const USER = arg("--user", "duanfengyuan");
const PASS = arg("--pass", "duanfengyuan");
const POLL_MS = Number(arg("--poll-ms", "15000"));
const NODE_TIMEOUT_MS = Number(arg("--node-timeout-ms", String(45 * 60 * 1000)));
const SKIP_COMPLETED = !args.includes("--force");

const CONTEXT = {
  businessLine: "likee",
  platform: "android",
  version: VERSION,
  batch: BATCH,
  workspaceId: WORKSPACE,
};

const cookieJar = "/tmp/af-smoke-cookies.txt";

async function request(method, path, body, { timeoutMs = method === "POST" && path.includes("/nodes/run") ? 7_200_000 : 120_000 } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (fs.existsSync(cookieJar)) headers.Cookie = fs.readFileSync(cookieJar, "utf8").trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const setCookie = res.headers.getSetCookie?.() || [];
    if (setCookie.length) {
      fs.writeFileSync(cookieJar, setCookie.map((c) => c.split(";")[0]).join("; "));
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function itemId() {
  return `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeActionId(id) {
  return String(id || "").startsWith("composite:") || String(id || "").includes(":")
    ? String(id)
    : `composite:${id}`;
}

function presetKey(node) {
  const id = String(node?.id || "");
  if (id.startsWith("release-initialization:")) return id;
  if (id.startsWith("composite:")) return id;
  return `composite:${String(node?.compositeId || id).replace(/^composite:/, "")}`;
}

function completedPresetIds(state) {
  const ids = new Set();
  for (const t of state.timeline || []) {
    const pid = t.sourcePresetId || t.nodeId;
    if (pid && (t.status === "completed" || t.status === "waiting")) ids.add(pid);
    if (t.nodeId === "release-initialization:prepare-context" && t.status === "completed") {
      ids.add("release-initialization:prepare-context");
    }
    const title = String(t.title || "");
    if (t.status === "completed" || t.status === "waiting") {
      if (title.includes("多语言上传")) ids.add("composite:localization-upload-notify");
      if (title.includes("创建/复用发版分支") || title.includes("发版分支")) ids.add("composite:create-release-branch");
      if (title.includes("多语言下载")) ids.add("composite:localization-download-merge-notify");
      if (title.includes("合回 master")) ids.add("composite:merge-release-to-master");
      if (title.includes("构建")) ids.add("composite:build-package");
      if (title.includes("审核")) ids.add("composite:submit-approval");
      if (title.includes("发布")) {
        if (title.includes("补包")) ids.add("composite:supplemental-publish-and-notify");
        else ids.add("composite:initial-publish-and-notify");
      }
      if (title.includes("开始补包") || title.includes("补包通知")) ids.add("composite:start-supplemental-release-notify");
      if (title.includes("放量") && !title.includes("全量")) ids.add("composite:rollout");
      if (title.includes("全量")) ids.add("composite:full-rollout");
    }
  }
  return ids;
}

function pendingByPreset(state) {
  const map = new Map();
  for (const p of state.pending || []) {
    const pid = p.sourcePresetId || p.nodeId;
    if (pid) map.set(pid, p);
  }
  return map;
}

async function login() {
  const { status, json } = await request("POST", "/api/auth/login", { username: USER, password: PASS });
  if (!json.authenticated) throw new Error(`login failed ${status} ${JSON.stringify(json)}`);
}

async function getCatalog() {
  const q = new URLSearchParams({ ...CONTEXT, workspaceId: WORKSPACE });
  const { json } = await request("GET", `/api/release/catalog?${q}`);
  return json.nodes || [];
}

async function getState() {
  const q = new URLSearchParams({ ...CONTEXT, workspaceId: WORKSPACE });
  const { json } = await request("GET", `/api/release/state?${q}`);
  return json.state || {};
}

async function runNode(node) {
  const actionId = node.id.startsWith("release-initialization:")
    ? node.id
    : normalizeActionId(node.compositeId || node.id.replace(/^composite:/, ""));
  const id = itemId();
  const payload = {
    ...CONTEXT,
    workspaceId: WORKSPACE,
    actionId,
    itemId: `custom-${actionId}-${id}`,
    processId: node.processId || node.workflowStageId,
    scopeKey: node.scopeKey || `likee/android/${VERSION}/${BATCH}`,
    inputs: { product: "likee", platform: "android" },
  };
  const { status, json } = await request("POST", "/api/release/nodes/run", payload);
  return { status, json, actionId, itemId: payload.itemId };
}

async function waitTerminal(actionId, itemIdValue) {
  const started = Date.now();
  while (Date.now() - started < NODE_TIMEOUT_MS) {
    const state = await getState();
    const pending = (state.pending || []).find((p) => p.id === itemIdValue || p.sourcePresetId === actionId);
    if (pending) {
      const st = String(pending.status || "").toLowerCase();
      process.stdout.write(`\r  ${actionId}: ${st} (${Math.round((Date.now() - started) / 1000)}s)   `);
      if (!["running", "pending", "previewing", "awaiting_confirmation"].includes(st)) {
        console.log("");
        return { status: st, error: pending.error, summary: pending.summary, pending };
      }
    } else {
      const done = (state.timeline || []).find((t) => t.sourcePresetId === actionId || t.nodeId === actionId);
      if (done) {
        console.log(`\n  ${actionId}: timeline ${done.status}`);
        return { status: done.status, error: done.error, summary: done.summary, timeline: done };
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  console.log(`\n  ${actionId}: TIMEOUT`);
  return { status: "timeout", error: "poll timeout" };
}

async function main() {
  await login();
  const nodes = await getCatalog();
  const ordered = [...nodes].sort((a, b) => {
    const ao = Number(a.workflowStageOrder ?? a.processOrder ?? 0) * 100 + Number(a.workflowActionOrder ?? 0);
    const bo = Number(b.workflowStageOrder ?? b.processOrder ?? 0) * 100 + Number(b.workflowActionOrder ?? 0);
    return ao - bo;
  });
  console.log(`Catalog: ${ordered.length} nodes for ${VERSION} ${BATCH}`);
  const results = [];
  for (const node of ordered) {
    const actionId = presetKey(node);
    const state = await getState();
    const done = completedPresetIds(state);
    const pend = pendingByPreset(state);
    if (SKIP_COMPLETED && done.has(actionId)) {
      console.log(`SKIP (completed) ${actionId} — ${node.title}`);
      results.push({ actionId, status: "skipped-completed" });
      continue;
    }
    const runningSame = (state.pending || []).find((p) => p.sourcePresetId === actionId && ["running", "pending"].includes(String(p.status || "").toLowerCase()));
    if (runningSame) {
      console.log(`WAIT running ${actionId} — ${runningSame.id}`);
      const terminal = await waitTerminal(actionId, runningSame.id);
      results.push({ actionId, ...terminal });
      if (terminal.status !== "completed" && terminal.status !== "waiting") {
        console.error(`STOP: ${actionId} ended with ${terminal.status}: ${terminal.error || terminal.summary || ""}`);
        break;
      }
      continue;
    }
    if (pend.has(actionId)) {
      const p = pend.get(actionId);
      if (p.status === "failed") {
        console.log(`RETRY failed ${actionId} — ${(p.error || "").slice(0, 80)}`);
        // 删除旧失败卡片，避免同一 preset 堆积 failed+running 两张卡。
        try {
          const enc = encodeURIComponent(p.id);
          const q = new URLSearchParams({ ...CONTEXT, workspaceId: WORKSPACE });
          await request("DELETE", `/api/release/pending/${enc}?${q}`);
        } catch { /* ignore */ }
        const run = await runNode(node);
        const terminal = await waitTerminal(actionId, run.itemId);
        results.push({ actionId, ...terminal });
        if (terminal.status !== "completed" && terminal.status !== "waiting") {
          console.error(`STOP: ${actionId} ended with ${terminal.status}: ${terminal.error || terminal.summary || ""}`);
          break;
        }
        continue;
      }
      console.log(`WAIT existing ${actionId} — ${p.status}`);
      const terminal = await waitTerminal(actionId, p.id);
      results.push({ actionId, ...terminal });
      if (terminal.status !== "completed" && terminal.status !== "waiting") {
        console.error(`STOP: ${actionId} ended with ${terminal.status}: ${terminal.error || terminal.summary || ""}`);
        break;
      }
      continue;
    }
    console.log(`RUN ${actionId} — ${node.title}`);
    const run = await runNode(node);
    if (run.status >= 400 && run.json?.code !== "RELEASE_NODE_RUNNING") {
      console.error(`  launch failed ${run.status}`, JSON.stringify(run.json).slice(0, 300));
      results.push({ actionId, status: "launch-failed", error: run.json?.error });
      break;
    }
    const terminal = await waitTerminal(actionId, run.itemId);
    results.push({ actionId, ...terminal });
    if (!["completed", "waiting"].includes(terminal.status)) {
      console.error(`STOP: ${actionId} ended with ${terminal.status}: ${terminal.error || terminal.summary || ""}`);
      break;
    }
    if (terminal.status === "waiting") {
      console.log(`  waiting — manual input may be required: ${JSON.stringify(terminal.pending?.output || terminal.summary || "").slice(0, 200)}`);
    }
  }
  console.log("\n=== Summary ===");
  for (const r of results) console.log(`${r.status.padEnd(18)} ${r.actionId}${r.error ? " — " + r.error.slice(0, 120) : ""}`);
  const failed = results.some((r) => ["failed", "timeout", "launch-failed"].includes(r.status));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
