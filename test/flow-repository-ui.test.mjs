import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("主资源入口统一展示为流程仓库", () => {
  const marketplace = source("builtin/web-ui/src/pages/MarketplacePage.jsx");
  const zh = JSON.parse(source("builtin/web-ui/src/i18n/locales/zh/common.json"));
  const en = JSON.parse(source("builtin/web-ui/src/i18n/locales/en/common.json"));

  assert.equal(zh.nav.marketplace, "流程仓库");
  assert.equal(en.nav.marketplace, "Flow Repository");
  assert.match(marketplace, /<h1>流程仓库<\/h1>/);
  assert.doesNotMatch(marketplace, />在流程中使用<\/button>/);
  assert.doesNotMatch(marketplace, /<small>输入<\/small>|<small>安装<\/small>|<small>用户<\/small>/);
  assert.match(marketplace, /<small>使用<\/small>/);
  assert.match(marketplace, /Stable/);
  assert.match(marketplace, /Draft/);
  assert.match(marketplace, /releaseState/);
  assert.match(marketplace, /hasUnpublishedChanges/);
  assert.doesNotMatch(marketplace, /已安装 \/ 可用/);
  assert.doesNotMatch(marketplace, /id: "installed"/);
});

test("流程仓库节点先预览，再选择目标流程加入调整态", () => {
  const marketplace = source("builtin/web-ui/src/pages/MarketplacePage.jsx");
  const workspace = source("builtin/web-ui/src/pages/WorkspacePage.jsx");

  assert.match(marketplace, /item\.resourceType === "node" \? "node"/);
  assert.match(workspace, /marketplaceAction === "add-node"/);
  assert.match(workspace, /marketplaceNodeDefinitionId/);
  assert.match(workspace, /addNodeFromDefinition\(definition, \{ openProperties: true \}\)/);
  assert.match(workspace, /已从流程仓库添加节点/);
});
