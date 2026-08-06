import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexPath = new URL("../builtin/web-ui/index.html", import.meta.url);
const appPath = new URL("../builtin/web-ui/src/App.jsx", import.meta.url);

test("AgentFlow owns the complete startup loading experience", async () => {
  const [indexSource, appSource] = await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(appPath, "utf8"),
  ]);

  assert.match(indexSource, /id="root">[\s\S]*class="af-app-loading"/);
  assert.match(indexSource, /class="af-app-loading__mark"[^>]*aria-hidden="true"[\s\S]*<svg/);
  assert.doesNotMatch(indexSource, /class="af-app-loading__mark"><img/);
  assert.match(indexSource, /AgentFlow 正在启动/);
  assert.match(indexSource, /正在连接工作空间…/);
  assert.match(appSource, /function AppLoading\(\)/);
  assert.match(appSource, /if \(auth\.loading\) \{\s*return <AppLoading \/>;/);
  assert.doesNotMatch(appSource, /af-auth-panel">Loading\.\.\./);
});
