---
name: agentflow-workspace-image
description: >-
  AgentFlow Workspace 图片展示技能。用于给 display_image 节点或连接到 image
  展示节点的输出引脚生成图片 URL、data URL 或 workspace 内图片路径；适合截图、
  视觉参考、生成图和设计资产预览。
---

# AgentFlow Workspace Image

在 Workspace 中需要展示一张图片、截图、设计参考图、生成图或文件产物时使用本技能。图片节点只接收可作为 `<img src>` 使用的字符串。

## 内容格式

支持：

- HTTP/HTTPS 图片 URL。
- `data:image/png;base64,...` 等 data URL。
- workspace 内可访问的相对图片路径或绝对路径。

不支持：

- Markdown 图片语法，例如 `![alt](url)`。
- HTML `<img>` 标签。
- 多张图片列表；需要多图时创建多个 `display_image` 节点或用 HTML 展示。

## 输出到具名引脚

如果上游 agent 节点的某个输出引脚连接到了图片节点，比如用户要求“图片写入 `${image}`”，最终回复必须是 Workspace 输出协议：

```json
{
  "result": "给 Markdown/默认展示节点看的说明正文",
  "outParams": {
    "image": "outputs/example.png"
  }
}
```

不要把图片地址写进 `result`，除非图片节点连接的是 `result` 输出口。

## 生成与落盘

- 如果任务产出新图片，优先保存到 workspace 下稳定路径，例如 `outputs/image.png`。
- 确保路径对应的文件真实存在，且扩展名与内容类型匹配。
- 需要说明图片含义时，把说明写到 `result` 或 Markdown 节点，不要混进图片 src。

## 节点写入

在 `workspace.flow.js` 里写一个 `display.image` 节点，图片地址放 `src` 引脚：

```js
const shot = display.image("截图", { src: "outputs/image.png" });
```

尺寸由平台维护，不要手写。
