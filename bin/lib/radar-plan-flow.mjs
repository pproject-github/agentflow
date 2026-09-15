/**
 * 让「规划一块雷达板」这件事本身也是一条流程。
 *
 * 在这之前，规划是服务端一个裸 prompt：spawn 一个 agent、转发 stdout、解析不出来就整轮白跑。
 * 指挥官造出来的东西是流程，它自己不是——所以没有 run 记录、没有节点级重试、没有执行面，
 * 规划过程本身也没法改。
 *
 * 现在它跑 `radar-plan` 这条真图。这里只管三件事：
 *
 * 1. **确保用户态有这条流程**。builtin 跑不了（`/api/workspace/run` 明确拒绝只读内置），
 *    所以模板要落成用户自己的一条。
 * 2. **把这次要问的话写进图**，而不是写进文件——图会随运行提交回去，「这次问了什么」
 *    就留在流程里了。
 * 3. **把跑出来的计划取回来**。
 *
 * 人改过这条流程就不再覆盖它：能改规划过程，是把规划做成流程的理由之一。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { radarPlanFile } from "./radar.mjs";

export const PLAN_FLOW_ID = "radar-plan";
export const PLAN_RUN_NODE_ID = "run";
/** 装进去时记一笔模板指纹。下次还对得上，就说明人没动过，可以刷新 */
const STAMP_FILE = ".radar-plan-template";

const sha = (text) => crypto.createHash("sha256").update(String(text || ""), "utf-8").digest("hex");

export function planTemplateFile() {
  return path.resolve(fileURLToPath(new URL("../../builtin/pipelines/radar-plan/workspace.flow.js", import.meta.url)));
}

/**
 * 确保这个用户有一条能跑的 `radar-plan`。
 *
 * 返回的 `installed` 说明发生了什么：`created` / `refreshed` / `current` / `kept-local-edits`。
 * 最后一个是有意的——人改过的流程不该被一次刷新悄悄抹掉。
 */
export function ensurePlanFlow({ workspaceRoot, userId = "", deps = {} } = {}) {
  const { createEmptyFlow, resolveFlowDirForWrite } = deps;
  if (typeof resolveFlowDirForWrite !== "function") return { ok: false, error: "缺 resolveFlowDirForWrite" };

  const resolved = resolveFlowDirForWrite(workspaceRoot, PLAN_FLOW_ID, "user", { userId: String(userId || "") });
  if (resolved.error) return { ok: false, error: resolved.error };
  const flowDir = resolved.flowDir;
  const target = path.join(flowDir, "workspace.flow.js");
  const readTemplate = deps.readTemplate || (() => fs.readFileSync(planTemplateFile(), "utf-8"));
  const template = readTemplate();
  const templateSha = sha(template);

  const install = (installed) => {
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(target, template, "utf-8");
    fs.writeFileSync(path.join(flowDir, STAMP_FILE), templateSha, "utf-8");
    return { ok: true, flowDir, installed };
  };

  if (!fs.existsSync(target)) {
    if (typeof createEmptyFlow === "function") {
      const created = createEmptyFlow(workspaceRoot, PLAN_FLOW_ID, "user", { userId: String(userId || "") });
      // 已存在不算失败：目录可能先于图文件被建出来
      if (created && created.success === false && !/已存在|exists/i.test(String(created.error || ""))) {
        return { ok: false, error: created.error };
      }
    }
    return install("created");
  }

  const current = fs.readFileSync(target, "utf-8");
  if (sha(current) === templateSha) return { ok: true, flowDir, installed: "current" };

  let stamp = "";
  try { stamp = fs.readFileSync(path.join(flowDir, STAMP_FILE), "utf-8").trim(); } catch { stamp = ""; }
  // 装进去之后没人动过 -> 可以换成新模板；动过就留着
  if (stamp && stamp === sha(current)) return install("refreshed");
  return { ok: true, flowDir, installed: "kept-local-edits" };
}

/**
 * 把这次的输入写进图里的 provide 节点。
 *
 * 找不到节点时**返回失败，不要放行**：拿默认值跑下去的后果是它照着模板里那句
 * 「盯 Google Play 强制要求」去规划，而人问的是别的——一份看起来正常、实际答非所问的计划，
 * 比一个报错难发现得多。
 */
export function withPlanInputs(graph, { ask = "", board = "" } = {}) {
  const next = JSON.parse(JSON.stringify(graph || {}));
  const missing = [];
  const setProvide = (nodeId, value) => {
    const node = next.instances?.[nodeId];
    if (!node || !String(node.definitionId || "").startsWith("provide_")) { missing.push(nodeId); return; }
    const slot = (Array.isArray(node.output) ? node.output : []).find((item) => item?.name === "value");
    if (!slot) { missing.push(nodeId); return; }
    slot.value = String(value ?? "");
  };
  setProvide("ask", ask);
  setProvide("boardId", board);
  if (missing.length) {
    return { ok: false, error: `radar-plan 图里找不到输入节点：${missing.join("、")}。改过图的话把这些节点名留着。` };
  }
  return { ok: true, graph: next };
}

/**
 * 取这次跑出来的计划。
 *
 * 按 runId 找，不是「拿最新那份」：两次规划并行时，后跑完的会盖掉前一个，
 * 而人完全看不出自己拿到的是别人那份计划。
 */
export function readPlanResult({ runId = "", deps = {} } = {}) {
  const resolve = deps.radarPlanFile || radarPlanFile;
  const file = resolve(runId);
  if (!file) return { ok: false, error: "缺 runId，取不了这次的计划" };
  if (!fs.existsSync(file)) return { ok: false, error: "这次运行没有留下计划——多半是它一条流程都没排出来" };
  let data = null;
  try { data = JSON.parse(fs.readFileSync(file, "utf-8")); } catch (e) {
    return { ok: false, error: `计划文件读不动：${(e && e.message) || e}` };
  }
  if (data?.ok === false) {
    return { ok: false, error: String(data.error || "两轮都没给出可用计划"), report: String(data.report || "") };
  }
  return { ok: true, plan: data?.plan || null, runId: String(data?.runId || ""), at: String(data?.at || "") };
}
