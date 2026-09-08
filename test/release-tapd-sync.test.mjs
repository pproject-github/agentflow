import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("extracts version iterations and syncs them idempotently", async () => {
  const { syncTapdReleases } = await import("../bin/lib/release-tapd.mjs");
  const writes = [];
  const result = await syncTapdReleases({
    project: "Likee",
    platform: "Android",
    tapd: { workspaceId: "33202860" },
    fetchIterations: async () => ({ body: { data: [
      { Iteration: { id: "it-564", name: "Likee Android&iOS V5.64（9/2）", startdate: "2026-08-12", enddate: "2026-09-02" } },
      { Iteration: { id: "it-invalid", name: "非版本迭代", startdate: "2026-08-01", enddate: "2026-08-02" } },
    ] } }),
    upsertRelease: (input) => { writes.push(input); return { created: writes.length === 1, release: input }; },
  });
  assert.equal(result.created, 1);
  assert.equal(result.skipped, 1);
  assert.equal(writes[0].version, "5.64");
  assert.equal(writes[0].releaseDate, "2026-09-02");
  assert.equal(writes[0].tapdIterationId, "it-564");
});

test("requires a TAPD workspace before syncing", async () => {
  const { syncTapdReleases } = await import("../bin/lib/release-tapd.mjs");
  await assert.rejects(
    syncTapdReleases({ project: "Likee", platform: "Android", tapd: {} }),
    /workspace/i,
  );
});

test("resolves an optional TAPD category before listing iterations", async () => {
  const { syncTapdReleases } = await import("../bin/lib/release-tapd.mjs");
  let requestedCategory = "";
  let requestedIterationCategory = "";
  const result = await syncTapdReleases({
    project: "Likee",
    platform: "Android",
    tapd: { workspaceId: "33202860", categoryName: "版本" },
    fetchCategories: async ({ categoryName }) => {
      requestedCategory = categoryName;
      return { body: { data: [{ WorkitemType: { id: "cat-release", name: "版本" } }] } };
    },
    fetchIterations: async ({ categoryId }) => {
      requestedIterationCategory = categoryId;
      return { body: { data: [] } };
    },
    upsertRelease: () => ({}),
  });
  assert.equal(requestedCategory, "版本");
  assert.equal(requestedIterationCategory, "cat-release");
  assert.equal(result.total, 0);
});

test("fetches TAPD iterations through the HTTP API with a bearer access token", async () => {
  const { defaultFetchIterations } = await import("../bin/lib/release-tapd.mjs?http-api");
  let request;
  const server = http.createServer((req, res) => {
    request = req;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: 1, data: [{ Iteration: { id: "it-1", name: "Likee V5.64", enddate: "2026-09-02" } }] }));
  });
  const port = await listen(server);
  try {
    const payload = await defaultFetchIterations({
      workspaceId: "33202860",
      apiBaseUrl: `http://127.0.0.1:${port}`,
      accessToken: "tapd-test-token",
    });
    assert.equal(payload.data[0].Iteration.id, "it-1");
    assert.equal(request.headers.authorization, "Bearer tapd-test-token");
    assert.match(request.url, /workspace_id=33202860/);
  } finally {
    await close(server);
  }
});

test("sync TAPD iteration lookup uses the HTTP API instead of bs-tapd", async () => {
  const { defaultFetchIterationsSync } = await import("../bin/lib/release-tapd.mjs?http-api-sync");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tapd-curl-"));
  const capturePath = path.join(tempRoot, "args.txt");
  const curlPath = path.join(tempRoot, "curl");
  fs.writeFileSync(curlPath, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(capturePath)}\nprintf '%s' '${JSON.stringify({ status: 1, data: [{ Iteration: { id: "it-1", name: "Likee V5.64", enddate: "2026-09-02" } }] })}'\n`);
  fs.chmodSync(curlPath, 0o755);
  const previousCurl = process.env.AGENTFLOW_CURL_BIN;
  process.env.AGENTFLOW_CURL_BIN = curlPath;
  try {
    const payload = defaultFetchIterationsSync({
      workspaceId: "33202860",
      apiBaseUrl: "https://api.tapd.cn",
      accessToken: "tapd-test-token",
    });
    assert.equal(payload.data[0].Iteration.id, "it-1");
    const args = fs.readFileSync(capturePath, "utf8");
    assert.match(args, /Authorization: Bearer tapd-test-token/);
    assert.match(args, /https:\/\/api\.tapd\.cn\/iterations\?workspace_id=33202860/);
  } finally {
    if (previousCurl == null) delete process.env.AGENTFLOW_CURL_BIN;
    else process.env.AGENTFLOW_CURL_BIN = previousCurl;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
