import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverPath = new URL("../bin/lib/ui-server.mjs", import.meta.url);

test("设备码授权的三步都留下日志", async () => {
  const source = await readFile(serverPath, "utf8");

  // 这三步以前全静默：线上有人说"授权了还是未授权"时，只能去 sessions.json
  // 按时间戳倒推是哪一秒兑换成功的。
  assert.match(source, /log\.info\(`\[auth\] CLI 授权请求已创建/);
  assert.match(source, /log\.info\(`\[auth\] CLI 授权被 \$\{user\.userId\}/);
  assert.match(source, /log\.info\(`\[auth\] CLI 授权已兑换/);
  assert.match(source, /log\.warn\(`\[auth\] CLI 授权兑换失败/);

  // pending 是每 3 秒一次的正常轮询，记了就是刷屏。
  assert.match(source, /result\.code !== "authorization_pending" && result\.code !== "slow_down"/);
});

test("日志不带 deviceCode / token / approvalNonce", async () => {
  const source = await readFile(serverPath, "utf8");
  for (const line of source.split("\n")) {
    if (!/log\.(info|warn)\(`\[auth\] CLI/.test(line)) continue;
    assert.doesNotMatch(line, /deviceCode|result\.token|approvalNonce/, `日志里带了凭据：${line.trim()}`);
  }
});
