# 如何建立模块迁移工作流

## 背景

模块迁移是代码重构中的常见场景：将主模块的代码迁移到子模块，涉及文件移动、依赖更新、编译验证等多个环节。传统方式需要人工反复执行这些步骤，效率低下且容易出错。

使用 AgentFlow，可以将整个迁移流程编排成自动化工作流，支持循环验证和断点续跑。

## 工作流设计思路

模块迁移的核心流程：

```
扫描模块 → 分析依赖 → 迁移文件 → 更新依赖 → 编译验证 → 发现新依赖 → 迁移新依赖 → 编译验证 → ... → 完成
```

这是一个典型的"检查-修复-检查"循环模式，可以用 AgentFlow 的 `control_anyOne` + `control_if` 实现。

## 工作流节点设计

### 1. 入口节点

- **control_start**：流程入口

### 2. 扫描与分析阶段

- **agent_scan_module**：扫描主模块，识别需要迁移的文件和依赖
- **agent_analyze_dependencies**：分析树型依赖关系，生成迁移计划

### 3. 迁移执行阶段

- **agent_migrate_files**：根据计划迁移文件到子模块
- **agent_update_imports**：更新所有引用的 import 语句

### 4. 编译验证阶段

- **tool_nodejs**：执行编译命令（如 `npm run build`）
- **agent_check_errors**：分析编译错误，识别新发现的依赖

### 5. 循环控制节点

- **control_anyOne**：汇合"首次进入"和"修复完成后再检查"两条路径
- **control_toBool**：将编译结果转换为布尔值（成功/失败）
- **control_if**：根据编译结果决定是否继续循环

### 6. 修复阶段

- **agent_fix_dependencies**：修复编译错误中发现的新依赖问题

### 7. 结束节点

- **control_end**：流程出口

## flow.yaml 示例

```yaml
instances:
  start:
    definitionId: control_start
    label: 开始
    
  scan_module:
    definitionId: agent_subAgent
    label: 扫描模块
    role: 扫描主模块，识别需要迁移的文件
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: moduleName, value: 'main-module' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: fileList, value: 'output/file_list.md' }
      
  analyze_deps:
    definitionId: agent_subAgent
    label: 分析依赖
    role: 分析文件依赖关系，生成迁移计划
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: fileList, value: '${scan_module fileList}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: plan, value: 'output/migration_plan.md' }
      
  migrate_files:
    definitionId: agent_subAgent
    label: 迁移文件
    role: 执行文件迁移
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: plan, value: '${analyze_deps plan}' }
    output:
      - { type: 节点, name: next, value: '' }
      
  compile_check:
    definitionId: tool_nodejs
    label: 编译验证
    script: npm run build
    input:
      - { type: 节点, name: prev, value: '' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: result, value: '' }
      
  check_errors:
    definitionId: agent_subAgent
    label: 检查错误
    role: 分析编译结果，判断是否有错误
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: compileResult, value: '${compile_check result}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: hasError, value: 'output/has_error.txt' }
      
  to_bool:
    definitionId: control_toBool
    label: 转换为布尔
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: value, value: '${check_errors hasError}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: prediction, value: '' }
      
  check_branch:
    definitionId: control_if
    label: 是否有错误
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: prediction, value: '${to_bool prediction}' }
    output:
      - { type: 节点, name: next1, value: '' }  # 无错误 → 结束
      - { type: 节点, name: next2, value: '' }  # 有错误 → 修复
      
  fix_deps:
    definitionId: agent_subAgent
    label: 修复依赖
    role: 根据编译错误修复依赖问题
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: errorLog, value: '${compile_check result}' }
    output:
      - { type: 节点, name: next, value: '' }
      
  loop_entry:
    definitionId: control_anyOne
    label: 循环入口
    input:
      - { type: 节点, name: prev1, value: '' }
      - { type: 节点, name: prev2, value: '' }
    output:
      - { type: 节点, name: next, value: '' }
      
  end:
    definitionId: control_end
    label: 结束

edges:
  - { source: start, target: scan_module }
  - { source: scan_module, target: analyze_deps }
  - { source: analyze_deps, target: migrate_files }
  - { source: migrate_files, target: loop_entry, sourceHandle: output-0, targetHandle: input-0 }
  - { source: loop_entry, target: compile_check }
  - { source: compile_check, target: check_errors }
  - { source: check_errors, target: to_bool }
  - { source: to_bool, target: check_branch, sourceHandle: output-1, targetHandle: input-1 }
  - { source: check_branch, target: end, sourceHandle: output-0, targetHandle: input-0 }
  - { source: check_branch, target: fix_deps, sourceHandle: output-1, targetHandle: input-0 }
  - { source: fix_deps, target: loop_entry, sourceHandle: output-0, targetHandle: input-1 }

ui:
  nodePositions:
    start: { x: 100, y: 100 }
    scan_module: { x: 250, y: 100 }
    analyze_deps: { x: 400, y: 100 }
    migrate_files: { x: 550, y: 100 }
    loop_entry: { x: 700, y: 100 }
    compile_check: { x: 700, y: 250 }
    check_errors: { x: 700, y: 400 }
    to_bool: { x: 700, y: 550 }
    check_branch: { x: 700, y: 700 }
    fix_deps: { x: 900, y: 700 }
    end: { x: 550, y: 700 }
```

## 关键设计要点

### 1. 循环控制模式

使用 `control_anyOne` 作为循环入口，汇合两条路径：
- **prev1**：首次进入（从 `migrate_files` 连入）
- **prev2**：修复后再次检查（从 `fix_deps` 连入）

任一路就绪即进入编译验证阶段。

### 2. 条件分支

使用 `control_if` 判断编译结果：
- **无错误（prediction=false）**：从 `next1`（output-0）连到 `end`，退出流程
- **有错误（prediction=true）**：从 `next2`（output-1）连到 `fix_deps`，进入修复阶段

注意：`control_toBool` 的输出需要反转语义（编译成功=false表示无错误）。

### 3. 状态持久化

每个节点输出到中间文件，确保：
- 编译错误日志保存到 `${compile_check result}`
- 失败后可以从 `fix_deps` 节点重试
- 支持断点续跑，不必重新执行已完成节点

## 运行流程

```bash
# 1. 创建工作流文件（保存到 ~/agentflow/pipelines/module-migration/flow.yaml）
agentflow ui

# 2. 验证流程结构
agentflow validate module-migration

# 3. 执行迁移
agentflow apply module-migration

# 4. 监控执行状态
agentflow run-status module-migration <uuid>

# 5. 失败后从断点继续
agentflow resume module-migration <uuid>

# 6. 单点重试某个节点
agentflow replay module-migration <uuid> fix_deps
```

## 扩展建议

### 1. 并行迁移

对于大型模块，可以拆分多个迁移节点并行执行：
- `migrate_files_part1`、`migrate_files_part2` 并行
- 使用多个 `agent_subAgent` 实例同时迁移不同文件

### 2. 用户确认点

在关键节点后插入 `tool_user_check`：
- 迁移计划生成后，让用户确认
- 编译验证前，让用户确认是否继续

### 3. 回滚机制

添加 `tool_save_key` + `tool_load_key` 记录迁移状态：
- 保存迁移前的文件列表
- 失败时可以回滚到初始状态

## 实际案例

参考内置示例 `builtin/pipelines/module-migrate`，查看完整工作流配置。