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
