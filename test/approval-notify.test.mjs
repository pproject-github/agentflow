import assert from "node:assert/strict";
import test from "node:test";

import { approvalText, notifyApproval } from "../bin/lib/approval-notify.mjs";

const RECORD = {
  interruptId: "int_abc",
  flowId: "android-policy-watch",
  requestedBy: "wangfang1",
  reason: "radar_gate",
  approvers: ["xingqiwei"],
  value: { content: "- **play-16kb-page-size** state `risk` → `ok`\n  改成已满足会关掉这条的告警", format: "markdown" },
};

function harness(overrides = {}) {
  const sent = [];
  return {
    sent,
    deps: {
      readGlobalEnv: () => ({
        WECOM_CORP_ID: "x", WECOM_APP_SECRET: "y", WECOM_AGENT_ID: "1",
        AGENTFLOW_SCHEDULE_ALERT_FALLBACK_USER: "wangfang1",
        AGENTFLOW_PUBLIC_BASE_URL: "https://af.example.com",
        ...overrides.env,
      }),
      readAuthUsers: () => ({ xingqiwei: { username: "xingqiwei" }, hesiqi: { username: "hesiqi" } }),
      readWecomBinding: (userId) => (overrides.bindings === undefined
        ? { xingqiwei: { wecomUserId: "00111" }, wangfang1: { wecomUserId: "00320" } }[userId]
        : overrides.bindings[userId]) || null,
      sendAppMarkdown: async (params) => { sent.push({ via: "app", ...params }); },
      sendGroupMarkdown: async (params) => { sent.push({ via: "group", ...params }); },
      ...overrides.deps,
    },
  };
}

// 只有一句「有审批待处理」等于没通知——人得知道要看什么才会去看
test("正文说清楚谁、为什么、要看什么", () => {
  const text = approvalText(RECORD, { baseUrl: "https://af.example.com" });
  assert.match(text, /待你确认：雷达追踪项变更/);
  assert.match(text, /流程：android-policy-watch/);
  assert.match(text, /发起：wangfang1/);
  assert.match(text, /play-16kb-page-size/);
  assert.match(text, /\[去审批\]\(https:\/\/af\.example\.com\/approvals\)/);
});

test("认不出的 reason 原样带出来，不要吞成空", () => {
  assert.match(approvalText({ ...RECORD, reason: "custom_thing" }), /待你确认：custom_thing/);
});

test("正文过长时截断，细节留给审批页", () => {
  const long = { ...RECORD, value: { content: "x".repeat(2000) } };
  assert.ok(approvalText(long).includes("…"));
  assert.ok(approvalText(long).length < 1200);
});

test("推给指定的审批人", async () => {
  const h = harness();
  const result = await notifyApproval(RECORD, { deps: h.deps });
  assert.equal(result.ok, true);
  assert.deepEqual(h.sent.map((item) => item.toUser), ["00111"]);
});

// 没指定审批人的中断是「谁看见谁处理」，群发只会变成噪音
test("没有 approvers 时不发", async () => {
  const h = harness();
  const result = await notifyApproval({ ...RECORD, approvers: [] }, { deps: h.deps });
  assert.equal(result.reason, "no_approvers");
  assert.equal(h.sent.length, 0);
});

// 审批卡住比通知发错人贵得多
test("审批人没绑企微时落到兜底账号，并写明是谁的", async () => {
  const h = harness({ bindings: { wangfang1: { wecomUserId: "00320" } } });
  await notifyApproval({ ...RECORD, approvers: ["hesiqi"] }, { deps: h.deps });
  assert.equal(h.sent[0].toUser, "00320");
  assert.match(h.sent[0].markdown, /hesiqi 没有绑定企业微信，转发给你/);
});

test("三级都没有收件人时如实返回，不假装发了", async () => {
  const h = harness({ bindings: {}, env: { AGENTFLOW_SCHEDULE_ALERT_FALLBACK_USER: "" } });
  const result = await notifyApproval(RECORD, { deps: h.deps });
  assert.equal(result.reason, "no_recipient");
  assert.deepEqual(result.unbound, ["xingqiwei"]);
});

test("全局开关关掉后一条都不发", async () => {
  const h = harness({ env: { AGENTFLOW_APPROVAL_NOTIFY: "off" } });
  assert.equal((await notifyApproval(RECORD, { deps: h.deps })).reason, "disabled");
  assert.equal(h.sent.length, 0);
});

// 通知挂了不该让审批创建失败——页面上还看得见，运行不该因此崩掉
test("单个收件人发失败不抛异常，其余照发", async () => {
  let calls = 0;
  const h = harness({
    env: { AGENTFLOW_APPROVAL_WEBHOOK: "https://qyapi.weixin.qq.com/x" },
    deps: {
      sendAppMarkdown: async () => { calls += 1; throw new Error("invalid user"); },
    },
  });
  const result = await notifyApproval(RECORD, { deps: h.deps });
  assert.equal(calls, 1);
  // 群里发出去了，所以整体算成功
  assert.equal(result.ok, true);
  assert.ok(result.sent.some((item) => item.via === "group" && item.ok));
});
