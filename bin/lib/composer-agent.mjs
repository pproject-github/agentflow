/**
 * Composer 执行器：支持单步执行（兼容旧逻辑）和多步编排执行。
 *
 * 多步模式流程：
 *   用户 prompt → planner 分解 → [script 直执 | agent 子调用(按复杂度选模型)] → sync UI
 */
import fs from "fs";
import path from "path";
import { getAgentflowDataRoot } from "./paths.mjs";
import { resolveCliAndModel } from "./model-config.mjs";
import { runCursorAgentWithPrompt, runOpenCodeAgentWithPrompt } from "./agent-runners.mjs";
import { planComposerTasks, hasPlannerApiAvailable, shouldUsePhased, classifyComplexity, classifyTaskComplexity, PHASED_DEFINITIONS } from "./composer-planner.mjs";
import { executeScriptOp, isSupportedScriptOp } from "./composer-script-ops.mjs";
import { routeModel } from "./composer-model-router.mjs";
import { validateComposerFlowYaml, formatValidationErrorsBlock } from "./composer-flow-validate.mjs";
import { parseInstanceRoleModelMap } from "./composer-flow-instances.mjs";
import { buildNodeSchemaPromptSection, buildNodeSchemaCompactSection, getBuiltinNodeSchemas, EXTENSIBLE_DEFINITIONS } from "./composer-node-schema.mjs";
import { ensurePhase1Skeletons, applyPlannedSlotsFromSpec } from "./composer-flow-skeleton.mjs";
import yaml from "js-yaml";
import { t } from "./i18n.mjs";

const MAX_PROMPT_CHARS = 500_000;
const MAX_COMPOSER_VALIDATION_REPAIR = 5;

// ─── 单步模式（向后兼容） ──────────────────────────────────────────────────

/**
 * 旧版单步执行：将整个 prompt 一次性发给 Cursor / OpenCode。
 * @param {object} opts
 * @param {string} opts.uiWorkspaceRoot
 * @param {string} [opts.cliWorkspace]
 * @param {string} opts.prompt
 * @param {string} [opts.modelKey]
 * @param {boolean} [opts.force]
 * @param {(ev: object) => void} [opts.onStreamEvent]
 * @returns {{ child: import('child_process').ChildProcess, finished: Promise<void> }}
 */
export function startComposerAgent(opts) {
  const uiRoot = opts.uiWorkspaceRoot && String(opts.uiWorkspaceRoot).trim();
  if (!uiRoot) throw new Error("Missing uiWorkspaceRoot");

  const prompt = opts.prompt != null ? String(opts.prompt) : "";
  if (!prompt.trim()) throw new Error("Empty prompt");
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`Prompt exceeds ${MAX_PROMPT_CHARS} characters`);

  const cliWs = opts.cliWorkspace ? String(opts.cliWorkspace) : getAgentflowDataRoot();
  const modelKey = opts.modelKey != null ? String(opts.modelKey).trim() : "";
  const { cli, model } = resolveCliAndModel(uiRoot, modelKey || null, null);

  const common = {
    onStreamEvent: opts.onStreamEvent,
    force: Boolean(opts.force),
  };

  if (cli === "opencode") {
    return runOpenCodeAgentWithPrompt(cliWs, prompt, {
      ...common,
      model: model || undefined,
    });
  }

  return runCursorAgentWithPrompt(cliWs, prompt, {
    ...common,
    model: model || undefined,
  });
}

// ─── 为单个 agent 步骤构建 prompt ──────────────────────────────────────────

/**
 * 从 flow.yaml 中提取指定 instance 的 YAML 片段，供子 agent 上下文使用，
 * 避免子 agent 重新 Read 整份 flow.yaml 仅为定位一个节点。
 * @param {string} flowYamlAbs
 * @param {string} instanceId
 * @returns {string} 该 instance 的 YAML 文本（缩进保留），找不到返回空串
 */
function extractInstanceYamlExcerpt(flowYamlAbs, instanceId) {
  if (!flowYamlAbs || !instanceId) return "";
  try {
    const raw = fs.readFileSync(flowYamlAbs, "utf-8");
    const data = yaml.load(raw);
    const inst = data?.instances?.[instanceId];
    if (!inst || typeof inst !== "object") return "";
    return yaml.dump({ [instanceId]: inst }, { lineWidth: 120, noRefs: true });
  } catch {
    return "";
  }
}

function buildAgentStepPrompt(step, flowContext) {
  const parts = [];
  const nodeRole = step.nodeRole != null ? String(step.nodeRole).trim() : "";
  if (nodeRole) {
    parts.push(`## ${t("composer.task_title").replace("## ", "")}\n${nodeRole}`);
    parts.push("");
  }
  if (flowContext) {
    parts.push(t("composer.edit_context"));
    if (flowContext.flowYamlAbs) {
      parts.push(`- 图定义文件：${flowContext.flowYamlAbs}`);
    }
    if (flowContext.composerSpecAbs) {
      parts.push(`- 节点规格书：${flowContext.composerSpecAbs}`);
    }
    if (flowContext.pipelineScriptsDirAbs) {
      parts.push(`- 流水线 scripts 目录（tool_nodejs 可执行脚本放此）：${flowContext.pipelineScriptsDirAbs}`);
    }
    if (flowContext.flowId) {
      parts.push(`- flowId：${flowContext.flowId}`);
      parts.push(`- flowSource：${flowContext.flowSource || "user"}`);
    }
    if (flowContext.skillsHint) {
      parts.push(flowContext.skillsHint);
    }
    if (flowContext.syncCurlHint) {
      parts.push(`- 保存后执行：${flowContext.syncCurlHint}`);
    }
    parts.push("");

    if (flowContext.skillInjectionBlock) {
      parts.push(flowContext.skillInjectionBlock);
      parts.push("");
    }
  }

  const sid = step.instanceId != null ? String(step.instanceId).trim() : "";
  const instMap = flowContext?._instanceMap;
  const targetInst = sid && instMap && instMap[sid];
  if (targetInst && targetInst.definitionId === "tool_nodejs") {
    parts.push(t("composer.tool_nodejs_rules_title"));
    parts.push(t("composer.tool_nodejs_rules_body"));
    parts.push("");
  }

  parts.push(t("composer.task_title"));
  parts.push(step.prompt || step.description || "");
  parts.push("");

  // 节点 schema 与目标 instance 上下文：避免子 agent forage（Glob/Read builtin/nodes、扒 runBuild）
  // 注入策略（按 step 选最小够用版本）：
  //   - full（5KB）：step 改 ★ 扩展节点结构，需要 YAML 正反对照防 type:node 误用
  //   - compact（2KB）：其他所有 step 默认
  //   - 若已知 step.instanceId，附该 instance 当前 YAML 片段，省一次 flow.yaml 读取
  //   - 显式禁止 forage 行为
  try {
    const targetIsExtensible = targetInst && EXTENSIBLE_DEFINITIONS.has(targetInst.definitionId);
    const promptText = String(step.prompt || step.description || "");
    const promptMentionsSlots = /input\s*:|output\s*:|追加|扩展槽|business\s*slot|业务槽/i.test(promptText);
    const useFullSchema = Boolean(targetIsExtensible || promptMentionsSlots);
    const schemaSection = useFullSchema
      ? buildNodeSchemaPromptSection()
      : buildNodeSchemaCompactSection();
    if (schemaSection) {
      parts.push(schemaSection);
      parts.push("");
    }
    if (sid && flowContext?.flowYamlAbs) {
      const excerpt = extractInstanceYamlExcerpt(flowContext.flowYamlAbs, sid);
      if (excerpt) {
        const defId = (targetInst && targetInst.definitionId) || "";
        parts.push(`## 目标 instance（${sid}${defId ? ` · ${defId}` : ""}）当前 YAML`);
        parts.push("```yaml");
        parts.push(excerpt.trimEnd());
        parts.push("```");
        parts.push("");
      }
    }
    parts.push(
      "## 上下文已就绪（禁止 forage）\n" +
      "- 节点定义见上方 schema 表，**禁止** Glob/Read `builtin/nodes/`、`.workspace/agentflow/nodes/`、历史 `runBuild/` 来推断节点结构。\n" +
      "- 目标 instance 的当前 YAML 已附上（若 instanceId 已知）；如需查看整份 flow，仅在确实需要时读取一次。"
    );
    parts.push("");
  } catch {
    /* schema 注入失败不影响主流程 */
  }

  parts.push(t("composer.task_instruction"));
  return parts.join("\n");
}

/**
 * @param {object} step
 * @param {Record<string, { role: string, model?: string, label: string }>} instMap
 * @param {string} [globalModelKey]
 * @returns {{ nodeRole: string, preferredModel: string }}
 */
function resolveAgentStepRoleAndModel(step, instMap, globalModelKey) {
  const sid = step.instanceId != null ? String(step.instanceId).trim() : "";
  const fromFlow = sid && instMap[sid];
  const plannerRole = step.nodeRole != null ? String(step.nodeRole).trim() : "";
  const nodeRole = plannerRole || (fromFlow && fromFlow.role) || "";
  let preferredModel = "";
  const execM = step.executorModel != null ? String(step.executorModel).trim() : "";
  if (execM && execM !== "default") preferredModel = execM;
  else if (fromFlow && fromFlow.model && String(fromFlow.model).trim() && String(fromFlow.model).trim() !== "default") {
    preferredModel = String(fromFlow.model).trim();
  } else if (globalModelKey && String(globalModelKey).trim()) {
    preferredModel = String(globalModelKey).trim();
  }
  return { nodeRole, preferredModel };
}

/**
 * @param {object} step
 * @param {number} index
 * @param {Record<string, { role: string, model?: string, label: string }>} instMap
 */
function summarizePlanStepForUi(step, index, instMap) {
  const sid = step.instanceId != null ? String(step.instanceId).trim() : "";
  const fromFlow = sid && instMap[sid];
  const plannerRole = step.nodeRole != null ? String(step.nodeRole).trim() : "";
  const nodeRole = plannerRole || (fromFlow && fromFlow.role) || "";
  let modelHint = "";
  const execM = step.executorModel != null ? String(step.executorModel).trim() : "";
  if (execM && execM !== "default") modelHint = execM;
  else if (fromFlow && fromFlow.model && String(fromFlow.model).trim() && String(fromFlow.model).trim() !== "default") {
    modelHint = String(fromFlow.model).trim();
  }
  return {
    index,
    type: step.type,
    description: step.description,
    op: step.op,
    instanceId: sid || undefined,
    nodeRole: nodeRole || undefined,
    executorModel: modelHint || undefined,
    complexity: step.complexity,
  };
}

// ─── 编辑后校验与自动修复 ─────────────────────────────────────────────────

/**
 * Composer 改动 flow.yaml 之后：运行与 CLI 一致的 validate-flow；若有 errors 则循环调用 agent 修复直至通过或达到上限。
 *
 * @param {object} opts
 * @param {string} opts.uiWorkspaceRoot
 * @param {string} [opts.cliWorkspace]
 * @param {string} opts.flowYamlAbs
 * @param {object} [opts.flowContext] 与多步相同的上下文（含 syncCurlHint、skillsHint 等）
 * @param {string} [opts.modelKey]
 * @param {boolean} [opts.force]
 * @param {(ev: object) => void} [opts.onStreamEvent]
 * @param {() => boolean} [opts.getAborted]
 * @param {(c: import('child_process').ChildProcess | null) => void} [opts.setCurrentChild] 便于外部 abort 杀子进程
 * @param {number} [opts.maxRepairAttempts] 默认 5，最大 10
 * @returns {Promise<{ ok: boolean, result?: object, repairAttempts?: number, aborted?: boolean, repairError?: string }>}
 */
export async function runComposerPostFlowValidationAndRepair(opts) {
  const emit = typeof opts.onStreamEvent === "function" ? opts.onStreamEvent : () => {};
  const getAborted = typeof opts.getAborted === "function" ? opts.getAborted : () => false;
  const setChild = typeof opts.setCurrentChild === "function" ? opts.setCurrentChild : () => {};

  const uiRoot = String(opts.uiWorkspaceRoot || "").trim();
  const flowYamlAbs = String(opts.flowYamlAbs || "").trim();
  const cliWs = opts.cliWorkspace ? String(opts.cliWorkspace) : getAgentflowDataRoot();
  const maxRepair = Math.max(1, Math.min(10, Number(opts.maxRepairAttempts) || MAX_COMPOSER_VALIDATION_REPAIR));

  if (!uiRoot || !flowYamlAbs) {
    return { ok: true, result: { skipped: true } };
  }

  let last = validateComposerFlowYaml(flowYamlAbs, uiRoot);
  if (last.ok) {
    emit({ type: "status", line: t("composer.validation_passed") });
    emit({ type: "natural", kind: "assistant", text: t("composer.validation_passed_detail") });
    return { ok: true, result: last };
  }

  emit({ type: "status", line: t("composer.validation_failed") });
  emit({
    type: "natural",
    kind: "assistant",
    text: `⚠ flow 校验未通过（${(last.errors && last.errors.length) || 0} 条错误），将调用 agent 修复…\n${formatValidationErrorsBlock(last)}`,
  });

  for (let attempt = 1; attempt <= maxRepair; attempt++) {
    if (getAborted()) {
      setChild(null);
      return { ok: false, result: last, aborted: true };
    }

    const repairStep = {
      type: "agent",
      complexity: "complex",
      description: `自动修复校验错误（第 ${attempt}/${maxRepair} 次）`,
      prompt: [
        t("composer.fix_task_title"),
        "",
        t("composer.fix_errors_intro"),
        "",
        formatValidationErrorsBlock(last),
        "",
        t("composer.fix_constraints_title"),
        t("composer.fix_constraints_body"),
        "- 完成后**保存文件**，并执行上下文中的同步 Web 画布命令（curl）。",
      ].join("\n"),
    };

    const agentPrompt = buildAgentStepPrompt(repairStep, opts.flowContext);
    const modelKey = opts.modelKey != null ? String(opts.modelKey).trim() : "";
    const routed = routeModel("complex", { userPreferredModel: modelKey || null });
    const { cli, model } = resolveCliAndModel(uiRoot, (routed.model || modelKey) || null, null);

    emit({ type: "ai-log", tag: "repair-prompt", text: agentPrompt, meta: { attempt, max: maxRepair, cli, model: model || null, errorCount: (last?.errors || []).length } });
    emit({ type: "status", line: t("composer.validation_repair", { attempt, max: maxRepair }) });
    emit({ type: "natural", kind: "assistant", text: t("composer.validation_repair_start", { attempt, max: maxRepair }) });

    const stepEmit = (ev) => {
      emit({ ...ev, stepIndex: -1, stepTotal: 0, phase: "validation-repair" });
    };

    try {
      if (cli === "opencode") {
        const handle = runOpenCodeAgentWithPrompt(cliWs, agentPrompt, {
          onStreamEvent: stepEmit,
          model: model || undefined,
          force: Boolean(opts.force),
        });
        setChild(handle.child);
        await handle.finished;
      } else {
        const handle = runCursorAgentWithPrompt(cliWs, agentPrompt, {
          onStreamEvent: stepEmit,
          model: model || undefined,
          force: Boolean(opts.force),
        });
        setChild(handle.child);
        await handle.finished;
      }
    } catch (e) {
      setChild(null);
      emit({ type: "natural", kind: "error", text: `校验修复 agent 失败: ${e.message}` });
      return { ok: false, result: last, repairError: e.message, repairAttempts: attempt };
    }
    setChild(null);

    if (getAborted()) {
      return { ok: false, result: last, aborted: true };
    }

    last = validateComposerFlowYaml(flowYamlAbs, uiRoot);
    if (last.ok) {
      emit({ type: "status", line: t("composer.validation_passed") + t("composer.validation_repair_auto_success") });
      emit({ type: "natural", kind: "assistant", text: "✓ 校验修复后 flow.yaml 已通过 validate-flow" });
      return { ok: true, result: last, repairAttempts: attempt };
    }

    emit({
      type: "natural",
      kind: "assistant",
      text: `⚠ 第 ${attempt} 次修复后仍未通过：\n${formatValidationErrorsBlock(last)}`,
    });
  }

  emit({
    type: "natural",
    kind: "error",
    text: `flow 校验在 ${maxRepair} 次自动修复后仍未通过，请根据上方错误列表手动修改 flow.yaml。`,
  });
  return { ok: false, result: last, repairAttempts: maxRepair };
}

// ─── 多步编排执行 ──────────────────────────────────────────────────────────

/**
 * 多步 Composer：规划 → 分步执行 → 流式推送进度。
 * 支持分阶段模式：大任务按「流转规划 → 节点补充 → 流程完善」三阶段逐轮生成，
 * 每阶段完成后 emit phase-complete，由前端决定是否继续下一阶段。
 *
 * @param {object} opts
 * @param {string} opts.uiWorkspaceRoot
 * @param {string} [opts.cliWorkspace]
 * @param {string} opts.userPrompt      用户原始输入
 * @param {string} [opts.fullPrompt]    含上下文的完整 prompt（兼容旧逻辑，若多步不使用此字段）
 * @param {string} [opts.modelKey]      用户选择的模型
 * @param {string} [opts.flowYamlAbs]   flow.yaml 绝对路径
 * @param {string} [opts.flowId]
 * @param {string} [opts.flowSource]
 * @param {string[]} [opts.instanceIds]
 * @param {object} [opts.flowContext]    { skillsHint, syncCurlHint } 等上下文
 * @param {Array<{ role: string, text: string }>} [opts.thread] 对话历史
 * @param {object} [opts.phaseContext]   分阶段上下文 { phaseIndex, phases, userPromptOriginal }
 * @param {string} [opts.phaseRole]     用户为本阶段指定的默认节点角色
 * @param {boolean} [opts.force]
 * @param {(ev: object) => void} [opts.onStreamEvent]
 * @returns {{ finished: Promise<void>, abort: () => void }}
 */
export function startComposerMultiStep(opts) {
  const uiRoot = opts.uiWorkspaceRoot && String(opts.uiWorkspaceRoot).trim();
  if (!uiRoot) throw new Error("Missing uiWorkspaceRoot");

  const emit = typeof opts.onStreamEvent === "function" ? opts.onStreamEvent : () => {};
  let aborted = false;
  let currentChild = null;

  const abort = () => {
    aborted = true;
    if (currentChild && !currentChild.killed) {
      try { currentChild.kill("SIGTERM"); } catch { /* ignore */ }
    }
  };

  const finished = (async () => {
    try {
      // ── 1. 规划 ──────────────────────────────────────────────────────
      emit({ type: "status", line: t("composer.analyzing_task") });

      let flowYaml = "";
      if (opts.flowYamlAbs) {
        try { flowYaml = fs.readFileSync(opts.flowYamlAbs, "utf-8"); } catch { /* ignore */ }
      }
      const instMap = parseInstanceRoleModelMap(flowYaml);

      if (!opts.flowContext) opts.flowContext = {};
      opts.flowContext._instanceMap = instMap;

      const planResult = await planComposerTasks({
        userPrompt: opts.userPrompt,
        flowYaml,
        flowYamlAbs: opts.flowYamlAbs,
        instanceIds: opts.instanceIds,
        thread: opts.thread,
        intents: opts.flowContext?.intents,
        phaseContext: opts.phaseContext,
        phaseRole: opts.phaseRole,
        onEvent: emit,
      });

      if (aborted) return;

      const steps = planResult.steps;
      const isPhased = Boolean(planResult.phased);
      const phases = planResult.phases || PHASED_DEFINITIONS;
      const currentPhase = planResult.currentPhase ?? 0;

      if (isPhased) {
        const phaseDef = phases[currentPhase];
        emit({
          type: "phase-plan",
          phases: phases.map((p, i) => ({
            ...p,
            status: i < currentPhase ? "done" : i === currentPhase ? "running" : "pending",
          })),
          currentPhase,
          phaseTotal: phases.length,
          phaseName: phaseDef?.label || `阶段 ${currentPhase + 1}`,
        });
      }

      const totalSteps = steps.length;
      emit({
        type: "plan",
        steps: steps.map((s, i) => summarizePlanStepForUi(s, i, instMap)),
        total: totalSteps,
      });

      // ── 1.5 多步前置：脚本预生成 flow.yaml 与 spec.md skeleton ──────
      // 让 AI 只做"插入节点 + 填充 section"，省下重复 YAML 与样板模板字符串。
      // 触发条件（任一）：
      //   - 分阶段模式的第 0 阶段（流转规划），始终尝试
      //   - 非分阶段多步：只要 flow.yaml 还空，也尝试（用户 prompt 没命中 phased
      //     正则，但实质是「新建」场景）
      // skeleton 内部幂等：已有 instances 或 spec.md 已存在则自动跳过。
      const shouldTrySkeleton = opts.flowYamlAbs && (
        (isPhased && currentPhase === 0) ||
        (!isPhased)
      );
      if (shouldTrySkeleton) {
        // composerSpecAbs 兜底：flowContext 没传时按 flow.yaml 同目录推
        let specAbs = opts.flowContext?.composerSpecAbs || "";
        if (!specAbs && opts.flowYamlAbs) {
          specAbs = path.join(path.dirname(opts.flowYamlAbs), "composer-node-spec.md");
        }
        try {
          const skel = ensurePhase1Skeletons({
            flowYamlAbs: opts.flowYamlAbs,
            composerSpecAbs: specAbs,
            flowId: opts.flowId,
            userRequest: opts.phaseContext?.userPromptOriginal || opts.userPrompt,
          });
          if (skel.flow.created) {
            emit({ type: "natural", kind: "assistant", text: `✓ 预生成 flow.yaml skeleton (start + end + 主链 edge)` });
          }
          if (skel.spec.created) {
            emit({ type: "natural", kind: "assistant", text: `✓ 预生成 composer-node-spec.md 模板：${specAbs}` });
          }
        } catch (e) {
          emit({ type: "natural", kind: "error", text: `skeleton 预生成失败: ${e.message}` });
        }
      }

      // ── 2. 执行步骤 ────────────────────────────────────────────────
      let stepIndex = 0;
      while (stepIndex < steps.length && !aborted) {
        const step = steps[stepIndex];

        if (step.type === "script" && isSupportedScriptOp(step.op)) {
          const scriptBatch = [step];
          let nextIdx = stepIndex + 1;
          while (nextIdx < steps.length && steps[nextIdx].type === "script" && isSupportedScriptOp(steps[nextIdx].op)) {
            scriptBatch.push(steps[nextIdx]);
            nextIdx++;
          }

          const scriptFirstId = scriptBatch[0]?.params?.instanceId;
          emit({
            type: "step-start",
            index: stepIndex,
            total: totalSteps,
            stepType: "script",
            description: `执行 ${scriptBatch.length} 个脚本操作`,
            count: scriptBatch.length,
            instanceId: scriptFirstId != null ? String(scriptFirstId) : undefined,
          });

          for (let i = 0; i < scriptBatch.length; i++) {
            const s = scriptBatch[i];
            if (aborted) break;
            const globalIdx = stepIndex + i;
            emit({ type: "step-progress", index: globalIdx, total: totalSteps, description: s.description || s.op });

            if (!opts.flowYamlAbs) {
              emit({ type: "natural", kind: "error", text: `脚本操作需要 flow.yaml 路径，但未提供` });
              continue;
            }

            const result = executeScriptOp(opts.flowYamlAbs, s);
            if (result.success) {
              emit({ type: "natural", kind: "assistant", text: `✓ ${result.message}` });
            } else {
              emit({ type: "natural", kind: "error", text: `✗ ${s.op}: ${result.message}` });
            }
            emit({ type: "step-done", index: globalIdx, total: totalSteps, success: result.success });
          }

          stepIndex = nextIdx;
          continue;
        }

        if (step.type === "agent") {
          const complexity = step.complexity || "medium";
          const { nodeRole, preferredModel } = resolveAgentStepRoleAndModel(step, instMap, opts.modelKey);
          const routed = routeModel(complexity, { userPreferredModel: preferredModel || null });
          const sid = step.instanceId != null ? String(step.instanceId).trim() : "";
          const fromFlow = sid && instMap[sid];

          emit({
            type: "step-start",
            index: stepIndex,
            total: totalSteps,
            stepType: "agent",
            description: step.description,
            model: routed.model,
            tier: routed.tier,
            complexity,
            nodeRole: nodeRole || undefined,
            instanceId: sid || undefined,
            instanceLabel: fromFlow?.label,
          });

          const stepForPrompt = nodeRole ? { ...step, nodeRole } : { ...step };
          const agentPrompt = buildAgentStepPrompt(stepForPrompt, opts.flowContext);
          const cliWs = opts.cliWorkspace ? String(opts.cliWorkspace) : getAgentflowDataRoot();
          const modelKey = routed.model || preferredModel || opts.modelKey || "";
          const { cli, model } = resolveCliAndModel(uiRoot, modelKey || null, null);

          emit({ type: "ai-log", tag: "agent-step-prompt", text: agentPrompt, meta: { stepIndex, total: totalSteps, instanceId: sid || null, nodeRole: nodeRole || null, complexity, cli, model: model || null, description: step.description } });

          const stepEmit = (ev) => {
            emit({ ...ev, stepIndex, stepTotal: totalSteps });
          };

          try {
            if (cli === "opencode") {
              const handle = runOpenCodeAgentWithPrompt(cliWs, agentPrompt, {
                onStreamEvent: stepEmit,
                model: model || undefined,
                force: Boolean(opts.force),
              });
              currentChild = handle.child;
              await handle.finished;
            } else {
              const handle = runCursorAgentWithPrompt(cliWs, agentPrompt, {
                onStreamEvent: stepEmit,
                model: model || undefined,
                force: Boolean(opts.force),
              });
              currentChild = handle.child;
              await handle.finished;
            }
            currentChild = null;
            emit({ type: "step-done", index: stepIndex, total: totalSteps, success: true });
          } catch (e) {
            currentChild = null;
            emit({ type: "step-done", index: stepIndex, total: totalSteps, success: false, error: e.message });
            emit({ type: "natural", kind: "error", text: `步骤 ${stepIndex + 1} 失败: ${e.message}` });
          }

          stepIndex++;
          continue;
        }

        emit({ type: "step-done", index: stepIndex, total: totalSteps, success: false, error: `未知步骤类型: ${step.type}` });
        stepIndex++;
      }

      // ── 2.5 阶段一/非分阶段后置：把 spec.md 计划数据槽合并到 flow.yaml ──
      // 幂等：同 name 槽位跳过；非 ★ 节点跳过。AI 已在 yaml 写过的不动。
      const shouldApplyPlannedSlots = !aborted && opts.flowYamlAbs && (
        (isPhased && currentPhase === 0) ||
        (!isPhased)
      );
      if (shouldApplyPlannedSlots) {
        let specAbs = opts.flowContext?.composerSpecAbs || "";
        if (!specAbs && opts.flowYamlAbs) {
          specAbs = path.join(path.dirname(opts.flowYamlAbs), "composer-node-spec.md");
        }
        if (specAbs && fs.existsSync(specAbs)) {
          try {
            const r = applyPlannedSlotsFromSpec(opts.flowYamlAbs, specAbs);
            if (r.ok && r.applied.length > 0) {
              const summary = r.applied.map((a) => {
                const parts = [];
                if (a.addedInputs.length) parts.push(`input += [${a.addedInputs.join(", ")}]`);
                if (a.addedOutputs.length) parts.push(`output += [${a.addedOutputs.join(", ")}]`);
                return `  ${a.instanceId}: ${parts.join(" / ")}`;
              }).join("\n");
              emit({
                type: "natural",
                kind: "assistant",
                text: `✓ 脚本合并 spec.md 计划数据槽到 flow.yaml（已存在的跳过）：\n${summary}`,
              });
            } else if (r.ok && r.applied.length === 0) {
              emit({ type: "status", line: "spec.md 计划数据槽已全部落到 flow.yaml" });
            } else if (!r.ok) {
              emit({ type: "natural", kind: "error", text: `合并计划数据槽失败：${r.error}` });
            }
          } catch (e) {
            emit({ type: "natural", kind: "error", text: `合并计划数据槽异常：${e.message}` });
          }
        }
      }

      // ── 3. 校验（分阶段仅在最后阶段统一校验；非分阶段每次都校验） ──
      const shouldRunValidation = !isPhased || currentPhase >= phases.length - 1;
      if (!aborted && opts.flowYamlAbs && shouldRunValidation) {
        await runComposerPostFlowValidationAndRepair({
          uiWorkspaceRoot: uiRoot,
          cliWorkspace: opts.cliWorkspace ? String(opts.cliWorkspace) : getAgentflowDataRoot(),
          flowYamlAbs: opts.flowYamlAbs,
          flowContext: opts.flowContext,
          modelKey: opts.modelKey,
          force: Boolean(opts.force),
          onStreamEvent: emit,
          getAborted: () => aborted,
          setCurrentChild: (c) => {
            currentChild = c;
          },
        });
      } else if (!aborted && opts.flowYamlAbs && isPhased) {
        emit({ type: "status", line: t("composer.skip_validation_for_phase") });
      }

      // ── 4. 分阶段完成通知 ──────────────────────────────────────────
      if (!aborted && isPhased) {
        const isLastPhase = currentPhase >= phases.length - 1;
        const phaseDef = phases[currentPhase];
        const nextPhaseDef = !isLastPhase ? phases[currentPhase + 1] : null;
        const userPromptOriginal = opts.phaseContext?.userPromptOriginal || opts.userPrompt;

        emit({
          type: "phase-complete",
          phaseIndex: currentPhase,
          phaseTotal: phases.length,
          phaseName: phaseDef?.label || t("composer.current_phase", { index: currentPhase + 1 }),
          nextPhase: nextPhaseDef ? { index: currentPhase + 1, name: nextPhaseDef.name, label: nextPhaseDef.label } : null,
          isLastPhase,
          phases: phases.map((p, i) => ({
            ...p,
            status: i <= currentPhase ? "done" : "pending",
          })),
          userPromptOriginal,
        });

        if (isLastPhase) {
          emit({ type: "status", line: t("composer.all_phases_complete") });
        } else {
          emit({ type: "status", line: t("composer.phase_complete_waiting", { label: phaseDef?.label || t("composer.current_phase", { index: currentPhase + 1 }) }) });
        }
      } else if (!aborted) {
        emit({ type: "status", line: t("composer.all_steps_complete") });
      }
    } catch (e) {
      emit({ type: "natural", kind: "error", text: t("composer.multi_step_failed", { message: e.message }) });
      throw e;
    }
  })();

  return { finished, abort };
}

/**
 * 根据任务复杂度判断是否走多步模式（async：用 Cursor/OpenCode CLI AI 判断，降级正则）。
 * - "multi"：新建流程、重构、复杂多节点操作 → 多步
 * - "single"：改标签、连一条边、小改动 → 单步
 */
export async function shouldUseMultiStep(opts) {
  if (!opts.flowYamlAbs) return false;
  const prompt = (opts.userPrompt || "").trim();
  if (!prompt) return false;
  const cliWs = opts.cliWorkspace || (opts.flowYamlAbs ? path.dirname(opts.flowYamlAbs) : undefined);
  const result = await classifyTaskComplexity(prompt, cliWs);
  return result === "multi";
}
