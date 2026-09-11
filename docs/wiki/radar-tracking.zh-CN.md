# 雷达追踪板（track）

每个人自己视角的专项监控：商店政策、合规期限、版本节点这类「有截止日、状态会变、过期要
告警」的事项。定时流程持续往里写，页面按跑道 / 看板 / 表格三种形态呈现。

## 为什么不是定时任务加一列

定时任务回答的是「它跑了没有」，雷达回答的是「事情到哪一步了」。这两个问题的答案经常
相反——流程每天成功跑完，却因为页面改版一条都没抓到。把状态存进流程自己的运行记录里，
就只能看到前者。

所以状态单独落盘，且**由流程写、由人改、两边都留着**。

## 存储：一板多片

```
radar/boards/<板>/_board.json     板级：标题、版本车、spec、归档位
radar/boards/<板>/<flowId>.json   每条流程独占一片
radar/boards/<板>/_overrides.json 人工改的状态
radar/boards/<板>/_alerts.json    每条条目的告警状态
radar/events/<板>.jsonl           变更流
```

**分片是为了让 N 条流程喂同一块板。** 「抓政策」和「扫代码现状」本来就该是不同节奏的两条
流程——一个看外部网页，一个看本仓库，合在一起必然一边浪费一边滞后。各写各的文件，于是
互不覆盖，也不需要加锁。

**算出来的字段一律在读的那一侧补，不落盘。** 剩余天数、有效截止、是否过期/陈旧都是时间的
函数；写进文件的那一刻就开始变陈旧，而文件不会自己更新。

**告警状态单独存 `_alerts.json`，不进分片。** 进了的话流程每天整片覆盖一次，等于把「今天
已经提醒过了」忘掉，降噪当场失效。

## 写入：agentflow track commit

流程末尾挂一个 `tool_nodejs`：

```
agentflow track commit --board=compliance --flow=play-policy-watch --rows=${rows}
```

`${rows}` 由运行时解析成上游节点输出文件的路径，退出码即成败，stdout 不包 JSON——和
`tool_nodejs` 的既有契约完全一致。

### 为什么是 CLI，不是新节点类型

代码节点包底层就是 `tool_nodejs`（见 `node-package-manifest.mjs` 的 `baseDefinitionId`），
而包的解析顺序是「流程自己的 `nodes/` → 已发布工作区包 → 合集」，**没有 builtin 这一档**。
新增原生节点则要开一条没人走过的路：`builtin/nodes/` 里 57 个全是声明，不存在
`switch (definitionId)` 那样的 handler 表。

`tool_nodejs` + `${slotName}` 是唯一走熟的路，一个新概念都不引入。CLI 顺带也给人用来排查。

### commit 替流程扛的四件事

| | 不这么做会怎样 |
|---|---|
| 继承 `settled` | 流程每次整片重写，人标的「已封存」被抹掉，下次扫描全部复活并开始告警 |
| 自动产变更事件 | 变更抽屉永远是空的，或者每个流程作者都得手写事件 |
| 盖 `writtenBy` 挡覆盖 | 两条流程写同一片，板上开始自相矛盾，看的人只会得出「这面板不准」 |
| 抓取失败保留上一片 | 写空数组会把每一条记成消失然后发灰，但它们并没有消失，只是这次没抓到 |

抓取失败这条还有个细节：**保留下来的条目不刷新 `lastSeenAt`**。刷新等于把「已经三天没更新」
这个事实抹掉，陈旧告警就永远不会响。

`writeRadarShard` 本身没有归属校验（只挡路径穿越），`rowsForActor` 是展示过滤不是访问控制
——`writtenBy` 这一层加在 commit 上。

### 条目的形状

```json
{
  "rows": [{
    "id": "play-target-36",
    "title": "Play 目标 API 36 宽限期结束",
    "state": "warn",
    "owner": "xingqiwei",
    "due": "2026-10-24",
    "current": "targetSdk 35",
    "required": "targetSdk 36",
    "evidence": "app/build.gradle:22"
  }]
}
```

`id` 和 `title` 必填。`state` 取 `ok` / `warn` / `risk` / `idle` / `unknown`。

**拼错的 state 报错，不静默降级。** `normalizeState` 对任何不认识的值都给 `idle`，于是
`"warning"` 这个拼写错误会变成「没什么可报告的」——正是一张假的合格证。`unknown` 是有意
收的（确定性脚本匹配不到时的正确答案，落到 `idle`），拼错的一条都不写。

**不做字段白名单。** 多出来的字段是特性：`spareFields()` 拿它们做多维展示，剥掉就把这块板
锁死成固定几列了。

详见 `agentflow-tracking` skill。

## 告警：过期之前降噪，过期之后升噪

截止日之前这是「追踪」：跨过 T-90 / T-30 / T-7 各提醒一次，其余时间闭嘴，免得人把通知
关掉。截止日之后这是「事故」：每天出声，收件人逐级扩大 owner → 兜底账号 → 群。
**这不是重复发送，是升级。**

一条原则贯穿始终：**只有未完成的才告警**。已经满足的、人工封存的，无论离截止日多近、过期
多久都不出声——催一件已经做完的事，是让人静音这个应用最快的方式。

人标了完成而脚本说没有时先不打扰，但矛盾挂过 7 天要提醒本人复核：尊重人的判断，又不能让
一次点击永久掩盖一次真实退化。

投递链复用定时失败通知那套：同一份绑定表、同一个兜底账号、同一个群 webhook。再造一套的
结果是两套各配一半。全局开关 `AGENTFLOW_RADAR_ALERTS=off`。

## 定时任务的雷达归属：反查，不存字段

定时任务那一侧**不加** `track` 字段。加了就是第二个真相源：

- 流程改成写另一块板之后，那个字段不会自己变，列表显示的归属成了过期的谎话；
- 一条流程可以喂多块板，单个字段装不下；
- 老的 schedule 没有这个字段，还要迁移。

改成 `boardsByFlow()` 从板目录反查。分片文件本身就是权威记录——它存在，就证明这条流程真的
往这块板写过；它的 `updatedAt` 还能证明最后一次成功写入是什么时候。**这是证据，不是声明。**

`GET /api/schedules` 的两个分支都会 join 上 `tracks`。反查失败不会让列表打不开——归属是
附加信息，不是主干。

其中 `stale` 最值钱：**「定时任务跑成功了」和「真的写进板了」是两回事**，只看 schedule 那
一侧永远发现不了流程在空转。

## 建板与归档

建板和归档都在面板里就地展开，不开弹框。

- **建板不弹框**：人取名字时要照着已有的板看（别撞车、命名风格一致），弹框正好把它们盖住。
- **归档要确认，建板不要**：建错一块板点归档就没了；归档一块板，别人列表里它也消失了。
  代价不对称，确认也就不该对称。
- **确认行说「留什么」，不问「确定吗」**：人犹豫的是「这会不会把半年的记录删掉」。
- **撤销 > 确认**：确认框只在动手前拦一次，人很快学会闭眼点；撤销在真的点错之后还在。

「删除」一律是归档，只翻 `_board.json` 上的一位，分片 / 覆盖层 / 告警状态 / 变更流全留着。
这类板攒的是**时间**：半年的状态变迁没法重建，误点一次只要一秒。彻底删除留在
`agentflow track rm`，命令行上的显式动作。

板 id 会进深链、进 `--board=`，所以建好之后不改——一直跟着标题走的话，改一次标题就把所有
已配好的流程指向了一块不存在的板。

## 展示：spec 驱动

跑道 / 看板 / 表格三视图由 `spec.encode` 描述视觉通道（lane / end / color / marker / value /
group / badges）。加一个展示维度只要改 spec，不用动前端——AI 编排产出的板因此能自带形态。

**有效截止**是跑道上的关键推导：取最后一班不晚于政策截止日、且还没发车的版本车。赶不上
任何一班和本来就没有车是两件事，页面要能分开讲；截止日晚于所有已知班次时退回截止日本身
（`beyond_known_trains`），否则会把紧急度夸大好几个月。

## 文件形态：一块板是一个工作目录

追踪项除了活在分片里，还可以是文件：

```
<board-workspace>/            可以是 git 仓库
  board.md                    盯什么、边界在哪        ← 人写
  evidence/                   本轮的现状产物
  trackers/<id>.md            一条一份
```

每份 tracker 两层，这是整个形态的关键：

- **frontmatter** 会被机器消费——跑道按 `due` 画、告警按 `state` 触发、协作视图按 `owner` 找人。
  写坏了是静默故障（`state: "警告"` 会被当成「没什么可报告的」），所以必须过校验。
- **正文**只给人看：任务怎么拆、调研到哪、还有什么没确认。它没有固定形状，
  正好是自由文本擅长的，也正好是 agent 和人都能直接改的。

同一个文件里，机器读的部分有契约，人读的部分没有。于是 agent 拿到整个目录当上下文时，
能自由地写正文，却改不动会影响告警的那几个字段——那几个要过 `track sync`。

```
agentflow track export --board=X --flow=Y --dir=<trackers>   板 → 文件
agentflow track sync   --board=X --flow=Y --dir=<trackers>   文件 → 板（同一套校验）
```

**`export` 必须按片导，不能导板的合并视图。** 两个原因：板是推导结果，`decorateRow` 会把
`unknown` 归一成 `idle` 给页面用——把推导值写回文件再 sync 回去，`unknown`（没查出来）
就被悄悄改成了 `idle`（没什么可报告的）；而且板上的条目来自多片，导合并视图会让 sync
把别的流程的条目写进这一片，就是重复认领。

### 机器写完必须自己提交

`track export` 写完会以 `agentflow` 身份自动 `git commit`。不提交的话，下一个提交的人会
「认领」所有机器写的行，`git blame` 把它们全算成人改的——门禁当场变成一堵墙。

## 门禁：哪些改动要人点头

规则不是列出来的，是从 `decideRadarAlert` **反推**的：凡是会让一条条目从此不再告警的
改动都要审批。今天让告警永久闭嘴的只有三种：

| | |
|---|---|
| `settled === true` | `radar-alerts.mjs:53` |
| `state === "ok"` | `radar-alerts.mjs:75` |
| `due` 变成空 | `radar-alerts.mjs:93`，阈值告警从此不触发 |

加上两种不静音但不可逆/越权的：条目消失、覆盖上次由人改的字段。

**其余一律直接落地**，这一条和门禁本身同等重要。每天一个 diff 全都要批，两周之后就是
闭眼点，那时候门禁比没有更糟——它制造了「已经审过」的假象。而且待审批意味着板是旧的，
而发现陈旧正是这套东西存在的意义。

不对称是有意的：**误报只花注意力，漏报会让违规的包发出去。** 所以状态变坏不用批，变好要批。

被拦的**只回退那几个字段**，不是整条不写：否则一条待审批会把同一条目上其它本该落地的
改动一起卡住。被拦下的「条目消失」会把条目留在板上，否则等审批期间人打开板都找不到它。

### 谁改的，靠 git

`--gate` 时用 `git blame HEAD` 逐行判作者，约定 `agentflow` 是机器、其余是人。

- **必须按行，不能按文件**：一次 `git commit -a` 会把所有文件的所有字段标成人改的。
- **必须 blame HEAD，不能 blame 工作区**：待判定的改动本身还没提交，对未提交的行
  git 会把作者填成本机用户名。
- 拿不到 git 就**降级成不拦**，而不是全拦。

### 审批走现成那套

`control.interrupt` 是既有的审批原语，雷达用 `reason: "radar_gate"` 作为标记，
落在侧栏「我的审批」里。`track sync --gate --held-out=<file>` 输出人话的 diff 给它当正文。

审批创建时会推企业微信（`bin/lib/approval-notify.mjs`）——在此之前审批只有拉取，
没人打开页面就没人知道，而挂起期间流程是停着的。通知失败**绝不让审批创建失败**：
宁可没人收到提醒（页面上还看得见），也不能因为企微不通让整条运行崩掉。

### 处理挂起的改动

待审批存在 `radar/boards/<板>/_pending.json`，和分片并列——它是**板的状态**，不是某次运行的
副产品。放运行记录里的话，运行一轮转就没了，而「这条还等着人点头」得一直看得见。

页面上待审批面板摆在板顶上，不塞抽屉：这几条改动**正在被压着不写**，板上相应字段显示的是
旧值。藏起来的话人看到的是一块「正常」的板，而真相在一个没人点开的角落等着。
每条改动旁边写着**为什么拦它**——只说「有待确认」的话，人只会点通过。

```
agentflow track pending <板>                      看有哪些等确认
agentflow track approve --board --flow [--id=]    批准并写入
agentflow track reject  --board --flow [--id=]    驳回（不写，但记一条事件）
```

**驳回必须留痕，不是为了审计**：agent 连着三轮想把同一条改成 ok 都被驳回，说明它的判定
规则该改了，而不是让它每轮再试一次。静默丢弃会把这个信号一起丢掉。

读待审批时会丢掉**已经不成立**的（目标值和现值已经一样）。门禁是逐条流程选择开不开的，
同一条目被另一条没开门禁的流程写成了目标值，这条待审批就成了幻影——留着的话人会去批
一件已经发生的事，而「批准」在变更流里又记一条，把真正那次改动淹掉。

### 分片名可以和流程不同名

一条流程写的分片可以另取名字（比如 `android-policy-ws` 写 `android-policy-watch` 这一片）。
不记下来的话，协作视图和定时归属都会按分片名去找流程，找不到就显示「从没跑过」。
所以 `sync` / `commit` 要带 `--flow-ref=<跑它的流程 id>`。

## 指挥官：给一个 topic，它自己排监控

指挥官就是板 workspace 里的**另一条定时流程**，和监控流程同构，只是任务不同：

```
定时唤醒 → cd 进板目录 → 读 board.md + trackers/ + 运行记录
        → 该加追踪项就加文件；该调监控就写 runtime/plan.md
        → track sync --gate        条目变更走门禁
        → track plan apply         流程变更提案成待审批
```

不用发明「常驻 agent」这一层——定时唤醒本来就是 `workspace.scheduledRun` 干的事。

### 建流程一律审批，没有例外

按「错了代价多大」排，建流程是最贵的一档：一条每小时跑的 agent 流程在**烧钱**，
而且它一旦认领了条目就会开始覆盖别人写的值。

但更要紧的是边界：**图仍然是授权边界**。agent 提议图、人批准图、图约束执行。
让 agent 直接建流程的话，「监控型不能写发现型的字段」就只剩提示词里的一句建议。

```
agentflow track plan apply --board=X --plan=runtime/plan.md --workspace=<板目录>
```

提案落进 `_pending.json` 的 `_plan` 篮子（它不是分片，所以不按分片名校验），
审批正文说清楚**批了会发生什么**：

```
新建监控流程 android-repo-scan，按 0 9 * * * 跑，认领 3 个条目，
写 state/current/evidence，建好后默认停用，要你在定时任务页上手动开启
```

**建出来默认 `enabled: false`。** 批准建它是一回事，让它开始每天烧 token 是另一回事；
混成一个决定的话，批准一份计划就等于同时批了往后每天的开销。

### 授权范围落进提示词

生成的流程把 `owns` / `updates` 写进 agent 的提示词：

```
你负责这些追踪项：play-target-api-36、android16-edge-to-edge、play-16kb-page-size
你只更新这几个字段：state / current / evidence。别的字段归别人管，不要动。
```

光靠图的连线约束不住——agent 拿到的是整个目录，什么都能改，得明确告诉它哪些不归它管。
生成的 `sync` 节点一定带 `--gate`，否则它写什么都直接落地。

## 命令

```
agentflow track commit --board --flow --rows [--fetch-failures] [--stale-after-ms] [--force]
agentflow track list                       有哪些板，各自几条危 / 几片哑了
agentflow track show <板> [--json]         条目、剩余天数、封存 / 过期 / 陈旧标记
agentflow track events <板> [--limit]      变更流
agentflow track create <板> [--title=]     建一块空板
agentflow track archive <板> [--undo]      归档 / 取消归档（不是删除）
agentflow track export --board --flow --dir=<trackers>   板 → 文件
agentflow track sync   --board --flow --dir=<trackers> [--gate] [--held-out=]  文件 → 板
agentflow track pending/approve/reject     处理挂起的改动
agentflow track plan apply --board --plan --workspace   计划 → 待审批的流程提案
agentflow track rm <板> [--flow=<流程>]    彻底删除
```

`rm` 删一片**不清**告警状态（清了的话误删再重建会把提醒过的档位全部重放）；删整块板**留**
变更流（误删之后它是唯一能说清丢了什么的东西）。

## 相关

- `skills/agentflow-tracking` — 约束 agent 产出的条目
- `bin/lib/radar.mjs` — 存储与推导
- `bin/lib/radar-alerts.mjs` — 告警判定（纯函数）
- `bin/lib/radar-alert-sweep.mjs` — 收件人解析与投递
- `bin/lib/radar-planner.mjs` — AI 编排的提示词与计划校验
- `bin/lib/radar-cli.mjs` — `agentflow track`
- `bin/lib/radar-docs.mjs` — `trackers/*.md` 的读写（frontmatter / 正文两层）
- `bin/lib/radar-gate.mjs` — 门禁判定（纯函数，从告警规则反推）
- `bin/lib/radar-plan-apply.mjs` — 计划 → 流程提案 → 真流程
- `bin/lib/approval-notify.mjs` — 审批的企业微信通知（所有审批共用，不只雷达）
