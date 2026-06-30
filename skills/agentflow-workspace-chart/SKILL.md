---
name: agentflow-workspace-chart
description: >-
  AgentFlow Workspace 图表展示技能。用于给 display_chart 节点或连接到 chart
  展示节点的输出引脚生成 ChartSpec JSON；约束模型只输出安全、可解析的 ECharts
  JSON 对象，不混入 Markdown、HTML 或过程说明。
---

# AgentFlow Workspace Chart

在 Workspace 中需要把数据展示为图表时使用本技能。优先使用 `display_chart`，不要用 HTML 自己加载图表库，除非用户明确要求完整自定义页面。

## ChartSpec 格式

图表节点只接受一个 JSON 对象：

```json
{
  "type": "chart",
  "version": "1.0",
  "renderer": "echarts",
  "title": "最近 3 天崩溃率",
  "option": {
    "tooltip": { "trigger": "axis" },
    "legend": {},
    "xAxis": { "type": "category", "data": ["2026-06-28", "2026-06-29", "2026-06-30"] },
    "yAxis": { "type": "value", "name": "崩溃率(%)" },
    "series": [
      { "name": "崩溃率", "type": "line", "smooth": true, "data": [0.527, 0.529, 0.433] }
    ]
  },
  "fallback": {
    "type": "table",
    "columns": ["日期", "崩溃率"],
    "rows": [["2026-06-28", "0.527%"], ["2026-06-29", "0.529%"], ["2026-06-30", "0.433%"]]
  }
}
```

必填字段：

- `type`: 必须是 `"chart"`。
- `version`: 必须是 `"1.0"`。
- `renderer`: 必须是 `"echarts"`。
- `option`: ECharts option JSON 对象。
- `option.series`: 一个 series 对象或 series 数组。

允许的 `series.type`：

`line`, `bar`, `pie`, `scatter`, `radar`, `heatmap`, `tree`, `treemap`, `sunburst`, `sankey`, `graph`, `gauge`, `funnel`。

## 输出到具名引脚

如果上游 agent 节点的某个输出引脚连接到了图表节点，比如用户要求“图表展示写入 `${graph}`”，最终回复必须是 Workspace 输出协议：

```json
{
  "result": "给 Markdown/默认展示节点看的说明正文",
  "outParams": {
    "graph": {
      "type": "chart",
      "version": "1.0",
      "renderer": "echarts",
      "option": {
        "xAxis": { "type": "category", "data": [] },
        "yAxis": { "type": "value" },
        "series": [{ "type": "line", "data": [] }]
      }
    }
  }
}
```

不要把 ChartSpec 写进 `result`，除非图表节点连接的是 `result` 输出口。

## 安全规则

- 只输出 JSON 对象，不要包 Markdown 代码围栏。
- 不要输出 HTML、`script`、`iframe`、事件处理器或 JS 函数。
- 不要使用 ECharts 回调函数，例如 `formatter: function () {}`；只能用字符串模板或普通 JSON 值。
- 不要引用外部脚本或网络资源。
- 数据量大时先聚合或采样。
- 小结果建议同时提供 `fallback` 表格，便于失败时排查。

## 图表选择

- 时间序列、趋势：`line`。
- 分类对比：`bar`。
- 占比：少量分类用 `pie`，分类多时用 `bar`。
- 相关性或分布：`scatter`。
- 矩阵：`heatmap`。
- 层级：`tree`、`treemap`、`sunburst`。
- 流向：`sankey`。
- 网络关系：`graph`。
- KPI 目标：`gauge`。
- 转化漏斗：`funnel`。

## 视觉建议

- 默认不要设置深色文字、复杂背景或自定义主题色；Workspace 会应用暗色画布默认样式。
- 有坐标轴时建议 `grid.containLabel: true`。
- `title` 保持短，详细说明放在 Markdown 结果里。
