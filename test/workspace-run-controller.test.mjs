import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { createWorkspaceRunController } from "../bin/lib/workspace-run-controller.mjs";

function fakeChild(onKill = () => {}) {
  const signals = [];
  return {
    pid: 0,
    exitCode: null,
    signalCode: null,
    signals,
    kill(signal) {
      signals.push(signal);
      onKill(signal, this);
      return true;
    },
  };
}

test("workspace run stop waits until the run is actually finished", async () => {
  const run = createWorkspaceRunController({
    gracefulTimeoutMs: 100,
    forceTimeoutMs: 20,
  });
  const child = fakeChild();
  run.setChild(child);

  const stopping = run.stop();
  assert.equal(run.state, "stopping");
  assert.deepEqual(child.signals, ["SIGTERM"]);
  setTimeout(() => run.finish("stopped"), 5);

  const result = await stopping;
  assert.equal(result.stopped, true);
  assert.equal(result.forced, false);
  assert.equal(run.state, "stopped");
});

test("workspace run stop terminates a replacement child started during retry", async () => {
  const run = createWorkspaceRunController({
    gracefulTimeoutMs: 100,
    forceTimeoutMs: 20,
  });
  const first = fakeChild();
  const retry = fakeChild();
  run.setChild(first);

  const stopping = run.stop();
  run.setChild(retry);
  setTimeout(() => run.finish("stopped"), 5);

  const result = await stopping;
  assert.equal(result.stopped, true);
  assert.deepEqual(first.signals, ["SIGTERM"]);
  assert.deepEqual(retry.signals, ["SIGTERM"]);
});

test("workspace run stop escalates to SIGKILL after the grace period", async () => {
  let run;
  const child = fakeChild((signal) => {
    if (signal === "SIGKILL") setTimeout(() => run.finish("stopped"), 0);
  });
  run = createWorkspaceRunController({
    gracefulTimeoutMs: 5,
    forceTimeoutMs: 100,
  });
  run.setChild(child);

  const result = await run.stop();
  assert.equal(result.stopped, true);
  assert.equal(result.forced, true);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("workspace run stop reports timeout instead of claiming success", async () => {
  const run = createWorkspaceRunController({
    gracefulTimeoutMs: 5,
    forceTimeoutMs: 5,
  });
  const child = fakeChild();
  run.setChild(child);

  const result = await run.stop();
  assert.equal(result.stopped, false);
  assert.equal(result.timedOut, true);
  assert.equal(run.state, "stopping");
});

test("workspace run stop terminates the detached process group", {
  skip: process.platform === "win32",
}, async () => {
  const script = [
    'const { spawn } = require("node:child_process");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    "process.stdout.write(String(child.pid) + \"\\n\");",
    "setInterval(() => {}, 1000);",
  ].join("");
  const parent = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let grandchildPid = 0;
  try {
    grandchildPid = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for grandchild pid")), 1_000);
      parent.once("error", reject);
      parent.stdout.once("data", (chunk) => {
        clearTimeout(timer);
        resolve(Number(String(chunk).trim()));
      });
    });
    assert.ok(grandchildPid > 0);

    const run = createWorkspaceRunController({
      gracefulTimeoutMs: 1_000,
      forceTimeoutMs: 200,
    });
    run.setChild(parent, { processGroup: true });
    parent.once("close", () => run.finish("stopped"));

    const result = await run.stop();
    assert.equal(result.stopped, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.throws(() => process.kill(grandchildPid, 0));
  } finally {
    try {
      process.kill(-parent.pid, "SIGKILL");
    } catch {
      // The process group should already be gone.
    }
  }
});
