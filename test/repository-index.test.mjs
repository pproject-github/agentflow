import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearRepositoryIndexMemoryForTest,
  getRepositoryIndex,
  indexedProjectFlowPreview,
  listIndexedProjectFlows,
  rebuildRepositoryIndex,
  repositoryIndexPath,
  updateIndexedProjectFlowVisibility,
} from "../bin/lib/repository-index.mjs";

function runnableGraph() {
  return {
    version: 1,
    instances: {
      run: { instanceId: "run", definitionId: "workspace_run", label: "Run", input: [], output: [{ name: "next", type: "node" }] },
      work: { instanceId: "work", definitionId: "provide_text", label: "Work", input: [{ name: "prev", type: "node" }], output: [] },
    },
    edges: [{ source: "run", sourceHandle: "output-0", target: "work", targetHandle: "input-0" }],
  };
}

test("流程仓库索引持久化列表元数据，Graph 只在预览时读取，并可从损坏索引恢复", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-repository-index-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(root, "data");
  try {
    const flowRoot = path.join(process.env.AGENTFLOW_HOME, "users", "owner-1", "pipelines", "indexed-flow");
    fs.mkdirSync(flowRoot, { recursive: true });
    fs.writeFileSync(path.join(flowRoot, "workspace.graph.json"), `${JSON.stringify(runnableGraph(), null, 2)}\n`, "utf-8");

    const built = rebuildRepositoryIndex(root);
    assert.equal(built.flows.length, 1);
    assert.equal(fs.existsSync(repositoryIndexPath(root)), true);
    const resource = built.flows[0];
    assert.equal(resource.displayName, "indexed-flow");
    assert.equal(Object.prototype.hasOwnProperty.call(resource, "graph"), false);

    fs.writeFileSync(path.join(flowRoot, "workspace.graph.json"), "{ invalid graph", "utf-8");
    clearRepositoryIndexMemoryForTest(root);
    const fromDisk = listIndexedProjectFlows(root, { userId: "consumer-1" }, "all");
    assert.equal(fromDisk.length, 1, "列表必须直接读取持久化索引，不能重新解析 Graph");
    assert.equal(indexedProjectFlowPreview(root, fromDisk[0]), null, "预览才读取并校验具体 Graph");

    updateIndexedProjectFlowVisibility(root, resource.id, "private", new Date().toISOString());
    assert.equal(listIndexedProjectFlows(root, { userId: "consumer-1" }, "all").length, 0);
    assert.equal(listIndexedProjectFlows(root, { userId: "owner-1" }, "owned").length, 1);

    fs.writeFileSync(path.join(flowRoot, "workspace.graph.json"), `${JSON.stringify(runnableGraph(), null, 2)}\n`, "utf-8");
    fs.writeFileSync(repositoryIndexPath(root), "not-json", "utf-8");
    clearRepositoryIndexMemoryForTest(root);
    const recovered = getRepositoryIndex(root);
    assert.equal(recovered.flows.length, 1);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(repositoryIndexPath(root), "utf-8")));
  } finally {
    clearRepositoryIndexMemoryForTest(root);
    if (previousHome == null) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
  }
});
