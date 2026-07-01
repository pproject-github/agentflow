import { Link } from 'react-router-dom';

const scenarioCards = [
  {
    icon: 'campaign',
    title: '首页 Feed 想加一个广告引导',
    question: '先判断入口、展示位、用户影响面，再决定弹框、浮层还是页面内引导。',
    context: ['查客户端展示位逻辑', '查历史需求与配置', '查 m09 / Feed PV'],
    result: '原型 + PRD + TAPD 更新',
    tone: 'pink',
  },
  {
    icon: 'manage_search',
    title: '接到需求但不知道现有逻辑',
    question: '不用先找研发问一圈，直接从 Likee 代码、知识库、历史文档里拿上下文。',
    context: ['客户端 / 后台 / 前端知识库', '接口与配置链路', '相关 Git 文档'],
    result: '背景结论 + 影响范围',
    tone: 'cyan',
  },
  {
    icon: 'query_stats',
    title: '运营要评估活动或入口价值',
    question: '先查人群规模、页面访问、历史转化，避免凭经验拍优先级。',
    context: ['CK / Hive 查数', '自动生成 SQL', '指标口径解释'],
    result: '数据表 + 图表 + 结论',
    tone: 'green',
  },
  {
    icon: 'draw',
    title: '想快速把方案画给团队看',
    question: '把一句需求变成客户端或 H5 原型，让评审时先讨论体验，不只讨论文字。',
    context: ['Likee 客户端样式', '前端页面结构', '交互状态与文案'],
    result: 'HTML 原型 + Display 面板',
    tone: 'amber',
  },
  {
    icon: 'sync_alt',
    title: '需求写完后需要同步多个地方',
    question: 'PRD、TAPD、Git 仓库和评审展示保持一致，减少重复复制和漏改。',
    context: ['需求正文', '变更记录', 'MR / 仓库路径'],
    result: 'TAPD 更新 + Git 提交',
    tone: 'violet',
  },
  {
    icon: 'monitoring',
    title: '上线后要看效果和复盘',
    question: '沿用需求阶段的口径继续查数，把结果沉淀回下一轮需求线索。',
    context: ['上线后 CK / Hive', '分页面 / 分人群指标', '实验和版本信息'],
    result: '复盘结论 + 后续建议',
    tone: 'blue',
  },
];

const useCases = [
  {
    label: 'Use Case 01',
    title: 'Likee 客户端知识库查询（如广告占位）',
    images: ['/likee-context/usecase-ad-query.png'],
    trigger: '产品或运营想确认客户端已有逻辑，例如 Likee Android 里有哪些广告占位，以及相关常量和代码位置。',
    steps: ['在「我的流程」加载 Likee Android 流程片段', '在子 Agent 节点输入客户端逻辑问题', '点击 Run Line，只执行当前链路', '在右侧 Markdown Display 查看知识库查询结果'],
    outputs: ['SETTING_ID / PAGE_ID 表格', '客户端代码路径与口径说明', '可继续用于 PRD 的背景材料'],
  },
  {
    label: 'Use Case 02',
    title: '客户端原型设计',
    images: ['/likee-context/usecase-prototype.png'],
    trigger: '业务已经明确要在 Likee 首页加入广告引导，需要先把弹框体验画出来给产品、设计、研发评审。',
    steps: ['在 Workspace 打开原型生成流程', '加载客户端原型 Skill', '在子 Agent 中说明生成一个首页 dialog 弹框', '查看 HTML Display 中的手机预览稿'],
    outputs: ['Likee 风格手机原型', '弹框文案与按钮状态', '可直接用于评审的 Display 面板'],
  },
  {
    label: 'Use Case 03',
    title: '前端 H5 原型设计',
    images: ['/likee-context/usecase-h5-prototype.png'],
    trigger: '运营活动需要快速产出 Likee 风格 H5 页面，例如幸运转盘、积分排行榜、活动首页或结果页。',
    steps: ['在 Workspace 打开 H5 原型生成流程', '加载前端 H5 原型相关 Skill', '在子 Agent 中说明活动结构、页面模块和运营规则', '查看 HTML Display 中的可交互 H5 原型'],
    outputs: ['Likee 风格 H5 页面', '抽奖转盘与排行榜布局', '活动规则和状态页', '可用于评审的 HTML Display'],
  },
  {
    label: 'Use Case 04',
    title: 'CK / Hive 查数与 SQL 生成',
    images: ['/likee-context/usecase-data-query.png'],
    trigger: '运营或产品需要快速验证一个数据问题，例如找出典型 UID、对比不同日期的视频上传分辨率占比，并保留可复用 SQL。',
    steps: ['在 Workspace 打开查数流程', '加载查数相关 Skill', '在子 Agent 中说明数据口径、日期和筛选条件', '查看 Markdown Display 中的数据结果和查询 SQL'],
    outputs: ['查询结果表格', 'SQL 语句', '口径说明', '可继续接入 PRD 或复盘面板的数据结论'],
  },
  {
    label: 'Use Case 05',
    title: '需求文档生成、数据补齐与同步',
    images: ['/likee-context/usecase-prd.png', '/likee-context/usecase-sync.png'],
    trigger: '需求进入评审和落库阶段，需要把 TAPD 信息、Hive 数据、原型内容组织成 PRD，并同步到 TAPD 和 Git 仓库。',
    steps: ['先运行 TAPD / 数据查询节点，拿到迭代、页面 PV 和业务背景', '把查询结果和原型 Display 内容接入 PRD 生成子 Agent', '在 Markdown Display 查看完整需求文档', '把 PRD content 接入 TAPD 更新节点和 Git 仓库提交节点'],
    outputs: ['完整 PRD 文档', '项目背景与 Top 页面数据', 'TAPD 需求更新成功', 'Git MR 链接'],
  },
  {
    label: 'Use Case 06',
    title: 'Display 模式做需求评审面板',
    images: ['/likee-context/usecase-display.png'],
    trigger: '流程跑完后，需要把 PRD、原型、数据图表、展示位表格放在一个页面里给产品、运营、研发一起看。',
    steps: ['在 Workspace 中完成查数、原型、PRD、同步节点执行', '确认 Markdown / HTML / 图表 / 表格展示节点都有结果', '切换顶部 DISPLAY 模式', '使用生成链接把评审面板发给相关同学'],
    outputs: ['PRD 长文档', '客户端原型预览', '图表与表格', '统一展示链接'],
  },
];

const capabilityRows = [
  ['知识库', '查客户端、后台、前端逻辑', '广告、Feed、会员、增长、配置、接口调用链'],
  ['数据', '查 CK / Hive 并输出 SQL', 'PV、UV、转化、分页面、分国家、分实验组'],
  ['产物', '生成原型、PRD、Display 面板', 'Markdown、HTML 原型、图表、表格、交互预览'],
  ['协作', '同步 TAPD 与 Git 仓库', '需求正文、变更记录、MR 链接、评审材料'],
];

const skills = [
  {
    name: 'likee-client-ui',
    namespace: '智能助手 / 客户端原型',
    icon: 'phone_iphone',
    mode: '客户端原型设计',
    usage: '生成 Likee 客户端风格页面、弹框、Feed 引导、个人页、活动入口等原型，适合产品评审前快速对齐体验。',
    examples: ['首页 dialog 弹框', 'Feed 内引导', '客户端红色主品牌视觉', '移动端交互态'],
    tone: 'pink',
  },
  {
    name: 'tapd-likee',
    namespace: '智能助手 / TAPD',
    icon: 'sync',
    mode: '需求系统交互',
    usage: '和 TAPD 交互，支持创建、同步、更新需求，把工作区生成的 PRD 或 Markdown 内容回写到需求系统。',
    examples: ['创建 TAPD 需求', '更新需求正文', '同步处理人和链接', '把结果回显到 Display'],
    tone: 'green',
  },
  {
    name: 'plain-language-response',
    namespace: '智能助手 / 回答风格',
    icon: 'record_voice_over',
    mode: '业务化回答',
    usage: '用于把回答收敛成产品、运营更容易阅读的解释，避免直接把客户端代码库细节、函数调用链和实现细节暴露太多。',
    examples: ['需求背景解释', '代码结论转业务语言', '评审材料摘要', '减少实现细节噪音'],
    tone: 'cyan',
  },
  {
    name: 'create-likee-h5-style-html',
    namespace: '智能助手 / 前端 H5',
    icon: 'language',
    mode: 'H5 原型设计',
    usage: '创建 Likee H5 风格原型，适合运营活动、抽奖、排行榜、报告页、反馈表单、创作者认证页、订单列表等页面。',
    examples: ['幸运转盘活动', '积分排行榜', '活动规则页', '结果页和空状态'],
    tone: 'amber',
  },
  {
    name: 'analytics',
    namespace: '数据 / CK & Hive',
    icon: 'query_stats',
    mode: '查数和 SQL 生成',
    usage: '面向 CK、Hive 的指标查询和 SQL 生成，适合 PV、UV、转化、分国家、分实验组、典型 UID 等数据问题。',
    examples: ['自动生成 SQL', '输出查询结果表', '解释指标口径', '沉淀复盘数据'],
    tone: 'green',
  },
];

function FlowNode({ icon, title, label, tone = 'violet' }) {
  return (
    <div className={`likee-flow-node likee-flow-node-${tone}`}>
      <span className="material-symbols-outlined">{icon}</span>
      <div>
        <strong>{title}</strong>
        <small>{label}</small>
      </div>
    </div>
  );
}

function WorkspaceScene() {
  return (
    <div className="likee-workspace-scene" aria-hidden="true">
      <div className="likee-scene-grid" />
      <svg className="likee-scene-lines" viewBox="0 0 980 560" fill="none">
        <path d="M96 154 C236 96 330 122 444 194 C552 262 654 260 814 160" />
        <path d="M118 350 C248 288 344 304 458 372 C578 444 704 420 858 310" />
        <path d="M472 196 C512 248 524 302 486 372" />
        <path d="M622 126 C670 198 696 258 682 354" />
      </svg>

      <div className="likee-node-pos likee-node-a">
        <FlowNode icon="travel_explore" title="全局上下文" label="Likee 业务、代码、数据" tone="pink" />
      </div>
      <div className="likee-node-pos likee-node-b">
        <FlowNode icon="database" title="CK / Hive" label="自动 SQL 与指标口径" tone="cyan" />
      </div>
      <div className="likee-node-pos likee-node-c">
        <FlowNode icon="article" title="需求文档" label="PRD、变更说明、评审稿" tone="amber" />
      </div>
      <div className="likee-node-pos likee-node-d">
        <FlowNode icon="sync_alt" title="TAPD / Git" label="同步需求与版本资产" tone="green" />
      </div>

      <div className="likee-phone-preview">
        <div className="likee-phone-top">
          <span>关注</span>
          <strong>推荐</strong>
          <span>直播</span>
        </div>
        <div className="likee-phone-card">
          <div className="likee-gift">AD</div>
          <h4>广告个性化引导弹框</h4>
          <p>保持推荐体验，同时解释权益与关闭路径。</p>
          <button>继续</button>
          <button className="secondary">稍后</button>
        </div>
      </div>

      <div className="likee-display-panel">
        <div className="likee-panel-header">
          <span>DISPLAY</span>
          <strong>需求资产面板</strong>
        </div>
        <div className="likee-table-row">
          <span>需求</span>
          <strong>首页广告个性化引导</strong>
        </div>
        <div className="likee-table-row">
          <span>数据</span>
          <strong>m09 PV Top 1</strong>
        </div>
        <div className="likee-table-row">
          <span>同步</span>
          <strong>TAPD + Git MR</strong>
        </div>
      </div>
    </div>
  );
}

function SkillsSection() {
  return (
    <section id="likee-skills" className="py-20 md:py-28 bg-[#070b13]">
      <div className="max-w-7xl mx-auto px-6 md:px-12">
        <div className="grid lg:grid-cols-[0.72fr_1.28fr] gap-12 lg:gap-16 items-start">
          <div className="lg:sticky lg:top-10">
            <p className="likee-section-kicker">SKILLS</p>
            <h2 className="mt-4 font-headline text-4xl md:text-5xl font-black text-white">
              用 Skills 把 Likee 上下文变成可复用能力
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-white/62">
              Skills 是工作区里可加载的能力包。手动搭建工作区时，只需要按场景加载对应 Skill。
            </p>
          </div>

          <div className="likee-skill-grid">
            {skills.map((skill) => (
              <article className={`likee-skill-card likee-skill-${skill.tone}`} key={skill.name}>
                <div className="likee-skill-head">
                  <div className="likee-skill-icon">
                    <span className="material-symbols-outlined">{skill.icon}</span>
                  </div>
                  <div>
                    <h3>{skill.name}</h3>
                    <span>{skill.namespace}</span>
                  </div>
                </div>
                <div className="likee-skill-mode">{skill.mode}</div>
                <p>{skill.usage}</p>
                <div className="likee-skill-examples">
                  {skill.examples.map((example) => (
                    <strong key={example}>{example}</strong>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export default function LikeeContext() {
  return (
    <div className="likee-page">
      <div className="likee-top-actions">
        <Link to="/" className="likee-home-link">
          <span className="material-symbols-outlined">arrow_back</span>
          返回首页
        </Link>
      </div>
      <section className="likee-hero">
        <WorkspaceScene />
        <div className="relative z-10 max-w-7xl mx-auto px-6 md:px-12 w-full">
          <div className="max-w-4xl">
            <p className="likee-eyebrow">LIKEE CONTEXT WORKSPACE</p>
            <h1 className="font-headline text-5xl sm:text-6xl md:text-7xl font-black leading-[0.92] text-white">
              Likee Agent 工作台
            </h1>
            <p className="mt-6 max-w-3xl text-xl md:text-2xl leading-relaxed text-white/78">
              提供 Likee 全局上下文，赋能需求挖掘、书写和运营。
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <span className="likee-signal">查业务逻辑</span>
              <span className="likee-signal">查 CK / Hive</span>
              <span className="likee-signal">生成原型</span>
              <span className="likee-signal">生成 PRD</span>
              <span className="likee-signal">同步 TAPD / Git</span>
            </div>
            <div className="likee-hero-actions mt-10 flex flex-col sm:flex-row sm:flex-wrap gap-3">
              <a href="/" className="likee-primary-action">
                <span className="material-symbols-outlined">rocket_launch</span>
                立即使用
              </a>
              <a href="#likee-scenarios" className="likee-secondary-action">
                <span className="material-symbols-outlined">ads_click</span>
                按场景查看
              </a>
              <a href="#likee-usecases" className="likee-secondary-action">
                <span className="material-symbols-outlined">view_timeline</span>
                查看 Use Cases
              </a>
              <a href="#likee-skills" className="likee-secondary-action">
                <span className="material-symbols-outlined">extension</span>
                查看 Skills
              </a>
            </div>
          </div>
        </div>
      </section>

      <section id="likee-scenarios" className="py-20 md:py-28 bg-[#070b13]">
        <div className="max-w-7xl mx-auto px-6 md:px-12">
          <div className="max-w-3xl">
            <p className="likee-section-kicker">SCENARIO TRIGGERS</p>
            <h2 className="mt-4 font-headline text-4xl md:text-5xl font-black text-white">
              打造 Likee 团队全景上下文
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-white/62">
              不要求先会写 Prompt，也不要求知道该找哪个系统。选择一个业务场景，工作台会把需要的 Likee 上下文、数据查询和最终产物组织起来。
            </p>
          </div>

          <div className="likee-scenario-grid mt-10">
            {scenarioCards.map((scenario) => (
              <article className={`likee-scenario-card likee-scenario-${scenario.tone}`} key={scenario.title}>
                <div className="likee-scenario-icon">
                  <span className="material-symbols-outlined">{scenario.icon}</span>
                </div>
                <div>
                  <h3>{scenario.title}</h3>
                  <p>{scenario.question}</p>
                </div>
                <div className="likee-scenario-context">
                  {scenario.context.map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
                <div className="likee-scenario-result">
                  <span>产出</span>
                  <strong>{scenario.result}</strong>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="likee-usecases" className="py-20 md:py-28 bg-[#0d111b]">
        <div className="max-w-7xl mx-auto px-6 md:px-12">
          <div className="grid lg:grid-cols-[0.82fr_1.18fr] gap-12 lg:gap-16 items-start">
            <div className="lg:sticky lg:top-10">
              <p className="likee-section-kicker">USE CASES</p>
              <h2 className="mt-4 font-headline text-4xl md:text-5xl font-black text-white">
                沉淀 Likee 业务流水线
              </h2>
              <p className="mt-5 text-lg leading-relaxed text-white/62">
                这里展示的是平台里实际可跑的工作流：加载流程片段，在子 Agent 或 Run 节点输入业务问题，执行当前 line，最终在 Display、TAPD 和 Git 中拿到结果。
              </p>
            </div>

            <div className="likee-usecase-stack">
              {useCases.map((useCase) => (
                <article className="likee-usecase-card" key={useCase.label}>
                  <div className={`likee-usecase-media ${useCase.images.length > 1 ? 'likee-usecase-media-split' : ''}`}>
                    {useCase.images.map((image, index) => (
                      <img
                        key={image}
                        src={image}
                        alt={`${useCase.title} 工作区截图 ${index + 1}`}
                        loading="lazy"
                      />
                    ))}
                  </div>
                  <div className="likee-usecase-body">
                    <div className="likee-usecase-label">{useCase.label}</div>
                    <h3>{useCase.title}</h3>
                    <p>{useCase.trigger}</p>
                    <ol className="likee-usecase-steps">
                      {useCase.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                    <div className="likee-usecase-output">
                      <span>实际产物</span>
                      <div>
                        {useCase.outputs.map((item) => (
                          <strong key={item}>{item}</strong>
                        ))}
                      </div>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      <SkillsSection />

      <section className="py-20 md:py-28 bg-[#070b13]">
        <div className="max-w-7xl mx-auto px-6 md:px-12">
          <div className="grid lg:grid-cols-[1fr_1.1fr] gap-10 lg:gap-16 items-center">
            <div>
              <p className="likee-section-kicker">CAPABILITY MAP</p>
              <h2 className="mt-4 font-headline text-4xl md:text-5xl font-black text-white">
                每个场景背后，都连接同一套 Likee 上下文能力
              </h2>
              <p className="mt-5 text-lg leading-relaxed text-white/62">
                工作台把知识库、CK / Hive、原型、PRD、TAPD 和 Git 放到同一条链路里。用户看到的是业务场景，系统处理的是上下文、产物和同步。
              </p>
            </div>

            <div className="likee-capability-table">
              {capabilityRows.map(([scope, action, detail]) => (
                <div className="likee-capability-row" key={scope}>
                  <span>{scope}</span>
                  <strong>{action}</strong>
                  <p>{detail}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
