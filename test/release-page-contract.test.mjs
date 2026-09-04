import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("release page does not contain a development-machine workspace fallback", () => {
  const source = fs.readFileSync(new URL("../builtin/web-ui/src/pages/ReleasePage.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\/Users\//);
  assert.match(source, /releaseWorkspaces/);
  assert.match(source, /尚未配置发版工程/);
});

test("release page derives membership context and switches version via query", () => {
  const source = fs.readFileSync(new URL("../builtin/web-ui/src/pages/ReleasePage.jsx", import.meta.url), "utf8");
  assert.match(source, /releaseAccess/);
  assert.match(source, /membership/);
  assert.match(source, /membershipKey/);
  assert.match(source, /handleReleaseAccess/);
  assert.match(source, /af-release-version-switcher/);
  assert.match(source, /canWrite/);
  assert.match(source, /无发版操作权限/);
});
