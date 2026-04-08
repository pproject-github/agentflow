# 如何建立 Figma UI 还原工作流

## 背景

将 Figma 设计稿还原为前端代码是常见的开发任务。对于复杂 UI（如多页面应用、复杂交互组件），一次性还原面临以下挑战：

1. **设计稿复杂度高**：多个页面、组件层级深、样式细节多
2. **技术栈适配**：需要转换为特定框架代码（React/Vue/小程序）
3. **交互逻辑实现**：静态设计稿需要添加动态交互
4. **细节调优**：还原后需要多次迭代调整细节

传统方式是逐个页面手工还原，效率低且难以保证一致性。使用 AgentFlow 可以编排自动化还原流程，支持一次性处理复杂 UI 并持续迭代优化。

## 工作流设计思路

Figma UI 还原的核心流程：

```
解析设计稿 → 拆分组件 → 生成代码 → 编译验证 → UI对比检查 → 发现差异 → 调整代码 → 编译验证 → ... → 完成
```

同样采用"检查-修复-检查"循环模式，但重点在于 UI 还原的准确性验证。

## 工作流节点设计

### 1. 入口节点

- **control_start**：流程入口

### 2. 设计稿解析阶段

- **agent_parse_figma**：解析 Figma 设计稿链接或导出文件，识别页面结构
- **agent_extract_components**：提取可复用组件，建立组件层级关系

### 3. 代码生成阶段

- **agent_generate_structure**：生成页面结构和布局代码
- **agent_generate_styles**：生成样式代码（CSS/Tailwind/styled-components）
- **agent_generate_components**：生成组件代码（React/Vue 函数组件）

### 4. 技术栈适配

- **tool_nodejs**：执行构建命令（如 `npm run dev` 启动开发服务器）
- **agent_add_interactions**：添加交互逻辑（点击、滑动、动画等）

### 5. UI 验证阶段

- **tool_nodejs**：截图对比（使用 Playwright/Puppeteer）
- **agent_compare_ui**：对比还原 UI 与设计稿，识别差异点

### 6. 循环控制节点

- **control_anyOne**：汇合"首次生成"和"调整后重新检查"
- **control_toBool**：将 UI 对比结果转换为布尔值
- **control_if**：根据还原准确度决定是否继续优化

### 7. 调整优化阶段

- **agent_fix_ui_differences**：根据差异报告调整代码细节

### 8. 结束节点

- **control_end**：流程出口

## flow.yaml 示例

```yaml
instances:
  start:
    definitionId: control_start
    label: 开始
    
  parse_figma:
    definitionId: agent_subAgent
    label: 解析Figma设计稿
    role: 解析Figma设计稿，识别页面结构和组件层级
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: figmaUrl, value: 'https://figma.com/file/xxx' }
      - { type: 文本, name: techStack, value: 'react' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: structure, value: 'output/structure.json' }
      
  extract_components:
    definitionId: agent_subAgent
    label: 提取组件
    role: 从设计稿中提取可复用组件
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: structure, value: '${parse_figma structure}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: components, value: 'output/components.json' }
      
  generate_structure:
    definitionId: agent_subAgent
    label: 生成页面结构
    role: 根据设计稿结构生成页面布局代码
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: structure, value: '${parse_figma structure}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: layoutCode, value: 'src/pages/layout.tsx' }
      
  generate_styles:
    definitionId: agent_subAgent
    label: 生成样式
    role: 根据设计稿生成样式代码
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: structure, value: '${parse_figma structure}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: styleCode, value: 'src/styles/main.css' }
      
  generate_components:
    definitionId: agent_subAgent
    label: 生成组件
    role: 根据组件定义生成React组件代码
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: components, value: '${extract_components components}' }
    output:
      - { type: 节点, name: next, value: '' }
      
  start_dev_server:
    definitionId: tool_nodejs
    label: 启动开发服务器
    script: npm run dev &
    input:
      - { type: 节点, name: prev, value: '' }
    output:
      - { type: 节点, name: next, value: '' }
      
  add_interactions:
    definitionId: agent_subAgent
    label: 添加交互逻辑
    role: 为组件添加交互逻辑（点击、动画等）
    input:
      - { type: 节点, name: prev, value: '' }
    output:
      - { type: 节点, name: next, value: '' }
      
  capture_screenshot:
    definitionId: tool_nodejs
    label: 截图对比
    script: |
      node scripts/capture-ui.mjs \
        --url http://localhost:3000 \
        --output output/ui_screenshot.png \
        --figma ${figmaUrl}
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: figmaUrl, value: '${parse_figma figmaUrl}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: screenshot, value: 'output/ui_screenshot.png' }
      
  compare_ui:
    definitionId: agent_subAgent
    label: UI对比检查
    role: 对比还原UI与设计稿，识别差异点
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: screenshot, value: '${capture_screenshot screenshot}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: differences, value: 'output/ui_differences.md' }
      
  check_accuracy:
    definitionId: agent_subAgent
    label: 判断还原准确度
    role: 分析差异报告，判断是否需要继续优化
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: differences, value: '${compare_ui differences}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: needFix, value: 'output/need_fix.txt' }
      
  to_bool:
    definitionId: control_toBool
    label: 转换为布尔
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: value, value: '${check_accuracy needFix}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: prediction, value: '' }
      
  accuracy_branch:
    definitionId: control_if
    label: 是否需要调整
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: prediction, value: '${to_bool prediction}' }
    output:
      - { type: 节点, name: next1, value: '' }  # 无差异 → 结束
      - { type: 节点, name: next2, value: '' }  # 有差异 → 调整
      
  fix_ui:
    definitionId: agent_subAgent
    label: 调整UI差异
    role: 根据差异报告调整样式和布局代码
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: differences, value: '${compare_ui differences}' }
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
  - { source: start, target: parse_figma }
  - { source: parse_figma, target: extract_components }
  - { source: extract_components, target: generate_structure }
  - { source: generate_structure, target: generate_styles }
  - { source: generate_styles, target: generate_components }
  - { source: generate_components, target: start_dev_server }
  - { source: start_dev_server, target: add_interactions }
  - { source: add_interactions, target: loop_entry, sourceHandle: output-0, targetHandle: input-0 }
  - { source: loop_entry, target: capture_screenshot }
  - { source: capture_screenshot, target: compare_ui }
  - { source: compare_ui, target: check_accuracy }
  - { source: check_accuracy, target: to_bool }
  - { source: to_bool, target: accuracy_branch, sourceHandle: output-1, targetHandle: input-1 }
  - { source: accuracy_branch, target: end, sourceHandle: output-0, targetHandle: input-0 }
  - { source: accuracy_branch, target: fix_ui, sourceHandle: output-1, targetHandle: input-0 }
  - { source: fix_ui, target: loop_entry, sourceHandle: output-0, targetHandle: input-1 }

ui:
  nodePositions:
    start: { x: 100, y: 100 }
    parse_figma: { x: 250, y: 100 }
    extract_components: { x: 400, y: 100 }
    generate_structure: { x: 550, y: 100 }
    generate_styles: { x: 700, y: 100 }
    generate_components: { x: 850, y: 100 }
    start_dev_server: { x: 1000, y: 100 }
    add_interactions: { x: 1150, y: 100 }
    loop_entry: { x: 1300, y: 100 }
    capture_screenshot: { x: 1300, y: 250 }
    compare_ui: { x: 1300, y: 400 }
    check_accuracy: { x: 1300, y: 550 }
    to_bool: { x: 1300, y: 700 }
    accuracy_branch: { x: 1300, y: 850 }
    fix_ui: { x: 1500, y: 850 }
    end: { x: 1150, y: 850 }
```

## 关键设计要点

### 1. 分阶段生成

将代码生成拆分为多个节点：
- **结构生成**：先确保布局正确
- **样式生成**：再处理视觉细节
- **组件生成**：最后生成可复用单元

每个阶段输出到中间文件，便于问题定位和断点续跑。

### 2. UI 验证机制

使用截图对比技术验证还原准确度：
- **Playwright/Puppeteer**：自动化截图
- **视觉对比工具**：像素级对比或 AI 对比
- **差异报告**：生成具体的差异点清单

### 3. 持续优化循环

发现差异后进入修复循环：
- 读取差异报告
- 定位对应代码文件
- 调整样式/布局参数
- 重新截图验证

直到达到满意的还原准确度。

### 4. 技术栈适配

通过参数化配置支持不同技术栈：
- React/Vue/小程序
- CSS/Tailwind/styled-components
- TypeScript/JavaScript

在入口节点配置技术栈，下游节点根据配置生成对应代码。

## 运行流程

```bash
# 1. 创建工作流文件
agentflow ui

# 2. 配置 Figma URL 和技术栈
# 在 UI 中编辑 parse_figma 节点的 input 参数

# 3. 验证流程结构
agentflow validate figma-ui-implementation

# 4. 执行还原
agentflow apply figma-ui-implementation

# 5. 监控执行状态
agentflow run-status figma-ui-implementation <uuid>

# 6. 查看差异报告
cat .workspace/agentflow/runBuild/figma-ui-implementation/<uuid>/output/ui_differences.md

# 7. 失败后从断点继续
agentflow resume figma-ui-implementation <uuid>
```

## 辅助脚本

### capture-ui.mjs

截图对比脚本示例：

```javascript
import puppeteer from 'puppeteer';
import { program } from 'commander';

program
  .option('--url <url>', 'UI地址')
  .option('--output <path>', '截图输出路径')
  .option('--figma <url>', 'Figma设计稿URL')
  .parse();

const { url, output, figma } = program.opts();

const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'networkidle0' });
await page.screenshot({ path: output, fullPage: true });
await browser.close();

console.log(JSON.stringify({
  err_code: 0,
  message: { screenshot: output, figmaUrl: figma }
}));
```

### UI 对比工具建议

- **pixelmatch**：像素级对比
- **Applitools**：AI 视觉对比
- **BackstopJS**：自动化视觉回归测试

## 扩展建议

### 1. 多页面并行还原

对于多页面应用：
- 拆分多个 `parse_figma_page` 实例并行执行
- 使用 `tool_save_key` 共享组件库信息

### 2. 响应式适配

添加响应式验证节点：
- 多分辨率截图对比
- 移动端/桌面端分别验证

### 3. 用户确认点

在关键阶段插入 `tool_user_check`：
- 组件结构确认
- 样式预览确认
- 交互逻辑确认

### 4. 代码质量检查

添加静态检查节点：
- ESLint/TSLint 代码规范检查
- TypeScript 类型检查
- 单元测试生成

## 实际案例

完整示例见 `builtin/pipelines/figma-ui-demo`（如有），包含：
- React + Tailwind 技术栈配置
- 多页面并行还原示例
- Playwright 截图对比脚本