import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("独立安装的 agentflow-cli skill 自带 runtime，并在无 npm/PATH 环境运行 DSL", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-skill-runtime-")));
  const installedSkill = path.join(tempRoot, "skills", "agentflow-cli");
  const cleanWorkspace = path.join(tempRoot, "workspace");
  fs.cpSync(path.resolve("skills/agentflow-cli"), installedSkill, { recursive: true });
  fs.mkdirSync(cleanWorkspace, { recursive: true });
  const cliPath = path.join(installedSkill, "scripts", "agentflow-cli.mjs");
  const packageVersion = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf-8")).version;
  const cleanEnv = {
    ...process.env,
    PATH: "",
    HOME: path.join(tempRoot, "home"),
    AGENTFLOW_AUTH_FILE: path.join(tempRoot, "home", ".agentflow", "auth.json"),
  };
  delete cleanEnv.AGENTFLOW_PACKAGE_ROOT;
  delete cleanEnv.AGENTFLOW_TOKEN;
  delete cleanEnv.AGENTFLOW_SESSION_TOKEN;

  try {
    const bundled = await execFileAsync(process.execPath, [cliPath, "config"], {
      cwd: cleanWorkspace,
      env: cleanEnv,
    });
    const bundledConfig = JSON.parse(bundled.stdout);
    assert.deepEqual(bundledConfig.localRuntime, {
      available: true,
      root: path.join(installedSkill, "runtime"),
      version: packageVersion,
    });
    assert.equal(bundledConfig.hasToken, false);

    const flowDir = path.join(cleanWorkspace, "sample-flow");
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(flowDir, "workspace.flow.js"), `
import { display, flow, provide } from "agentflow/flow";

const message = provide.str("内容", { value: "SkillHub runtime works" });
const result = display.markdown("结果", { content: message.value });
export const run = flow("Run", result);
`.trimStart(), "utf-8");

    const lint = await execFileAsync(process.execPath, [
      cliPath, "dsl-lint", "--file", flowDir,
    ], {
      cwd: cleanWorkspace,
      env: cleanEnv,
    });
    assert.deepEqual(JSON.parse(lint.stdout).errors, []);

    const layout = await execFileAsync(process.execPath, [
      cliPath, "dsl-layout", "--file", flowDir, "--all",
    ], {
      cwd: cleanWorkspace,
      env: cleanEnv,
    });
    const layoutResult = JSON.parse(layout.stdout);
    assert.equal(layoutResult.mode, "all");
    assert.equal(layoutResult.nodeCount, 3);
    assert.equal(fs.existsSync(path.join(flowDir, "workspace.layout.json")), true);

    const located = await execFileAsync(process.execPath, [
      cliPath,
      "config",
      "--agentflow-package-root", path.resolve("."),
    ], {
      cwd: cleanWorkspace,
      env: cleanEnv,
    });
    const locatedConfig = JSON.parse(located.stdout);
    assert.deepEqual(locatedConfig.localRuntime, {
      available: true,
      root: path.resolve("."),
      version: packageVersion,
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
