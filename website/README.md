# AgentFlow Website

官方网站和文档站点，部署在 GitHub Pages。

## 快速开始

### 本地开发

```bash
cd website
npm install
npm run dev
```

访问 http://localhost:5174/agentflow/

### 构建

```bash
cd website
npm run build
```

构建产物在 `dist/` 目录。

### 预览构建结果

```bash
cd website
npm run preview
```

## 目录结构

```
website/
├── public/
│   ├── docs/              # Markdown 文档（从 docs/wiki 复制）
│   ├── demo-flow.yaml     # Demo Flow 数据
│   └── logo-*.png         # Logo 资源
├── src/
│   ├── components/        # React 组件
│   ├── pages/             # 页面组件
│   ├── styles/            # 全局样式
│   ├── i18n.js            # 国际化配置
│   ├── main.jsx           # 入口文件
│   └── App.jsx            # 路由配置
├── index.html
├── vite.config.js
├── tailwind.config.js
└── package.json
```

## 页面说明

### 首页 (/)
- Hero Section：展示核心价值
- Features Section：四大特性卡片
- Demo Preview：交互式演示入口
- CTA Section：引导用户

### 文档页 (/docs)
- 左侧导航：文档目录
- 右侧内容：Markdown 渲染
- 支持中英文切换

### Demo 页 (/demo)
- 只读 Flow 查看器
- 模拟运行功能
- 节点状态动画

## 部署

### GitHub Actions 自动部署

推送到 `main` 分支时自动触发部署：

```yaml
.github/workflows/deploy-website.yml
```

触发条件：
- `website/` 目录变更
- `docs/` 目录变更
- `builtin/pipelines/` 变更
- Logo 文件更新

部署地址：https://pproject-github.github.io/agentflow/

### 手动部署

```bash
# 在 GitHub Actions 页面点击 "Run workflow"
```

## 技术栈

- React 18 + Vite 5
- React Router 6
- Tailwind CSS 3.4
- @xyflow/react 12（Flow 可视化）
- react-markdown + remark-gfm（Markdown 渲染）
- i18next（国际化）

## 设计系统

继承 AgentFlow UI 的设计规范：

### 颜色
- Primary: `#d0bcff`
- Surface: `#0b1326`
- Container: `#171f33` ~ `#2d3449`

### 字体
- Headline: Space Grotesk
- Body: Inter
- Mono: JetBrains Mono（代码）

### 组件
- Glass Panel：半透明玻璃效果
- Card Solid：实色卡片
- Badge：技术标签
- Button：渐变主按钮 / Ghost 按钮

## 国际化

支持语言：
- English (en)
- Chinese (zh)

切换方式：
- 导航栏右侧语言切换按钮
- 自动检测浏览器语言

## 注意事项

### 文档更新

文档从 `docs/wiki/` 复制到 `public/docs/`，需要手动同步：

```bash
cp -r docs/wiki/* website/public/docs/
```

或修改 GitHub Actions 在构建前自动复制。

### Demo Flow 更新

演示 Flow 使用 `builtin/pipelines/new/flow.yaml`：

```bash
cp builtin/pipelines/new/flow.yaml website/public/demo-flow.yaml
```

### 构建配置

Vite 配置 `base: '/agentflow/'` 确保资源路径正确。

## 许可证

MIT

## GitHub

仓库地址：https://github.com/pproject-github/agentflow