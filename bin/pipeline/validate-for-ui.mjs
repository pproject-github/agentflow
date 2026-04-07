#!/usr/bin/env node
/**
 * 产出 PC 用校验结果：edgeTypeMismatch、nodeRoleMissing、nodeModelMissing。
 * 用法：agentflow apply -ai validate-for-ui <workspaceRoot> <flowName> <flowDir> [uuid]
 * 或由 agentflow validate <FlowName> [uuid] 调用；传 uuid 时写入 runDir/intermediate/validation.json。
 * 边 id 约定：source__sourceHandle__target__targetHandle。
 */

import fs from "fs";
import path from "path";
import yaml from "js-yaml";

import { getModelListsAbs, getRunDir, getUserAgentsJsonAbs } from "../lib/paths.mjs";

/** 与前端 flowFormat.VALID_ROLES + 内置 id 一致：flow 中 role 可能为展示名或 id */
const VALID_ROLE_KEYS = ["requirement", "planning", "code", "test", "normal"];
const ROLE_ZH_TO_KEY = {
  需求拆解: "requirement",
  技术规划: "planning",
  代码执行: "code",
  测试回归: "test",
  普通: "normal",
};
const VALID_ROLES = new Set([
  ...VALID_ROLE_KEYS,
  ...Object.keys(ROLE_ZH_TO_KEY),
  "前端/UI",
  "agentflow-node-executor-requirement",
  "agentflow-node-executor-planning",
  "agentflow-node-executor-code",
  "agentflow-node-executor-test",
  "agentflow-node-executor",
  "agentflow-node-executor-ui",
]);

function getSlotsFromInstance(inst) {
  const result = { inputNames: [], outputNames: [], inputTypes: [], outputTypes: [] };
  if (!inst || typeof inst !== "object") return result;
  const inp = Array.isArray(inst.input) ? inst.input : [];
  const out = Array.isArray(inst.output) ? inst.output : [];
  for (const slot of inp) {
    const name = slot && (slot.name != null) ? String(slot.name).trim() : "";
    const type = slot && (slot.type != null) ? String(slot.type).trim() : "";
    if (name) {
      result.inputNames.push(name);
      result.inputTypes.push(type);
    }
  }
  for (const slot of out) {
    const name = slot && (slot.name != null) ? String(slot.name).trim() : "";
    const type = slot && (slot.type != null) ? String(slot.type).trim() : "";
    if (name) {
      result.outputNames.push(name);
      result.outputTypes.push(type);
    }
  }
  return result;
}

function loadFlowYaml(flowDir) {
  const filePath = path.join(flowDir, "flow.yaml");
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = yaml.load(raw);
    if (!data || typeof data !== "object") return null;
    const instances = data.instances && typeof data.instances === "object" ? data.instances : {};
    const edgesRaw = Array.isArray(data.edges) ? data.edges : [];
    const nodeIds = new Set(Object.keys(instances));
    for (const e of edgesRaw) {
      if (e?.source) nodeIds.add(e.source);
      if (e?.target) nodeIds.add(e.target);
    }
    const nodes = Array.from(nodeIds).map((id) => {
      const inst = instances[id] || {};
      return { id, definitionId: inst.definitionId != null ? String(inst.definitionId) : id };
    });
    const edges = edgesRaw
      .filter((e) => e?.source && e?.target)
      .map((e) => ({
        source: String(e.source),
        target: String(e.target),
        sourceHandle: e.sourceHandle ?? "output-0",
        targetHandle: e.targetHandle ?? "input-0",
      }));
    return { nodes, edges, instances };
  } catch {
    return null;
  }
}

function loadModelLists(_workspaceRoot) {
  const p = getModelListsAbs();
  if (!fs.existsSync(p)) return { cursor: [], opencode: [] };
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return {
      cursor: Array.isArray(data.cursor) ? data.cursor : [],
      opencode: Array.isArray(data.opencode) ? data.opencode : [],
    };
  } catch {
    return { cursor: [], opencode: [] };
  }
}

/** ~/agentflow/agents.json 仅存用户角色，无 source 字段，取所有条目的 id */
function loadCustomRoleIds(_workspaceRoot) {
  const agentsPath = getUserAgentsJsonAbs();
  if (!fs.existsSync(agentsPath)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(agentsPath, "utf-8"));
    const list = Array.isArray(data) ? data : (data.agents || []);
    return new Set(list.filter((a) => a && typeof a.id === "string" && a.id.trim()).map((a) => a.id.trim()));
  } catch {
    return new Set();
  }
}

function toEdgeId(e) {
  return `${e.source}__${e.sourceHandle || "output-0"}__${e.target}__${e.targetHandle || "input-0"}`;
}

function computeValidation(flowDir, workspaceRoot) {
  const loaded = loadFlowYaml(flowDir);
  const edgeTypeMismatch = [];
  const nodeRoleMissing = [];
  const nodeModelMissing = [];

  if (!loaded || loaded.nodes.length === 0) {
    return { validation: { edgeTypeMismatch, nodeRoleMissing, nodeModelMissing }, ok: false };
  }

  const { nodes, edges, instances } = loaded;
  const nodeIds = new Set(nodes.map((n) => n.id));
  const nodeIdToSlots = {};
  for (const n of nodes) {
    nodeIdToSlots[n.id] = getSlotsFromInstance(instances[n.id]);
  }

  for (const e of edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    const outMatch = (e.sourceHandle || "output-0").match(/^output-(\d+)$/);
    const inMatch = (e.targetHandle || "input-0").match(/^input-(\d+)$/);
    if (!outMatch || !inMatch) continue;
    const outIdx = parseInt(outMatch[1], 10);
    const inIdx = parseInt(inMatch[1], 10);
    const srcSlots = nodeIdToSlots[e.source];
    const tgtSlots = nodeIdToSlots[e.target];
    const srcType = (srcSlots?.outputTypes?.[outIdx] ?? "").trim();
    const tgtType = (tgtSlots?.inputTypes?.[inIdx] ?? "").trim();
    if (srcType && tgtType && srcType !== tgtType) {
      edgeTypeMismatch.push(toEdgeId(e));
    }
  }

  const validRoles = new Set(VALID_ROLES);
  if (workspaceRoot) {
    for (const id of loadCustomRoleIds(workspaceRoot)) validRoles.add(id);
  }
  for (const n of nodes) {
    const role = (instances[n.id] && instances[n.id].role != null) ? String(instances[n.id].role).trim() : "";
    if (role && !validRoles.has(role)) nodeRoleMissing.push(n.id);
  }

  const root = workspaceRoot ? path.resolve(workspaceRoot) : flowDir;
  const { cursor: cursorList, opencode: opencodeList } = loadModelLists(root);
  const opencodeSet = new Set((opencodeList || []).map((s) => String(s).trim()));
  const cursorSet = new Set(
    (cursorList || []).map((s) => {
      const t = String(s).trim();
      const first = t.split(/\s+-/)[0].trim();
      return first || t;
    })
  );
  for (const n of nodes) {
    const model = (instances[n.id] && instances[n.id].model != null) ? String(instances[n.id].model).trim() : "";
    if (!model) continue;
    let valid = false;
    if (model.startsWith("opencode:")) {
      valid = opencodeSet.has(model.slice(9).trim());
    } else {
      const cursorId = model.startsWith("cursor:") ? model.slice(7).trim() : model;
      valid = cursorSet.has(cursorId) || (cursorList || []).some((c) => String(c).trim() === model || String(c).trim().startsWith(cursorId + " "));
    }
    if (!valid) nodeModelMissing.push(n.id);
  }

  const ok = edgeTypeMismatch.length === 0 && nodeRoleMissing.length === 0 && nodeModelMissing.length === 0;
  return { validation: { edgeTypeMismatch, nodeRoleMissing, nodeModelMissing }, ok };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 3) {
    console.error(JSON.stringify({ ok: false, error: "Usage: validate-for-ui.mjs <workspaceRoot> <flowName> <flowDir> [uuid]" }));
    process.exit(1);
  }
  const workspaceRoot = path.resolve(argv[0]);
  const flowName = argv[1];
  const flowDir = path.resolve(argv[2]);
  const uuid = argv.length >= 4 && /^\d{14}$/.test(String(argv[3]).trim()) ? String(argv[3]).trim() : null;

  if (!fs.existsSync(path.join(flowDir, "flow.yaml"))) {
    console.error(JSON.stringify({ ok: false, error: "flow.yaml not found in " + flowDir }));
    process.exit(1);
  }

  const { validation, ok } = computeValidation(flowDir, workspaceRoot);

  if (uuid && flowName) {
    const runDir = getRunDir(workspaceRoot, flowName, uuid);
    const intermediateDir = path.join(runDir, "intermediate");
    try {
      fs.mkdirSync(intermediateDir, { recursive: true });
      fs.writeFileSync(path.join(intermediateDir, "validation.json"), JSON.stringify({ validation }, null, 2), "utf-8");
    } catch (err) {
      console.error(JSON.stringify({ ok: false, error: err.message }));
      process.exit(1);
    }
  }

  console.log(JSON.stringify({ ok, validation }));
  process.exit(ok ? 0 : 1);
}

main();
