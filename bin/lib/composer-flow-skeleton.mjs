/**
 * Composer 阶段一 skeleton 生成器：在 AI 真正执行前，由脚本写入：
 *   1. flow.yaml — 含 control_start + control_end + 一条主链 edge + nodePositions
 *   2. composer-node-spec.md — 含三段 section 模板（整体框架/节点职责/计划数据槽）
 *
 * 设计原则：
 *   - **幂等**：只有当目标文件不存在 / 完全空 / instances 为空时才写入。
 *     如已有内容，**不动**（避免覆盖用户工作）。
 *   - **最小骨架**：让 AI 只做"插入节点 + 调整边"而非"从零写 YAML"。
 *   - **正确 YAML**：start/end 槽位结构、type、name 严格对齐 schema。
 */
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

/**
 * 写入 flow.yaml skeleton（如已有非空 instances 则跳过）。
 * @param {string} flowYamlAbs flow.yaml 绝对路径
 * @returns {{ created: boolean, reason: string }}
 */
export function ensureFlowSkeleton(flowYamlAbs) {
  if (!flowYamlAbs) return { created: false, reason: "missing flowYamlAbs" };

  const exists = fs.existsSync(flowYamlAbs);
  if (exists) {
    try {
      const raw = fs.readFileSync(flowYamlAbs, "utf-8");
      const data = yaml.load(raw);
      const instCount = data && data.instances && typeof data.instances === "object"
        ? Object.keys(data.instances).length
        : 0;
      if (instCount > 0) {
        return { created: false, reason: `flow.yaml already has ${instCount} instances` };
      }
    } catch {
      /* 解析失败也覆盖（视为坏文件） */
    }
  }

  fs.mkdirSync(path.dirname(flowYamlAbs), { recursive: true });

  const skeleton = {
    instances: {
      control_start: {
        definitionId: "control_start",
        label: "Start",
        input: [],
        output: [
          { type: "node", name: "next", value: "" },
        ],
        body: "流程入口",
      },
      control_end: {
        definitionId: "control_end",
        label: "End",
        input: [
          { type: "node", name: "prev", value: "" },
        ],
        output: [],
        body: "流程出口",
      },
    },
    edges: [
      {
        source: "control_start",
        target: "control_end",
        sourceHandle: "output-0",
        targetHandle: "input-0",
      },
    ],
    ui: {
      nodePositions: {
        control_start: { x: 100, y: 300 },
        control_end: { x: 380, y: 300 },
      },
    },
  };

  const text = yaml.dump(skeleton, { lineWidth: -1, noRefs: true });
  fs.writeFileSync(flowYamlAbs, text, "utf-8");
  return { created: true, reason: "wrote start+end skeleton" };
}

/**
 * 写入 composer-node-spec.md 模板（如已存在则跳过）。
 * @param {string} specMdAbs
 * @param {{ flowId?: string, userRequest?: string }} [meta]
 * @returns {{ created: boolean, reason: string }}
 */
export function ensureNodeSpecSkeleton(specMdAbs, meta = {}) {
  if (!specMdAbs) return { created: false, reason: "missing specMdAbs" };

  if (fs.existsSync(specMdAbs)) {
    try {
      const raw = fs.readFileSync(specMdAbs, "utf-8").trim();
      if (raw.length > 0) {
        return { created: false, reason: "spec.md already exists" };
      }
    } catch { /* fallthrough */ }
  }

  fs.mkdirSync(path.dirname(specMdAbs), { recursive: true });

  const flowId = meta.flowId || "(unknown)";
  const userRequest = (meta.userRequest || "").trim() || "(未提供)";
  const ts = new Date().toISOString();

  const tmpl = `# composer-node-spec — ${flowId}

> 生成时间：${ts}
> 用户原始需求：
${userRequest.split("\n").map((l) => "> " + l).join("\n")}

## 整体框架

<!--
  AI 在此填写整体设计意图：
  - 主链节点序列（Start → ... → End）
  - 分支结构（control_if 的真假分支去向）
  - 循环结构（control_anyOne + control_toBool + control_if 的环路）
  - 并行结构（如有）
  - 全局数据（SaveKey / LoadKey 跨节点共享的 key）
-->

## 节点职责

<!--
  按 instanceId 分小节，**每节点必须写齐 4 项**：
    **职责**：一句话说该节点做什么
    **输入**：列出每个 input 槽 → 语义 + 来源（上游 instanceId.slot）
    **输出**：列出每个 output 槽 → 语义 + 去向（下游 instanceId.slot）
    **实现要点**：tool_nodejs 写脚本路径（scripts/xxx.mjs）、agent_subAgent 写 body 关键点、control_* 写判定/汇合规则、provide_* 写固定值
  说明：
  - **输入/输出**就是阶段三连线的依据——把每个槽位的「上游来源」和「下游去向」写清，连边 sourceHandle/targetHandle 就一目了然
  - 控制流槽（prev/next）也要写，标「控制流：来自 <upstream>.next」即可
  - 业务数据槽（text/file）必须写清语义，让阶段二节点补充时知道 body/script 该用什么 \${slot} 占位符
  - tool_nodejs 的可执行代码留到阶段二写，本阶段只需脚本路径与 I/O 语义
-->

### control_start
**职责**：流程入口
**输入**：—
**输出**：next:node → 给 <下一个节点>.prev（控制流，启动主链）

### control_end
**职责**：流程出口
**输入**：prev:node ← 来自 <最后一个节点>.next（控制流）
**输出**：—

<!-- 在此后追加每个新节点的小节 -->

## 计划数据槽（仅 ★ 可扩展节点需追加的业务槽）

<!--
  本 section 是**完整业务数据槽设计**——是 spec.md 的权威记录与阶段二/三对账依据。
  仅对 ★ 可扩展节点（agent_subAgent / tool_nodejs / tool_user_check）列出需要在 input/output 数组**末尾追加**的业务数据槽。
  固定槽位节点（control_*、provide_*、tool_load_key、tool_save_key、tool_get_env、tool_print、tool_user_ask）槽位结构由 schema 锁死，**不在此列出**。

  **重要：阶段一 AI 应该同时把这些槽落到 flow.yaml**（鼓励一次写到位）。
  - 已落到 yaml → 阶段二按 name 去重跳过，不影响幂等
  - 未落到 yaml → 阶段二脚本/agent 据此 section 补齐

  格式（机器可解析）：
    <instanceId>:
      input += [<name>:<text|file>, ...]
      output += [<name>:<text|file>, ...]
  type 仅可用 \`text\`（短串/路径/JSON）或 \`file\`（大块产物路径），**禁止 node**。
  命名建议与上下游语义对齐（如下游 \`fromapp\` 的入参，上游就用同名 output）便于连线。
  示例：
    agent_analyze:
      input += [fromapp:text, page_name:text]
      output += [analysis:file]
    agent_convert:
      input += [analysis:file, toapp:text]
      output += [converted_code:file]
    agent_check_compile:
      input += [converted_code:file]
      output += [compile_result:text]
-->
`;

  fs.writeFileSync(specMdAbs, tmpl, "utf-8");
  return { created: true, reason: "wrote spec.md template" };
}

/**
 * 阶段一前置：同时确保 flow.yaml + spec.md 两份骨架。
 * @param {{ flowYamlAbs: string, composerSpecAbs?: string, flowId?: string, userRequest?: string }} opts
 * @returns {{ flow: ReturnType<typeof ensureFlowSkeleton>, spec: ReturnType<typeof ensureNodeSpecSkeleton> }}
 */
export function ensurePhase1Skeletons(opts) {
  const flow = ensureFlowSkeleton(opts.flowYamlAbs);
  const spec = opts.composerSpecAbs
    ? ensureNodeSpecSkeleton(opts.composerSpecAbs, { flowId: opts.flowId, userRequest: opts.userRequest })
    : { created: false, reason: "missing composerSpecAbs" };
  return { flow, spec };
}

// ─── 解析 spec.md「计划数据槽」+ 合并到 flow.yaml ──────────────────────────

const VALID_BUSINESS_TYPES = new Set(["text", "file"]);

/**
 * 从 spec.md 文本中解析「计划数据槽」section。
 * 期望格式：
 *   ## 计划数据槽（...）
 *   <instanceId>:
 *     input += [<name>:<type>, <name>:<type>]
 *     output += [<name>:<type>]
 * @param {string} specText
 * @returns {Record<string, { input: Array<{name,type}>, output: Array<{name,type}> }>}
 */
export function parsePlannedSlotsFromSpec(specText) {
  if (!specText || typeof specText !== "string") return {};
  const idx = specText.search(/^##\s+计划数据槽/m);
  if (idx < 0) return {};
  const section = specText.slice(idx);
  // 截到下一个 ## 或 EOF
  const nextH = section.slice(2).search(/^##\s/m);
  const body = nextH >= 0 ? section.slice(0, nextH + 2) : section;

  const result = {};
  // 按 instanceId 块分割：行首非缩进的 "<id>:" 起一个块
  const lines = body.split("\n");
  let currentId = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    // 跳过 HTML 注释、标题、空行
    if (/^\s*$/.test(line)) continue;
    if (/^<!--|-->\s*$|^##\s/.test(line)) continue;

    const idMatch = /^\s{0,2}([A-Za-z][A-Za-z0-9_]*)\s*:\s*$/.exec(line);
    if (idMatch) {
      currentId = idMatch[1];
      if (!result[currentId]) result[currentId] = { input: [], output: [] };
      continue;
    }
    // input += [...] / output += [...]
    const slotMatch = /^\s*(input|output)\s*\+?=\s*\[([^\]]*)\]\s*$/.exec(line);
    if (slotMatch && currentId) {
      const kind = slotMatch[1];
      const items = slotMatch[2].split(",").map((s) => s.trim()).filter(Boolean);
      for (const item of items) {
        const m = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*([a-z]+)$/.exec(item);
        if (!m) continue;
        const name = m[1];
        const type = m[2];
        if (!VALID_BUSINESS_TYPES.has(type)) continue;
        result[currentId][kind].push({ name, type });
      }
    }
  }
  return result;
}

/**
 * 把 spec.md 解析出的业务槽合并到 flow.yaml（幂等：同 name 跳过）。
 * 仅对 ★ 可扩展节点（agent_subAgent / tool_nodejs / tool_user_check）操作；
 * 其它 definitionId 上的 planned 数据**忽略**（属于 spec.md 误写，不要破坏固定槽位）。
 *
 * @param {string} flowYamlAbs
 * @param {string} specMdAbs
 * @returns {{ ok: boolean, applied: Array<{instanceId, addedInputs: string[], addedOutputs: string[]}>, skipped: Array<{instanceId, reason: string}>, error?: string }}
 */
export function applyPlannedSlotsFromSpec(flowYamlAbs, specMdAbs) {
  if (!flowYamlAbs || !fs.existsSync(flowYamlAbs)) return { ok: false, applied: [], skipped: [], error: "flow.yaml not found" };
  if (!specMdAbs || !fs.existsSync(specMdAbs)) return { ok: false, applied: [], skipped: [], error: "spec.md not found" };

  const EXTENSIBLE = new Set(["agent_subAgent", "tool_nodejs", "tool_user_check"]);
  const applied = [];
  const skipped = [];

  let flow;
  try {
    flow = yaml.load(fs.readFileSync(flowYamlAbs, "utf-8"));
  } catch (e) {
    return { ok: false, applied: [], skipped: [], error: `failed to parse flow.yaml: ${e.message}` };
  }
  if (!flow || typeof flow !== "object" || !flow.instances) {
    return { ok: false, applied: [], skipped: [], error: "flow.yaml has no instances" };
  }

  let planned;
  try {
    const specText = fs.readFileSync(specMdAbs, "utf-8");
    planned = parsePlannedSlotsFromSpec(specText);
  } catch (e) {
    return { ok: false, applied: [], skipped: [], error: `failed to parse spec.md: ${e.message}` };
  }

  let mutated = false;
  for (const [instanceId, plan] of Object.entries(planned)) {
    const inst = flow.instances[instanceId];
    if (!inst || typeof inst !== "object") {
      skipped.push({ instanceId, reason: "instance not in flow.yaml" });
      continue;
    }
    if (!EXTENSIBLE.has(inst.definitionId)) {
      skipped.push({ instanceId, reason: `non-extensible definitionId: ${inst.definitionId}` });
      continue;
    }
    if (!Array.isArray(inst.input)) inst.input = [];
    if (!Array.isArray(inst.output)) inst.output = [];

    const existingInputNames = new Set(inst.input.map((s) => s && s.name).filter(Boolean));
    const existingOutputNames = new Set(inst.output.map((s) => s && s.name).filter(Boolean));
    const addedInputs = [];
    const addedOutputs = [];

    for (const { name, type } of plan.input) {
      if (existingInputNames.has(name)) continue;
      inst.input.push({ type, name, value: "" });
      existingInputNames.add(name);
      addedInputs.push(`${name}:${type}`);
      mutated = true;
    }
    for (const { name, type } of plan.output) {
      if (existingOutputNames.has(name)) continue;
      inst.output.push({ type, name, value: "" });
      existingOutputNames.add(name);
      addedOutputs.push(`${name}:${type}`);
      mutated = true;
    }

    if (addedInputs.length > 0 || addedOutputs.length > 0) {
      applied.push({ instanceId, addedInputs, addedOutputs });
    }
  }

  if (mutated) {
    fs.writeFileSync(flowYamlAbs, yaml.dump(flow, { lineWidth: -1, noRefs: true }), "utf-8");
  }
  return { ok: true, applied, skipped };
}
