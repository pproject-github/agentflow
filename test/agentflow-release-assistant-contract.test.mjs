import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("release assistant contract always routes the original request through free-prompt-agent", async () => {
  const source = await readFile(new URL("../skills/agentflow-cli/SKILL.md", import.meta.url), "utf8");
  const section = source.slice(source.indexOf("## Release workflow (assistant)"));

  assert.match(section, /固定使用 `--action-id free-prompt-agent`/);
  assert.match(section, /用户原始输入[\s\S]*`--input prompt=/);
  assert.match(section, /不得直接选择原子 Action/);
  assert.match(section, /每次调用都生成独立的 `custom-.*` 时间线节点/);
});
