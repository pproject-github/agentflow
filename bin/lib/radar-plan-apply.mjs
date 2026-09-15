/**
 * 把指挥官的计划变成真的监控流程。
 *
 * 指挥官（板 workspace 里的一条定时流程）读完板、写出一份计划：该建哪几条监控流程、
 * 各认领哪些条目、什么节奏。这里负责把它**提案**成待审批，批了才真的建。
 *
 * 为什么建流程一律走审批，没有例外：一条每小时跑的 agent 流程是在**烧钱**，而且它一旦
 * 认领了条目就会开始覆盖别人写的值。这比「把一条改成 ok」贵得多。
 *
 * 更要紧的是边界问题——**图仍然是授权边界**：agent 提议图，人批准图，图约束执行。
 * 让 agent 直接建流程的话，「监控型不能写发现型的字段」就只剩提示词里的一句建议。
 */
import path from "node:path";

/** 每条监控流程都是同一个形状，参数化出来。这个形状已经真跑通过 */
export function buildMonitorGraph({ flowId, board, workspacePath, cron, timezone = "Asia/Shanghai", owns = [], updates = [], task = "" }) {
  const ownsText = owns.includes("*") ? "板上所有条目" : owns.join("、");
  const updatesText = updates.length ? updates.join(" / ") : "state / current / evidence";
  const prompt = [
    "你在一块雷达板的工作目录里。先读 board.md 弄清楚这块板盯什么、边界在哪。",
    "",
    `你负责这些追踪项：${ownsText || "（板上尚无条目，按 board.md 判断该建哪些）"}`,
    `你只更新这几个字段：${updatesText}。别的字段归别人管，不要动。`,
    "",
    task || "读 evidence/ 下的现状产物，逐条核对并更新 frontmatter；正文里补上或勾掉任务项。",
    "",
    "**产物里找不到依据的，state 写 unknown，绝不能默认当成通过。**",
    // 一份 frontmatter 写坏，整个目录这一轮一条都不写。而写坏的方式几乎总是同一个：
    // 值里带冒号却没加引号。与其让它每轮换个说法再犯一次，不如在提示词里说死
    "frontmatter 的值里只要有冒号、井号或引号，整个值要用双引号包起来，否则这份文件解析不了、这一轮一条都写不进去。",
    "每条追踪项一个文件，文件名是 `<id>.md`——**必须带 .md 后缀**，只写 id 的话这个目录一条都读不出来。",
    "已经勾掉的任务不要取消勾选，人写的「待确认」不要删。",
    "直接改文件，改完回一句话说你改了哪几个。",
  ].join("\n");

  const node = (id, definitionId, label, extra = {}) => ({ id, definitionId, label, ...extra });
  const instances = {
    entry: node("entry", "workspace_scheduled_run", cron ? `定时 ${cron}` : "定时", {
      body: JSON.stringify({ cron: cron || "0 9 * * *", timezone, enabled: false }),
    }),
    cd: node("cd", "control_cd_workspace", "进入板目录", {
      input: [{ type: "text", name: "path", value: workspacePath }, { type: "text", name: "label", value: board }],
    }),
    skills: node("skills", "control_load_skills", "载入追踪规范", {
      input: [{ type: "text", name: "skillKeys", value: "agentflow-tracking" }],
    }),
    work: node("work", "agent_subAgent", "更新追踪项", { body: prompt }),
    sync: node("sync", "tool_nodejs", "同步回板", {
      script: `agentflow track sync --board=${board} --flow=${flowId} --dir=${path.join(workspacePath, "trackers")} --gate --flow-ref=${flowId}`,
    }),
    run: node("run", "workspace_run", `${board} 监控`),
  };
  const edges = [
    { source: "run", sourceHandle: "next", target: "entry", targetHandle: "prev" },
    { source: "entry", sourceHandle: "next", target: "cd", targetHandle: "prev" },
    { source: "cd", sourceHandle: "next", target: "skills", targetHandle: "prev" },
    { source: "skills", sourceHandle: "next", target: "work", targetHandle: "prev" },
    { source: "skills", sourceHandle: "skillsContext", target: "work", targetHandle: "skillsContext" },
    { source: "cd", sourceHandle: "workspaceContext", target: "work", targetHandle: "workspaceContext" },
    { source: "work", sourceHandle: "next", target: "sync", targetHandle: "prev" },
  ];
  return { version: 1, instances, edges, ui: { nodePositions: {} } };
}

/**
 * 把校验过的计划变成待审批条目。
 *
 * **建流程默认 `enabled: false`**：批准建它是一回事，让它开始每天烧 token 是另一回事。
 * 人在定时任务页上开启，那一步才是真正的「开始花钱」。
 */
export function planToPending(plan = {}, { board, workspacePath }) {
  const held = [];
  for (const flow of Array.isArray(plan.flows) ? plan.flows : []) {
    if (flow.action === "keep") continue;
    const verb = flow.action === "create" ? "新建" : "调整";
    const owns = Array.isArray(flow.owns) ? flow.owns : [];
    held.push({
      kind: "flow",
      action: flow.action,
      id: flow.flowId,
      flowSpec: { ...flow, board, workspacePath },
      // 审批正文要说清楚「批了会发生什么」，而不是「有个流程要建」
      reason: [
        `${verb}监控流程 ${flow.flowId}`,
        flow.cron ? `按 ${flow.cron} 跑` : "节奏未定",
        `认领 ${owns.includes("*") ? "全部条目" : `${owns.length} 个条目`}`,
        `写 ${(flow.updates || []).join("/") || "state/current/evidence"}`,
        "建好后默认停用，要你在定时任务页上手动开启",
      ].join("，"),
    });
  }
  return held;
}

/**
 * 批准之后真的建。
 *
 * 建完**不启用**：调度注册表里 enabled=false，需要人再点一次。建流程和开始花钱
 * 是两个决定，混成一个的话，批准一份计划就等于同时批了往后每天的开销。
 */
export function materializeFlow(spec = {}, deps = {}) {
  const { createEmptyFlow, writeWorkspaceGraph, resolveFlowDirForWrite } = deps;
  const flowId = String(spec.flowId || "").trim();
  if (!flowId) return { ok: false, error: "缺 flowId" };
  const workspaceRoot = String(deps.workspaceRoot || "");
  const flowSource = String(spec.flowSource || "user");
  const opts = { userId: String(deps.userId || "") };

  const existing = resolveFlowDirForWrite(workspaceRoot, flowId, flowSource, opts);
  if (existing.error) return { ok: false, error: existing.error };
  if (spec.action === "create") {
    const created = createEmptyFlow(workspaceRoot, flowId, flowSource, opts);
    // 已经存在时不当成失败：计划可能是基于稍旧的板算的，重复建一次不该整批卡住
    if (!created.success && !/已存在|exists/i.test(String(created.error || ""))) {
      return { ok: false, error: created.error };
    }
  }
  const graph = buildMonitorGraph({
    flowId,
    board: spec.board,
    workspacePath: spec.workspacePath,
    cron: spec.cron,
    owns: spec.owns,
    updates: spec.updates,
    task: spec.task,
  });
  const written = writeWorkspaceGraph(existing.flowDir, graph);
  if (written?.format !== "dsl") {
    return { ok: false, error: `图没能写成代码：${written?.degradedReason || "未知原因"}` };
  }
  return { ok: true, flowId, flowDir: existing.flowDir };
}
