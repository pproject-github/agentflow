import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { CURSOR_NON_MODEL_PATTERNS, getAgentflowUserConfigAbs, getModelListsAbs } from "./paths.mjs";

/** GUI / 精简 PATH 下常见找不到 Homebrew 等目录下的 CLI，为子进程补上 */
function envWithCommonBinPaths() {
  const env = { ...process.env };
  const extra = [
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (extra.length === 0) return env;
  const sep = path.delimiter;
  const prefix = extra.join(sep);
  env.PATH = env.PATH && String(env.PATH).trim() !== "" ? `${prefix}${sep}${env.PATH}` : prefix;
  return env;
}

export function stripAnsiModelList(text) {
  return String(text || "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export function isCursorModelLine(line) {
  const lower = line.toLowerCase();
  if (lower.startsWith("name") || lower === "models" || lower === "model") return false;
  if (lower.startsWith("error") || lower.startsWith("fatal") || lower.startsWith("warning:")) return false;
  if (CURSOR_NON_MODEL_PATTERNS.some((re) => re.test(line))) return false;
  return line.length > 0 && line.length < 200;
}

export function parseModelLines(stdout) {
  const cleaned = stripAnsiModelList(stdout);
  const lines = cleaned.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.filter(isCursorModelLine);
}

export function runCursorModels(workspaceRoot) {
  return new Promise((resolve) => {
    const agentCmd = process.env.CURSOR_AGENT_CMD || "agent";
    const child = spawn(agentCmd, ["models"], { cwd: workspaceRoot, shell: false });
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk) => {
      out += chunk.toString("utf-8");
    });
    child.on("close", (code) => (code === 0 ? resolve(parseModelLines(out)) : resolve([])));
    child.on("error", () => resolve([]));
  });
}

/**
 * Claude Code CLI 不暴露模型列表子命令 — 使用内置列表。
 * 新模型发布时更新此常量即可。
 */
export const BUILTIN_CLAUDE_CODE_MODELS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

export function getBuiltinClaudeCodeModels() {
  return BUILTIN_CLAUDE_CODE_MODELS.slice();
}

/**
 * 探测 Claude Code CLI 是否可用（仅判定能否启动，不拉取模型）。
 */
export function probeClaudeCodeAvailable() {
  return new Promise((resolve) => {
    const claudeCmd = process.env.CLAUDE_CODE_CMD || "claude";
    const child = spawn(claudeCmd, ["--version"], {
      shell: false,
      env: envWithCommonBinPaths(),
    });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.on("close", (code) => finish(code === 0));
    child.on("error", () => finish(false));
    setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
      finish(false);
    }, 5000);
  });
}

export function runOpencodeModels(workspaceRoot, provider) {
  if (!provider || !String(provider).trim()) return Promise.resolve([]);
  return new Promise((resolve) => {
    const opencodeCmd = process.env.OPENCODE_CMD || "opencode";
    const child = spawn(opencodeCmd, ["models", String(provider).trim()], {
      cwd: workspaceRoot,
      shell: false,
      env: envWithCommonBinPaths(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("close", (code) => {
      if (code === 0) resolve(parseModelLines(stdout || stderr));
      else resolve([]);
    });
    child.on("error", () => resolve([]));
  });
}

/**
 * 拉取 Cursor / OpenCode 模型列表并写入 ~/agentflow/model-lists.json
 * @param {string} workspaceRoot
 * @param {{ opencodeProviderOverride?: string }} [opts]
 */
export async function updateModelLists(workspaceRoot, opts = {}) {
  const root = path.resolve(workspaceRoot);
  const override =
    typeof opts.opencodeProviderOverride === "string" ? opts.opencodeProviderOverride.trim() : "";
  let opencodeProvider = override;
  if (!opencodeProvider) {
    try {
      const configPath = getAgentflowUserConfigAbs();
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (typeof config?.opencodeProvider === "string") opencodeProvider = config.opencodeProvider.trim();
      }
    } catch (_) {}
  }

  const cachePath = getModelListsAbs();
  let prev = {
    cursor: [],
    opencode: [],
    claudeCode: [],
    cursorFetchedAt: null,
    opencodeFetchedAt: null,
    claudeCodeFetchedAt: null,
  };
  try {
    if (fs.existsSync(cachePath)) {
      const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) prev = { ...prev, ...raw };
    }
  } catch (_) {}

  const [cursorRaw, opencode, claudeCodeAvailable] = await Promise.all([
    runCursorModels(root),
    runOpencodeModels(root, opencodeProvider),
    probeClaudeCodeAvailable(),
  ]);
  const cursor = cursorRaw.filter(isCursorModelLine);
  const claudeCode = claudeCodeAvailable ? getBuiltinClaudeCodeModels() : [];
  const now = Date.now();

  const data = {
    cursor: cursor.length > 0 ? cursor : prev.cursor ?? [],
    opencode: opencode.length > 0 ? opencode : prev.opencode ?? [],
    claudeCode: claudeCode.length > 0 ? claudeCode : prev.claudeCode ?? [],
    cursorFetchedAt: cursor.length > 0 ? now : prev.cursorFetchedAt ?? null,
    opencodeFetchedAt: opencode.length > 0 ? now : prev.opencodeFetchedAt ?? null,
    claudeCodeFetchedAt: claudeCode.length > 0 ? now : prev.claudeCodeFetchedAt ?? null,
  };

  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (_) {}

  return { cursor: data.cursor, opencode: data.opencode, claudeCode: data.claudeCode };
}
