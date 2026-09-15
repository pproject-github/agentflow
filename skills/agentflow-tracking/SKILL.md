---
name: agentflow-tracking
description: >-
  给雷达追踪板产出条目并写回。用于定时流程盯商店政策、合规期限、版本节点这类
  「有截止日、状态会变、过期要告警」的事项；约束条目字段、state 取值和抓取失败
  的记法，并用 `agentflow track commit` 落盘。
---

# AgentFlow 追踪（track）

一块**板**是一个主题下的监控面（比如「发版合规」）。板由若干条**定时流程**喂，每条流程
独占一个**分片**，只写自己认领的条目。分片之间互不覆盖，所以同一块板上可以有「抓政策」
和「扫代码现状」两条节奏完全不同的流程。

## 一条流程长什么样

```
定时触发 → agent 判定现状 → tool_nodejs 写回
```

最后那个 `tool_nodejs` 的 `script` 就一行：

```
agentflow track commit --board=compliance --flow=play-policy-watch --rows=${rows}
```

`${rows}` 由运行时解析成上游节点输出文件的路径。退出码即成败，stdout 不要包 JSON。

## 条目的形状

```json
{
  "rows": [
    {
      "id": "play-target-36",
      "title": "Play 目标 API 36 宽限期结束",
      "state": "warn",
      "owner": "xingqiwei",
      "due": "2026-10-24",
      "current": "targetSdk 35",
      "required": "targetSdk 36",
      "evidence": "app/build.gradle:22",
      "source": "https://support.google.com/googleplay/android-developer/answer/11926878"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 稳定、可读、跨次运行不变。**换了 id 就是换了一条**，旧的会被记成 dropped |
| `title` | ✅ | **要盯的那件事，陈述句**。不要写成问句：「X 是否达标」的答案是 yes/no，而这一行旁边显示的是「进行中 / 已满足」，问句配进度读起来是矛盾的。结论归 `state` 和 `current` |
| `state` | | `ok` / `warn` / `risk` / `idle` / `unknown`，缺省 `idle` |
| `owner` | | AgentFlow 用户名。告警按它找人，空着就落到兜底账号 |
| `due` | | 政策截止日。`YYYY-MM-DD` 按**当地**零点解释 |
| `current` | | 现在是什么样 |
| `required` | | 要求是什么样 |
| `evidence` | | 凭什么这么判：文件行号、接口返回、页面片段 |
| `source` | | 依据的原始链接 |
| `parent` | | 挂在哪一条下面。见下面「层级」 |
| `kind` | | `verdict`（结论）/ `task`（要做的事）。见下面「层级」 |
| `theme` | | 属于哪个大组。**只写在最上面那一条上**，子行继承，见下面「大组和标签」 |
| `tags` | | 这件事要动哪儿。**取值只能从板的词典里挑**，见下面「大组和标签」 |

**多余的字段留着，不会被剥掉。** 板的展示规格（`spec.encode`）没用到的字段会作为
附加维度出现在条目详情里 —— 想加 `platform`、`政策链接`、`风险等级` 就直接加。

## 层级：一条政策、各端的结论、各自的任务

`parent` 指向另一条的 `id`，深度不限。典型是三层：

```
play-16kb-page-size-req              一条要求（谁都没答之前它就在）
  play-16kb-page-size@likee          kind: verdict —— Likee 满足没有
    …-ndk@likee                      kind: task    —— 要做的一件事
    …-cmake@likee                    kind: task
```

**结论行和任务行必须分开，不能挤在同一层。** 满足时写一条、不满足时写 N 条的话，
同一个层级上就有了两种语义——板上没人答得出「Likee 这条到底行不行」。
而且任务要能单独认领、单独排期，挂在结论上的负责人和起止日期指给谁都不对。

规矩：

- **每个（父项 × 流程）恰好一条 `verdict`。** 多一条少一条都是错的。
- `task` 的 `parent` 指**结论行**，不是父项。指错了它会跑到父项底下变成另一个结论。
- 满足了就 **0 条 task**。
- 父行的状态**不用你写**：它从子行汇总（取最坏），你写了也会被推导盖掉。

## 归属：`owns` 和 `covers`

```
agentflow track sync --board=gp --flow=likee-compliance \
  --owns='*@likee' --covers='play-*-req'
```

- **`owns`** = 我负责写哪些 id。写了范围外的 id，**整次拒收**，不是只丢那几条——
  半写进去的一片比不写更难查。
- **`covers`** = 我替哪些父项作答。声明了却没写 `verdict`，板上就标**缺席**。
  这是「查过了，不满足」和「压根没人查」的唯一区别，而后者才是最该被看见的。

父行因此**永远不会**在有端缺席时显示已满足——缺席按「无状态」参与汇总。

## 大组和标签：两套词典，不准有同一个词

这是最容易做错的一处，而且做错了不报错——直到半年后有人问「为什么这个标签点进去
和那个分组一模一样」。

|  | `theme`（大组） | `tags`（标签） |
|---|---|---|
| 答的问题 | 这条**属于哪儿** | 这件事**要动哪儿** |
| 形状 | 单值字符串 | 数组 |
| 词典 | `spec.themes[{key,label}]`，有中文 label | `spec.tags`，只有 key |
| 写在哪 | **只写最上面那一条**（政策），子行继承 | 哪一层都可以 |
| 页面上 | 分区抬头，显示的是 label | 可点的筛选胶囊，显示的是 key |
| 一行能有几个 | 一个 | 多个 |

两者**正交**：一条 `aep` 的政策底下完全可能有个 `native` 的活。

```js
// ✗ 子行把父行的大组又抄了一遍，还顺手写进了 theme
{ id: "play-16kb@likee", parent: "play-16kb-req",
  theme: "android16", tags: ["android16", "native"] }

// ✓ 归属靠 parent 推，标签只说这件事碰什么
{ id: "play-16kb@likee", parent: "play-16kb-req", tags: ["native"] }
```

抄出来的那份既冗余（顺着 `parent` 就推得出来），又会漂：政策改挂大组的那天，
子行的标签开始撒谎，而且没有任何东西会发现。

**这两条现在会让整次 commit 失败**（板申明过词典的前提下）：

- 子行写了 `theme`
- 标签不在 `spec.tags` 里——包括「这个标签其实是个大组」

和 `owns` 一样是整次拒收，不是只丢那几条。

## 词典：别在提示词里抄一份

状态在这块板上怎么念、有哪几个大组、标签只能挑哪些——这些是**板的数据**，
不是你提示词里的常量。用 `radar.readSpec` 节点读进来：

```js
const vocab = radar.readSpec("读板的词典", { board: "gp" });
const work = agent.subAgent("…", { vocab: vocab.vocab }, `… 标签只能从输入 vocab.tags 里挑 …`);
```

抄一份的后果：改一个大组要去编辑流程源码；两条流程各抄一份就会拼出两个同名的组；
而真正生效的那份在板里——三份真相，没人知道该信谁。

## 四条硬规矩

**1. `id` 必须稳定。** 它是跨次运行认人的唯一依据，也是人工改状态、告警降噪挂靠的键。
用 `play-target-36` 这种语义 id，不要用行号、数组下标或带日期的串。

**2. 判定现状要用确定性脚本，不要每天让模型重猜。** 脚本匹配不到时写
`state: "unknown"`，**绝不能默认当成 `ok`** —— 那等于发了一张假的合格证。

`unknown` 会落到 `idle`（没什么可报告的），不会触发告警，但会在板上和真正的 `ok`
区分开。

**3. 抓取失败要和「没有变化」分开记。**

```
agentflow track commit --board=... --flow=... --rows=${rows} --fetch-failures=2
```

失败时**照样 commit**，条目保持上一次的值，把失败次数报上去。整片不写的话，板看起来
一切正常，而监控其实已经静默死掉了。

**4. 一个条目只能由一条流程负责写。** 两条流程写同一条，板上会开始自相矛盾，而看的人
只会得出「这面板不准」的结论。要改归属就换 `--flow` 名字，或者用 `--force` 明确接手。

## 不用你操心的三件事

- **`settled`（人工封存）会自动继承。** 整片重写不会把人标的「这条定了」抹掉。反过来，
  这次显式写 `"settled": false` 就能让它重新亮起来 —— 政策改期时这么做。
- **变更事件自动产生。** `commit` 会 diff 上一片和这一片，新增 / 状态翻转 / 改期 /
  现状推进都会进变更流。不要自己写事件。
- **人工改过的状态不会被覆盖。** 人在页面上改的状态存在单独的覆盖层里，流程照常写
  自己的观测值；两者不一致时板上会把矛盾摆出来，而不是二选一。

## 排查

```
agentflow track list                      有哪些板，各自几条危 / 几片哑了
agentflow track show <板>                 条目、剩余天数、封存 / 过期 / 陈旧标记
agentflow track show <板> --json          原样看算出来的字段
agentflow track events <板> --limit=20    最近的变更
agentflow track rm <板> [--flow=<流程>]   删一块板，或只删一片
```

`show` 里 `[陈旧]` 意味着这一条已经超过预期更新间隔没被写过了 —— 流程还在跑，但这个
条目不在它的输出里了。`--stale-after-ms` 可以按自己的 cron 告诉 commit 该多久算陈旧。
