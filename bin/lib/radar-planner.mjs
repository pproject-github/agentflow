/**
 * 雷达的板级编排规划。
 *
 * 用户说「我要盯 Android/iOS 商店政策」，要回答的不是「搭一条流程」，而是**这块板该由哪几条
 * 定时组成、各管哪些追踪项、各自什么节奏**。这件事必须在板这一层做，因为：
 *
 * - 政策一年变几次，代码天天变。塞进一条流程里，要么代码扫得太少，要么政策抓得太勤；
 * - 一个条目只能由一条流程负责。两条都写同一条，就是 radar.mjs 里那个 conflicts——
 *   板上会开始自相矛盾，而人第一反应是「这破面板不准」，不是「配置错了」。
 *
 * 所以这里产出的是**计划**，不是流程。人确认之后再逐条去建——重活模型干，人只做二选一。
 */

/** 计划里允许的动作 */
const PLAN_ACTIONS = new Set(["create", "update", "keep"]);
/** 一条流程允许声明自己更新条目的哪些字段 */
const UPDATABLE_FIELDS = new Set(["state", "current", "required", "evidence", "due", "owner", "title", "source"]);
const MAX_FLOWS = 8;

function cronLooksValid(cron) {
  const parts = String(cron || "").trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((part) => /^[\d*/,\-]+$/.test(part));
}

/**
 * 把当前这块板的状态摊给模型看。
 *
 * 给的是**事实**，不是叙述：有哪几条流程、各自多久没更新、哪些条目没人负责。
 * 模型要能提出「改」，而不是每次都从零重搭一遍。
 */
export function describeBoardState(board) {
  if (!board) return "这是一块还不存在的板，从零开始规划。";
  const lines = [];
  lines.push(`板：${board.title || board.board}（id: ${board.board}）`);

  const flows = Array.isArray(board.flows) ? board.flows : [];
  if (!flows.length) {
    lines.push("当前还没有任何流程写过这块板。");
  } else {
    lines.push(`当前由 ${flows.length} 条流程在喂：`);
    for (const flow of flows) {
      const parts = [`  - ${flow.flowId}`, `写入 ${flow.rows} 条`];
      if (flow.flow?.scheduleNodeId) parts.push(`定时节点 ${flow.flow.scheduleNodeId}`);
      if (flow.stale) parts.push("**已经哑了（超过预期间隔没更新）**");
      if (flow.fetchFailures) parts.push(`${flow.fetchFailures} 次抓取失败`);
      lines.push(parts.join("，"));
    }
  }

  const rows = Array.isArray(board.rows) ? board.rows : [];
  if (rows.length) {
    lines.push(`当前 ${rows.length} 个追踪项：`);
    for (const row of rows.slice(0, 40)) {
      lines.push(`  - ${row.id || row.title}（${row.state}${row.owner ? `，负责人 ${row.owner}` : "，**无人认领**"}${row.flowId ? `，来自 ${row.flowId}` : ""}）`);
    }
    if (rows.length > 40) lines.push(`  …… 另有 ${rows.length - 40} 条`);
  }

  const conflicts = Array.isArray(board.conflicts) ? board.conflicts : [];
  if (conflicts.length) {
    lines.push("有条目被多条流程重复认领，需要在计划里指定归属：");
    for (const conflict of conflicts) lines.push(`  - ${conflict.id}：${conflict.flows.join(" / ")}`);
  }
  return lines.join("\n");
}

/**
 * 拼规划提示词。
 *
 * 约束写死在这里，不指望模型自己想到——不写的话它会给出「一条流程每天让模型读一遍政策页写段
 * 总结」，能跑，但既贵又没有能点开的证据。
 */
export function buildRadarPlanPrompt({ board, ask, boardId }) {
  const target = board?.board || boardId || "";
  return [
    "你在为一块「雷达板」做编排规划。雷达板是一组被长期追踪的事项，每条有截止日、状态和负责人，",
    "由若干条定时流程各写各的一片，合并成一块板。",
    "",
    "## 现状",
    describeBoardState(board),
    "",
    "## 用户要什么",
    String(ask || "").trim(),
    "",
    "## 规划时必须守的几条",
    "1. **按变化节奏拆流程**，不要塞进一条。官方政策页一年变几次，仓库代码天天变——",
    "   抓政策和扫代码现状应当是不同的流程、不同的 cron。合在一起必然一边浪费一边滞后。",
    "2. **一个追踪项只能由一条流程负责写**。两条流程写同一条，板上会开始自相矛盾，",
    "   而看的人只会得出「这面板不准」的结论。要改归属就在计划里写清楚。",
    "3. 判定仓库现状要用**确定性脚本**，不要让模型每天去猜。脚本匹配不到时返回 unknown，",
    "   绝不能默认当成通过——那等于发了一张假的合格证。",
    "4. **抓取失败要和「没有变化」分开记**，否则监控静默死掉时，面板看起来一切正常。",
    "5. 已经存在、而且还合适的流程用 `keep`，不要重建。已经哑了的流程优先诊断，别直接另起一条。",
    "",
    "## 只输出一段 JSON，不要别的",
    "```json",
    "{",
    '  "summary": "一两句话说清楚这块板打算怎么组织",',
    '  "flows": [',
    "    {",
    '      "action": "create|update|keep",',
    `      "flowId": "英文小写、连字符分隔，比如 play-policy-watch",`,
    '      "title": "中文名",',
    '      "cron": "0 9 * * *",',
    '      "cadenceWhy": "为什么是这个节奏（对着「它多久会变一次」说）",',
    '      "owns": ["这条流程负责写的追踪项 id"],',
    '      "updates": ["state", "current", "evidence"],',
    '      "prompt": "交给 AI 去搭这条流程时用的提示词，要具体到抓哪个页面、判定哪个文件",',
    '      "why": "这条流程为什么存在"',
    "    }",
    "  ],",
    '  "notes": ["需要人确认的事，比如某个条目现在没人负责"]',
    "}",
    "```",
    target ? `板 id 是 ${target}，流程写入时用它。` : "",
  ].filter(Boolean).join("\n");
}

/** 从模型回复里抠出那段 JSON。它经常会裹一层 ``` 或者前后带解释 */
export function parseRadarPlan(text) {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, error: "模型没有返回内容" };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced ? fenced[1] : "", raw].filter(Boolean);
  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, plan: parsed };
    } catch {
      // 换下一个候选再试
    }
  }
  return { ok: false, error: "模型返回的不是可解析的 JSON 计划" };
}

/**
 * 收敛并检查计划。
 *
 * 检查的重点是**这份计划会不会造出我们刚防住的那些问题**：一个条目两条流程抢着写、
 * cron 写错、引用了板上不存在的条目。模型给的计划不该直接落地，它只是一份待审的草案。
 */
export function normalizeRadarPlan(plan, board) {
  const warnings = [];
  const knownRows = new Set((board?.rows || []).map((row) => String(row.id || row.title || "")).filter(Boolean));
  const knownFlows = new Set((board?.flows || []).map((flow) => String(flow.flowId || "")).filter(Boolean));
  const ownedBy = new Map();
  const flows = [];

  for (const entry of Array.isArray(plan?.flows) ? plan.flows.slice(0, MAX_FLOWS) : []) {
    const flowId = String(entry?.flowId || "").trim();
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(flowId)) {
      warnings.push(`流程名不合法，已丢弃：${flowId || "(空)"}`);
      continue;
    }
    const action = PLAN_ACTIONS.has(String(entry?.action)) ? String(entry.action) : "create";
    if (action === "create" && knownFlows.has(flowId)) {
      warnings.push(`${flowId} 已经存在，动作按 update 处理`);
    }
    if (action !== "create" && !knownFlows.has(flowId)) {
      warnings.push(`${flowId} 目前不存在，动作按 create 处理`);
    }
    const cron = String(entry?.cron || "").trim();
    if (cron && !cronLooksValid(cron)) warnings.push(`${flowId} 的 cron 看起来不对：${cron}`);

    const owns = [];
    for (const item of Array.isArray(entry?.owns) ? entry.owns : []) {
      const id = String(item || "").trim();
      if (!id) continue;
      // 通配符表示「这块板的全部条目」，扫代码现状那种流程会用到
      if (id !== "*" && knownRows.size && !knownRows.has(id)) {
        warnings.push(`${flowId} 声称负责 ${id}，但板上没有这一条`);
      }
      const previous = ownedBy.get(id);
      if (previous && previous !== flowId && id !== "*") {
        warnings.push(`${id} 被 ${previous} 和 ${flowId} 同时认领，必须二选一`);
      }
      if (id !== "*") ownedBy.set(id, flowId);
      owns.push(id);
    }

    flows.push({
      action: knownFlows.has(flowId) ? (action === "create" ? "update" : action) : "create",
      flowId,
      title: String(entry?.title || flowId),
      cron,
      cadenceWhy: String(entry?.cadenceWhy || ""),
      owns,
      updates: (Array.isArray(entry?.updates) ? entry.updates : [])
        .map((field) => String(field || "").trim())
        .filter((field) => UPDATABLE_FIELDS.has(field)),
      prompt: String(entry?.prompt || ""),
      why: String(entry?.why || ""),
      exists: knownFlows.has(flowId),
    });
  }

  if (!flows.length) warnings.push("这份计划里没有一条可用的流程");

  // 板上已有、但计划里没人管的条目：容易被漏掉，必须点名
  const orphans = [...knownRows].filter((id) => !ownedBy.has(id) && !flows.some((flow) => flow.owns.includes("*")));
  if (orphans.length) {
    warnings.push(`计划没有覆盖这些已有条目：${orphans.slice(0, 6).join("、")}${orphans.length > 6 ? " 等" : ""}`);
  }

  return {
    summary: String(plan?.summary || ""),
    flows,
    notes: (Array.isArray(plan?.notes) ? plan.notes : []).map((note) => String(note || "")).filter(Boolean),
    warnings,
  };
}
