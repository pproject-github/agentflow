---
name: agentflow-workspace-html
description: >-
  AgentFlow Workspace HTML 展示技能。用于给 display_html 节点或连接到 html
  展示节点的输出引脚生成可直接 iframe 渲染的 HTML；适合交互原型、移动端页面、
  小型可视化和富 UI 预览。
---

# AgentFlow Workspace HTML

在 Workspace 中需要展示可交互 UI、移动端原型、富文本布局或自包含页面时使用本技能。若只是图表，优先使用 `display_chart`；若只是表格，优先使用 `display_table`。

## 内容格式

HTML 展示节点接收完整 HTML 文档或 HTML fragment：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; }
    </style>
  </head>
  <body>
    <main>...</main>
    <script>
      // 可写少量自包含交互脚本
    </script>
  </body>
</html>
```

不要包 Markdown 代码围栏，不要在 HTML 外追加解释文字。

## 输出到具名引脚

如果上游 agent 节点的某个输出引脚连接到了 HTML 节点，比如用户要求“HTML 写入 `${html}`”，最终回复必须是 Workspace 输出协议：

```json
{
  "result": "给 Markdown/默认展示节点看的说明正文",
  "outParams": {
    "html": "<!doctype html><html><body>...</body></html>"
  }
}
```

不要把 HTML 写进 `result`，除非 HTML 节点连接的是 `result` 输出口。

## 安全与兼容

- HTML 在 sandbox iframe 中运行，允许脚本、表单和弹窗，但不要依赖父页面权限。
- 不要引用外部 JS/CSS 资源；优先写自包含 CSS/JS。
- 不要使用网络接口发送敏感数据。
- 移动端原型建议固定一个清晰的设计宽度，例如 `max-width: 430px`，并兼容容器缩放。
- 文本、按钮、列表和卡片必须避免溢出；不要用纯装饰性背景代替实际内容。

## 节点写入

新增或更新 `workspace.graph.json` 中的 `display_html` instance 时，`body`、`input.content.value`、`output.content.value` 使用同一份 HTML。

建议默认尺寸：宽 430-760，高 640-860，按原型复杂度调整。
