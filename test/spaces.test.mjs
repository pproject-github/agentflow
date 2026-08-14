import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Space provides persistent wiki routes while preserving owner visibility controls", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-spaces-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, workspaceServer, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?spaces=${nonce}`),
      import(`../bin/lib/workspace-server.mjs?spaces=${nonce}`),
      import(`../bin/lib/ui-server.mjs?spaces=${nonce}`),
    ]);
    const owner = loginOrCreateUser("space-owner", "space-password");
    const outsider = loginOrCreateUser("space-outsider", "space-password");
    const share = workspaceServer.createDisplayShareRecord({
      userId: owner.user.userId,
      flowId: "source-flow",
      flowSource: "user",
      title: "Source dashboard",
      layout: "single",
      nodeIds: ["display"],
      expiresInDays: 1,
    });
    assert.notEqual(share.expiresAt, "");

    server = await startUiServer({
      workspaceRoot: path.join(tempRoot, "workspace"),
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const auth = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

    const createResponse = await fetch(`${baseUrl}/api/spaces`, {
      method: "POST",
      headers: auth(owner.token),
      body: JSON.stringify({ title: "情报空间", slug: "insight", visibility: "public" }),
    });
    assert.equal(createResponse.status, 200);
    const created = await createResponse.json();
    assert.equal(created.space.slug, "insight");

    const pageResponse = await fetch(`${baseUrl}/api/spaces/page`, {
      method: "POST",
      headers: auth(owner.token),
      body: JSON.stringify({ spaceId: created.space.id, shareId: share.id, title: "商店日报", path: "/stores" }),
    });
    assert.equal(pageResponse.status, 200);
    const published = await pageResponse.json();
    assert.equal(published.page.path, "/stores");
    assert.equal(published.space.pages.length, 1);
    assert.equal(workspaceServer.readDisplayShares()[share.id].expiresAt, "", "Space pages must not inherit share TTL");

    const publicResponse = await fetch(`${baseUrl}/api/spaces/public?owner=${owner.user.userId}&slug=insight`);
    assert.equal(publicResponse.status, 200);
    assert.equal((await publicResponse.json()).space.pages[0].title, "商店日报");

    const shortenResponse = await fetch(`${baseUrl}/api/display/share`, {
      method: "PATCH",
      headers: auth(owner.token),
      body: JSON.stringify({ id: share.id, expiresMode: "days", expiresInDays: 1 }),
    });
    assert.equal(shortenResponse.status, 409, "a Space page cannot silently become a temporary link");

    const privateResponse = await fetch(`${baseUrl}/api/spaces`, {
      method: "PATCH",
      headers: auth(owner.token),
      body: JSON.stringify({ id: created.space.id, visibility: "private" }),
    });
    assert.equal(privateResponse.status, 200);
    assert.equal(workspaceServer.readDisplayShares()[share.id].visibility, "private");

    const anonymousPrivate = await fetch(`${baseUrl}/api/spaces/public?owner=${owner.user.userId}&slug=insight`);
    assert.equal(anonymousPrivate.status, 404);
    const ownerPrivate = await fetch(`${baseUrl}/api/spaces/public?owner=${owner.user.userId}&slug=insight`, {
      headers: auth(owner.token),
    });
    assert.equal(ownerPrivate.status, 200);
    const outsiderShare = await fetch(`${baseUrl}/api/display/share?id=${share.id}`, { headers: auth(outsider.token) });
    assert.equal(outsiderShare.status, 404);

    const removeResponse = await fetch(`${baseUrl}/api/spaces/page?spaceId=${created.space.id}&pageId=${published.page.id}`, {
      method: "DELETE",
      headers: auth(owner.token),
    });
    assert.equal(removeResponse.status, 200);
    assert.equal((await removeResponse.json()).space.pages.length, 0);

    const deleteShareResponse = await fetch(`${baseUrl}/api/display/share?id=${share.id}`, {
      method: "DELETE",
      headers: auth(owner.token),
    });
    assert.equal(deleteShareResponse.status, 200, "the source share can be revoked after the Space page is removed");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
