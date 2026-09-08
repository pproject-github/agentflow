import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverPath = new URL("../bin/lib/ui-server.mjs", import.meta.url);
const appPath = new URL("../builtin/web-ui/src/App.jsx", import.meta.url);

test("CAS 登录的每种失败都留下日志，并且页面上不是同一句话", async () => {
  const [server, app] = await Promise.all([
    readFile(serverPath, "utf8"),
    readFile(appPath, "utf8"),
  ]);

  // 没有日志就只能靠猜：三条路径在页面上曾经长得一模一样。
  assert.match(server, /if \(!flow\) \{[\s\S]{0,400}?log\.warn\(`\[auth\] CAS 回调没有登录流水/);
  assert.match(server, /log\.warn\(`\[auth\] CAS 登录被拒/);

  // CAS 认了人、但用户名落不进 AgentFlow 的 ID 规则，跟 ticket 无效是两回事：
  // 前者重登一万次也没用。
  assert.match(server, /result\.status === 400 \? "cas_user_unmappable"/);

  for (const reason of ["cas_forbidden", "cas_unavailable", "cas_user_unmappable", "cas_flow_expired"]) {
    assert.match(app, new RegExp(`authError === "${reason}"`), `前端没有区分 ${reason}`);
  }
  assert.doesNotMatch(app, /登录状态已过期或 ticket 无效/);
});
