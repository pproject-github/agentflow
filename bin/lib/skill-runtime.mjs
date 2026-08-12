/**
 * Bundled skills 使用的稳定本地 runtime facade。
 *
 * Skill 可以装在任意目录，不能通过 `../../../bin/lib` 猜 AgentFlow 源码位置；它只定位
 * 已安装的 @fieldwangai/agentflow 包，再从这一处入口取本地 DSL、节点包和 marketplace
 * 能力。不要让 skill 继续直接依赖内部模块路径。
 */
export {
  readWorkspaceDesign,
  writeWorkspaceGraphFiles,
} from "./workspace-flow-store.mjs";

export {
  WORKSPACE_STATE_FILENAME,
  mergeWorkspaceState,
  splitWorkspaceGraph,
} from "./workspace-state.mjs";

export {
  marketplaceDependenciesFromSource,
  rewriteFlowLocalPackageImports,
  scanFlowLocalPackages,
} from "./flow-dsl/packages.mjs";

export {
  listMarketplacePackages,
  parseMarketplaceDefinitionId,
  publishNodePackageArchive,
} from "./marketplace.mjs";

export {
  createNodePackageArchive,
  inspectNodePackageArchive,
  inspectNodePackageDirectory,
} from "./node-package-archive.mjs";
