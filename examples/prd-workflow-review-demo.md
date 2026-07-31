---
tapd_id: 1018321
platform: android
epic: 评论体验
issue: preserve-member-comment-bubble
gitlab_issue:
ai_iteration_version: version2
ai_iteration_history:
  - version1: 初版方案草稿
  - version2: 补全会员评论气泡从首次绑定到重新 attach 后消失的完整代码链路
---

# 修复会员评论气泡重新进入视口后消失

> 目标：只修复气泡 View 的资源恢复生命周期，不改变会员身份、评论数据、点击引导和视觉规则。

## 背景

会员评论气泡首次出现时能够正常下载和渲染；列表滚动导致 View detach 后，位图会被回收。相同 ViewHolder 重新 attach 时没有再次 bind，因此气泡 URL 虽然仍然存在，但资源不会恢复。

## 代码理解

实际链路如下：

1. 首次绑定评论时，`FloorCommentViewHolder#bindCommentBubble()` 从当前 `VideoCommentItem` 解析气泡 URL，
   并调用 `CommentBubbleLayout#setBubbleUrl(url)` 触发资源下载和渲染。
2. 点击会员评论气泡后，首次引导场景会打开气泡面板。
   评论列表中的 View 可能随后经历 detach。
3. `CommentBubbleLayout#onDetachedFromWindow()` 会停止当前下载监听，
   并调用 `clearLoadedBitmap()` 回收已经加载的位图。
4. `CommentBubbleLayout` 当前没有实现 `onAttachedToWindow()`，
   因此 View 重新 attach 时不会依据已经保留的 URL 恢复下载。
5. RecyclerView 中同一个 ViewHolder 重新 attach 不等于重新 bind。
   如果没有再次执行 `bindCommentBubble()`，就不会重新调用 `setBubbleUrl(url)`。
6. 此时 URL 仍保留在 `CommentBubbleLayout` 中，但 `hasLoadedBitmap=false`；
   成功加载后的 `fallbackDrawable` 已被清空，所以 `onDraw()` 没有可绘制内容。

简化链路：

```text
首次 bind → setBubbleUrl → 加载成功
detach    → 停止下载监听 + 回收位图
attach    → 没有恢复处理，也没有重新 bind
结果      → URL 还在，但位图不存在，且没有重新拉取
```

因此修复点应放在 `CommentBubbleLayout` 自身的 attach 生命周期：保留 detach 时释放位图的内存策略，在重新 attach 时根据当前 URL 恢复资源。

## 影响范围

| 模块 | 当前行为 | 修改后 |
| --- | --- | --- |
| 评论列表 | 气泡离开视口后可能消失 | 重新进入视口后恢复 |
| 会员身份 | 不变 | 不变 |
| 点击引导 | 不变 | 不变 |
| 图片缓存 | detach 时释放位图 | detach 释放，attach 按 URL 恢复 |

## TODO Actions

- [ ] A1（补齐 attach 恢复逻辑）
  - 要解决的问题：View 重新 attach 时没有恢复已经释放的气泡资源。
  - 准备怎么解决：
    #change modify
    #target function
    #file iHeima/src/main/java/sg/bigo/live/widget/CommentBubbleLayout.kt
    #symbol CommentBubbleLayout#onAttachedToWindow
    #base story/1018321@demo
    #insert-near CommentBubbleLayout#onDetachedFromWindow
    #reference line112-121
    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        bubbleDisposable?.dispose()
        bubbleDisposable = null
        clearLoadedBitmap()
    }
    #referenceend
    #annotation line114-117 preserve
    detach 时停止监听并释放位图的内存策略保持不变。
    #annotationend
    #proposal code
    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (!bubbleUrl.isNullOrBlank() && !hasLoadedBitmap) {
            loadBubbleResource(bubbleUrl)
        }
    }
    #proposalend
    #changeend

- [ ] A2（覆盖 RecyclerView 生命周期回归）
  - 验证首次 bind、detach、重新 attach 的完整路径。
  - 验证 URL 为空时不会发起请求。
  - 验证已有位图时不会重复下载。

## 验收标准

- 气泡首次加载成功。
- 滚动离开视口后位图仍按原策略释放。
- 重新进入视口后气泡自动恢复。
- 不新增会员身份、评论绑定和点击引导逻辑的修改。
