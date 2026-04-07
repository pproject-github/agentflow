/**
 * 本地 HTTP：静态 UI + /api/flows（GET/POST）、/api/flows/import（POST multipart 导入 .yaml/.zip）、/api/flow/archive（POST）、/api/flow/delete（POST 永久删除）、/api/model-lists、/api/ui-context、/api/pipeline-recent-runs、/api/run-node-statuses（GET 某次 run 各节点磁盘状态）、/api/workspace-tree（GET 工作区目录树）、/api/nodes、/api/flow（GET/POST）、
 * /api/flow-editor-sync（POST 通知画布刷新）、/api/flow-editor-sync-events（GET SSE）、/api/flow/run（POST NDJSON 流式执行 agentflow apply --machine-readable）、/api/flow/run/stop（POST 终止运行）、
 * /api/composer-agent（POST NDJSON；有 flow 时结束后 validate-flow，失败则自动 agent 修复至多 5 次）、
 * /api/agentflow-config（GET/POST 读写 ~/agentflow/config.json 的 opencodeProvider；POST 后执行 update-model-lists）、/api/update-model-lists（POST 可选 JSON body.opencodeProvider 覆盖本次拉取用的 Provider，未保存 config 也可用）；
 * listen 后后台 updateModelLists
 */
import fs from "fs";
import http from "http";
import path from "path";
import { spawn } from "child_process";
import busboy from "busboy";
import { log } from "./log.mjs";
import { getFlowYamlAbs, listFlowsJson, listNodesJson, readFlowJson } from "./catalog-flows.mjs";
import {
  FLOW_YAML_FILENAME,
  archiveFlowPipeline,
  buildEmptyUserFlowYaml,
  deleteFlowPipeline,
  moveFlowDirectory,
  resolveFlowDirForWrite,
  validateUserPipelineId,
  writeFlowYaml,
} from "./flow-write.mjs";
import { updateModelLists } from "./model-lists.mjs";
import {
  startComposerAgent,
  startComposerMultiStep,
  shouldUseMultiStep,
  runComposerPostFlowValidationAndRepair,
} from "./composer-agent.mjs";
import {
  PACKAGE_ROOT,
  getAgentflowUserConfigAbs,
  getModelListsAbs,
  getRunDir,
} from "./paths.mjs";
import { RUN_INTERRUPTED_FILENAME } from "./recent-runs.mjs";
import {
  detectIntents,
  loadResourcesForIntents,
  buildSkillInjectionBlock,
} from "./composer-skill-router.mjs";
import { COMPOSER_NODE_SPEC_FILENAME } from "./composer-planner.mjs";
import { listRecentRunsFromDisk } from "./recent-runs.mjs";
import {
  unzipAndNormalizePipelineZip,
  validateImportedFlowYaml,
  writePipelineTree,
} from "./flow-import.mjs";
import { getWorkspaceTree } from "./workspace-tree.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readAgentflowUserConfigObject() {
  const p = getAgentflowUserConfigAbs();
  try {
    if (!fs.existsSync(p)) return {};
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function readModelListsFromDisk(workspaceRoot) {
  const p = getModelListsAbs();
  try {
    if (!fs.existsSync(p)) {
      return { cursor: [], opencode: [], cursorFetchedAt: null, opencodeFetchedAt: null };
    }
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return {
      cursor: Array.isArray(data.cursor) ? data.cursor.map(String) : [],
      opencode: Array.isArray(data.opencode) ? data.opencode.map(String) : [],
      cursorFetchedAt: data.cursorFetchedAt ?? null,
      opencodeFetchedAt: data.opencodeFetchedAt ?? null,
    };
  } catch {
    return { cursor: [], opencode: [], cursorFetchedAt: null, opencodeFetchedAt: null };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** ZIP 本地头：PK\x03\x04 / \x05\x06 / \x07\x08 */
function bufferLooksLikeZip(buf) {
  return (
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07) &&
    (buf[3] === 0x04 || buf[3] === 0x06 || buf[3] === 0x08)
  );
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<{ targetSpace: string, flowIdField: string, file: Buffer, filename: string, gotFile: boolean }>}
 */
function parseFlowsImportForm(req) {
  return new Promise((resolve, reject) => {
    const bb = busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: 10 * 1024 * 1024, parts: 32 },
    });
    let targetSpace = "user";
    let flowIdField = "";
    /** @type {Buffer[]} */
    const chunks = [];
    let filename = "";
    let gotFile = false;

    bb.on("field", (name, val) => {
      if (name === "targetSpace" && (val === "workspace" || val === "user")) {
        targetSpace = val;
      }
      if (name === "flowId" && typeof val === "string") {
        flowIdField = val;
      }
    });

    bb.on("file", (name, file, info) => {
      if (name !== "file") {
        file.resume();
        return;
      }
      gotFile = true;
      filename = info.filename || "";
      file.on("data", (d) => chunks.push(d));
      file.on("limit", () => {
        reject(new Error("FILE_TOO_LARGE"));
      });
    });

    bb.on("finish", () => {
      resolve({
        targetSpace,
        flowIdField: flowIdField.trim(),
        file: Buffer.concat(chunks),
        filename,
        gotFile,
      });
    });
    bb.on("error", reject);
    req.pipe(bb);
  });
}

/** GET 读 flow / nodes / SSE 等 */
function isValidFlowSourceRead(s) {
  return s === "builtin" || s === "user" || s === "workspace";
}

/** POST 写 flow */
function isValidFlowSourceWrite(s) {
  return s === "user" || s === "workspace";
}

/** Composer 打开的画布通过 SSE 订阅；POST /api/flow-editor-sync 向对应 flow 推送刷新 */
const flowEditorSyncSubscribers = new Map();
/** 每次 broadcastFlowEditorSync 时递增，供轮询端点 /api/flow-editor-sync-poll 使用 */
const flowEditorSyncVersions = new Map();

function flowEditorSyncKey(flowId, flowSource, flowArchived) {
  return `${String(flowId)}\t${String(flowSource)}\t${flowArchived ? "1" : "0"}`;
}

function broadcastFlowEditorSync(flowId, flowSource, flowArchived = false) {
  const key = flowEditorSyncKey(flowId, flowSource, flowArchived);

  /* 递增轮询版本号 */
  flowEditorSyncVersions.set(key, (flowEditorSyncVersions.get(key) ?? 0) + 1);

  const set = flowEditorSyncSubscribers.get(key);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify({ type: "refresh" });
  const chunk = `data: ${payload}\n\n`;
  for (const clientRes of set) {
    try {
      clientRes.write(chunk);
    } catch (_) {}
  }
}

/** 正在执行的 flow run（flowId → { child, runUuid }）；同一 flow 只允许一个 run */
const activeFlowRuns = new Map();

/** Cursor/OpenCode 执行目录统一使用当前 UI 启动 workspace。 */
function composerCliWorkspaceForFlowDir(workspaceRoot, _flowDir) {
  return path.resolve(workspaceRoot);
}

/**
 * @param {object} p
 * @param {string} p.flowYamlAbs
 * @param {string} p.flowId
 * @param {"builtin" | "user" | "workspace"} p.flowSource
 * @param {string} [p.workspaceWriteDirAbs] builtin 时可写副本根目录（…/pipelines/<flowId>）
 * @param {"user" | "workspace"} [p.editorSyncFlowSource] flow-editor-sync 使用的 flowSource（builtin 时为 workspace）
 * @param {string[]} p.instanceIds
 * @param {string} p.userPrompt
 * @param {number} p.uiPort 本地 Web UI 端口（用于 flow 保存后通知浏览器刷新）
 * @param {boolean} [p.flowArchived]
 */
const THREAD_HISTORY_MAX_CHARS = 8000;
const THREAD_HISTORY_MAX_TURNS = 20;

function formatThreadHistory(thread) {
  if (!thread || thread.length === 0) return "";
  const recent = thread.slice(-THREAD_HISTORY_MAX_TURNS);
  const lines = [];
  let chars = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    const label = m.role === "user" ? "用户" : "助手";
    const text = m.text.length > 1500 ? m.text.slice(0, 1500) + "…(截断)" : m.text;
    const line = `${label}：${text}`;
    if (chars + line.length > THREAD_HISTORY_MAX_CHARS) break;
    lines.unshift(line);
    chars += line.length;
  }
  if (lines.length === 0) return "";
  return "## 对话历史\n\n" + lines.join("\n\n");
}

function buildComposerPromptWithFlowContext(p) {
  const idsLine =
    p.instanceIds.length > 0 ? p.instanceIds.map(String).join(", ") : "（无，可能为全局修改或新增节点）";
  const flowDirAbs = path.dirname(p.flowYamlAbs);
  const syncFs = p.editorSyncFlowSource ?? p.flowSource;
  const syncBody = { flowId: p.flowId, flowSource: syncFs };
  if (p.flowArchived) syncBody.flowArchived = true;
  const syncJsonArg = JSON.stringify(JSON.stringify(syncBody));
  const builtinExtra =
    p.flowSource === "builtin" && p.workspaceWriteDirAbs
      ? [
          `- 包内 builtin 模板为只读；若保存修改请写入工作区副本目录：${p.workspaceWriteDirAbs}（flow.yaml 与同 id）`,
          "- 保存后刷新 Web 画布时，flow-editor-sync 的 JSON 须使用 flowSource: workspace（与上方 curl 一致）。",
        ]
      : [];

  // 基于用户意图动态注入 skill 和 reference 内容
  const intents = detectIntents(p.userPrompt);
  const resources = loadResourcesForIntents(intents, PACKAGE_ROOT);
  const skillBlock = resources.hasContext
    ? buildSkillInjectionBlock(resources.skills, resources.references)
    : "";

  // 无意图匹配时使用通用 skill 路径引用作为兜底
  const skillPathHints = resources.hasContext
    ? []
    : [
        "- 新增实例与边：遵循 skill `skills/agentflow-flow-add-instances/SKILL.md`（或 `.cursor/skills/.../SKILL.md`）。",
        "- 仅改已有实例文案/占位等：遵循 `skills/agentflow-flow-edit-node-fields/SKILL.md`，勿改 definitionId、instanceId、IO 结构与边拓扑。",
      ];

  const prefix = [
    "## AgentFlow 编辑上下文",
    `- 流水线目录（flowId=${p.flowId}）：${flowDirAbs}`,
    `- 图定义文件（必读/必改此文件）：${p.flowYamlAbs}`,
    `- flowId：${p.flowId}`,
    `- flowSource：${p.flowSource}`,
    ...builtinExtra,
    `- 当前关联的节点实例 ID（顺序：画布选中优先，再输入框 @提及）：${idsLine}`,
    ...skillPathHints,
    "",
    "### 节点类型选择（必须遵守）",
    "**核心原则：能用 tool 节点确定性执行的，不要用 agent_subAgent。**",
    "| 场景 | 推荐节点 |",
    "|------|----------|",
    "| 执行已知命令/脚本、打印文本、文件操作、数据处理 | **tool_nodejs** + `script` 字段（零 LLM 调用，毫秒级） |",
    "| 向用户输出醒目信息 | **tool_print** |",
    "| 需要 AI 理解上下文、做判断、生成内容 | **agent_subAgent** |",
    "",
    "tool_nodejs + script 示例（打印文本）：",
    "```yaml",
    "print_hello:",
    "  definitionId: tool_nodejs",
    "  label: 打印Hello",
    '  script: node -e "console.log(${value})"',
    "  input:",
    "    - { type: 节点, name: prev, value: '' }",
    "    - { type: 文本, name: value, value: '' }",
    "  output:",
    "    - { type: 节点, name: next, value: '' }",
    "    - { type: 文本, name: result, value: '' }",
    "```",
    "script 成败以 exit code 为准（0=success），stdout 直接作为 result 槽位内容（纯文本即可，如 console.log）。",
    "常见误用：用 agent_subAgent 做「打印一段文字」「执行已有脚本」→ 应改用 tool_nodejs + script 或 tool_print。",
    "",
    "### tool_nodejs 的 script 与 body 关键区分",
    "- **`script` 字段**：实际执行的命令代码，流水线直接 spawn 执行；**tool_nodejs 必须写 script**",
    "- **`body` 字段**：纯文档注释，有 script 时完全不执行；**禁止在 body 写期望执行的逻辑**",
    "- 如果无法写出完整可执行的 script（需要 AI 理解/判断），**必须改用 agent_subAgent**，不要用 tool_nodejs",
    "- script 支持多行（YAML `|`）和管道，可写复杂的 curl + node 组合",
    "- **禁止**：tool_nodejs 只有 body 没有 script（body 中的自然语言不会被执行，节点会失败）",
    "",
    // 动态注入的 skill 和 reference 内容
    ...(skillBlock ? [skillBlock, ""] : []),
    "- **保存 flow.yaml 后必须刷新 Web 画布**：遵循 `skills/agentflow-flow-sync-ui/SKILL.md`；在终端执行（将 JSON 与上方 flowId、flowSource" +
      (p.flowArchived ? "、flowArchived" : "") +
      " 保持一致）：",
    `  curl -sS -X POST http://127.0.0.1:${p.uiPort}/api/flow-editor-sync -H 'Content-Type: application/json' -d ${syncJsonArg}`,
    "",
    ...(p.thread && p.thread.length > 0
      ? [formatThreadHistory(p.thread), ""]
      : []),
    "## 用户说明",
    "",
    p.userPrompt.trim(),
  ].join("\n");
  return prefix;
}

function normalizeContextInstanceIds(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const x of raw) {
    const s = typeof x === "string" ? x.trim() : String(x ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.workspaceRoot
 * @param {number} opts.port
 * @param {string} [opts.staticDir] 默认 PACKAGE_ROOT/builtin/web-ui/dist（npm run build 产出）
 * @returns {Promise<import('http').Server>}
 */
export function startUiServer({ workspaceRoot, port, staticDir = path.join(PACKAGE_ROOT, "builtin", "web-ui", "dist") }) {
  const root = path.resolve(workspaceRoot);
  const uiPort = port;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const reqStart = Date.now();
    log.debug(`[ui] ${req.method} ${url.pathname}${url.search || ""}`);

    const origEnd = res.end.bind(res);
    res.end = function (...args) {
      log.debug(`[ui] ${req.method} ${url.pathname} → ${res.statusCode} (${Date.now() - reqStart}ms)`);
      return origEnd(...args);
    };

    if (url.pathname === "/api/flows") {
      if (req.method === "GET") {
        try {
          json(res, 200, listFlowsJson(root));
        } catch (e) {
          json(res, 500, { error: (e && e.message) || String(e) });
        }
        return;
      }
      if (req.method === "POST") {
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { error: "Invalid JSON body" });
          return;
        }
        const idCheck = validateUserPipelineId(payload.flowId);
        if (!idCheck.ok) {
          json(res, 400, { error: idCheck.error });
          return;
        }
        const flowId = idCheck.flowId;
        const desc =
          payload.description != null && typeof payload.description === "string"
            ? payload.description
            : "";
        let targetSpace = "user";
        const ts = payload.targetSpace;
        if (ts === "workspace" || ts === "user") {
          targetSpace = ts;
        }
        const existing = listFlowsJson(root);
        if (
          existing.some(
            (f) => f.id === flowId && (f.source ?? "user") === targetSpace && !f.archived,
          )
        ) {
          json(res, 409, { error: "已存在同名流水线，请换一个名称" });
          return;
        }
        const flowYaml = buildEmptyUserFlowYaml({ description: desc });
        const result = writeFlowYaml(root, flowId, targetSpace, flowYaml);
        if (!result.success) {
          json(res, 400, result);
          return;
        }
        json(res, 200, { success: true, flowId, flowSource: targetSpace });
        return;
      }
      const body405 = JSON.stringify({ error: "Method not allowed" });
      res.writeHead(405, {
        "Content-Type": "application/json; charset=utf-8",
        Allow: "GET, POST",
        "Content-Length": Buffer.byteLength(body405),
      });
      res.end(body405);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flows/import") {
      const ct = req.headers["content-type"] || "";
      if (!ct.toLowerCase().startsWith("multipart/form-data")) {
        json(res, 415, { error: "需要 multipart/form-data" });
        return;
      }
      let parsed;
      try {
        parsed = await parseFlowsImportForm(req);
      } catch (e) {
        if (e && e.message === "FILE_TOO_LARGE") {
          json(res, 400, { error: "文件过大（最大 10MB）" });
          return;
        }
        json(res, 400, { error: (e && e.message) || String(e) });
        return;
      }
      if (!parsed.gotFile || !parsed.file.length) {
        json(res, 400, { error: "请上传文件（字段名 file）" });
        return;
      }
      const idCheck = validateUserPipelineId(parsed.flowIdField);
      if (!idCheck.ok) {
        json(res, 400, { error: idCheck.error });
        return;
      }
      const flowId = idCheck.flowId;
      const targetSpace = parsed.targetSpace === "workspace" ? "workspace" : "user";
      const existing = listFlowsJson(root);
      if (
        existing.some(
          (f) => f.id === flowId && (f.source ?? "user") === targetSpace && !f.archived,
        )
      ) {
        json(res, 409, { error: "已存在同名流水线，请换一个名称" });
        return;
      }

      const buf = parsed.file;
      /** @type {Map<string, Buffer> | null} */
      let filesMap = null;

      if (bufferLooksLikeZip(buf)) {
        const norm = unzipAndNormalizePipelineZip(buf);
        if (!norm.ok) {
          json(res, 400, { error: norm.error });
          return;
        }
        filesMap = norm.files;
      } else {
        const text = buf.toString("utf8");
        const v = validateImportedFlowYaml(text);
        if (!v.ok) {
          json(res, 400, { error: v.error });
          return;
        }
        filesMap = new Map([["flow.yaml", Buffer.from(text, "utf8")]]);
      }

      const w = writePipelineTree(root, flowId, targetSpace, filesMap);
      if (!w.success) {
        json(res, 400, { error: w.error });
        return;
      }
      json(res, 200, { success: true, flowId, flowSource: targetSpace });
      return;
    }

    // ── Node execution context (run-mode sidebar) ──
    if (req.method === "GET" && url.pathname === "/api/node-exec-context") {
      try {
        const flowId = url.searchParams.get("flowId") || "";
        const instanceId = url.searchParams.get("instanceId") || "";
        const runId = url.searchParams.get("runId") || "";
        if (!flowId || !instanceId) {
          json(res, 400, { error: "Missing flowId or instanceId" });
          return;
        }
        const { getNodeExecContext } = await import("./node-exec-context.mjs");
        json(res, 200, getNodeExecContext(root, flowId, instanceId, runId));
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/pipeline-recent-runs") {
      try {
        json(res, 200, { runs: listRecentRunsFromDisk(root) });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/run-node-statuses") {
      try {
        const flowId = url.searchParams.get("flowId") || "";
        const runId = url.searchParams.get("runId") || "";
        if (!flowId || !runId) {
          json(res, 400, { error: "Missing flowId or runId" });
          return;
        }
        const { getRunNodeStatusesFromDisk } = await import("./run-node-statuses-from-disk.mjs");
        json(res, 200, { statuses: getRunNodeStatusesFromDisk(root, flowId, runId) });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace-tree") {
      try {
        json(res, 200, getWorkspaceTree(root));
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/model-lists") {
      try {
        json(res, 200, readModelListsFromDisk(root));
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ui-context") {
      try {
        json(res, 200, { workspaceRoot: root });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agentflow-config") {
      try {
        const cfg = readAgentflowUserConfigObject();
        const opencodeProvider = typeof cfg.opencodeProvider === "string" ? cfg.opencodeProvider : "";
        json(res, 200, { opencodeProvider });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agentflow-config") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const raw = payload.opencodeProvider;
      const opencodeProvider = typeof raw === "string" ? raw.trim() : "";
      try {
        const cfgPath = getAgentflowUserConfigAbs();
        const prev = readAgentflowUserConfigObject();
        const next = { ...prev };
        if (opencodeProvider) next.opencodeProvider = opencodeProvider;
        else delete next.opencodeProvider;
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, JSON.stringify(next, null, 2), "utf-8");
        await updateModelLists(root);
        json(res, 200, {
          success: true,
          opencodeProvider: opencodeProvider || "",
          modelLists: readModelListsFromDisk(root),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/update-model-lists") {
      try {
        let opencodeProviderOverride = "";
        const raw = await readBody(req);
        if (raw && String(raw).trim()) {
          try {
            const payload = JSON.parse(raw);
            const o = payload?.opencodeProvider;
            if (typeof o === "string") opencodeProviderOverride = o.trim();
          } catch {
            /* 忽略非 JSON body，仍按 config 拉取 */
          }
        }
        await updateModelLists(root, { opencodeProviderOverride });
        json(res, 200, { success: true, modelLists: readModelListsFromDisk(root) });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/nodes") {
      const flowId = url.searchParams.get("flowId");
      const flowSource = url.searchParams.get("flowSource") || "user";
      const lang = url.searchParams.get("lang") || "en";
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      if (!isValidFlowSourceRead(flowSource)) {
        json(res, 400, { error: "Invalid flowSource" });
        return;
      }
      const nodesArchived = url.searchParams.get("archived") === "1";
      try {
        const { setLanguage } = await import("./i18n.mjs");
        setLanguage(lang);
        json(res, 200, listNodesJson(root, flowId, flowSource, { archived: nodesArchived }));
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/flow") {
      const flowId = url.searchParams.get("flowId");
      const flowSource = url.searchParams.get("flowSource") || "user";
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      if (!isValidFlowSourceRead(flowSource)) {
        json(res, 400, { error: "Invalid flowSource" });
        return;
      }
      const flowArchived = url.searchParams.get("archived") === "1";
      const result = readFlowJson(root, flowId, flowSource, { archived: flowArchived });
      if (result.error) {
        json(res, 404, result);
        return;
      }
      json(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flow") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = payload.flowId;
      const flowSource = payload.flowSource || "user";
      const flowYaml = payload.flowYaml;
      if (!flowId || typeof flowId !== "string") {
        json(res, 400, { error: "Missing or invalid flowId" });
        return;
      }
      if (!isValidFlowSourceWrite(flowSource)) {
        json(res, 400, { error: "Invalid flowSource (use user or workspace; builtin is read-only)" });
        return;
      }
      if (typeof flowYaml !== "string") {
        json(res, 400, { error: "Missing or invalid flowYaml" });
        return;
      }
      const flowArchived = Boolean(payload.flowArchived);
      const result = writeFlowYaml(root, flowId, flowSource, flowYaml, { archived: flowArchived });
      if (!result.success) {
        json(res, 400, result);
        return;
      }
      json(res, 200, { success: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flow-editor-sync") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = payload.flowId;
      const flowSource = payload.flowSource || "user";
      if (!flowId || typeof flowId !== "string") {
        json(res, 400, { error: "Missing or invalid flowId" });
        return;
      }
      if (!isValidFlowSourceRead(flowSource)) {
        json(res, 400, { error: "Invalid flowSource" });
        return;
      }
      const flowArchived = Boolean(payload.flowArchived);
      broadcastFlowEditorSync(flowId, flowSource, flowArchived);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/flow-editor-sync-events") {
      const flowId = url.searchParams.get("flowId");
      const flowSource = url.searchParams.get("flowSource") || "user";
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      if (!isValidFlowSourceRead(flowSource)) {
        json(res, 400, { error: "Invalid flowSource" });
        return;
      }
      const flowArchived = url.searchParams.get("archived") === "1";
      const key = flowEditorSyncKey(flowId, flowSource, flowArchived);
      let set = flowEditorSyncSubscribers.get(key);
      if (!set) {
        set = new Set();
        flowEditorSyncSubscribers.set(key, set);
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });
      res.write(": connected\n\n");
      set.add(res);
      const detach = () => {
        try {
          set.delete(res);
          if (set.size === 0) flowEditorSyncSubscribers.delete(key);
        } catch (_) {}
      };
      req.on("close", detach);
      res.on("close", detach);
      return;
    }

    /* 轮询替代 SSE：客户端传上次已知的 version，若服务端 version 更大则返回 changed:true */
    if (req.method === "GET" && url.pathname === "/api/flow-editor-sync-poll") {
      const flowId = url.searchParams.get("flowId");
      const flowSource = url.searchParams.get("flowSource") || "user";
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      const flowArchived = url.searchParams.get("archived") === "1";
      const key = flowEditorSyncKey(flowId, flowSource, flowArchived);
      const serverVer = flowEditorSyncVersions.get(key) ?? 0;
      const clientVer = parseInt(url.searchParams.get("v") ?? "0", 10) || 0;
      json(res, 200, { version: serverVer, changed: serverVer > clientVer });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flow/move") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = payload.flowId;
      const fromSource = payload.fromSource;
      const toSource = payload.toSource;
      if (!flowId || typeof flowId !== "string") {
        json(res, 400, { error: "Missing or invalid flowId" });
        return;
      }
      if (fromSource !== "user" && fromSource !== "workspace") {
        json(res, 400, { error: "Invalid fromSource" });
        return;
      }
      if (toSource !== "user" && toSource !== "workspace") {
        json(res, 400, { error: "Invalid toSource" });
        return;
      }
      const result = moveFlowDirectory(root, flowId.trim(), fromSource, toSource);
      if (!result.success) {
        json(res, 400, { error: result.error || "Move failed" });
        return;
      }
      json(res, 200, { success: true, flowId: flowId.trim(), flowSource: result.flowSource });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flow/archive") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = typeof payload.flowId === "string" ? payload.flowId.trim() : "";
      const flowSource = payload.flowSource || "user";
      const confirm = typeof payload.confirmFlowId === "string" ? payload.confirmFlowId.trim() : "";
      if (!flowId) {
        json(res, 400, { error: "Missing or invalid flowId" });
        return;
      }
      if (confirm !== flowId) {
        json(res, 400, { error: "确认名称与流水线 ID 不一致" });
        return;
      }
      if (flowSource !== "user" && flowSource !== "workspace") {
        json(res, 400, { error: "仅支持归档用户目录或工作区流水线" });
        return;
      }
      const result = archiveFlowPipeline(root, flowId, flowSource);
      if (!result.success) {
        json(res, 400, { error: result.error || "归档失败" });
        return;
      }
      json(res, 200, { success: true, flowId, flowSource, archived: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flow/delete") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = typeof payload.flowId === "string" ? payload.flowId.trim() : "";
      const flowSource = payload.flowSource || "user";
      const confirm = typeof payload.confirmFlowId === "string" ? payload.confirmFlowId.trim() : "";
      const flowArchived = Boolean(payload.flowArchived);
      if (!flowId) {
        json(res, 400, { error: "Missing or invalid flowId" });
        return;
      }
      if (confirm !== flowId) {
        json(res, 400, { error: "确认名称与流水线 ID 不一致" });
        return;
      }
      if (flowSource !== "user" && flowSource !== "workspace") {
        json(res, 400, { error: "仅支持删除用户目录或工作区流水线" });
        return;
      }
      const result = deleteFlowPipeline(root, flowId, flowSource, { archived: flowArchived });
      if (!result.success) {
        json(res, 400, { error: result.error || "删除失败" });
        return;
      }
      json(res, 200, { success: true, flowId, flowSource, deleted: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flow/run") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = typeof payload.flowId === "string" ? payload.flowId.trim() : "";
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      const runUuid = typeof payload.uuid === "string" ? payload.uuid.trim() : "";
      if (activeFlowRuns.has(flowId)) {
        json(res, 409, { error: "该流水线已在运行中" });
        return;
      }

      const agentflowBin = path.join(PACKAGE_ROOT, "bin", "agentflow.mjs");
      const args = [agentflowBin, "apply", flowId];
      if (runUuid) args.push(runUuid);
      args.push("--machine-readable", "--workspace-root", root);
      if (payload.force !== false) args.push("--force");

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });
      try {
        res.socket?.setNoDelay?.(true);
      } catch (_) {}

      let responseEnded = false;
      const endSafe = () => {
        if (responseEnded) return;
        responseEnded = true;
        activeFlowRuns.delete(flowId);
        try {
          res.end();
        } catch (_) {}
      };
      const writeLine = (obj) => {
        if (responseEnded) return;
        try { res.write(JSON.stringify(obj) + "\n"); } catch (_) {}
      };

      let child;
      try {
        child = spawn(process.execPath, args, {
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, FORCE_COLOR: "0" },
        });
      } catch (e) {
        writeLine({ type: "error", message: `启动失败: ${e.message}` });
        endSafe();
        return;
      }

      /** @type {{ child: import("child_process").ChildProcess, runUuid: string | null }} */
      const runEntry = { child, runUuid: runUuid || null };
      activeFlowRuns.set(flowId, runEntry);
      log.debug(`[ui] flow/run: spawned pid=${child.pid} flowId=${flowId}${runUuid ? ` uuid=${runUuid}` : ""}`);

      let stdoutBuf = "";
      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString("utf8");
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            if (evt && evt.event === "apply-start" && typeof evt.uuid === "string" && evt.uuid.trim()) {
              runEntry.runUuid = evt.uuid.trim();
            }
            writeLine({ type: "event", ...evt });
          } catch {
            writeLine({ type: "log", text: line });
          }
        }
      });

      let stderrBuf = "";
      child.stderr.on("data", (chunk) => {
        stderrBuf += chunk.toString("utf8");
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          writeLine({ type: "log", text: line });
        }
      });

      child.on("close", (code) => {
        if (stderrBuf.trim()) writeLine({ type: "log", text: stderrBuf.trim() });
        if (stdoutBuf.trim()) {
          try {
            const evt = JSON.parse(stdoutBuf.trim());
            writeLine({ type: "event", ...evt });
          } catch {
            writeLine({ type: "log", text: stdoutBuf.trim() });
          }
        }
        writeLine({ type: "done", exitCode: code ?? 0 });
        endSafe();
      });

      child.on("error", (e) => {
        writeLine({ type: "error", message: e.message });
        endSafe();
      });

      req.on("close", () => {
        if (!responseEnded && runEntry.child && !runEntry.child.killed) {
          try {
            runEntry.child.kill("SIGTERM");
          } catch (_) {}
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flow/run/stop") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = typeof payload.flowId === "string" ? payload.flowId.trim() : "";
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      const entry = activeFlowRuns.get(flowId);
      if (!entry || !entry.child) {
        json(res, 404, { error: "该流水线未在运行" });
        return;
      }
      try {
        entry.child.kill("SIGTERM");
      } catch (_) {}
      const uuid = entry.runUuid;
      activeFlowRuns.delete(flowId);
      if (uuid) {
        try {
          const runDir = getRunDir(root, flowId, uuid);
          fs.mkdirSync(runDir, { recursive: true });
          fs.writeFileSync(
            path.join(runDir, RUN_INTERRUPTED_FILENAME),
            JSON.stringify({ reason: "user_stop", at: Date.now() }, null, 2),
            "utf-8",
          );
        } catch (e) {
          log.debug(`[ui] flow/run/stop: could not write ${RUN_INTERRUPTED_FILENAME}: ${e && e.message}`);
        }
      }
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/composer-agent") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const prompt = payload.prompt;
      const model = payload.model;
      const phaseRole = typeof payload.phaseRole === "string" ? payload.phaseRole.trim() : "";
      if (typeof prompt !== "string" || !prompt.trim()) {
        json(res, 400, { error: "Missing or empty prompt" });
        return;
      }
      if (typeof model !== "string" && model != null) {
        json(res, 400, { error: "Invalid model" });
        return;
      }

      const flowIdRaw = payload.flowId;
      const flowSourceRaw = payload.flowSource;
      const hasFlowId = flowIdRaw != null && String(flowIdRaw).trim() !== "";
      const hasFlowSource = flowSourceRaw != null && String(flowSourceRaw).trim() !== "";
      if (hasFlowId !== hasFlowSource) {
        json(res, 400, { error: "flowId and flowSource must both be set or both omitted" });
        return;
      }

      const threadRaw = Array.isArray(payload.thread) ? payload.thread : [];
      const thread = threadRaw
        .filter((m) => m && typeof m.text === "string" && m.text.trim() && (m.role === "user" || m.role === "assistant"))
        .map((m) => ({ role: m.role, text: String(m.text) }));

      let finalPrompt = prompt.trim();
      let cliWorkspace = root;
      let flowYamlAbs = null;
      let flowId = null;
      let flowSource = null;
      let instanceIds = [];
      let flowContextForMultiStep = null;

      if (hasFlowId) {
        flowId = String(flowIdRaw).trim();
        flowSource = String(flowSourceRaw).trim();
        if (!isValidFlowSourceRead(flowSource)) {
          json(res, 400, { error: "Invalid flowSource" });
          return;
        }
        const flowArchived = Boolean(payload.flowArchived);
        const yamlRes = getFlowYamlAbs(root, flowId, flowSource, { archived: flowArchived });
        if (yamlRes.error || !yamlRes.path) {
          json(res, 400, { error: yamlRes.error || "Could not resolve flow.yaml" });
          return;
        }
        flowYamlAbs = yamlRes.path;
        let workspaceWriteDirAbs;
        let editorSyncFlowSource = flowSource;
        let flowDirForCli = path.dirname(flowYamlAbs);
        if (flowSource === "builtin") {
          const w = resolveFlowDirForWrite(root, flowId, "workspace");
          if (w.error || !w.flowDir) {
            json(res, 400, { error: w.error || "Could not resolve workspace flow directory" });
            return;
          }
          workspaceWriteDirAbs = w.flowDir;
          editorSyncFlowSource = "workspace";
          flowDirForCli = w.flowDir;
        }
        instanceIds = normalizeContextInstanceIds(payload.contextInstanceIds);

        const syncFs = editorSyncFlowSource ?? flowSource;
        const syncBody = { flowId, flowSource: syncFs };
        if (flowArchived) syncBody.flowArchived = true;
        const syncJsonArg = JSON.stringify(JSON.stringify(syncBody));

        // 基于用户意图动态加载 skill 上下文
        const multiStepIntents = detectIntents(prompt);
        const multiStepResources = loadResourcesForIntents(multiStepIntents, PACKAGE_ROOT);
        const flowPipelineDir = flowYamlAbs ? path.dirname(flowYamlAbs) : "";

        flowContextForMultiStep = {
          flowYamlAbs,
          flowId,
          flowSource,
          intents: multiStepIntents,
          skillsHint: multiStepResources.skillsHint,
          skillInjectionBlock: multiStepResources.hasContext
            ? buildSkillInjectionBlock(multiStepResources.skills, multiStepResources.references)
            : "",
          syncCurlHint: `curl -sS -X POST http://127.0.0.1:${uiPort}/api/flow-editor-sync -H 'Content-Type: application/json' -d ${syncJsonArg}`,
          composerSpecAbs: flowPipelineDir ? path.join(flowPipelineDir, COMPOSER_NODE_SPEC_FILENAME) : "",
          pipelineScriptsDirAbs: flowPipelineDir ? path.join(flowPipelineDir, "scripts") : "",
        };

        finalPrompt = buildComposerPromptWithFlowContext({
          flowYamlAbs,
          flowId,
          flowSource,
          workspaceWriteDirAbs,
          editorSyncFlowSource,
          instanceIds,
          userPrompt: prompt,
          uiPort,
          flowArchived,
          thread,
        });
        cliWorkspace = composerCliWorkspaceForFlowDir(root, flowDirForCli);
      }

      if (!hasFlowId && thread.length > 0) {
        finalPrompt = formatThreadHistory(thread) + "\n\n## 用户说明\n\n" + finalPrompt;
      }

      let child = null;
      let multiStepAbort = null;
      let responseEnded = false;
      let clientDisconnected = false;
      const endSafe = () => {
        if (responseEnded) return;
        responseEnded = true;
        try {
          res.end();
        } catch (_) {}
      };
      const killChild = () => {
        if (multiStepAbort) {
          multiStepAbort();
          return;
        }
        if (child && !child.killed) {
          try {
            child.kill("SIGTERM");
          } catch (_) {}
        }
      };

      // 先发送响应头，建立 NDJSON 流连接，避免后续分类阻塞导致前端超时
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });

      const onStreamEvent = (ev) => {
        if (responseEnded) return;
        try {
          res.write(JSON.stringify(ev) + "\n");
        } catch (_) {
          killChild();
        }
      };

      req.on("close", () => {
        clientDisconnected = true;
        if (!responseEnded) killChild();
      });

      onStreamEvent({ type: "status", line: "正在分析任务…" });
      log.debug(`[ui] composer-agent: flowId=${flowId || "(none)"} model=${model || "default"} promptLen=${finalPrompt.length}`);

      const hasPhaseContext = payload.phaseContext && typeof payload.phaseContext === "object" && typeof payload.phaseContext.phaseIndex === "number";
      let useMultiStep;
      try {
        useMultiStep = hasPhaseContext || ((await shouldUseMultiStep({ flowYamlAbs, userPrompt: prompt.trim(), cliWorkspace })) && !payload.singleStep);
      } catch (classifyErr) {
        log.debug(`[ui] composer classify error: ${classifyErr.message}`);
        onStreamEvent({ type: "error", message: `[CLASSIFY_FAIL] 任务分类失败: ${classifyErr.message}`, code: "CLASSIFY_FAIL" });
        endSafe();
        return;
      }

      log.debug(`[ui] composer mode: ${useMultiStep ? "multi-step" : "single-step"}`);

      if (useMultiStep) {
        try {
          onStreamEvent({ type: "status", line: "多步模式启动…" });
          const phaseContext = payload.phaseContext && typeof payload.phaseContext === "object" ? payload.phaseContext : undefined;
          const handle = startComposerMultiStep({
            uiWorkspaceRoot: root,
            cliWorkspace,
            userPrompt: prompt.trim(),
            fullPrompt: finalPrompt,
            modelKey: typeof model === "string" ? model.trim() : "",
            flowYamlAbs,
            flowId,
            flowSource,
            instanceIds,
            flowContext: flowContextForMultiStep,
            thread,
            phaseContext,
            phaseRole: phaseRole || undefined,
            force: true,
            onStreamEvent,
          });
          multiStepAbort = handle.abort;
          handle.finished
            .then(() => {
              if (!responseEnded) {
                if (flowId && flowSource) {
                  broadcastFlowEditorSync(flowId, flowSource, Boolean(payload.flowArchived));
                }
                try { res.write(JSON.stringify({ type: "done" }) + "\n"); } catch (_) {}
              }
              endSafe();
            })
            .catch((e) => {
              if (!responseEnded) {
                try {
                  res.write(JSON.stringify({ type: "error", message: (e && e.message) || String(e), code: "MULTI_STEP_FAIL" }) + "\n");
                } catch (_) {}
              }
              endSafe();
            });
        } catch (e) {
          try {
            res.write(JSON.stringify({ type: "error", message: (e && e.message) || String(e), code: "MULTI_STEP_INIT_FAIL" }) + "\n");
          } catch (_) {}
          endSafe();
        }
      } else {
        try {
          const handle = startComposerAgent({
            uiWorkspaceRoot: root,
            cliWorkspace,
            prompt: finalPrompt,
            modelKey: typeof model === "string" ? model.trim() : "",
            onStreamEvent,
          });
          child = handle.child;
          handle.finished
            .then(async () => {
              if (responseEnded) {
                endSafe();
                return;
              }
              if (flowYamlAbs && flowContextForMultiStep) {
                try {
                  await runComposerPostFlowValidationAndRepair({
                    uiWorkspaceRoot: root,
                    cliWorkspace,
                    flowYamlAbs,
                    flowContext: flowContextForMultiStep,
                    modelKey: typeof model === "string" ? model.trim() : "",
                    force: true,
                    onStreamEvent,
                    getAborted: () => clientDisconnected || responseEnded,
                    setCurrentChild: (c) => {
                      child = c;
                    },
                  });
                } catch (e) {
                  onStreamEvent({
                    type: "natural",
                    kind: "error",
                    text: `校验修复异常: ${(e && e.message) || String(e)}`,
                  });
                }
              }
              if (!responseEnded) {
                if (flowId && flowSource) {
                  broadcastFlowEditorSync(flowId, flowSource, Boolean(payload.flowArchived));
                }
                try { res.write(JSON.stringify({ type: "done" }) + "\n"); } catch (_) {}
              }
              endSafe();
            })
            .catch((e) => {
              if (!responseEnded) {
                try {
                  res.write(JSON.stringify({ type: "error", message: (e && e.message) || String(e), code: "SINGLE_STEP_FAIL" }) + "\n");
                } catch (_) {}
              }
              endSafe();
            });
        } catch (e) {
          try {
            res.write(JSON.stringify({ type: "error", message: (e && e.message) || String(e), code: "SINGLE_STEP_INIT_FAIL" }) + "\n");
          } catch (_) {}
          endSafe();
        }
      }
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET, POST" });
      res.end();
      return;
    }

    const safeRoot = path.resolve(staticDir);
    let rel = url.pathname.replace(/^\/+/, "") || "index.html";
    if (rel.includes("..") || path.isAbsolute(rel)) {
      res.writeHead(403);
      res.end();
      return;
    }
    let filePath = path.resolve(safeRoot, rel);
    if (filePath !== safeRoot && !filePath.startsWith(safeRoot + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      // 避免 /agentflow-icon.svg 缺失时回退成 index.html（浏览器当图片解析会破图）
      if (rel === "agentflow-icon.svg") {
        const pkgIcon = path.join(PACKAGE_ROOT, "builtin", "web-ui", "src", "assets", "agentflow-icon.svg");
        if (fs.existsSync(pkgIcon) && fs.statSync(pkgIcon).isFile()) {
          filePath = pkgIcon;
        }
      }
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      const fallback = path.join(staticDir, "index.html");
      if (fs.existsSync(fallback)) {
        filePath = fallback;
      } else {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": type, "Content-Length": data.length });
    res.end(data);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      log.debug(`[ui] server listening on 127.0.0.1:${port}, workspace=${root}, static=${staticDir}`);
      updateModelLists(root).catch(() => {});
      resolve(server);
    });
  });
}
