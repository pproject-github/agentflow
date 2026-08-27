import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("regular users enter through CAS while admin password login and Project ownership stay separate", () => {
  const app = source("builtin/web-ui/src/App.jsx");
  const sidebar = source("builtin/web-ui/src/layout/Sidebar.jsx");
  const users = source("builtin/web-ui/src/pages/AdminUsersPage.jsx");

  assert.match(app, /path === "\/admin\/login"/);
  assert.match(app, /\/api\/auth\/cas\/login/);
  assert.match(app, /\/api\/admin\/auth\/login/);
  assert.match(app, /管理员登录/);
  assert.match(sidebar, /用户与归属/);
  assert.match(users, /\/api\/admin\/projects\/reassign/);
  assert.match(users, /目标 CAS 用户/);
  assert.match(users, /历史运行审计仍保留原执行人/);
});
