/**
 * Composer 任务规划器：将用户编辑请求分解为可独立执行的子任务。
 *
 * 三种模式：
 * 1. API 模式 — 使用快速模型（gpt-4o-mini 等）智能分解
 * 2. 启发式模式 — 基于正则/关键词的简单分类（兜底）
 * 3. 分阶段模式 — 大任务按「流转规划 → 节点补充 → 流程完善」三阶段逐轮生成
 */
import fs from "fs";
import { parseApiModel } from "./api-runner.mjs";
import { buildPlannerSkillContext } from "./composer-skill-router.mjs";
import { buildNodeSchemaPromptSection } from "./composer-node-schema.mjs";
import { formatInstancePlannerHint } from "./composer-flow-instances.mjs";
import { resolveCliAndModel } from "./model-config.mjs";
import { runCursorAgentWithPrompt, runOpenCodeAgentWithPrompt } from "./agent-runners.mjs";
import { t } from "./i18n.mjs";

const PLANNER_MAX_TOKENS = 2048;
const PLANNER_TIMEOUT_MS = 15_000;

// ─── 分阶段定义 ──────────────────────────────────────────────────────────

/** 与 flow.yaml 同目录的节点规格书（阶段一产出，阶段二必读） */
export const COMPOSER_NODE_SPEC_FILENAME = "composer-node-spec.md";

const PHASED_DEFINITIONS = [
  {
    name: "flow_plan",
    label: "流转规划",
    description: "选定节点类型与整体框架，撰写规格书，建立实例与布局（主链拓扑；不补全副引脚连线）",
  },
  {
    name: "node_enrich",
    label: "节点补充",
    description: "按规格书逐节点完善 agent 提示、tool 脚本与引脚索引",
  },
  {
    name: "flow_finish",
    label: "流程完善",
    description: "补全连线与布局，校验并自动修复直至通过",
  },
];

const PHASED_PHASE_COUNT = PHASED_DEFINITIONS.length;

const PHASED_TRIGGER_PATTERNS = [
  /(?:新建|创建|新增|生成|搭建|设计).*(?:流程|流水线|pipeline|flow|agentflow)/i,
  /(?:从零|从头|从无到有).*(?:搭|建|写|做)/i,
  /create\s+(?:a\s+)?(?:new\s+)?(?:flow|pipeline)/i,
  /(?:重新设计|重构|重新规划|重新搭建|大改|重做).*(?:流程|流水线|pipeline|flow)/i,
  /(?:流程|流水线|pipeline|flow).*(?:重新设计|重构|重新规划|大改|重做)/i,
];

function shouldUsePhased(userPrompt, phaseContext) {
  if (phaseContext && typeof phaseContext === "object" && typeof phaseContext.phaseIndex === "number") {
    return true;
  }
  if (!userPrompt || typeof userPrompt !== "string") return false;
  if (!PHASED_TRIGGER_PATTERNS.some((re) => re.test(userPrompt))) return false;
  // 关键词匹配但需求简单（如"新建 agentflow 打印 helloworld"）时不走分阶段
  const complexity = classifyComplexity(userPrompt);
  return complexity !== "simple";
}

// ─── 分阶段规划器提示 ─────────────────────────────────────────────────────

function buildPhasedSystemPrompt(phaseName, intents) {
  const skillContext = buildPlannerSkillContext(intents || []);
  const skillSection = skillContext ? "\n\n" + skillContext : "";
  const schemaSection = "\n\n" + buildNodeSchemaPromptSection();

  const phaseInstructions = {
    flow_plan: `当前阶段：**流转规划**（框架与类型优先）。
目标：建立**清晰、合理**的整体流转图（含分支 if、循环/回流、provide、getenv、并行汇合等），**节点类型选对、框架选对、单一权责**。

**前置已就位**（脚本已写盘）：\`flow.yaml\` 含 control_start + control_end + 主链 edge + nodePositions；\`${COMPOSER_NODE_SPEC_FILENAME}\` 含三段 section 占位符。规划 step 时按"插入节点 / 调整 edge / 填充 section"组织，**不要**让 AI 重建 start/end 或重写 spec.md 标题。

你需要生成 agent/script 步骤，指示 AI 完成：
1. 在 flow.yaml 中**新增** instances（保留 start/end）：\`definitionId\`、\`label\`、\`role\`；每个节点 \`body\` **一句**职责概要即可（也允许直接写得更详细，阶段二还能补强）。
2. **input/output（不强制锁死）**：基础控制槽（\`prev\`/\`next\` 等）必须保留 schema 默认结构。**业务数据槽（text/file）能想清楚就一次写到 flow.yaml**，阶段二会跳过已存在的槽（按 name 去重）；想不清的留到阶段二。type 必须 \`text\` 或 \`file\`，**禁止 node**。务必在节点规格书的「计划数据槽」section 也同步登记一份（作为完整设计文档与阶段二补漏依据）。
3. **edges（不强制锁死）**：主链 \`output-0 → input-0\` 必连；副边（control_if 的 prediction、control_toBool 的 value、回流、并行汇合的 prev2、tool/agent 业务数据边）**能确定就连**，连后阶段三只补漏；不确定就留到阶段三。
4. **ui.nodePositions**：为每个 instance 写入坐标（主链从左到右 x 每节点递增 **280**，起始 x:100 y:300；分支路径 y 错开 **200**）。
5. **必须**在与 flow.yaml **同目录**创建（或更新）文件 **${COMPOSER_NODE_SPEC_FILENAME}**，结构如下：
   - \`## 整体框架\`：叙述主链、分支、循环、并行、全局数据（SaveKey/LoadKey）等**设计意图**（可用条目列表）。
   - \`## 节点职责\`：按 **instanceId** 分小节，写清该节点**具体要做什么**；对 **tool_nodejs** 须写明**计划脚本文件名**（如 \`scripts/xxx.mjs\`）与输入输出语义，并注明「**可执行代码在「节点补充」阶段写入**」；对 **agent_subAgent** 注明阶段二要写的 body 要点（判定规则、产物路径等）。
   - \`## 计划数据槽\`：仅对**可扩展节点 ★**（agent_subAgent / tool_nodejs / tool_user_check）逐项列出阶段二要追加的数据槽：\`<instanceId>: input += [name:type, ...], output += [name:type, ...]\`，type 用 \`text\` 或 \`file\`；命名应与上下游一致便于连线（例如 \`agent_check: input += [toapp:text]; output += [result:text]\`）。**固定槽位节点**不在此列出。
6. 保留且仅保留一个 control_start、一个 control_end（除非用户明确要求改造已有图）。
7. **复杂任务循环拆解原则（关键）**
   AgentFlow 的核心优势是通过**循环**分解复杂问题（普通 CLI 因上下文限制无法解决）。规划时须主动判断是否需要环路：

   **必须使用循环的场景**（用 control_anyOne + control_toBool + control_if 构建环路）：
   - 校验/检查类：代码检查、编译构建、测试运行、格式校验——不可能一次通过，必须 check → fix → re-check
   - 迭代改进类：UI 还原、文档生成、翻译校对——需反复校对直至质量达标
   - 批量处理类：逐文件/逐组件操作，结果需逐项确认
   - 外部不确定性：API 调用可能失败、用户输入可能不合规

   **循环模板 A：简单 bool 环**（适用于通过/不通过的二元判定）
   control_anyOne(入口，汇合首次进入与修复回路) → 执行/检查 → control_toBool(判定结果) → control_if(分支)
     control_if.next1(通过) → 出环到后续节点或 End
     control_if.next2(未通过) → 修复节点 → 回到 control_anyOne(成环)

   **循环模板 B：todolist 拆解+增量环**（推荐用于复杂/批量任务）
   适用于大任务拆解与逐项推进的场景（如逐文件修复、逐组件还原、逐任务编译、复杂需求分步实现）：
   1. **拆解节点**（agent_subAgent 或 tool_nodejs）：分析大任务，产出 todolist 文件（\`- [ ] 子任务1\\n- [ ] 子任务2\\n...\`），作为后续循环的驱动清单——**拆解记录与执行驱动合二为一**
   2. control_anyOne(入口) → **执行节点**（从清单取未完成项 \`- [ ]\`，执行后打勾 \`- [x]\`）
   3. control_toBool(判定 todolist 中是否全部 \`- [x]\`) → control_if(分支)
      control_if.next1(全部完成) → 出环
      control_if.next2(仍有 \`- [ ]\`) → 回到 control_anyOne(继续下一轮)
   优势：增量执行（每轮只处理未完成项）、进度可视化、断点续作。

   **禁止**将校验/修复设计为线性链（check → fix → end）；
   如果用户需求包含「检查」「验证」「确认」「校验」「测试」「构建」「遍历」「逐个」「批量」等关键词，必须设计成环路。
   **大任务拆解时**，优先使用 todolist 模式：先用一个节点将大任务拆解为 todolist，再用循环逐项执行。`,

    node_enrich: `当前阶段：**节点补充**（按节点迭代，可多步）。
执行前须阅读 **${COMPOSER_NODE_SPEC_FILENAME}**（整体框架 + 各节点职责 + 计划数据槽）与当前 **flow.yaml**。

**幂等原则**：阶段一可能已经把部分业务槽 / body / script 写到 flow.yaml 了。本阶段是**补漏**而非重写——逐节点对照「spec.md 计划数据槽」与「flow.yaml 现状」：
- 槽位**已存在**（同 name）→ 跳过，不修改 type / 顺序
- 槽位**未追加** → 在 input/output 末尾补齐
- body / script 已经完整可执行 → 不动；为空或只有占位 → 写齐

为**每个**需要完善的 instance 生成独立 agent 步骤（或确定性 script 步骤）：
- **agent_subAgent**：若 body 已是可执行 prompt 则跳过；否则编写**准确、可执行**的 \`body\`（提示词/规则/输入输出占位 \`\${...}\`）。**复杂度用 "simple"**。
- **tool_nodejs**：若 \`script\` 字段已是完整命令且 scripts/ 下脚本已存在 → 跳过；否则在 **scripts/** 子目录创建 Node 脚本（\`scripts/<instanceId>.mjs\`），\`script\` 写入完整 \`node ...\` 调用并用 \`\${}\` 引用槽位。**不要**给 \`\${workspaceRoot}\`、\`\${runDir}\` 等外包双引号（已自动 shell-quote）。**禁止**仅 body 自然语言无 script。
- **control_toBool / provide_str / provide_file** 等：按规格书补齐空的 \`body\` 或 output \`value\`。
- **引脚补漏**：核对 body/script 中每个 \`\${X}\` 是否对应实际槽位 name；缺槽就在末尾追加（type 必为 \`text\` 或 \`file\`，**绝不写 node**），多余的不要动（可能是阶段三连线用）。
- **不得删改基础控制槽**（\`prev\`/\`next\` 的 type/name 与顺序）；**固定槽位节点**（control_* / provide_* / tool_load_key/save_key/get_env / tool_print / tool_user_ask）的 input/output 结构永不修改。

**引脚路径约束（tool_nodejs 必读）：** 脚本的输入输出文件路径**必须通过引脚传入**，禁止在脚本内部自行拼接。
- \`script\` 字段中用 \`\${槽位名}\` 引用 input/output 的文件路径（如 \`--figma-tree \${figma_tree} --output \${restore_todolist}\`），流水线会将其解析为绝对路径并自动 shell-quote。
- 脚本通过命令行参数接收这些路径后直接读写，**禁止**在脚本中用 \`outDirForNode\`、手写 \`node_<instance>_xxx.json/md\` 等方式自行构造路径——否则产物路径与流水线解析器约定不一致，下游节点将找不到文件。
- output 类型为「文件」的槽位路径由流水线按约定生成（\`output/<instanceId>/node_<instanceId>_<slot>.md\`），脚本只需 \`ensureDir(path.dirname(outPath))\` 后写入即可。

规则：**不要**在此阶段大改拓扑（尽量不增删 instance、不改 definitionId）。**已存在的边不要重复添加**；阶段一可能已连了部分副边，本阶段聚焦节点内容补漏。可适当微调 \`nodePositions\` 仅当妨碍阅读。`,

    flow_finish: `当前阶段：**流程完善**。
依据 **${COMPOSER_NODE_SPEC_FILENAME}** 与 flow.yaml 中已有实例与内容：

**幂等原则**：阶段一/二可能已经连了主链和部分副边。本阶段是**补漏 + 审计**而非重连：
- 边**已存在**（同 source/target/sourceHandle/targetHandle）→ 跳过，不重复添加
- 边**缺失**（spec.md「节点职责」的「输入 ← 来自 X」「输出 → 给 Y」描述了但 flow.yaml 没连）→ 补连

具体：
1. **补齐 edges**：数据流（text/file 槽对槽）、control_if 的 prediction（toBool.output-1 → if.input-1）、多输入汇合（anyOne.input-1 接修复回流）、tool 业务数据边等。**sourceHandle/targetHandle 必须与槽位索引一致**（如 output-1 → input-1）。
2. **引脚语义审查 checklist**（每节点过一遍，发现问题修正）：
   a. **同 output 多消费者冲突**：一个 output 槽被两条边消费且消费方语义矛盾（如同时供 \`control_toBool.value\`（要 true/false 单行）和 \`agent.input\`（要详细内容）→ 必须**拆成两个 output 槽**（如 \`result:text\` + \`report:file\`）
   b. **text vs file 错配**：内容超过 ~1KB 或为多行报告/日志/源码 → 应是 \`file\`；只是路径串/key/JSON 短串 → 应是 \`text\`
   c. **bool 误用**：\`bool\` 槽只允许出现在 \`control_toBool.prediction\`(out) 与 \`control_if.prediction\`(in) 这一对位置，其它任何节点禁用
   d. **节点类型错配**：发现 \`tool_nodejs\` 实际做的是非确定性任务（代码翻译/源码理解/创意生成）→ 改 \`definitionId: agent_subAgent\` + 删 script + 把要求写到 body
   e. **provide_* 类型对齐**：\`provide_str\` 必须 \`output[0].type=text\`；\`provide_file\` 必须 \`output[0].type=file\`
3. **ui.nodePositions**：按 \`reference/flow-layout.md\` 优化布局（主链 x 递增、分支 y 错开、避免一条线）。
4. 完成后应能通过 validate-flow；可用 add-edge、update-position 等 script 步骤，必要时用 agent 步骤处理复杂拓扑。

**不要**在此阶段重写 tool_nodejs 脚本正文（除非为审查 d 类型错配或修复占位符所必需）。`,
  };

  return `你是 AgentFlow Composer 的分阶段任务规划器。当前正在执行分阶段 flow 生成的特定阶段。

${phaseInstructions[phaseName] || "根据当前阶段完成对应的操作。"}

## script 类型（Node.js 直接执行，毫秒级）
确定性操作，用户给了明确目标值时使用：
- edit-label：改 label（params: instanceId, value）
- edit-body：改 body（params: instanceId, value）
- edit-script：改 tool_nodejs 的 script（params: instanceId, value）**tool_nodejs 节点必须用此操作写入可执行命令**
- edit-role：改 role（params: instanceId, value）
- edit-input-value：改某个 input 的 value（params: instanceId, inputName, value）
- edit-output-value：改某个 output 的 value（params: instanceId, outputName, value）
- add-edge：连线（params: source, target, sourceHandle, targetHandle）
- remove-edge：断线（params: source, target）
- update-position：移动节点（params: instanceId, x, y）

## agent 类型（AI 生成，需要选模型）
- complexity "simple"：写简短文案、微调 body 等
- complexity "medium"：添加节点并设计内容
- complexity "complex"：重新设计流程拓扑、多节点重构

agent 步骤的 prompt 必须是独立可执行的精确指令，包含必要上下文（文件路径等）。

## 规则
1. 用户给了明确值 → script op；需要 AI 创造 → agent 步骤
2. **tool_nodejs 节点（definitionId: tool_nodejs）**核心是 \`script\` 字段（可执行 shell/node），\`body\` 仅是说明不会被执行。
   - 若能确定脚本内容 → 用 edit-script 直接写入完整可执行脚本
   - 若需 AI 生成 → 用 agent 步骤，prompt 中**必须**写明：「把可执行脚本写入 \`script\` 字段（YAML \`|\` 块），body 只写一句说明。script 为空或为自然语言将导致节点失败。」
   - \`script\` 中**禁止**写成 \`node "\${workspaceRoot}/..."\`：\`\${}\` 已会被单独转义，外包双引号会破坏路径；应写成 \`node \${workspaceRoot}/...\`。
3. 只做当前阶段的工作，不要超出范围
4. agent 步骤 prompt 里要包含 flow.yaml 路径和上下文
5. 生成的 agent 步骤 prompt 必须**复述**或**引用**下方「内置节点 schema」中相关 definitionId 的槽位（type/name/顺序），让子 agent 不必再去读 builtin/nodes/${schemaSection}${skillSection}

输出严格 JSON：
{
  "steps": [
    { "type": "script", "op": "add-edge", "description": "...", "params": { ... } },
    { "type": "agent", "complexity": "medium", "description": "...", "prompt": "...",
      "instanceId": "可选", "nodeRole": "可选", "executorModel": "可选" }
  ]
}`;
}

function buildPhasedUserMessage(userPrompt, flowYaml, flowYamlAbs, phaseName, phaseIndex, thread) {
  const parts = [];
  const historyBlock = formatPlannerThreadHistory(thread);
  if (historyBlock) parts.push(historyBlock);
  parts.push(`## 用户原始需求\n${userPrompt.trim()}`);
  parts.push(`\n## 当前阶段\n第 ${phaseIndex + 1}/${PHASED_PHASE_COUNT} 阶段：${phaseName}`);
  if (flowYaml) {
    const trimmed = flowYaml.length > 6000 ? flowYaml.slice(0, 6000) + "\n# ... (truncated)" : flowYaml;
    parts.push(`\n## 当前 flow.yaml（${flowYamlAbs || ""}）\n\`\`\`yaml\n${trimmed}\n\`\`\``);
    parts.push(formatInstancePlannerHint(flowYaml));
  }
  parts.push("\n请输出 JSON 任务分解（仅包含当前阶段需要的步骤）。");
  return parts.join("\n");
}

// ─── 规划器系统提示 ────────────────────────────────────────────────────────

function buildPlannerSystemPrompt(intents) {
  const skillContext = buildPlannerSkillContext(intents || []);
  const skillSection = skillContext ? "\n\n" + skillContext : "";
  const schemaSection = "\n\n" + buildNodeSchemaPromptSection();

  return `你是 AgentFlow Composer 的任务规划器。将用户的 flow.yaml 编辑请求分解为独立子任务。

## script 类型（Node.js 直接执行，毫秒级）
确定性操作，用户给了明确目标值时使用：
- edit-label：改 label（params: instanceId, value）
- edit-body：改 body，用户给了完整文本（params: instanceId, value）
- edit-script：改 tool_nodejs 的 script（params: instanceId, value）**tool_nodejs 节点必须用此操作写入可执行命令**
- edit-role：改 role（params: instanceId, value）
- edit-input-value：改某个 input 的 value（params: instanceId, inputName, value）
- edit-output-value：改某个 output 的 value（params: instanceId, outputName, value）
- add-edge：连线（params: source, target, sourceHandle, targetHandle）
- remove-edge：断线（params: source, target）
- update-position：移动节点（params: instanceId, x, y）

## agent 类型（AI 生成，需要选模型）
- complexity "simple"：写简短文案、微调 body 等（用快速模型）
- complexity "medium"：添加节点并设计内容（用中等模型）
- complexity "complex"：重新设计流程拓扑、多节点重构（用强力模型）

agent 步骤的 prompt 必须是独立可执行的精确指令，包含必要上下文（文件路径等）。

## 规则
1. 用户给了明确值 → script op；需要 AI 创造 → agent 步骤
2. **tool_nodejs 节点（definitionId: tool_nodejs）**核心是 \`script\` 字段（可执行 shell/node 命令），\`body\` 仅是说明文本不会被执行。
   - 若能确定脚本内容 → 用 edit-script 直接写入
   - 若需 AI 生成 → 用 agent 步骤，prompt 中**必须**写明：「把可执行脚本写入 instance 的 \`script\` 字段（YAML \`|\` 块），body 只写一句说明。script 为空或为自然语言将导致节点运行失败。」
   - \`script\` 中**禁止** \`node "\${workspaceRoot}/..."\`：应 \`node \${workspaceRoot}/...\`（\`\${}\` 已单独 shell 转义，勿再包双引号）。
   - **引脚路径约束**：脚本读写文件的路径**必须通过引脚传入**。\`script\` 中用 \`\${槽位名}\` 引用 input/output 路径（如 \`--input \${figma_tree} --output \${todolist}\`），脚本通过命令行参数接收后直接读写。**禁止**在脚本内自行拼 \`node_<instance>_xxx\` 或用 \`outDirForNode\` 构造路径——产物路径与流水线解析器约定不一致会导致下游节点找不到文件。
3. 拆小不合大：每步只做一件事
4. 不同节点的内容生成拆为独立 agent 步骤；涉及已有实例时填写 **instanceId**，**nodeRole** 与该实例在 YAML 中的 role 一致；需要指定本步 CLI 模型时可填 **executorModel**
5. 先改内容再连线，先加节点再连线
6. agent 步骤 prompt 里要包含 flow.yaml 路径和上下文
7. **循环拆解**：涉及校验/检查/迭代/批量/遍历的流程，agent 步骤的 prompt 中须指导 AI 用 control_anyOne + control_toBool + control_if 设计环路（check → fix → re-check），禁止线性链。批量/大任务推荐 todolist 模式（拆解产出 \`- [ ]\` 清单 → 循环执行打勾 → ToBool 判定全部完成 → If 出环/继续）${schemaSection}${skillSection}

输出严格 JSON：
{
  "steps": [
    { "type": "script", "op": "edit-label", "description": "...", "params": { ... } },
    { "type": "agent", "complexity": "simple", "description": "...", "prompt": "...",
      "instanceId": "可选，本步主要操作的实例 id",
      "nodeRole": "可选，与画布角色一致：requirement|planning|code|test|normal（或中文：需求拆解|技术规划|代码执行|测试回归|普通）",
      "executorModel": "可选，本步执行模型（覆盖实例 model；不设则用实例或用户全局模型）" }
  ]
}`;
}

function formatPlannerThreadHistory(thread) {
  if (!thread || thread.length === 0) return "";
  const MAX_CHARS = 3000;
  const recent = thread.slice(-10);
  const lines = [];
  let chars = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    const label = m.role === "user" ? "用户" : "助手";
    const text = m.text.length > 600 ? m.text.slice(0, 600) + "…(截断)" : m.text;
    const line = `${label}：${text}`;
    if (chars + line.length > MAX_CHARS) break;
    lines.unshift(line);
    chars += line.length;
  }
  if (lines.length === 0) return "";
  return "\n## 对话历史\n" + lines.join("\n\n");
}

function buildPlannerUserMessage(userPrompt, flowYaml, instanceIds, flowYamlAbs, thread) {
  const parts = [];
  const historyBlock = formatPlannerThreadHistory(thread);
  if (historyBlock) parts.push(historyBlock);
  parts.push(`## 用户请求\n${userPrompt.trim()}`);
  if (flowYaml) {
    const trimmed = flowYaml.length > 6000 ? flowYaml.slice(0, 6000) + "\n# ... (truncated)" : flowYaml;
    parts.push(`\n## 当前 flow.yaml（${flowYamlAbs || ""}）\n\`\`\`yaml\n${trimmed}\n\`\`\``);
    parts.push(formatInstancePlannerHint(flowYaml));
  }
  if (instanceIds?.length) {
    parts.push(`\n## 关联节点 ID（优先操作这些实例）\n${instanceIds.join(", ")}`);
  }
  parts.push("\n请输出 JSON 任务分解。");
  return parts.join("\n");
}

// ─── API 调用 ──────────────────────────────────────────────────────────────

async function callPlannerApi(systemPrompt, userMessage, apiProvider) {
  const { provider, apiKey, baseUrl, model } = apiProvider;

  if (provider === "anthropic") {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        max_tokens: PLANNER_MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(PLANNER_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`Anthropic ${resp.status}`);
    const data = await resp.json();
    const text = data.content?.find((b) => b.type === "text")?.text ?? "";
    return text;
  }

  const url = `${(baseUrl || "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      max_tokens: PLANNER_MAX_TOKENS,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(PLANNER_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? "";
}

function parseStepsJson(raw) {
  const text = String(raw || "").trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (Array.isArray(parsed.steps) && parsed.steps.length > 0) return parsed.steps;
  } catch { /* ignore */ }
  return null;
}

// ─── 启发式分类（兜底） ────────────────────────────────────────────────────

const HEURISTIC_PATTERNS = [
  { re: /(?:改|修改|更新|设置|设为|改为|换成).*(?:label|标签|名称|名字)/i, type: "script", op: "edit-label" },
  { re: /(?:改|修改|更新|设置).*(?:role|角色)/i, type: "script", op: "edit-role" },
  { re: /(?:连接|连线|接到|连到|接入)/i, type: "script", op: "add-edge" },
  { re: /(?:断开|删除连线|删除边|取消连接|断线)/i, type: "script", op: "remove-edge" },
  { re: /(?:移动|拖到|移到|位置)/i, type: "script", op: "update-position" },
];

function classifyComplexity(prompt) {
  const len = prompt.length;
  const hasMultipleActions = /[，,].*(?:并|且|然后|接着|同时|再)/.test(prompt);
  const hasTopologyChange = /(?:重新设计|重构|重新规划|调整.*流程|拓扑)/.test(prompt);
  if (hasTopologyChange || len > 300) return "complex";
  if (hasMultipleActions || len > 150) return "medium";
  return "simple";
}

function heuristicPlan(userPrompt) {
  for (const { re, type, op } of HEURISTIC_PATTERNS) {
    if (re.test(userPrompt)) {
      return [{ type, op, description: userPrompt.slice(0, 120), params: {} }];
    }
  }
  const complexity = classifyComplexity(userPrompt);
  return [{ type: "agent", complexity, description: userPrompt.slice(0, 120), prompt: userPrompt }];
}

// ─── AI 任务复杂度分类（通过 Cursor/OpenCode CLI 或 API） ─────────────────

const CLASSIFY_PROMPT = `你是 AgentFlow 任务分类器。判断用户对流程图的编辑请求属于哪类：
- "multi"：涉及分支/循环/并行等复杂拓扑的新建流程、重构/重新设计流程、涉及多个节点的增删改、复杂拓扑变更
- "single"：新建简单线性流程（如仅需 start→一两个节点→end 的简单任务）、改标签/文案、改一个节点的 body 或 script、连/断一条边、移动节点位置、添加一两个节点的小改动

判断"新建"请求时，重点看需求本身的复杂度：如果需求简单（如打印文本、单步操作），即使是新建也应归为 single；只有需求涉及多节点协作、分支判断、循环检查等才归为 multi。

用户请求：
---
{USER_PROMPT}
---

只回复 multi 或 single 一个单词，不要解释。`;

const CLASSIFY_CLI_TIMEOUT_MS = 60_000;

/**
 * 通过 Cursor/OpenCode CLI 调用 AI 做分类。
 * 收集 stdout 中的 assistant 文本，提取 multi/single。
 */
async function classifyViaCli(userPrompt, cliWorkspace) {
  const prompt = CLASSIFY_PROMPT.replace("{USER_PROMPT}", userPrompt.slice(0, 2000));
  const { cli, model } = resolveCliAndModel(cliWorkspace, null, null);

  let collected = "";
  const onStreamEvent = (ev) => {
    if (ev.type === "natural" && typeof ev.text === "string") {
      collected += " " + ev.text;
    }
  };

  const runner = cli === "opencode"
    ? runOpenCodeAgentWithPrompt(cliWorkspace, prompt, { onStreamEvent, model: model || undefined })
    : runCursorAgentWithPrompt(cliWorkspace, prompt, { onStreamEvent, model: model || undefined, force: true });

  const timeout = new Promise((_, reject) =>
    setTimeout(() => {
      try { runner.child.kill("SIGTERM"); } catch {}
      reject(new Error(`[CLASSIFY_TIMEOUT] ${cli} CLI 分类超时 (${CLASSIFY_CLI_TIMEOUT_MS}ms), collected: "${collected.trim().slice(0, 100)}"`));
    }, CLASSIFY_CLI_TIMEOUT_MS),
  );

  await Promise.race([runner.finished, timeout]);

  const lower = collected.toLowerCase();
  if (lower.includes("multi")) return "multi";
  if (lower.includes("single")) return "single";
  return null;
}

/**
 * AI 判断任务是否需要多步执行。
 * 优先级：分阶段正则快检 → CLI AI 分类 → 正则启发式兜底。
 * @param {string} userPrompt
 * @param {string} [cliWorkspace] Cursor/OpenCode 工作目录
 * @returns {Promise<"multi" | "single">}
 */
export async function classifyTaskComplexity(userPrompt, cliWorkspace) {
  if (cliWorkspace) {
    try {
      const result = await classifyViaCli(userPrompt, cliWorkspace);
      if (result) return result;
    } catch (e) {
      process.stderr.write(`[classifyTaskComplexity] CLI classify failed, falling back to heuristic: ${e.message}\n`);
    }
  }

  return classifyComplexity(userPrompt) === "complex" ? "multi" : "single";
}

// ─── 选择规划器使用的快速模型 ──────────────────────────────────────────────

function resolvePlannerApiProvider(plannerModel) {
  if (plannerModel) {
    const { provider, model } = parseApiModel(plannerModel);
    if (provider === "anthropic") {
      const key = process.env.ANTHROPIC_API_KEY;
      if (key) return { provider: "anthropic", apiKey: key, model, baseUrl: null };
    } else {
      const key = process.env.OPENAI_API_KEY;
      if (key) {
        const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
        return { provider: "openai", apiKey: key, baseUrl, model };
      }
    }
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    return { provider: "openai", apiKey: openaiKey, baseUrl, model: "gpt-4o-mini" };
  }
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return { provider: "anthropic", apiKey: anthropicKey, model: "claude-3-5-haiku-20241022", baseUrl: null };
  }
  return null;
}

// ─── 公开接口 ──────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.userPrompt
 * @param {string} [opts.flowYaml] 当前 flow.yaml 内容
 * @param {string} [opts.flowYamlAbs] flow.yaml 绝对路径
 * @param {string[]} [opts.instanceIds]
 * @param {Array<{ role: string, text: string }>} [opts.thread] 对话历史
 * @param {string[]} [opts.intents] 检测到的用户意图（来自 composer-skill-router）
 * @param {string} [opts.plannerModel] 指定规划器模型，如 "api:openai/gpt-4o-mini"
 * @param {object} [opts.phaseContext] 分阶段上下文 { phaseIndex, phases, userPromptOriginal }
 * @param {string} [opts.phaseRole] 用户为本阶段指定的默认节点角色
 * @param {(ev: object) => void} [opts.onEvent]
 * @returns {Promise<{ steps: Array<{ type: string, op?: string, complexity?: string, description: string, params?: object, prompt?: string }>, phased?: boolean, phases?: Array, currentPhase?: number }>}
 */
export async function planComposerTasks(opts) {
  const emit = opts.onEvent || (() => {});
  const apiProvider = resolvePlannerApiProvider(opts.plannerModel);

  const phaseCtx = opts.phaseContext;
  const isPhased = shouldUsePhased(opts.userPrompt, phaseCtx);

  if (isPhased) {
    const phaseIndex = (phaseCtx && typeof phaseCtx.phaseIndex === "number") ? phaseCtx.phaseIndex : 0;
    const result = await planSinglePhase({
      ...opts,
      phaseIndex,
      apiProvider,
      emit,
    });
    return result;
  }

  if (!apiProvider) {
    emit({ type: "status", line: t("planner.heuristic_analysis") });
    return { steps: heuristicPlan(opts.userPrompt) };
  }

  emit({ type: "status", line: t("planner.planning", { model: apiProvider.model }) });

  let flowYaml = opts.flowYaml || "";
  if (!flowYaml && opts.flowYamlAbs) {
    try { flowYaml = fs.readFileSync(opts.flowYamlAbs, "utf-8"); } catch { /* ignore */ }
  }

  const systemPrompt = buildPlannerSystemPrompt(opts.intents);
  const userMessage = buildPlannerUserMessage(opts.userPrompt, flowYaml, opts.instanceIds, opts.flowYamlAbs, opts.thread);

  emit({ type: "ai-log", tag: "planner-system", text: systemPrompt, meta: { provider: apiProvider.provider, model: apiProvider.model, mode: "regular" } });
  emit({ type: "ai-log", tag: "planner-user", text: userMessage, meta: { flowYamlAbs: opts.flowYamlAbs || null, instanceIds: opts.instanceIds || [] } });

  try {
    const raw = await callPlannerApi(systemPrompt, userMessage, apiProvider);
    emit({ type: "ai-log", tag: "planner-response", text: String(raw || ""), meta: { provider: apiProvider.provider, model: apiProvider.model } });
    const steps = parseStepsJson(raw);
    if (steps && steps.length > 0) {
      return { steps };
    }
    emit({ type: "status", line: t("planner.planner_format_error") });
  } catch (e) {
    emit({ type: "status", line: t("planner.planner_call_failed", { message: e.message }) });
  }

  return { steps: heuristicPlan(opts.userPrompt) };
}

// ─── 分阶段 CLI 快捷路径：追加到 agent prompt 的固定指引 ───────────────────
// 节点类型速查已并入 buildNodeSchemaCompactSection，不在此处重复

/** 与 API 规划器 flow_plan 阶段对齐的 CLI 指引 */
function buildPhaseCliGuide(phaseIndex) {
  if (phaseIndex === 0) {
    return `

## 阶段：流转规划（必读）
目标：**框架合理、类型正确、职责清晰**。建立可读的流转图（含 if/循环/并行等时选对节点）。

**前置已就位**（脚本已写盘，**无需重建**）：
- \`flow.yaml\` 已含 \`control_start\` + \`control_end\` + 一条主链 edge（output-0 → input-0）+ \`ui.nodePositions\`
- \`${COMPOSER_NODE_SPEC_FILENAME}\` 已含三段 section 占位符（整体框架 / 节点职责 / 计划数据槽）

你的工作（**鼓励一次写到位，不强行拆阶段**）：
1. **向 flow.yaml 的 instances 中插入新节点**（保留 start/end，不要删改现有两节点）：definitionId、label。body 写一句职责概要即可；如果你已经清楚要做什么，**也允许直接写得详细**——阶段二会按 name 去重不会重复。
2. **input/output（不强制锁死）**：基础控制槽（\`prev\`/\`next\` 等）保留 schema 默认结构。**业务数据槽（text/file）想清楚的就直接追加到 flow.yaml** 末尾，阶段二会跳过已存在的 name；想不清的留到阶段二。type 必为 \`text\` 或 \`file\`，**禁止 node**。务必**同时**在 spec.md「计划数据槽」section 登记一份完整设计（即使你已落到 yaml）——让 spec.md 始终是完整设计文档，阶段二/三的补漏依据。
3. **edges（不强制锁死）**：
   - 删除 skeleton 的 start→end 占位 edge，改为 Start→N1→N2→…→End 的主路径，均用 **output-0 → input-0**
   - 副边（control_if 的 prediction、control_toBool 的 value、回流到 anyOne.prev2、tool/agent 业务数据边）**能确定就连**——连后阶段三只补漏；不确定就留到阶段三，spec.md 节点职责里写清「输入 ← 来自 X」「输出 → 给 Y」即可
4. **ui.nodePositions**：为每个新 instance 加坐标，主链从左到右 x 每节点递增 **280**（起始 x:100 y:300），分支 y 错开 **200**。不要动 start/end 现有坐标。
5. **填充 ${COMPOSER_NODE_SPEC_FILENAME} 三段 section**（保留文件结构与标题；删除 HTML 注释占位 \`<!-- ... -->\` 后写入具体内容）：
   - \`## 整体框架\`：主链、分支、循环、并行、全局数据等设计说明。
   - \`## 节点职责\`：**每个 instanceId 必须写齐 4 项**：
     - **职责**：一句话
     - **输入**：列出每个 input 槽 → 语义 + 来源（\`<上游id>.<slot>\`）
     - **输出**：列出每个 output 槽 → 语义 + 去向（\`<下游id>.<slot>\`）
     - **实现要点**：tool_nodejs 写脚本路径（\`scripts/<id>.mjs\`）、agent_subAgent 写 body 关键点、control_* 写判定/汇合规则、provide_* 写固定值
     用途：输入/输出的来源/去向就是阶段三连线 \`sourceHandle/targetHandle\` 的依据，写清此处可避免阶段三反复猜
   - \`## 计划数据槽\`：仍然要写（即使阶段一已落到 yaml）——是阶段二/三的设计权威与对账依据
6. **循环拆解原则**：AgentFlow 通过循环分解复杂问题。涉及校验/检查/迭代/批量/遍历的任务，**必须**用 control_anyOne + control_toBool + control_if 构建环路（check → fix → re-check），**禁止**设计成线性链。批量/大任务优先使用 **todolist 模式**：拆解节点产出 \`- [ ]\` 清单 → 循环执行并打勾 → ToBool 判定全部完成 → If 出环/继续。
**节点类型选型判据**：**确定性任务 → \`tool_nodejs\`；非确定性任务 → \`agent_subAgent\`**。
- **确定性** = 相同输入永远产出相同输出，可用普通代码完整描述（跑 CLI、npm、读写文件、JSON/路径转换、调现成 API 解析固定格式）→ tool_nodejs
- **非确定性** = 需语义理解或创造（**代码翻译/生成**如 Android→RN、Vue→React；**理解源码/文本**如解析、改写、review；**多步推理决策**；**创意写作**）→ agent_subAgent
- 醒目输出 → \`tool_print\`；分支 → \`toBool+if\`；固定文本 → \`provide\`；密钥 → \`get_env\`
**反例**：『Android 页面转 RN/TS』『代码 review』必然非确定性，必须 agent_subAgent，做成 tool_nodejs 必然失败。`;
  }
  if (phaseIndex === 1) {
    return `

## 阶段：节点补充（必读）
1. 阅读 **${COMPOSER_NODE_SPEC_FILENAME}**（路径见上下文）与 **flow.yaml**。
2. **agent_subAgent**：写准确、完整的 **body**（规则、\`\${...}\` 路径）；本阶段宜用**较快/普通模型**完成即可。
3. **tool_nodejs**：在流水线 **scripts/** 下创建 **Node 可执行脚本**（路径见上下文），\`script\` 字段写完整 shell/node 调用命令；遵守仓库 Node 与 tool_nodejs 规范。**不要**写成 \`node "\${workspaceRoot}/..."\`，应 \`node \${workspaceRoot}/...\`（占位符已单独转义，外包双引号会坏路径）。
4. **引脚路径约束**：脚本读写文件的路径**必须从引脚传入**，\`script\` 中用 \`\${槽位名}\` 引用 input/output 路径（如 \`--input \${figma_tree} --output \${todolist}\`）。**禁止**在脚本内自行拼 \`node_<instance>_xxx\` 或调用 \`outDirForNode\` 构造路径——否则产物路径与流水线解析器约定不一致，下游节点找不到文件。
5. **引脚**：按节点定义与 reference 核对 **input/output 顺序与索引**（input-0、output-1 等），与规格书一致。
6. **不要**大改实例拓扑或补全复杂副引脚连线（留待流程完善）。`;
  }
  if (phaseIndex === 2) {
    return `

## 阶段：流程完善（必读）
1. 依据 **${COMPOSER_NODE_SPEC_FILENAME}** 与当前 **flow.yaml**，**补全所有 edges**（含 if 的 prediction、多路 handle 等），handle 与槽位索引严格对应。
2. **引脚语义审查 checklist**（每节点过一遍）：
   a. **同 output 多消费者冲突**：一个 output 同时供给两个语义矛盾的下游（如 \`toBool.value\` 要单行 true/false 与 \`agent.input\` 要详细内容）→ 拆成两个 output 槽
   b. **text/file 错配**：内容超 ~1KB 或多行报告/源码 → 应是 \`file\`；只是路径串/key/JSON 短串 → 应是 \`text\`
   c. **bool 误用**：\`bool\` 槽只允许 \`control_toBool.prediction\`(out) → \`control_if.prediction\`(in)，其它禁用
   d. **节点类型错配**：\`tool_nodejs\` 实际做非确定性任务（代码翻译/源码理解/创意生成）→ 改 \`definitionId: agent_subAgent\` + 删 script + 写 body
   e. **provide_* 类型对齐**：\`provide_str.output[0].type\` 必为 \`text\`；\`provide_file.output[0].type\` 必为 \`file\`
3. **优化 ui.nodePositions**（参考 flow-layout.md：主链 x 递增、分支 y 错开）。
4. 完成后须能通过 **validate-flow**；本轮结束后系统会自动校验并尝试修复。`;
  }
  return "";
}

/**
 * 为分阶段模式规划单个阶段的步骤。
 */
async function planSinglePhase(opts) {
  const { phaseIndex, apiProvider, emit } = opts;
  const phase = PHASED_DEFINITIONS[phaseIndex];
  // 创建带 status 字段的 phases 副本，避免修改原始常量
  const buildPhasesWithStatus = (currentIdx) => PHASED_DEFINITIONS.map((p, i) => ({
    ...p,
    status: i < currentIdx ? "done" : i === currentIdx ? "running" : "pending",
  }));

  if (!phase) {
    return { steps: heuristicPlan(opts.userPrompt), phased: true, phases: buildPhasesWithStatus(phaseIndex), currentPhase: phaseIndex };
  }

  emit({ type: "status", line: t("planner.phased_planning", { label: phase.label, index: phaseIndex + 1, total: PHASED_DEFINITIONS.length }) });

  let flowYaml = opts.flowYaml || "";
  if (!flowYaml && opts.flowYamlAbs) {
    try { flowYaml = fs.readFileSync(opts.flowYamlAbs, "utf-8"); } catch { /* ignore */ }
  }

  let userPromptForPlan = opts.phaseContext?.userPromptOriginal || opts.userPrompt;
  if (opts.phaseRole) {
    userPromptForPlan += `\n\n【用户指定本阶段默认节点角色偏好：${opts.phaseRole}】`;
  }
  const phaseCli = buildPhaseCliGuide(phaseIndex);

  if (phaseIndex === 0 && (!flowYaml || flowYaml.trim().length < 50)) {
    const steps = [{
      type: "agent",
      complexity: "complex",
      description: `${phase.label}：节点类型与框架 + ${COMPOSER_NODE_SPEC_FILENAME}`,
      prompt: userPromptForPlan + phaseCli,
    }];
    return { steps, phased: true, phases: buildPhasesWithStatus(phaseIndex), currentPhase: phaseIndex };
  }

  if (!apiProvider) {
    emit({ type: "status", line: t("planner.phased_cli_exec", { label: phase.label }) });
    const complexity = phaseIndex === 0 ? "complex" : phaseIndex === 1 ? "simple" : "complex";
    const steps = [{
      type: "agent",
      complexity,
      description: `${phase.label}：${phase.description}`,
      prompt: `${userPromptForPlan}${phaseCli}\n\n当前阶段：${phase.label} — ${phase.description}`,
    }];
    return { steps, phased: true, phases: buildPhasesWithStatus(phaseIndex), currentPhase: phaseIndex };
  }

  const systemPrompt = buildPhasedSystemPrompt(phase.name, opts.intents);
  const userMessage = buildPhasedUserMessage(userPromptForPlan, flowYaml, opts.flowYamlAbs, phase.name, phaseIndex, opts.thread);

  emit({ type: "ai-log", tag: "planner-system", text: systemPrompt, meta: { provider: apiProvider.provider, model: apiProvider.model, mode: "phased", phaseName: phase.name, phaseIndex } });
  emit({ type: "ai-log", tag: "planner-user", text: userMessage, meta: { flowYamlAbs: opts.flowYamlAbs || null, phaseName: phase.name, phaseIndex } });

  try {
    const raw = await callPlannerApi(systemPrompt, userMessage, apiProvider);
    emit({ type: "ai-log", tag: "planner-response", text: String(raw || ""), meta: { provider: apiProvider.provider, model: apiProvider.model, phaseName: phase.name, phaseIndex } });
    const steps = parseStepsJson(raw);
    if (steps && steps.length > 0) {
      return { steps, phased: true, phases: buildPhasesWithStatus(phaseIndex), currentPhase: phaseIndex };
    }
    emit({ type: "status", line: t("planner.phased_format_error") });
  } catch (e) {
    emit({ type: "status", line: t("planner.phased_planning_failed", { message: e.message }) });
  }

  const complexity = phaseIndex === 0 ? "complex" : phaseIndex === 1 ? "simple" : "complex";
  const steps = [{
    type: "agent",
    complexity,
    description: `${phase.label}：${phase.description}`,
    prompt: `${userPromptForPlan}${phaseCli}\n\n当前阶段：${phase.label} — ${phase.description}`,
  }];
  return { steps, phased: true, phases: buildPhasesWithStatus(phaseIndex), currentPhase: phaseIndex };
}

/**
 * 检查是否有可用的 API key 用于规划。
 */
export function hasPlannerApiAvailable() {
  return Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
}

/**
 * 检查用户请求是否适合分阶段生成。
 */
export { shouldUsePhased, classifyComplexity, PHASED_DEFINITIONS };
