/**
 * 边指向哪个槽位，权威是**槽位名**。
 *
 * `output-2` / `input-0` 这种位置坐标是 React Flow 的渲染细节，一旦节点定义增删槽位就整体错位：
 * 线上真实发生过——某个流程的 display_markdown 存着 `output-0`，而定义里 0 号位是 `content`
 * 不是 `next`，于是一条控制边落在了内容槽上，图仍然连通，跑起来才发现错。
 *
 * 所以磁盘、API、运行时一律用名字；下标只在前端画布边界上转换。读的时候两种都认，
 * 写的时候只写名字。
 */

const INDEX_HANDLE = /^(?:input|output)-(\d+)$/;

/** 这个句柄是不是历史的位置坐标形态。 */
export function isIndexSlotHandle(handle) {
  return INDEX_HANDLE.test(String(handle ?? ""));
}

/**
 * 句柄 -> 槽位名。历史下标按给定的槽位表还原，名字原样返回。
 *
 * 还原必须用**这张图当时的槽位表**，不能用重新对账过的——下标的原意只在原表里存在。
 *
 * @param {string} handle
 * @param {Array<{name?: string}>} slots 该节点该方向的槽位表
 * @returns {string} 槽位名；还原不出来时返回 ""
 */
export function slotNameFromHandle(handle, slots) {
  const list = Array.isArray(slots) ? slots : [];
  const raw = String(handle ?? "").trim();
  // 句柄缺省在历史图里就是"第一个槽"，不是"没有指向"。丢掉这类边等于把图改瘦。
  if (!raw) return String(list[0]?.name ?? "");
  const match = INDEX_HANDLE.exec(raw);
  if (!match) return raw;
  return String(list[Number(match[1])]?.name ?? "");
}

/**
 * 槽位名 -> React Flow 句柄。只给画布用。
 *
 * @param {string} name
 * @param {Array<{name?: string}>} slots
 * @param {"input"|"output"} prefix
 * @returns {string} 找不到该槽位时返回 ""，调用方自行决定怎么处理
 */
export function indexHandleFromSlotName(name, slots, prefix) {
  const target = String(name ?? "").trim();
  if (!target) return "";
  const list = Array.isArray(slots) ? slots : [];
  const index = list.findIndex((slot) => String(slot?.name ?? "") === target);
  return index < 0 ? "" : `${prefix}-${index}`;
}

/**
 * 把一条边的两个句柄都归一成槽位名。
 *
 * @param {{source?: string, target?: string, sourceHandle?: string, targetHandle?: string}} edge
 * @param {Record<string, {input?: Array, output?: Array}>} instances
 * @returns {{source: string, target: string, sourceHandle: string, targetHandle: string}}
 */
export function edgeWithSlotNames(edge, instances) {
  const source = String(edge?.source ?? "");
  const target = String(edge?.target ?? "");
  const from = instances?.[source];
  const to = instances?.[target];
  return {
    ...edge,
    source,
    target,
    sourceHandle: slotNameFromHandle(edge?.sourceHandle, from?.output),
    targetHandle: slotNameFromHandle(edge?.targetHandle, to?.input),
  };
}

/** 整张图的边归一成槽位名。丢掉两端节点已不存在、或句柄还原不出来的边。用于比对。 */
export function edgesWithSlotNames(graph) {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const list = Array.isArray(graph?.edges) ? graph.edges : [];
  return list
    .filter((edge) => instances[String(edge?.source ?? "")] && instances[String(edge?.target ?? "")])
    .map((edge) => edgeWithSlotNames(edge, instances))
    .filter((edge) => edge.sourceHandle && edge.targetHandle);
}

/**
 * 落盘用的归一：尽力换成槽位名，换不出来就原样留着。
 *
 * 归一绝不能是有损的——节点包还没装好、槽位表暂时读不到的时刻是真实存在的，
 * 那一刻把边丢掉，等于用户下次打开就少了几条线。
 */
export function edgesWithSlotNamesPreserving(graph) {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const list = Array.isArray(graph?.edges) ? graph.edges : [];
  return list.map((edge) => {
    const named = edgeWithSlotNames(edge, instances);
    return {
      ...edge,
      sourceHandle: named.sourceHandle || edge?.sourceHandle || null,
      targetHandle: named.targetHandle || edge?.targetHandle || null,
    };
  });
}

/**
 * 一条边 -> React Flow 的句柄形态。
 *
 * 画布的句柄是引脚在**渲染用的那张槽位表**里的下标（`FlowNodePortRail` 按数组下标发
 * `output-<i>`，隐藏的槽也占位置）。磁盘和 API 上是槽位名。这个换算是加载路径上唯一
 * 要做的事，而画布有不止一个加载入口——漏掉任何一个，那个入口下整张图的连线全不见：
 * 句柄名对不上任何一个渲染出来的 handle，React Flow 留着边但一条都画不出来。
 *
 * 还原下标要用**这条边写下时那张表**，换算成下标要用**现在渲染的那张表**，两者可能
 * 不是同一张（合并定义表会补槽、会改顺序），所以分成两步、各传各的。
 *
 * @param {Array} edges
 * @param {(nodeId: string) => ({input?: Array, output?: Array}|undefined)} storedSlotsOf 边写下时的槽位表
 * @param {(nodeId: string) => ({input?: Array, output?: Array}|undefined)} [renderSlotsOf] 渲染用的槽位表，默认同上
 * @returns {Array} 句柄换成 `input-N` / `output-N` 的边；换不出来的留 undefined 交给调用方
 */
export function edgesWithCanvasHandles(edges, storedSlotsOf, renderSlotsOf = storedSlotsOf) {
  return (Array.isArray(edges) ? edges : []).map((edge) => {
    const source = String(edge?.source ?? "");
    const target = String(edge?.target ?? "");
    const fromName = slotNameFromHandle(edge?.sourceHandle, storedSlotsOf(source)?.output);
    const toName = slotNameFromHandle(edge?.targetHandle, storedSlotsOf(target)?.input);
    return {
      ...edge,
      sourceHandle: indexHandleFromSlotName(fromName, renderSlotsOf(source)?.output, "output") || undefined,
      targetHandle: indexHandleFromSlotName(toName, renderSlotsOf(target)?.input, "input") || undefined,
    };
  });
}
