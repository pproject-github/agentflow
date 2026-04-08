# Quickstart: 用 AgentFlow 自动化 PR 流程

> **真实故事**：我是如何驯服混乱的 PR 审查流程，实现 100% 可靠执行的。

## 痛点："AI 有时会忘记步骤"

作为一个重视代码质量的开发者，我想自动化团队的 PR 工作流：

```
1. 提交代码 → 2. 代码审查 → 3. 生成 PR → 4. Slack 通知组员
```

我尝试用 **Skills** 或自定义 **Commands** 来定义这个流程。**大部分时间工作正常**，但偶尔会出现：

- ❌ AI 跳过了代码审查步骤
- ❌ PR 描述生成了但没运行测试
- ❌ 团队通知在 PR 创建之前就发出去了
- ❌ 出错时必须从头开始

**根本原因**：AI 对话本质上是不稳定的。即使指令再清晰，当上下文变长或出现错误时，模型可能会"忘记"步骤。没有运行时强制保证——只能指望模型记住。

## AgentFlow 解决方案："定义一次，稳定执行"

AgentFlow 把你的工作流当作**有明确依赖的图**，而不是对话。AI 独立执行每个节点，由**运行时**（而非模型）确保流程正确推进。

### 第一步：在 AI Composer 中描述

在 Web UI 右侧 Composer 输入框中，我输入：

```
创建一个 PR 工作流：
1. 从 git diff 扫描变更文件
2. 对每个变更文件执行代码审查
3. 生成 PR 标题和描述
4. 创建 GitHub PR
5. 发送 Slack 通知给团队
```

### 第二步：审查与调整

AI 生成了一个包含 5 个节点的流程。我做了一些调整：

1. **添加 `control_if` 节点**：如果没有变更则跳过通知
2. **将审查节点改为 `agent_subAgent`**：代码分析质量更好
3. **添加 `tool_print` 节点**：醒目显示 PR 链接

最终流程结构：

```
control_start
    ↓
git_diff_scan
    ↓
review_loop (control_anyOne 遍历每个文件)
    ↓
generate_pr_content
    ↓
create_github_pr
    ↓
control_if (有变更？)
   ↙     ↘
 是      否
  ↓        ↓
slack_notify  control_end
  ↓
control_end
```

### 第三步：运行并放心

```bash
# 应用流程
agentflow apply prsrc

# 如果任何步骤失败，从该点续跑
agentflow resume prsrc <uuid>
```

**现在每个 PR 都精确执行相同的步骤，每次都是：**

- ✅ 代码审查**从不**跳过
- ✅ 测试**总是**在 PR 创建前运行
- ✅ 通知**只在** PR 创建后发送
- ✅ 任何步骤失败，**从该点续跑**（不是从头开始）

## 为什么 AgentFlow 能赢

| 方案 | 稳定性 | 失败恢复 | 可见性 | 学习曲线 |
|------|--------|----------|--------|----------|
| Skills/Commands | ~80% | 从头开始 | 不透明 | 低 |
| **AgentFlow** | **100%** | **检查点续跑** | **每步都有日志** | 中等 |

## flow.yaml 示例

以下是简化版的 `flow.yaml`：

```yaml
instances:
  start:
    definitionId: control_start
    label: 开始
  git_diff:
    definitionId: tool_nodejs
    label: 扫描 Git 变更
    script: git diff --name-only HEAD~1
  review_each:
    definitionId: agent_subAgent
    label: 代码审查
    body: 审查变更文件的潜在问题...
  generate_pr:
    definitionId: agent_subAgent
    label: 生成 PR 描述
    body: 创建清晰的 PR 标题和描述...
  create_pr:
    definitionId: tool_nodejs
    label: 创建 GitHub PR
    script: gh pr create --title "${title}" --body "${body}"
  has_changes:
    definitionId: control_toBool
    label: 有变更？
    value: ${git_diff.result}
  if_changes:
    definitionId: control_if
    label: 如果有变更
  slack_notify:
    definitionId: tool_nodejs
    label: Slack 通知
    script: curl -X POST $SLACK_WEBHOOK -d '{"text":"PR 已创建：${pr_url}"}'
  end:
    definitionId: control_end
    label: 结束

edges:
  - source: start
    target: git_diff
  - source: git_diff
    target: review_each
  - source: review_each
    target: generate_pr
  - source: generate_pr
    target: create_pr
  - source: create_pr
    target: has_changes
  - source: has_changes
    target: if_changes
    sourceHandle: output-1
    targetHandle: input-1
  - source: if_changes
    target: slack_notify
    sourceHandle: output-0
  - source: if_changes
    target: end
    sourceHandle: output-1
  - source: slack_notify
    target: end

ui:
  nodePositions:
    start: { x: 400, y: 50 }
    git_diff: { x: 400, y: 150 }
    review_each: { x: 400, y: 250 }
    generate_pr: { x: 400, y: 350 }
    create_pr: { x: 400, y: 450 }
    has_changes: { x: 400, y: 550 }
    if_changes: { x: 400, y: 650 }
    slack_notify: { x: 250, y: 750 }
    end: { x: 400, y: 850 }
```

## 亲自尝试

### 方式一：使用 AI Composer（推荐）

1. 运行 `agentflow ui`
2. 点击 **新建流水线**
3. 在 Composer 输入框中输入：
   ```
   创建一个 PR 工作流，扫描 git 变更、审查代码、
   创建 PR 并通知团队
   ```
4. 审查生成的流程并按需调整
5. 点击 **保存** 并 **运行**

### 方式二：从模板开始

```bash
# 查看内置流水线
agentflow list

# 从模板创建（如果有）
agentflow create pr-workflow
```

## 下一步

掌握 PR 工作流后，尝试这些高级模式：

- **循环修复**：自动修复代码审查中发现的问题
- **并行审查**：并行审查多个文件
- **定时检查**：定时运行代码质量检查

查看 [模块迁移工作流](module-migration-workflow.zh-CN.md) 了解更多复杂示例。
