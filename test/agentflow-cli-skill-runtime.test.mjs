import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("独立安装的 agentflow-cli skill 能诊断并显式定位本地 runtime", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-skill-runtime-")));
  const installedSkill = path.join(tempRoot, "skills", "agentflow-cli");
  const cleanWorkspace = path.join(tempRoot, "workspace");
  fs.cpSync(path.resolve("skills/agentflow-cli"), installedSkill, { recursive: true });
  fs.mkdirSync(cleanWorkspace, { recursive: true });
  const cliPath = path.join(installedSkill, "scripts", "agentflow-cli.mjs");
  const packageVersion = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf-8")).version;
  const cleanEnv = { ...process.env, PATH: "" };
  delete cleanEnv.AGENTFLOW_PACKAGE_ROOT;

  try {
    const missing = await execFileAsync(process.execPath, [cliPath, "config"], {
      cwd: cleanWorkspace,
      env: cleanEnv,
    });
    const missingConfig = JSON.parse(missing.stdout);
    assert.equal(missingConfig.localRuntime.available, false);
    assert.match(missingConfig.localRuntime.error, /Install\/update the agentflow CLI/);

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
