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
  // 空板是从零排，已经在跑的板是**改**。同一句「想盯什么」在这两种情形下要的东西完全不同：
  // 前者要一份完整清单，后者要的是增量——把不变的照原样留住，只说改哪儿
  const tuning = Array.isArray(board?.rows) && board.rows.length > 0;
  return [
    "你在为一块「雷达板」做编排规划。雷达板是一组被长期追踪的事项，每条有截止日、状态和负责人，",
    "由若干条定时流程各写各的一片，合并成一块板。",
    "",
    ...(tuning ? [
      "**这块板已经在跑了，你是在调整它，不是重建。**",
      "没被要求改的条目和流程原样留住（流程用 `keep`，条目照抄现有 id），只把用户说的那部分改掉。",
      "把一条现有条目拆细时，新条目的 parent 指回它；不要凭空重排整块板——人看到的会是一次全量替换，",
      "而板上攒的状态、认领和人工标记都挂在原来那些 id 上。",
      "",
    ] : []),
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
    "6. **`items` 是要盯的具体事项，一条一个。** 它们的初始 state 一律留空——这一刻你还没扫过，",
    "   写任何值都是编的。`tasks` 拆成人能直接照着做的步骤，`unknowns` 写你查不到、需要人补的。",
    "7. `flows[].owns` 里的 id 必须来自 `items` 或板上已有的条目，不能凭空出现。",
    "8. **`vocab` 是这块板的词典，由你定。** 状态在这块板上怎么念（合规板说「已满足」，",
    "   线上问题板说「已恢复」，争议板说「已定论」）、分几个大组、横切标签用哪几个。",
    "   它是数据不是代码：流程从板上读它，页面照它渲染，改词表不用改任何源码。",
    "   大组按**人会怎么分块看这块板**来定，三到六个，别按流程分——流程是谁去查，大组是查的是哪一类。",
    "",
    "## 只输出一段 JSON，不要别的",
    "```json",
    "{",
    '  "summary": "一两句话说清楚这块板打算怎么组织",',
    // 新板的名字和 id 也归规划——让人先取名再描述需求，是把内部字段当成了提问
    target ? "" : '  "board": { "title": "这块板叫什么，四到八个字的中文名", "id": "英文小写、连字符分隔，比如 sdk-compliance" },',
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
    // 词典也归规划：状态怎么念、分几个大组、标签用哪几个——这些是**这块板的业务**，
    // 不是内核。不让规划定的话，它们只会散进各条流程的提示词里，
    // 改一个大组要去编辑流程源码，而两条流程各抄一份就会拼出两个同名的组
    '  "vocab": {',
    '    "states": { "ok": "已满足", "warn": "进行中", "risk": "未开始", "idle": "无状态" },',
    '    "themes": [{ "key": "英文小写key", "label": "给人看的组名，比如 Android 16 适配" }],',
    '    "tags": ["跨条目的横切标签，英文小写，五到八个"],',
    '    "fields": { "current": "现状", "evidence": "依据", "required": "要求" }',
    "  },",
    '  "items": [',
    "    {",
    '      "id": "英文小写、连字符分隔、稳定不变，比如 play-target-api-36",',
    '      "title": "一句话说清楚这是什么事",',
    '      "due": "YYYY-MM-DD，没有确定截止日就留空字符串",',
    '      "required": "满足的标准是什么",',
    '      "owner": "负责人的用户名，不知道就留空",',
    '      "source": "依据的原始链接",',
    '      "tasks": ["要做的第一步", "第二步"],',
    '      "unknowns": ["还需要人确认的事"]',
    "    }",
    "  ],",
    '  "notes": ["需要人确认的事，比如某个条目现在没人负责"]',
    "}",
    "```",
    target
      ? `板 id 是 ${target}，流程写入时用它。`
      : "这块板还不存在，`board.title` 和 `board.id` 由你定：title 给人看，id 会进深链、也是流程里 --board= 的值，定下就不再改。",
  ].filter(Boolean).join("\n");
}

/**
 * 扫出每一段大括号平衡的片段。
 *
 * 不能用「第一个 `{` 到最后一个 `}`」：模型在 JSON 后面补一句带括号的解释，那一刀就切歪了。
 * 字符串里的括号也不算——`"required": "{ 见附录 }"` 会把边界带偏。
 */
function* jsonObjects(text) {
  const s = String(text || "");
  if (s.length > 400_000) return;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j += 1) {
      const ch = s[j];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { if (inStr) esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) { yield s.slice(i, j + 1); i = j; break; }
      }
    }
  }
}

/**
 * 先按原样解析，不行再做两处保守修补：尾逗号、整行 `//` 注释。
 *
 * 只修这两样。再往下就是猜模型想写什么了——一份猜出来的计划比解析失败更糟，
 * 因为它会静默地少掉几个条目。
 */
function tryParseObject(chunk) {
  const noTrailingComma = chunk.replace(/,(\s*[}\]])/g, "$1");
  const attempts = [chunk, noTrailingComma, noTrailingComma.replace(/^\s*\/\/.*$/gm, "")];
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // 换下一种修补再试
    }
  }
  return null;
}

/** 一份回复里可能同时有示例和真计划。认这几个键，谁更像计划挑谁 */
function planScore(plan) {
  let score = 0;
  if (Array.isArray(plan?.flows)) score += 4 + Math.min(plan.flows.length, 4);
  if (Array.isArray(plan?.items)) score += 4 + Math.min(plan.items.length, 4);
  if (plan?.board && typeof plan.board === "object") score += 2;
  if (String(plan?.summary || "").trim()) score += 1;
  return score;
}

/**
 * 从模型回复里抠出那段 JSON 计划。
 *
 * 宽容不是纵容：一次规划要跑一两分钟，为了一个尾逗号让人从头再来，比多写几十行解析贵得多。
 * 但宽容只到「把结构抠出来」为止——抠出来的东西照样要过 normalizeRadarPlan 的校验，
 * 那里才是真正决定什么能落盘的地方。
 */
export function parseRadarPlan(text) {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, error: "模型没有返回内容" };

  // 所有围栏块，不只第一个：模型常常先给一段示例再给真的
  const candidates = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  candidates.push(raw);

  const seen = new Set();
  const plans = [];
  for (const candidate of candidates) {
    for (const chunk of jsonObjects(candidate)) {
      if (seen.has(chunk)) continue;
      seen.add(chunk);
      const parsed = tryParseObject(chunk);
      if (parsed) plans.push(parsed);
    }
  }
  if (!plans.length) return { ok: false, error: "模型返回的不是可解析的 JSON 计划" };
  plans.sort((a, b) => planScore(b) - planScore(a));
  return { ok: true, plan: plans[0] };
}

/**
 * 解析不出来时，让它只重发一遍 JSON。
 *
 * 把原任务整段带上，而不是只说「重发」：模型第二轮看不到第一轮的上下文，
 * 只说重发的结果是它凭印象重编一份，条目和第一轮对不上。
 */
export function buildRadarPlanRepairPrompt(prompt, raw) {
  return [
    "上一轮的回复里没有可解析的 JSON 计划。",
    "",
    "**只输出那一段 JSON**：不要解释、不要示例、不要第二段 JSON、不要在 JSON 之后再补话。",
    "内容和上一轮应当一致——这一轮只是重新输出，不是重新规划。",
    "",
    "## 原任务",
    String(prompt || ""),
    "",
    "## 你上一轮的输出（截断）",
    String(raw || "").slice(0, 4000),
  ].join("\n");
}

/**
 * 收敛并检查计划。
 *
 * 检查的重点是**这份计划会不会造出我们刚防住的那些问题**：一个条目两条流程抢着写、
 * cron 写错、引用了板上不存在的条目。模型给的计划不该直接落地，它只是一份待审的草案。
 */
/** 只留认得出的 id 格式：它会进文件名、进深链、进 `--board=` */
const ITEM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * 规整模型产出的追踪项。
 *
 * **初始 state 一律不收**：规划这一刻还没扫过任何东西，写进去的任何状态都是编的，
 * 而板上一条绿色的 ok 会让人以为已经查过了。条目建出来就是待扫描，由监控流程去填。
 */
export function normalizeRadarItems(raw = [], existingIds = new Set()) {
  const items = [];
  const warnings = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const id = String(entry?.id || "").trim().toLowerCase();
    if (!ITEM_ID.test(id)) { warnings.push(`条目 id 不合法，已丢掉：${entry?.id ?? "(空)"}`); continue; }
    if (seen.has(id) || existingIds.has(id)) { warnings.push(`条目 ${id} 重复，已丢掉`); continue; }
    seen.add(id);
    const title = String(entry?.title || "").trim();
    if (!title) { warnings.push(`条目 ${id} 缺 title，已丢掉`); continue; }
    const due = String(entry?.due || "").trim();
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
      warnings.push(`条目 ${id} 的截止日不是 YYYY-MM-DD，已留空：${due}`);
    }
    items.push({
      id,
      title,
      due: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : "",
      required: String(entry?.required || "").trim(),
      owner: String(entry?.owner || "").trim(),
      source: String(entry?.source || "").trim(),
      tasks: (Array.isArray(entry?.tasks) ? entry.tasks : []).map((x) => String(x).trim()).filter(Boolean),
      unknowns: (Array.isArray(entry?.unknowns) ? entry.unknowns : []).map((x) => String(x).trim()).filter(Boolean),
    });
  }
  return { items, warnings };
}

export function normalizeRadarPlan(plan, board) {
  const warnings = [];
  // 板 id 和条目 id 一个形状：都会进文件名、进深链、进 `--board=`
  const proposedId = String(plan?.board?.id || "").trim().toLowerCase();
  if (plan?.board?.id && !ITEM_ID.test(proposedId)) {
    warnings.push(`板 id 不合法，已丢掉：${plan.board.id}`);
  }
  const existing = new Set((board?.rows || []).map((row) => String(row.id || row.title || "")).filter(Boolean));
  // 这一轮新提的条目也算「已知」：流程认领它们是正常的，不该被当成引用了不存在的条目
  const { items, warnings: itemWarnings } = normalizeRadarItems(plan?.items, existing);
  const knownRows = new Set([...existing, ...items.map((item) => item.id)]);
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
    board: {
      title: String(plan?.board?.title || "").trim(),
      id: ITEM_ID.test(proposedId) ? proposedId : "",
    },
    items,
    flows,
    notes: (Array.isArray(plan?.notes) ? plan.notes : []).map((note) => String(note || "")).filter(Boolean),
    warnings: [...itemWarnings, ...warnings],
  };
}
