#!/usr/bin/env node
/**
 * 往数据根里写一块示例雷达板，用来看页面长什么样。
 *
 * 这是**示例数据**，不是抓取结果：日期按运行当天推算，所以随时跑都有合理的剩余天数。
 * 真板由定时流程写，格式和这里完全一样。
 *
 *   node scripts/seed-radar-demo.mjs            写 demo-compliance
 *   node scripts/seed-radar-demo.mjs --board=x  换个板 id
 *   node scripts/seed-radar-demo.mjs --remove   删掉它
 */
import fs from "fs";
import path from "path";

import { appendRadarEvent, writeRadarBoardMeta, writeRadarShard } from "../bin/lib/radar.mjs";
import { getAgentflowDataRoot } from "../bin/lib/paths.mjs";

const args = process.argv.slice(2);
const board = (args.find((arg) => arg.startsWith("--board=")) || "--board=demo-compliance").split("=")[1];
const remove = args.includes("--remove");

const DAY = 24 * 60 * 60 * 1000;
const today = new Date();
today.setHours(0, 0, 0, 0);
const day = (offset) => {
  const date = new Date(today.getTime() + offset * DAY);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

if (remove) {
  fs.rmSync(path.join(getAgentflowDataRoot(), "radar", "boards", board), { recursive: true, force: true });
  fs.rmSync(path.join(getAgentflowDataRoot(), "radar", "events", `${board}.jsonl`), { force: true });
  console.log(`已删除示例板 ${board}`);
  process.exit(0);
}

const meta = writeRadarBoardMeta(board, {
  title: "发版合规（示例）",
  icon: "flight_takeoff",
  // 版本车：有效截止日靠它算出来，没有它就只能用政策日期
  trains: [
    { version: "v42.0", cutoff: day(14) },
    { version: "v43.0", cutoff: day(44) },
    { version: "v44.0", cutoff: day(75) },
    { version: "v45.0", cutoff: day(105) },
  ],
  spec: {
    view: "runway",
    views: ["runway", "board", "table"],
    encode: {
      lane: "title",
      end: "effectiveDue",
      color: "state",
      marker: "cutoffDate",
      value: { field: "daysLeft", format: "剩 {} 天" },
      group: "platform",
      badges: ["platform", "owner"],
    },
    detail: {
      sections: [
        { title: "现状", fields: ["current", "required", "owner"] },
        { title: "来源", fields: ["source", "flow"] },
      ],
    },
  },
});

// 两条流程各写各的片：这块板由它们俩一起喂，谁也覆盖不了谁
const android = writeRadarShard(board, "play-policy-watch", {
  flow: { flowSource: "user", scheduleNodeId: "daily" },
  fetchFailures: 0,
  rows: [
    {
      id: "android16-edge", title: "Android 16 边到边强制生效", platform: "Android",
      owner: "", due: day(51), state: "risk",
      current: "37 个页面仍依赖系统栏内边距", required: "全量适配 edge-to-edge",
      source: "Android 16 行为变更（targetSdk 36）",
    },
    {
      id: "play-target-36", title: "Play 目标 API 36 宽限期结束", platform: "Android",
      owner: "xingqiwei", due: day(51), state: "warn",
      current: "targetSdk 35", required: "targetSdk 36",
      source: "Google Play 目标 API 等级要求",
    },
    {
      id: "aep", title: "AEP 结束时间（口径待确认）", platform: "待定",
      owner: "wangfang1", due: day(81), state: "idle",
      current: "未接入监控", required: "确认口径后补数据源",
    },
    {
      id: "data-safety-photo", title: "照片与视频权限政策", platform: "Android",
      owner: "hesiqi", due: day(110), state: "warn",
      current: "表单已更新，权限声明待复核", required: "权限声明与表单一致",
      source: "Google Play 照片和视频权限政策",
    },
  ],
});

const ios = writeRadarShard(board, "appstore-policy-watch", {
  flow: { flowSource: "user", scheduleNodeId: "weekly" },
  // 每周跑一次的流程，放宽哑掉判定，否则周一到周三都会被说成哑了
  staleAfterMs: 10 * 24 * 60 * 60 * 1000,
  fetchFailures: 0,
  rows: [
    {
      id: "ios-sdk", title: "App Store 要求使用新版 SDK 构建", platform: "iOS",
      owner: "linguanhong", due: day(231), state: "risk",
      current: "Xcode 17.2", required: "Xcode 18+",
      source: "App Store 提交要求更新",
    },
    {
      id: "privacy-manifest", title: "隐私清单与 SDK 签名要求", platform: "iOS",
      owner: "linguanhong", due: day(-70), state: "ok",
      current: "全部三方 SDK 已带签名与清单", required: "PrivacyInfo.xcprivacy 完整",
      source: "Apple 隐私清单要求",
    },
  ],
});

for (const result of [meta, android, ios]) {
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
}

for (const event of [
  { kind: "new", item: "data-safety-photo", text: "发现新政策：照片和视频权限政策更新，已按仓库匹配到 Likee / imo" },
  { kind: "worse", item: "android16-edge", text: "边到边扫描新增 6 个未适配页面" },
  { kind: "better", item: "play-target-36", text: "targetSdkVersion 34 → 35，这一条从未开始变成进行中" },
  { kind: "moved", item: "play-target-36", text: "宽限期被推后 31 天，有效截止日从 v42.0 挪到 v43.0 封包" },
]) {
  appendRadarEvent(board, event);
}

console.log(`示例板已写入：${android.path}`);
console.log(`　　　　　　　${ios.path}`);
console.log(`打开 http://127.0.0.1:8765/radar?board=${board} 查看`);
