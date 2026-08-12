/**
 * 给 AI 看的那份节点编写参考，必须和运行时真实契约一致。
 *
 * 这条测试是有由来的：`agentflow-node-dsl` 的旧版本曾经长期教的是 `node.yaml` + `runtime.entry`
 * + `scripts/run.mjs`，还让人跑已经退休的 `agentflow run`。文档 wiki 早就改成了 `index.mjs`，
 * skill 没跟上。后果不是「文档不准」这么轻——AI 读哪份就写出哪种格式，于是让模型生成一个
 * 自定义节点这条路是断的，而且断得很隐蔽：写出来的包扫描不到，面板上什么都不出现。
 *
 * 所以这里把 skill 里的示例**真的喂给解析器**，而不是比对字符串。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  nodePackageExportsRun,
  readNodePackageManifest,
} from "../bin/lib/node-package-manifest.mjs";

const SKILL = fs.readFileSync(
  path.resolve(import.meta.dirname, "..", "skills", "agentflow-node-dsl", "SKILL.md"),
  "utf-8",
);

/** skill 里第一个 ```js 代码块——那是「最小完整例子」。 */
function firstJsBlock(text) {
  const match = /```js\n([\s\S]*?)```/.exec(text);
  assert.ok(match, "skill 里找不到 js 示例");
  return match[1];
}

test("skill 的最小示例能被真解析器读出清单", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-node-skill-"));
  try {
    fs.writeFileSync(path.join(dir, "index.mjs"), firstJsBlock(SKILL), "utf-8");
    const manifest = readNodePackageManifest(dir, () => null);
    assert.ok(manifest, "示例读不出清单——AI 照着写出来的包不会出现在面板上");
    assert.equal(manifest.id, "count_lines");
    assert.equal(manifest.version, "1.0.0");
    assert.equal(manifest.baseDefinitionId, "tool_nodejs");
    // 控制槽自动前置，示例声明的槽跟在后面
    assert.deepEqual(manifest.input.map((s) => s.name), ["prev", "filePath"]);
    assert.deepEqual(manifest.output.map((s) => s.name), ["next", "total"]);
    assert.equal(nodePackageExportsRun(path.join(dir, "index.mjs")), true, "示例必须导出 run");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("skill 里演示的三种错误写法确实是错的", () => {
  // 「声明必须是纯字面量」这条如果只是写着好看，AI 迟早会踩
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-node-skill-bad-"));
  try {
    for (const [label, decl] of [
      ["变量引用", 'const T = "text";\nexport default { id: "x", version: "1.0.0", inputs: { day: { type: T } } };'],
      ["展开", 'const base = {};\nexport default { ...base, id: "x", version: "1.0.0" };'],
      ["成员访问", 'const pkg = { version: "1.0.0" };\nexport default { id: "x", version: pkg.version };'],
    ]) {
      fs.writeFileSync(path.join(dir, "index.mjs"), decl, "utf-8");
      assert.throws(
        () => readNodePackageManifest(dir, () => null),
        // 三种写法各有各的报错措辞；共同点是必须带上 `export default` 这个定位前缀，
        // 让人知道错在声明里的哪一处，而不是丢一句「解析失败」
        (e) => /^export default/.test(String(e?.message || e)),
        `${label} 应当带位置报错，而不是静默变成空清单`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("skill 不再教已经退休的东西", () => {
  // 只扫「别做的事」之前的部分——那一节的存在意义就是点名这些用法，把它算进来等于
  // 禁止 skill 警告用户别踩坑
  const dontSection = SKILL.indexOf("## 别做的事");
  assert.ok(dontSection > 0, "skill 应当有「别做的事」一节，明确点名已退休的用法");
  const teaching = SKILL.slice(0, dontSection);
  // 每一条都对应一个真实的失效原因，不是风格洁癖
  const banned = [
    // 老 manifest 格式：新包一律 index.mjs，写 node.yaml 只会得到一个没有实现的壳
    [/^\s*[-*]?\s*.*创建一个独立节点包目录.*node\.yaml/m, "把 node.yaml 当成必需项"],
    [/runtime\.entry.*指向/, "runtime.entry / scripts/run.mjs 是老 manifest 字段"],
    // apply/resume/replay 全部返回「Legacy Start/End Pipeline execution has been retired.」
    [/`agentflow run`|agentflow apply/, "Start/End Pipeline 执行栈已退休"],
    // install-node 往 flow.yaml 写依赖，代码流程根本不读 flow.yaml
    [/install-node[^\n]*\n[\s\S]{0,80}validate/, "install-node 对代码流程无效"],
  ];
  for (const [pattern, why] of banned) {
    assert.ok(!pattern.test(teaching), `skill 里还留着已退休的用法（${why}）：${pattern}`);
  }
  // 反过来，「别做的事」必须真的点到这几样，否则 AI 无从知道它们为什么不能用
  for (const mention of ["node.yaml", "runtime.entry", "install-node", "agentflow run"]) {
    assert.ok(SKILL.slice(dontSection).includes(mention), `「别做的事」漏了 ${mention}`);
  }
});

test("skill 点明了两个最容易踩的运行时契约", () => {
  // outputs 是路径不是值；stdout 只在没写结果文件时才当结果
  assert.match(SKILL, /outputs\.<name>.*路径/, "没写清 outputs 是路径而不是值");
  assert.match(SKILL, /stdout|console\.log/, "没交代 stdout 和写文件的关系");
  assert.match(SKILL, /静态解析/, "没交代声明不会被执行");
});
