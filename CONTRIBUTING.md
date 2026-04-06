# Contributing to AgentFlow

感谢你对 AgentFlow 的兴趣！以下是参与贡献的指南。

## 开发环境 setup

```bash
# 克隆仓库
git clone https://github.com/bigo-sg/agentflow.git
cd agentflow

# 安装依赖（使用 npm 公网源）
npm install

# 链接到全局以便测试
npm link

# 验证
agentflow --help
```

## 项目结构

```
.
├── bin/              # CLI 入口和 pipeline 脚本
│   ├── agentflow.mjs # 主 CLI
│   └── pipeline/     # apply/replay 各阶段脚本
├── agents/           # 节点执行器 agent 定义 (.md)
├── builtin/          # 内置流水线、Web UI
│   ├── pipelines/    # 示例/内置 flow.yaml
│   └── web-ui/       # 可视化编辑器
├── reference/        # 参考文档和 schema
└── .cursor/skills/   # Cursor skills（开发时使用）
```

## 提交 Pull Request

1. **Fork 仓库** 并创建你的分支 (`git checkout -b feature/amazing-feature`)
2. **确保代码能运行**：`npm install` 和基本 CLI 命令正常
3. **Web UI 变更**：若修改了 `builtin/web-ui/`，确保 `npm run build` 成功
4. **提交信息**：使用清晰的提交信息描述改动
5. **发起 PR**：描述改动的目的和测试方式

## 代码风格

- 使用 ES Module (`type: "module"`)
- 保持与现有代码一致的命名和结构
- 添加必要的注释说明非直观的逻辑

## 多语言贡献指南

AgentFlow 支持 CLI、Web UI 和 Agent 定义的多语言。如果你想添加新语言或改进现有翻译：

### 添加新语言（以法语 fr 为例）

#### 1. CLI 翻译

创建 `bin/lib/locales/fr.json`，参考现有语言文件的结构。

#### 2. Web UI 翻译

创建以下文件：
- `builtin/web-ui/src/i18n/locales/fr/common.json`
- `builtin/web-ui/src/i18n/locales/fr/flow.json`
- `builtin/web-ui/src/i18n/locales/fr/settings.json`
- `builtin/web-ui/src/i18n/locales/fr/composer.json`

然后在 `builtin/web-ui/src/i18n/index.js` 中导入并注册：

```javascript
import frCommon from './locales/fr/common.json';
// ... 其他导入

const resources = {
  // ... 现有语言
  fr: {
    common: frCommon,
    // ... 其他命名空间
  },
};
```

#### 3. Agent 定义翻译

创建 `agents/fr/` 目录，翻译主要的 agent 定义文件：
- `agentflow-node-executor.md`
- `agentflow-node-executor-code.md`
- `agentflow-node-executor-planning.md`
- `agentflow-node-executor-requirement.md`
- `agentflow-node-executor-test.md`
- `agentflow-node-executor-ui.md`

#### 4. 注册语言

更新以下文件中的 `SUPPORTED_LANGUAGES`：
- `bin/lib/i18n.mjs`
- `builtin/web-ui/src/i18n/index.js`

### 翻译注意事项

- **保持占位符一致**：如 `{{name}}`、`{{count}}` 等插值变量
- **保持命名空间一致**：CLI 和 Web UI 使用相同的键结构
- **测试语言切换**：在 Web UI Settings 页面验证切换功能
- **验证 RTL 语言**（如阿拉伯语、希伯来语）：可能需要额外的 CSS 调整

## 报告问题

发现 bug 或有功能建议？请通过 [GitHub Issues](../../issues) 提交，包含：
- 问题描述
- 复现步骤
- 期望 vs 实际行为
- 环境信息（Node 版本、操作系统）

## 许可

通过提交 PR，你同意你的贡献将在 [MIT 许可](LICENSE) 下发布。
