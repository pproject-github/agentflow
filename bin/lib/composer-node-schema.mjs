/**
 * Composer 节点 schema 加载器：读取 builtin/nodes/*.md frontmatter，
 * 输出 definitionId → input/output 槽位的紧凑 schema 表，
 * 注入 composer 规划器/子 agent 的 system prompt，作为 ground truth。
 *
 * 目的：避免 agent 凭记忆造槽位 type/name/顺序（常见错误：provide_str output 写成 type=node、
 * 槽位中英混乱、默认值漂移）。
 */

import fs from "fs";
import path from "path";
import yaml from "js-yaml";

import { PACKAGE_BUILTIN_NODES_DIR } from "./paths.mjs";

/**
 * 可扩展节点：允许在基础控制槽（prev/next）之外**追加** type=text|file 的业务数据槽。
 * 其它节点（control_*、provide_*、tool_load_key、tool_save_key、tool_get_env、tool_print、tool_user_ask）
 * 必须严格保持 schema 默认槽位结构。
 */
export const EXTENSIBLE_DEFINITIONS = new Set([
  "agent_subAgent",
  "tool_nodejs",
  "tool_user_check",
]);

/**
 * 合法 role 值（与 bin/pipeline/validate-flow.mjs:VALID_ROLES 保持同步）。
 * 推荐使用英文 key；中文别名仅为兼容旧画布。
 */
export const VALID_ROLE_VALUES = [
  "requirement", "planning", "code", "test", "normal",
  "需求拆解", "技术规划", "代码执行", "测试回归", "普通",
  "前端/UI",
  "agentflow-node-executor-requirement",
  "agentflow-node-executor-planning",
  "agentflow-node-executor-code",
  "agentflow-node-executor-test",
  "agentflow-node-executor-ui",
  "agentflow-node-executor",
];

let cachedTable = null;
let cachedSummary = null;
let cachedCompact = null;

/** 解析单个节点 .md 的 frontmatter，返回 { input:[{name,type}], output:[{name,type}], description } */
function parseNodeFrontmatter(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return null;
    const fm = yaml.load(m[1]);
    if (!fm || typeof fm !== "object") return null;
    const toSlots = (arr) =>
      Array.isArray(arr)
        ? arr.map((s) => ({
            name: s && s.name != null ? String(s.name) : "",
            type: s && s.type != null ? String(s.type) : "",
          }))
        : [];
    return {
      description: fm.displayName || fm.description || "",
      input: toSlots(fm.input),
      output: toSlots(fm.output),
    };
  } catch {
    return null;
  }
}

/**
 * 读取所有内置节点定义并缓存。
 * @returns {Record<string, {input:Array<{name,type}>, output:Array<{name,type}>, description:string}>}
 */
export function getBuiltinNodeSchemas() {
  if (cachedTable) return cachedTable;
  const table = {};
  if (!fs.existsSync(PACKAGE_BUILTIN_NODES_DIR)) {
    cachedTable = table;
    return table;
  }
  const files = fs.readdirSync(PACKAGE_BUILTIN_NODES_DIR).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    const definitionId = f.replace(/\.md$/, "");
    const parsed = parseNodeFrontmatter(path.join(PACKAGE_BUILTIN_NODES_DIR, f));
    if (parsed) table[definitionId] = parsed;
  }
  cachedTable = table;
  return table;
}

/** 把单条 schema 压成一行：`tool_nodejs ★  in: prev:node  out: next:node, result:text`（★ 标记可扩展） */
function formatSchemaLine(definitionId, def) {
  const fmt = (slot) => `${slot.name || "_"}:${slot.type || "?"}`;
  const inStr = def.input.length > 0 ? def.input.map(fmt).join(", ") : "—";
  const outStr = def.output.length > 0 ? def.output.map(fmt).join(", ") : "—";
  const mark = EXTENSIBLE_DEFINITIONS.has(definitionId) ? " ★" : "";
  return `- ${definitionId}${mark}  in: ${inStr}  out: ${outStr}`;
}

/**
 * Compact 版：schema 表 + 5 条硬约束 + 引脚 type 决策树（约 2KB）。
 * 默认所有 agent step 用此版本；只有 step 修改 ★ 扩展节点的槽位时才升级到 full 版。
 */
export function buildNodeSchemaCompactSection() {
  if (cachedCompact) return cachedCompact;
  const table = getBuiltinNodeSchemas();
  const lines = [];
  lines.push("## 引脚 type 含义（设计连线前必读）");
  lines.push("流水线里「连一条 edge」就是「上游 output 槽位 → 下游同 type 的 input 槽位」传一份数据。**type 决定这条线传什么、做什么**：");
  lines.push("");
  lines.push("- **`node`**（控制流连线）：只表达「执行顺序」，**不携带业务数据**。串主链（Start→A→B→End）、汇合分支用它。槽位名通常是 `prev` / `next` / `prev1` / `next2` / `option_N`。⚠️ 业务字段绝不要标 `node`。");
  lines.push("- **`text`**（短上下文 / 结论 / 路径串）：上游把字符串结果（分析结论、用户输入、key 名、JSON 串）直接传给下游；下游 body / script 用 `${slotName}` 引用，apply 时原样替换。适合 < ~1KB 的内容。");
  lines.push("- **`file`**（大块产物 / 上下文文件）：上游把内容写到一个**文件**，下游通过 `${slotName}` 拿到的是**文件绝对路径**（不是内容）。下游需 Read 该路径取内容。适合报告 / todolist / 中间代码 / 截图等 > 1KB 或二进制。");
  lines.push("- **`bool`**（仅做分支判定）：只在 `control_toBool.prediction`(out) → `control_if.prediction`(in) 一对位置使用，其它任何节点禁止 `bool` 槽。");
  lines.push("");
  lines.push("**选 type 决策**：");
  lines.push("- 想表达「下一步走谁」 → `node`");
  lines.push("- 想传「短串/路径/key/JSON」 → `text`");
  lines.push("- 想传「整篇文档/报告/JSON 文件/代码」 → `file`");
  lines.push("- 想做「if 真假分支」 → `control_toBool` → `control_if`（用 bool 引脚）");
  lines.push("");
  lines.push("## 内置节点 schema（权威，必须严格遵守）");
  lines.push(
    "格式：`definitionId [★]  in: <name>:<type>, ...  out: <name>:<type>, ...` " +
    "（`type` 仅允许 `node|text|file|bool`；★ 标记的是**可扩展节点**）"
  );
  lines.push("");
  const ids = Object.keys(table).sort();
  for (const id of ids) {
    lines.push(formatSchemaLine(id, table[id]));
  }
  lines.push("");
  lines.push("**硬性约束（违反则 validate-flow 失败）：**");
  lines.push("1. **固定槽位节点**（未带 ★）：`input`/`output` 数组必须**完整复制**上表槽位（`type`、`name`、顺序、个数均不可改），仅可填写 `value`。");
  lines.push("2. **可扩展节点**（带 ★）：基础骨架不可删改，可在数组**末尾追加** type=`text` 或 `file` 的业务数据槽（按上方语义选 text 还是 file）。⚠️ 业务槽 type 必须 `text` 或 `file`，**绝对不能写 `node`**（node 仅控制流）。");
  lines.push("3. `provide_*` 节点不得连入控制链（node→node 边），仅作数据源向下游 text/file 槽供值。");
  lines.push("4. 边连接时 `sourceHandle: output-N` 与 `targetHandle: input-N` 的索引必须对应**同一 type**；type 不一致禁止连线（text 不能接 file，node 不能接 text）。");
  lines.push("5. **YAML 多行字符串必须用 `|` 块标量。** 写 `script` / `body` / `value` 等字符串字段时，只要内容含 `: `、`\"`、`'`、`#`、换行、shell 操作符，**强制**使用 `|` 块。");
  cachedCompact = lines.join("\n");
  return cachedCompact;
}

/**
 * Full 版：compact + YAML 正反对照 + role 枚举（约 5KB）。
 * 仅当 step 修改 ★ 扩展节点的 input/output 结构时使用，避免误把业务槽写成 type:node。
 */
export function buildNodeSchemaPromptSection() {
  if (cachedSummary) return cachedSummary;
  const table = getBuiltinNodeSchemas();
  const lines = [];
  lines.push("## 引脚 type 含义（设计连线前必读）");
  lines.push("流水线里「连一条 edge」就是「上游 output 槽位 → 下游同 type 的 input 槽位」传一份数据。**type 决定这条线传什么、做什么**：");
  lines.push("");
  lines.push("- **`node`**（控制流连线）：只表达「执行顺序」，**不携带业务数据**。串主链、汇合分支用它。槽位名通常是 `prev` / `next` / `prev1` / `next2` / `option_N`。⚠️ 业务字段绝不要标 `node`。");
  lines.push("- **`text`**（短上下文 / 结论 / 路径串）：上游把字符串结果（分析结论、用户输入、key 名、JSON 串）直接传给下游；下游 body / script 用 `${slotName}` 引用，apply 时原样替换。适合 < ~1KB 的内容。");
  lines.push("- **`file`**（大块产物 / 上下文文件）：上游把内容写到一个**文件**，下游通过 `${slotName}` 拿到的是**文件绝对路径**（不是内容）。下游需 Read 该路径取内容。适合报告 / todolist / 中间代码 / 截图等 > 1KB 或二进制。");
  lines.push("- **`bool`**（仅做分支判定）：只在 `control_toBool.prediction`(out) → `control_if.prediction`(in) 一对位置使用，其它任何节点禁止 `bool` 槽。");
  lines.push("");
  lines.push("## 内置节点 schema（权威，必须严格遵守）");
  lines.push(
    "格式：`definitionId [★]  in: <name>:<type>, ...  out: <name>:<type>, ...` " +
    "（`type` 仅允许 `node|text|file|bool`；★ 标记的是**可扩展节点**）"
  );
  lines.push("");
  const ids = Object.keys(table).sort();
  for (const id of ids) {
    lines.push(formatSchemaLine(id, table[id]));
  }
  lines.push("");
  lines.push("**硬性约束（违反则 validate-flow 失败）：**");
  lines.push(
    "1. **固定槽位节点**（未带 ★）：`input`/`output` 数组必须**完整复制**上表槽位（`type`、`name`、顺序、个数均不可改），仅可填写 `value`。"
  );
  lines.push(
    "2. **可扩展节点**（带 ★：agent_subAgent / tool_nodejs / tool_user_check）：" +
    "上表槽位为**基础骨架不可删改**（`prev`/`next` 等控制槽与 schema 已有数据槽的 `type`/`name`/顺序保持一致）；" +
    "可在数组**末尾追加** type=`text` 或 `file` 的业务数据槽（`bool` 仅 control_toBool/control_if 使用，禁止他处出现），" +
    "命名应与上下游语义对齐（如 `fromapp`、`analysis`、`compile_result`、`result`），便于阶段三连线。"
  );
  lines.push(
    "   ⚠️ **追加业务数据槽时 type 必须是 `text` 或 `file`，绝对不能写 `node`。**" +
    " `node` 类型**仅限**基础控制槽（`prev`/`next`/`prev1`/`prev2`/`next1`/`next2`/`option_N`），属于 schema 默认骨架。" +
    " 不要因为 schema 表里 `prev:node` 就惯性给 `fromapp`/`toapp`/`page_name` 也写 `node`——那意味着「控制流连线」，下游会报「边类型不一致」。"
  );
  lines.push(
    "3. `provide_*` 节点不得连入控制链（node→node 边），仅作数据源向下游 text/file 槽供值。"
  );
  lines.push(
    "4. 边连接时 `sourceHandle: output-N` 与 `targetHandle: input-N` 的索引必须对应同一 type；type 不一致禁止连线。"
  );
  lines.push(
    "5. **YAML 多行字符串必须用 `|` 块标量。** 写 `script` / `body` / `value` 等字符串字段时，只要内容含 `: `（冒号+空格）、`\"`、`'`、`#`、换行、shell 操作符（`|`/`&`/`>`/`<`），**强制**使用 `|` 块。**默认全部用 `|`**——比裸写安全且易读。"
  );
  lines.push("   ✅ 正确：");
  lines.push("   ```yaml");
  lines.push("   script: |");
  lines.push("     node -e \"console.log('TODO: scripts/x.mjs')\"");
  lines.push("   ```");
  lines.push("   ❌ 错误（YAML 报 `bad indentation of a mapping entry`）：");
  lines.push("   ```yaml");
  lines.push("   script: node -e \"console.log('TODO: scripts/x.mjs')\"");
  lines.push("   ```");
  lines.push("   原因：YAML 解析器看到 `: ` 会试图开新 mapping key（`TODO` 会被当 key），缩进对不上就崩。");
  lines.push("");
  lines.push("## 引脚 type 决策树（写槽位前必看）");
  lines.push("```");
  lines.push("要追加的槽位代表什么？");
  lines.push("├─ 上游节点的「控制流向」（prev / next / prev1 / next2 ...）");
  lines.push("│    └─ 这些是 schema 默认骨架槽，**禁止你追加**，已经在基础结构里。");
  lines.push("├─ 短字符串 / JSON 串 / 路径字符串（fromapp、page_name、analysis、result、compile_result …）");
  lines.push("│    └─ type: text   ✅");
  lines.push("├─ 文件绝对路径（todolist.json、conversion_result.md、screenshot.png …）");
  lines.push("│    └─ type: file   ✅");
  lines.push("└─ 二元判定值（仅 control_toBool 的 prediction、control_if 的 prediction）");
  lines.push("     └─ type: bool   ✅（其他节点禁用）");
  lines.push("");
  lines.push("⛔ 任何业务数据槽都**不可**写 type: node");
  lines.push("```");
  lines.push("");
  lines.push("## 完整 YAML 正反对照（agent_subAgent ★ 追加业务槽）");
  lines.push("");
  lines.push("✅ **正例**（追加 `fromapp` text 输入 + `todolist` file 输出）：");
  lines.push("```yaml");
  lines.push("agent_plan:");
  lines.push("  definitionId: agent_subAgent");
  lines.push("  label: 规划");
  lines.push("  input:");
  lines.push("    - type: node          # 基础控制槽（保留，原顺序）");
  lines.push("      name: prev");
  lines.push("      value: ''");
  lines.push("    - type: text          # 追加业务数据槽（字符串入参）");
  lines.push("      name: fromapp");
  lines.push("      value: ''");
  lines.push("    - type: text          # 追加业务数据槽");
  lines.push("      name: page_name");
  lines.push("      value: ''");
  lines.push("  output:");
  lines.push("    - type: node          # 基础控制槽");
  lines.push("      name: next");
  lines.push("      value: ''");
  lines.push("    - type: file          # 追加业务数据槽（产出文件路径）");
  lines.push("      name: todolist");
  lines.push("      value: ''");
  lines.push("```");
  lines.push("");
  lines.push("❌ **反例 1**（把业务槽 type 写成 node）：");
  lines.push("```yaml");
  lines.push("input:");
  lines.push("  - type: node");
  lines.push("    name: prev");
  lines.push("  - type: node    # ❌ fromapp 是字符串入参，type 必须是 text，不是 node");
  lines.push("    name: fromapp");
  lines.push("  - type: node    # ❌ 同上");
  lines.push("    name: page_name");
  lines.push("```");
  lines.push("**会触发**：连边时 provide_str (output:text) → 该槽 (input:node)，validate-flow 报「边类型不一致」；或 agent 把它当成「上游控制流」试图等待，运行时阻塞。");
  lines.push("");
  lines.push("❌ **反例 2**（删改基础 prev/next 控制槽）：");
  lines.push("```yaml");
  lines.push("input:");
  lines.push("  - type: text    # ❌ prev 必须是 node，不可改 type");
  lines.push("    name: prev");
  lines.push("output: []        # ❌ next 不可删除，agent_subAgent 必须保留 next");
  lines.push("```");
  lines.push("**会触发**：上游 control_start.next (output-0:node) 无法连入；下游所有节点失去控制流入边。");
  lines.push("");
  lines.push("❌ **反例 3**（在固定槽位节点上追加槽）：");
  lines.push("```yaml");
  lines.push("provide_fromapp:");
  lines.push("  definitionId: provide_str   # ← 未带 ★，固定槽位节点");
  lines.push("  output:");
  lines.push("    - type: text              # ✅ schema 默认槽");
  lines.push("      name: value");
  lines.push("    - type: text              # ❌ provide_str 不可追加任何槽");
  lines.push("      name: extra");
  lines.push("```");
  lines.push("**会触发**：参考 schema 表，provide_str 仅有 `out: value:text`，多余槽位破坏 schema。");
  lines.push("");
  lines.push("## instance.role 合法枚举");
  lines.push("`role` 字段**可选**——不确定时**直接省略**（缺省即合法），切勿凭印象写「分析/参数输入/循环入口」等枚举外的值（validate 会拒绝）。");
  lines.push("若要写，仅可从下表选一项（推荐英文 key）：");
  const roleEng = VALID_ROLE_VALUES.filter((r) => /^[a-z_-]+$/i.test(r));
  const roleZh = VALID_ROLE_VALUES.filter((r) => !/^[a-z_-]+$/i.test(r));
  lines.push(`- 英文 key：${roleEng.map((r) => "`" + r + "`").join(" / ")}`);
  lines.push(`- 中文别名：${roleZh.map((r) => "`" + r + "`").join(" / ")}`);
  lines.push("约定：`agent_subAgent` 写代码相关→`code`；规划/分析→`planning`；测试→`test`；其余或不确定→`normal` 或省略。`tool_*` / `control_*` / `provide_*` 一律省略 role。");
  cachedSummary = lines.join("\n");
  return cachedSummary;
}

/** 用于测试/排错：清空缓存 */
export function _resetSchemaCache() {
  cachedTable = null;
  cachedSummary = null;
  cachedCompact = null;
}
