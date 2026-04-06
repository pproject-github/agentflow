#!/usr/bin/env node
/**
 * figma-restore 脚本单元测试：验证 URL 解析、节点遍历、参数处理、输出格式。
 * 不依赖真实 Figma Token，仅测试离线可验证的纯函数逻辑。
 *
 * 用法：node test-all.mjs
 * 退出码：0=全部通过 1=有失败
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractFileKey, extractNodeId } from "./fetch-figma-tree.mjs";
import { walkForExportNodes } from "./export-assets.mjs";
import { finalize } from "./finalize.mjs";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── 1. extractFileKey ────────────────────────────────────────

console.log("\n[fetch-figma-tree] extractFileKey");

assertEqual(
  extractFileKey("https://www.figma.com/design/ABC123def/MyFile?node-id=1-2"),
  "ABC123def",
  "标准 design URL",
);

assertEqual(
  extractFileKey("https://www.figma.com/file/XYZ789/Name"),
  "XYZ789",
  "旧版 file URL",
);

assertEqual(
  extractFileKey("https://google.com/"),
  null,
  "非 Figma URL 返回 null",
);

assertEqual(
  extractFileKey(""),
  null,
  "空字符串返回 null",
);

assertEqual(
  extractFileKey("https://www.figma.com/design/key-with-dash_underscore/file"),
  "key-with-dash_underscore",
  "key 含连字符和下划线",
);

// ── 2. extractNodeId ─────────────────────────────────────────

console.log("\n[fetch-figma-tree] extractNodeId");

assertEqual(
  extractNodeId("https://www.figma.com/design/ABC/Name?node-id=10-20"),
  "10:20",
  "下划线格式转冒号",
);

assertEqual(
  extractNodeId("https://www.figma.com/design/ABC/Name?node-id=10%3A20"),
  "10:20",
  "URL encoded 冒号",
);

assertEqual(
  extractNodeId("https://www.figma.com/design/ABC/Name"),
  null,
  "无 node-id 返回 null",
);

assertEqual(
  extractNodeId("https://www.figma.com/design/ABC/Name?node-id=0-1&viewport=100,200,0.5"),
  "0:1",
  "node-id 后有其他参数",
);

// ── 3. walkForExportNodes ────────────────────────────────────

console.log("\n[export-assets] walkForExportNodes");

const mockTree = {
  id: "0:0",
  name: "Document",
  children: [
    {
      id: "1:1",
      name: "Page 1",
      children: [
        { id: "2:1", name: "img_export_hero", children: [] },
        { id: "2:2", name: "icon_export_close", children: [] },
        { id: "2:3", name: "SomeFrame", children: [
          { id: "3:1", name: "IMG_EXPORT_banner", children: [] },
          { id: "3:2", name: "NormalText", children: [] },
        ]},
      ],
    },
  ],
};

const exportNodes = walkForExportNodes(mockTree);

assertEqual(exportNodes.length, 3, "找到 3 个导出节点");

assert(
  exportNodes.some((n) => n.id === "2:1" && n.name === "img_export_hero"),
  "包含 img_export_hero",
);

assert(
  exportNodes.some((n) => n.id === "2:2" && n.name === "icon_export_close"),
  "包含 icon_export_close",
);

assert(
  exportNodes.some((n) => n.id === "3:1" && n.name === "IMG_EXPORT_banner"),
  "包含大写 IMG_EXPORT_banner（不区分大小写）",
);

const emptyResult = walkForExportNodes(null);
assertEqual(emptyResult.length, 0, "null 输入返回空数组");

const noExports = walkForExportNodes({
  id: "0:0",
  name: "Doc",
  children: [{ id: "1:1", name: "NormalFrame", children: [] }],
});
assertEqual(noExports.length, 0, "无导出节点返回空数组");

// ── 4. finalize ──────────────────────────────────────────────

console.log("\n[finalize] finalize()");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-test-"));
const planPath = path.join(tmpDir, "restore_plan.json");
const planData = {
  fileKey: "TEST_KEY",
  treeJsonPath: "/tmp/tree.json",
  dfsOrder: [
    { id: "1:1", name: "Frame", type: "FRAME", role: "frame" },
    { id: "2:1", name: "img_export_hero", type: "RECTANGLE", role: "asset" },
  ],
  exportNodeIds: [{ id: "2:1", name: "img_export_hero" }],
};
fs.writeFileSync(planPath, JSON.stringify(planData), "utf8");

const exportReport = JSON.stringify({
  stage: "export_img_icon_assets",
  fileKey: "TEST_KEY",
  exported: [{ id: "2:1", path: "/tmp/export_2_1.png", name: "img_export_hero" }],
  totalRequested: 1,
});

const result1 = finalize({ restorePlan: planPath, exportResult: exportReport });
assertEqual(result1.stage, "finalize_figma_restore", "stage 正确");
assertEqual(result1.dfsStepsCount, 2, "dfsStepsCount = 2");
assertEqual(result1.exportAssetsCount, 1, "exportAssetsCount = 1");
assertEqual(result1.done, true, "done = true（dfsOrder 非空）");

const result2 = finalize({ restorePlan: "", exportResult: "" });
assertEqual(result2.done, false, "无 plan 时 done = false");
assertEqual(result2.dfsStepsCount, 0, "无 plan 时 dfsStepsCount = 0");

const result3 = finalize({ restorePlan: "/nonexistent/path.json", exportResult: "not json" });
assertEqual(result3.done, false, "plan 文件不存在时 done = false");
assert(result3.exportReport?.raw != null, "exportResult 非 JSON 时保留 raw 文本");

// cleanup
try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) { /* noop */ }

// ── 5. CLI 参数格式测试（通过 spawn 验证脚本可独立运行）─────

console.log("\n[scripts] CLI 可独立执行");

import { execSync } from "node:child_process";
const scriptsDir = path.dirname(new URL(import.meta.url).pathname);

try {
  const out = execSync(`node ${path.join(scriptsDir, "fetch-figma-tree.mjs")} 2>&1 || true`, {
    encoding: "utf8",
    timeout: 5000,
  });
  assert(out.includes("figmaToken 为空"), "fetch-figma-tree 无参数时报 token 错误");
} catch {
  failed++;
  console.error("  ✗ fetch-figma-tree.mjs 无法执行");
}

try {
  const out = execSync(`node ${path.join(scriptsDir, "export-assets.mjs")} 2>&1 || true`, {
    encoding: "utf8",
    timeout: 5000,
  });
  assert(out.includes("figmaToken 为空"), "export-assets 无参数时报 token 错误");
} catch {
  failed++;
  console.error("  ✗ export-assets.mjs 无法执行");
}

try {
  const finalizeOut = execSync(
    `node ${path.join(scriptsDir, "finalize.mjs")}`,
    { encoding: "utf8", timeout: 5000 },
  );
  const parsed = JSON.parse(finalizeOut.trim());
  assertEqual(parsed.stage, "finalize_figma_restore", "finalize 无参数正常输出");
} catch (e) {
  failed++;
  console.error("  ✗ finalize.mjs 无法执行: " + (e.message || e));
}

// ── 汇总 ────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`合计：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
