import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseNodeFrontmatter } from "../bin/lib/catalog-flows.mjs";
import { flowFilesToGraph } from "../bin/lib/flow-dsl/index.mjs";
import {
  workspaceDisplayKindFromInstance,
  workspaceDisplayTextFilePath,
  workspaceWriteDisplayContent,
} from "../bin/lib/workspace-server.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("display_code 是带展示元数据的一等内置节点", () => {
  const source = fs.readFileSync(path.join(repoRoot, "builtin", "nodes", "display_code.md"), "utf-8");
  const definition = parseNodeFrontmatter(source);
  assert.equal(definition.runtime, "native");
  assert.deepEqual(definition.input.map((slot) => `${slot.type}:${slot.name}`), [
    "node:prev",
    "text:content",
    "text:language",
    "text:fileName",
    "bool:wrap",
  ]);
  assert.deepEqual(definition.output.map((slot) => `${slot.type}:${slot.name}`), ["text:content", "node:next"]);
});

test("Flow DSL 支持 display.code 并保留语言、文件名和换行配置", () => {
  const graph = flowFilesToGraph({
    source: `
import { display, flow } from "agentflow/flow";

const source = display.code("生成代码", {
  content: "const answer = 42;",
  language: "javascript",
  fileName: "answer.mjs",
  wrap: false,
});

export const run = flow("code-demo", source);
`,
    layout: {},
    nodeMeta: {},
    files: {},
  });
  const instance = Object.values(graph.instances).find((item) => item.definitionId === "display_code");
  assert.ok(instance);
  const values = Object.fromEntries(instance.input.map((slot) => [slot.name, slot.value ?? slot.default]));
  assert.equal(values.content, "const answer = 42;");
  assert.equal(values.language, "javascript");
  assert.equal(values.fileName, "answer.mjs");
  assert.equal(values.wrap, "false");
});

test("代码展示执行回填只更新 content，不覆盖展示元数据", () => {
  const instance = {
    definitionId: "display_code",
    input: [
      { type: "text", name: "content", value: "old" },
      { type: "text", name: "language", value: "kotlin" },
      { type: "text", name: "fileName", value: "Main.kt" },
      { type: "bool", name: "wrap", value: "true" },
    ],
    output: [{ type: "text", name: "content", value: "old" }, { type: "node", name: "next", value: "" }],
  };
  const updated = workspaceWriteDisplayContent(instance, "fun main() = println(42)");
  const values = Object.fromEntries(updated.input.map((slot) => [slot.name, slot.value ?? slot.default]));
  assert.equal(updated.body, "fun main() = println(42)");
  assert.equal(values.content, "fun main() = println(42)");
  assert.equal(values.language, "kotlin");
  assert.equal(values.fileName, "Main.kt");
  assert.equal(values.wrap, "true");
});

test("代码展示支持常见源码文件并进入分享/MCP 类型识别", () => {
  assert.equal(workspaceDisplayKindFromInstance({ definitionId: "display_code", body: "const x = 1;" }), "code");
  assert.equal(workspaceDisplayTextFilePath("outputs/app.tsx", "code"), "outputs/app.tsx");
  assert.equal(workspaceDisplayTextFilePath("outputs/app.exe", "code"), "");

  const workspaceSource = fs.readFileSync(path.join(repoRoot, "builtin", "web-ui", "src", "pages", "WorkspacePage.jsx"), "utf-8");
  const publicSource = fs.readFileSync(path.join(repoRoot, "builtin", "web-ui", "src", "pages", "DisplayPage.jsx"), "utf-8");
  const rendererSource = fs.readFileSync(path.join(repoRoot, "builtin", "web-ui", "src", "displayRenderers.jsx"), "utf-8");
  const mcpSource = fs.readFileSync(path.join(repoRoot, "bin", "lib", "mcp-server.mjs"), "utf-8");
  assert.match(workspaceSource, /display_code/);
  assert.match(workspaceSource, /CodeDisplayContent/);
  assert.match(workspaceSource, /\["js", "jsx", "tsx"\]\.includes\(ext\)[\s\S]*?"display_react_app"/);
  assert.match(publicSource, /CodeDisplayContent/);
  assert.match(rendererSource, /af-code-display__lines/);
  assert.match(rendererSource, /navigator\.clipboard\.writeText[\s\S]*?catch \{[\s\S]*?document\.execCommand\("copy"\)/);
  assert.match(mcpSource, /display_code/);
});
