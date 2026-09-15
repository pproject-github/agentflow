/**
 * 从一句「我想盯什么」到一块真的在跑的板。
 *
 * 用户视角只有一个输入框；剩下的由流程接手：
 *
 *   规划 → 细化条目 → 人确认还有没有要加的 → 人 review 流程 → 建板 + 建流程
 *
 * **第一次建板时那两次确认就是审批本身**，建完不再进审批队列——人刚刚一条条看过了，
 * 再让他去审批页批一遍同样的东西，只会教会他闭眼点。之后指挥官再改什么，才走门禁。
 */
import fs from "node:fs";
import path from "node:path";

import yaml from "js-yaml";

/** 板目录放在数据根下，和分片分开：一个是给人和 agent 编辑的，一个是给页面读的 */
export function boardWorkspacePath(dataRoot, board) {
  return path.join(dataRoot, "board-workspaces", board);
}

/**
 * `board.md` 是这块板的**宪法**：盯什么、边界在哪、怎么更新。
 *
 * agent 每轮先读它。写得含糊的话，一块「Android 政策」的板三个月后会混进
 * 各种最佳实践建议，把真正会卡发版的那几条淹掉。
 */
export function renderBoardDoc({ board, title, topic, summary = "" }) {
  const front = yaml.dump({ board, title }, { lineWidth: 100 }).trimEnd();
  return [
    `---\n${front}\n---`,
    "",
    `# ${title}`,
    "",
    "## 盯什么",
    "",
    topic.trim(),
    "",
    ...(summary ? ["## 这块板怎么组织", "", summary, ""] : []),
    "## 边界",
    "",
    "- 只收**有截止日、不做会出事**的事项。建议性的最佳实践不进来 —— 进来了就会淹掉真正要紧的那几条。",
    "- 判定现状必须有依据（配置文件、扫描报告、后台截图）。**拿不准写 `unknown`，绝不默认当成通过。**",
    "",
    "## 怎么更新",
    "",
    "`trackers/<id>.md` 一个文件一条：",
    "",
    "- **frontmatter** 是结构化核心，跑道按 `due` 画、告警按 `state` 触发。改完要过 `agentflow track sync` 校验。",
    "- **正文**随便写：任务怎么拆、调研到哪、还有什么没确认。人和 agent 都可以直接改。",
    "",
  ].join("\n");
}

/** 条目文件。规划阶段不写 state —— 还没扫过，写什么都是编的 */
export function renderTrackerDoc(item = {}) {
  const meta = {};
  for (const key of ["id", "title", "due", "required", "owner", "source"]) {
    if (String(item[key] || "").trim()) meta[key] = item[key];
  }
  const front = yaml.dump(meta, { lineWidth: 100, noRefs: true }).trimEnd();
  const body = [];
  if (item.tasks?.length) {
    body.push("## 要做的", "", ...item.tasks.map((task) => `- [ ] ${task}`), "");
  }
  if (item.unknowns?.length) {
    // 「还不知道」要摆在明面上。藏起来的话，下一个人会以为已经查清楚了
    body.push("## 待确认", "", ...item.unknowns.map((x) => `- ${x}`), "");
  }
  if (!body.length) body.push("<!-- 任务拆解、调研、待确认的事写在这儿。agent 和人都可以改 -->", "");
  return `---\n${front}\n---\n\n${body.join("\n")}`;
}

/**
 * 落地一份已经被人过目的计划。
 *
 * 顺序是有意的：**先建板和条目，再建流程。** 流程建出来就会认领条目，条目还不存在的话
 * 它第一轮跑完会把「认领的条目不存在」记成一堆告警。
 */
export function setupBoard({ board, title, topic, plan = {}, dataRoot, createdBy = "" }, deps = {}) {
  const createBoard = deps.createRadarBoard;
  const workspacePath = boardWorkspacePath(dataRoot, board);
  /**
   * 词典跟着计划一起落。
   *
   * 状态在这块板上怎么念、分几个大组、标签用哪几个——是**这块板的业务**，
   * 规划的时候就该定下来。不落进 spec 的话它只能散进各条流程的提示词，
   * 改一个大组要去编辑流程源码，两条流程各抄一份还会拼出两个同名的组。
   */
  const vocab = plan.vocab && typeof plan.vocab === "object" ? plan.vocab : {};
  const spec = {
    // 状态页是默认形态：这类板大多数条目没有截止日，跑道上是一片空
    view: "status",
    views: ["status", "runway", "table"],
    ...(Array.isArray(vocab.themes) && vocab.themes.length ? { encode: { group: "theme" } } : {}),
    ...(vocab.states ? { states: vocab.states } : {}),
    ...(vocab.themes ? { themes: vocab.themes } : {}),
    ...(vocab.tags ? { tags: vocab.tags } : {}),
    ...(vocab.fields ? { fields: vocab.fields } : {}),
  };
  const created = createBoard(board, { title, createdBy, spec });
  if (!created.ok) return { ok: false, error: created.error };

  fs.mkdirSync(path.join(workspacePath, "trackers"), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, "evidence"), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, "runtime"), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, "board.md"),
    renderBoardDoc({ board, title, topic, summary: plan.summary }),
    "utf-8",
  );

  const items = Array.isArray(plan.items) ? plan.items : [];
  for (const item of items) {
    fs.writeFileSync(path.join(workspacePath, "trackers", `${item.id}.md`), renderTrackerDoc(item), "utf-8");
  }

  /**
   * 条目先进板，否则人建完看到的是一块空板。
   *
   * 但**不能另开一个 seed 分片**：第一条监控流程跑起来会写同一批 id，两片认领同一条目
   * 就是重复认领，板上立刻标红。所以直接写进**将来认领它们的那条流程**的分片——
   * 它还没跑过，协作视图会如实显示「从没跑过」，那正是此刻的事实。
   */
  const planFlows = (Array.isArray(plan.flows) ? plan.flows : []).filter((flow) => flow.action !== "keep");
  const seedFlow = planFlows.find((flow) => {
    const owns = Array.isArray(flow.owns) ? flow.owns : [];
    return owns.includes("*") || items.some((item) => owns.includes(item.id));
  }) || planFlows[0];
  if (items.length && seedFlow && deps.commitTrack) {
    deps.commitTrack({
      board,
      flowId: seedFlow.flowId,
      // 还没扫过就是 unknown，不是 idle——后者意思是「查过了，没什么可报告的」
      rows: items.map((item) => ({ ...item, state: "unknown", current: "还没扫过" })),
      actor: createdBy,
      flow: { flowId: seedFlow.flowId, flowSource: "user" },
    });
  }

  const flows = [];
  for (const flow of planFlows) {
    const out = deps.materializeFlow({ ...flow, board, workspacePath, action: flow.action }, deps);
    flows.push(out.ok ? { flowId: out.flowId, ok: true } : { flowId: flow.flowId, ok: false, error: out.error });
  }

  // 先 init 再提交：没有 git 的话门禁分不清人和机器，会降级成不拦
  const repo = deps.ensureGitRepo?.(workspacePath);
  if (repo) deps.autoCommit?.(workspacePath, `建板：${title}，${items.length} 条追踪项`);
  return { ok: true, board, workspacePath, items: items.length, flows, git: Boolean(repo) };
}
