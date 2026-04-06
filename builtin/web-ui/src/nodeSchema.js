/** 按类型返回连接点颜色（与桌面 AgentFlow 一致） */
export function getHandleColor(type) {
  switch (type) {
    case "文本":
      return "#2196f3";
    case "文件":
      return "#4caf50";
    case "节点":
      return "#ff9800";
    case "bool":
      return "#9c27b0";
    default:
      return "#9e9e9e";
  }
}
