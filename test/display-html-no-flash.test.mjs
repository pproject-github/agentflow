import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspaceSource = await readFile(
  new URL("../builtin/web-ui/src/pages/WorkspacePage.jsx", import.meta.url),
  "utf8",
);

// 用户需求点：HTML 全屏展示时，偶尔会闪一下露出后面的画布，像整页刷新了。
// 原因不是刷新——是重读展示文件时先把内容清空，渲染落到 Loading 分支，iframe 被摘出
// DOM 再挂回来。displayReloadKey 每次运行/协作同步都会变，所以一跑流程就闪。
test("展示内容重读期间不清空旧内容，iframe 不会被摘掉再挂回来", () => {
  const bodies = workspaceSource.split("useEffect(() => {");
  const readers = bodies.filter((chunk) => chunk.includes("readWorkspaceTextFile(") && chunk.includes("setFileLoading(true)"));
  assert.ok(readers.length >= 2, `期望至少两处展示文件读取，实际 ${readers.length}`);
  for (const chunk of readers) {
    // 只看"确定要读这个文件"之后到发起读取之间那段；早退分支里的清空是对的（没有文件可显示）
    const beforeFetch = chunk.slice(
      chunk.indexOf("setFileLoading(true)"),
      chunk.indexOf("readWorkspaceTextFile("),
    );
    assert.doesNotMatch(
      beforeFetch,
      /setFileContent\(""\)/,
      "重读前清空内容会让 iframe 被卸载，全屏预览就会闪出背后的画布",
    );
  }
});

test("内容没变时不写 state，srcDoc 不重写", () => {
  assert.match(workspaceSource, /setFileContent\(\(previous\) => \(previous === text \? previous : text\)\)/);
});

test("只有手上没有这个文件的内容时才显示 Loading 占位", () => {
  assert.match(workspaceSource, /const hasLoadedThisFile = Boolean\(filePath\) && loadedFilePath === filePath/);
  assert.match(workspaceSource, /if \(fileLoading && !hasLoadedThisFile\) return/);
  // 换成另一个文件时不能把上一份接着显示
  assert.match(workspaceSource, /filePath \? \(hasLoadedThisFile \? fileContent : ""\) : unwrappedRawContent/);
});
