import assert from "node:assert/strict";
import test from "node:test";

import { chunkMarkdownByBytes, sendWecomGroupMarkdown } from "../bin/lib/wecom.mjs";

const GROUP_MAX_BYTES = 4096;

function bytes(text) {
  return Buffer.byteLength(text, "utf8");
}

function stripLabels(chunks) {
  return chunks.map((chunk) => chunk.replace(/^（\d+\/\d+）\n/, ""));
}

test("keeps a short markdown message untouched", () => {
  const content = "# 标题\n\n- 一条\n- 两条";
  assert.deepEqual(chunkMarkdownByBytes(content, GROUP_MAX_BYTES), [content]);
});

test("splits by UTF-8 bytes, not characters", () => {
  // 中文一个字符 3 字节：按字符数看没超，按字节数看超了。
  const content = Array.from({ length: 700 }, () => "报表").join("\n");
  assert.ok(content.length < GROUP_MAX_BYTES, "字符数应当在限制内");
  assert.ok(bytes(content) > GROUP_MAX_BYTES, "字节数应当超出限制");
  const chunks = chunkMarkdownByBytes(content, GROUP_MAX_BYTES);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(bytes(chunk) <= GROUP_MAX_BYTES, `分段 ${bytes(chunk)} 字节超限`);
});

test("preserves the whole message across chunks and labels each part", () => {
  const lines = Array.from({ length: 400 }, (_, index) => `- 第 ${index} 行报告内容`);
  const content = lines.join("\n");
  const chunks = chunkMarkdownByBytes(content, GROUP_MAX_BYTES);
  assert.ok(chunks.length > 1);
  chunks.forEach((chunk, index) => {
    assert.match(chunk, new RegExp(`^（${index + 1}/${chunks.length}）\\n`));
  });
  const rejoined = stripLabels(chunks).join("\n");
  for (const line of lines) assert.ok(rejoined.includes(line), `丢了一行: ${line}`);
});

test("splits a single overlong line with no newline to break on", () => {
  const content = "啊".repeat(3000);
  const chunks = chunkMarkdownByBytes(content, GROUP_MAX_BYTES);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(bytes(chunk) <= GROUP_MAX_BYTES);
  assert.equal(stripLabels(chunks).join(""), content);
});

test("sends one webhook request per chunk", async (t) => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ errcode: 0, errmsg: "ok" }) };
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const content = Array.from({ length: 400 }, (_, index) => `- 第 ${index} 行报告内容`).join("\n");
  const result = await sendWecomGroupMarkdown({ markdown: content, webhookKey: "k" });
  assert.equal(result.ok, true);
  assert.ok(result.parts > 1);
  assert.equal(calls.length, result.parts);
  for (const call of calls) {
    assert.equal(call.body.msgtype, "markdown");
    assert.ok(bytes(call.body.markdown.content) <= GROUP_MAX_BYTES);
  }
});

test("reports which part failed when WeCom rejects one chunk", async (t) => {
  const previousFetch = globalThis.fetch;
  let seen = 0;
  globalThis.fetch = async () => {
    seen += 1;
    const body = seen === 2
      ? { errcode: 40058, errmsg: "markdown.content exceed max length 4096" }
      : { errcode: 0, errmsg: "ok" };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const content = Array.from({ length: 400 }, (_, index) => `- 第 ${index} 行报告内容`).join("\n");
  await assert.rejects(
    sendWecomGroupMarkdown({ markdown: content, webhookKey: "k" }),
    /send wecom group markdown part 2\/\d+ failed/,
  );
});
