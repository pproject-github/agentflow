import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { scheduleTargetUrl, scheduleOwnerQueryParam } = await import("../builtin/web-ui/src/scheduleNavigation.js");

test("别人的排程链接带 adminOwnerId，自己的不带", () => {
  // flowSource=user 在服务端是按发请求的人解析目录的。不带 owner，管理员就是
  // 去自己的 pipelines 里找别人的 flowId——只会 404。
  const other = scheduleTargetUrl(
    { flowId: "f3d627019a577", flowSource: "user", kind: "workspace", scheduleNodeId: "watchSchedule", ownerUserId: "xingqiwei" },
    "wangfang1",
  );
  assert.match(other, /adminOwnerId=xingqiwei/);
  assert.match(other, /focusNodeId=watchSchedule/);

  // 自己的排程带上 adminOwnerId 会让 workspaceWritable 变 false，等于把自己的
  // 流程锁成只读。
  const mine = scheduleTargetUrl(
    { flowId: "f3d627019a577", flowSource: "user", kind: "workspace", scheduleNodeId: "watchSchedule", ownerUserId: "wangfang1" },
    "wangfang1",
  );
  assert.doesNotMatch(mine, /adminOwnerId/);

  // 非管理员视图下 ownerUserId 本来就是空的。
  assert.doesNotMatch(scheduleTargetUrl({ flowId: "x", ownerUserId: "" }, ""), /adminOwnerId/);
  assert.equal(scheduleTargetUrl({ flowSource: "user" }, "admin"), "");
});

test("两个入口用同一个判断，不会一个带一个不带", async () => {
  const page = await readFile(new URL("../builtin/web-ui/src/pages/SchedulesPage.jsx", import.meta.url), "utf8");
  assert.match(page, /scheduleTargetUrl\(schedule, currentUserId\)/);
  assert.match(page, /scheduleOwnerQueryParam\(inspectingSchedule, currentUserId\)/);
  assert.doesNotMatch(page, /adminView && inspectingSchedule\.ownerUserId/);

  const server = await readFile(new URL("../bin/lib/ui-server.mjs", import.meta.url), "utf8");
  assert.match(server, /adminView: false,\s*\n\s*currentUserId,/);
  assert.match(server, /adminView: true,[\s\S]{0,200}?currentUserId,/);
});

test("同一个人时 scheduleOwnerQueryParam 返回 null", () => {
  assert.equal(scheduleOwnerQueryParam({ ownerUserId: "a" }, "a"), null);
  assert.equal(scheduleOwnerQueryParam({ ownerUserId: "a" }, "b"), "a");
  assert.equal(scheduleOwnerQueryParam({}, "b"), null);
});
