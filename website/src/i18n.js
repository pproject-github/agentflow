import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

const resources = {
  en: {
    translation: {
      nav: {
        home: 'Home',
        docs: 'Documentation',
        demo: 'Demo',
        github: 'GitHub',
      },
      hero: {
        title: 'Orchestrate',
        titleGradient: 'with Precision',
        subtitle: 'Agent orchestration system for long-running complex tasks. Treat Cursor, OpenCode, and Claude Code as swappable execution backends.',
        cta: 'Get Started',
        docs: 'View Documentation',
      },
      install: {
        title: 'Quick Start',
        subtitle: 'Get up and running in minutes',
        step1: 'Install globally',
        step2: 'Launch Web UI',
        step3: 'CLI / CI Execution',
        copy: 'Copy',
        copied: 'Copied!',
      },
      features: {
        stability: {
          title: 'Orchestration Engine',
          desc: 'Visual context workflow built for AI agents. Drag-and-drop nodes to define dependencies and control flow—orchestrate, not dialogue.',
        },
        resilience: {
          title: '24h Continuous Execution',
          desc: 'Agent tasks run for hours without supervision. Each node\'s inputs, outputs, and state persisted to disk—survives restarts.',
        },
        visual: {
          title: 'Manual + AI Orchestration',
          desc: 'Edit flow structure by hand or use AI Composer to generate nodes from natural language. Iterate until perfect.',
        },
        recovery: {
          title: 'Checkpoint Recovery',
          desc: 'Gradle-inspired caching with MD5 checksums. Resume from exact failure point—no need to restart from scratch.',
        },
      },
      demo: {
        title: 'Interactive Demo',
        subtitle: 'Experience the flow in action',
        start: 'Start Simulation',
        pause: 'Stop',
        reset: 'Reset',
        restart: 'Restart',
        step: 'Next Step',
        running: 'Running',
        paused: 'Paused',
        completed: 'Completed',
        ready: 'Ready',
        experienceLive: 'Experience it live',
        infoTitle: 'Flow Visualization',
        infoDesc: 'Real-time view of AgentFlow pipeline. Each node represents a task—control nodes define flow, tool nodes execute scripts, agent nodes run AI reasoning.',
        realtimeTitle: 'Simulated Execution',
        realtimeDesc: 'Watch nodes execute sequentially with timing. In production, each node runs actual tasks with full persistence.',
        yamlTitle: 'YAML Powered',
        yamlDesc: 'Flows defined in simple YAML. Version-controlled, human-readable, and CI-friendly—perfect for automation.',
        nodeActive: 'NODE_ACTIVE',
        processing: 'Executing: control_start → tool_nodejs',
      },
      cta: {
        title: 'Ready to orchestrate',
        titleGradient: 'your agents?',
        primary: 'Start with AgentFlow',
        secondary: 'Explore on GitHub',
      },
      footer: {
        copyright: '© 2026 AgentFlow. Orchestration system for long-running complex tasks.',
        links: {
          privacy: 'Privacy',
          terms: 'Terms',
          github: 'GitHub',
        },
      },
    },
  },
  zh: {
    translation: {
      nav: {
        home: '首页',
        docs: '文档',
        demo: '演示',
        github: 'GitHub',
      },
      hero: {
        title: '精准编排',
        titleGradient: '智能流程',
        subtitle: '为长时复杂任务打造的代理编排系统。将 Cursor、OpenCode、Claude Code 视为可替换的执行后端。',
        cta: '立即开始',
        docs: '查看文档',
      },
      install: {
        title: '快速开始',
        subtitle: '几分钟即可上手',
        step1: '全局安装',
        step2: '启动 Web UI',
        step3: '命令行/CI运行',
        copy: '复制',
        copied: '已复制！',
      },
      features: {
        stability: {
          title: '编排引擎',
          desc: '为 AI 代理打造的上下文工作流。拖拽节点定义依赖与控制流——编排而非对话。',
        },
        resilience: {
          title: '24h 持续执行',
          desc: '代理任务可运行数小时无需人工监督。每个节点的输入、输出和状态持久化到磁盘——重启后依然存活。',
        },
        visual: {
          title: '手动 + AI 编排',
          desc: '手动编辑流程结构，或使用 AI Composer 从自然语言生成节点。反复迭代直至完美。',
        },
        recovery: {
          title: '检查点恢复',
          desc: '借鉴 Gradle 的缓存设计与 MD5 校验系统。从精确的失败点恢复——无需从头重启。',
        },
      },
      demo: {
        title: '交互式演示',
        subtitle: '体验流程运行实况',
        start: '开始模拟',
        pause: '停止',
        reset: '重置',
        restart: '重新开始',
        step: '下一步',
        running: '运行中',
        paused: '已暂停',
        completed: '已完成',
        ready: '就绪',
        experienceLive: '实时体验',
        infoTitle: '流程可视化',
        infoDesc: 'AgentFlow 流程实时视图。每个节点代表一个任务——控制节点定义流程走向，工具节点执行脚本，代理节点运行 AI 推理。',
        realtimeTitle: '模拟执行',
        realtimeDesc: '观察节点按序执行及耗时。在生产环境中，每个节点运行真实任务并完整持久化。',
        yamlTitle: 'YAML 驱动',
        yamlDesc: '流程以简洁 YAML 定义。可版本化管理、易于阅读、适配 CI/CD——完美契合自动化。',
        nodeActive: '节点运行',
        processing: '执行中：control_start → tool_nodejs',
      },
      cta: {
        title: '准备好编排',
        titleGradient: '你的代理了吗？',
        primary: '开始使用 AgentFlow',
        secondary: '查看 GitHub',
      },
      footer: {
        copyright: '© 2026 AgentFlow. 为长时复杂任务打造的 AI Agent 智能编排系统。',
        links: {
          privacy: '隐私政策',
          terms: '使用条款',
          github: 'GitHub',
        },
      },
    },
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage'],
      lookupLocalStorage: 'i18nextLng',
    },
    supportedLngs: ['en', 'zh', 'zh-CN', 'zh-TW'],
    load: 'languageOnly',
  });

export default i18n;