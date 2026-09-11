# 企微收件人绑定

## 为什么需要它

企微投递认的是 userid（`00320` 这种工号式 ID），AgentFlow 认的是登录名（`wangfang1`）。
两者不是一回事，填错就是 `errcode 81013 user & party & tag all invalid`——线上有多条
每日定时就是这样连续失败的，而且失败本身也没人通知。

换算内网早就有：Privilege 用户中心按 `user_name` 查得到 openid，marketplace 的
`my_wecom_id` 节点就是这么做的。问题是它停在节点层——每个人在自己的流程里拼一遍，
平台不留结果，于是"当前用户的企微是谁"这个问题，每条流程都要重新解一次：

- 有人调 Privilege 自己解；
- 有人做了「绑定当前企微收件人」节点，指望运行时给 `WECOM_TO_USER`，而平台从不注入，
  这个节点必然抛错；
- 有人干脆手填一个名字，填错了就天天失败。

## 现在的口径

平台查一次、存下来、运行时统一注入。

```
登录名 → casUsername → GET privileges.bigo.sg/api/getUserList?disabled=0&user_name=<name>
      → data[] 精确匹配 user_name/name（匹配不到退回第一条）→ openid
      → users.json 的 notify.wecomUserId（带 wecomUserIdSource / wecomUserIdVerifiedAt）
```

凭据取全局环境变量 `PRIVILEGE_ACCOUNT` / `PRIVILEGE_PASSWORD`，可用
`PRIVILEGE_URL` / `PRIVILEGE_USER_API` 覆盖地址。查过即缓存，不会每次都打 Privilege。

绑定写在**用户记录**上，不是环境变量：环境变量是"这条流程要发给谁"，绑定是"这个人是谁"。

## 运行时注入

`runtimeEnvForUser` 会给每次节点执行补上 `WECOM_TO_USER` 和 `AGENTFLOW_WECOM_USER_ID`，
位置在用户自己的 env **之前**：

- 流程不用再各自去查，「绑定当前企微收件人」这类节点直接可用；
- 要发给别人时，用户自己配的 `WECOM_TO_USER` 仍然盖得住平台默认值；
- `AGENTFLOW_USER_ID` 依旧在最后，用户改不掉。

## 绑定时机

| 时机 | 入口 |
| --- | --- |
| CAS 登录 | 登录成功后异步解析一次，失败只记日志，不挡登录 |
| 用户自助 | `GET/POST /api/me/wecom-binding`，POST 传 `wecomUserId` 即手工指定 |
| 管理员批量 | `POST /api/admin/wecom-bindings`，历史 linked 账号自动跳过 |
| 管理员手工 | `POST /api/admin/wecom-bindings` + `{"userId":"...","wecomUserId":"..."}` |
| 查看全员 | `GET /api/admin/wecom-bindings` |

## 绑定完必须真发一条

ID 对不对是一回事，人在不在这个应用（`WECOM_AGENT_ID`）的可见范围内是另一回事，
只有发出去才知道——线上那批 `81013` 里两种都有。

- `POST /api/me/wecom-binding/test`：给自己发；
- `POST /api/admin/wecom-bindings/test` + `{"userId":"..."}`：管理员替某人试发，
  不需要本人登录。

两个接口在失败时都会带上 `hint`，指明 81013 的两种可能。

## 查不到的账号

Privilege 按内网用户名查，查询名是 `casUsername` 优先、没有才退回 AgentFlow `userId`。
早期密码账号的 `casUsername` 为空，登录名又未必等于内网用户名，就会查不到——线上
46 个账号里有 3 个真人属于这种（他们的定时因此一直投递失败）。

两条路：

1. **改用 CAS 登录**（推荐）：登录会写入 `casUsername` 并当场绑定，之后每次登录都校准；
   登录名与老账号不同的，走一次老账号关联把项目带过去。
2. **管理员手工绑**：`POST /api/admin/wecom-bindings` 传 `{userId, wecomUserId}`，
   记为 `source: "manual"`。查不到的当天就能先把投递恢复。

普通用户密码登录已停用（`/api/auth/login` 返回 410），所以自动绑定只需要挂在 CAS 分支。

## 定时失败通知

绑定的第一个用处：定时任务坏了，直接私聊负责人。

在这之前，一条定时坏掉的唯一痕迹是登记表里的 `lastStatus` / `lastError`，没人主动去看就
没人知道——线上真发生过一条每半小时跑一次的流程连炸两天、失败 126 次无人察觉。

### 降噪规则

难点不是发消息，是不把人烦到静音：一条每半小时跑一次的流程一天能失败 48 次。

| 情况 | 行为 |
| --- | --- |
| 状态从「好」变「坏」 | 发一条 |
| 一直坏着 | 每 24 小时最多再补一条，正文标注「持续失败中」 |
| 恢复 | 发一条。这条比失败通知更重要——让人知道问题结束了，不用去猜 |
| `stopped` / `skipped` / `disabled` | 不是坏了，不打扰 |

通知状态存在登记表条目的 `alert` 字段里。**投递失败也照样推进状态**，否则一条发不出去的
通知会在每次运行时重试，把降噪整个绕过去。

### 收件人

依次尝试，第一个能投递的就用：

1. **这条定时的 owner** —— 他绑定的企业微信 userid；
2. **兜底账号** —— `AGENTFLOW_SCHEDULE_ALERT_FALLBACK_USER` 指定的 AgentFlow 用户名
   （不是企微 id：填用户名才能复用绑定表，换人时也不用去查工号）。转发出去的消息会写明
   「原负责人是谁、他为什么没收到」，否则收件人无从判断这条跟自己什么关系；
3. **运维群** —— `AGENTFLOW_SCHEDULE_ALERT_WEBHOOK` 配置的群机器人；
4. 都没有就跳过，并记一行日志说明是谁没绑。

**没人可通知时不推进通知状态**，等这个人绑定之后，下一次失败会从头提醒一次。

### 在哪配

这几个都是全局环境变量，管理员在 **设置 → 环境变量** 页直接填即可，不用改配置文件：

| 键 | 作用 |
| --- | --- |
| `AGENTFLOW_SCHEDULE_ALERT_FALLBACK_USER` | 兜底收件人的 AgentFlow 用户名 |
| `AGENTFLOW_SCHEDULE_ALERT_WEBHOOK` | 运维群机器人 webhook（可选） |
| `AGENTFLOW_PUBLIC_BASE_URL` | 通知里回跳链接的站点地址，没配就不带链接 |
| `AGENTFLOW_SCHEDULE_ALERTS` | 填 `off` 全局关闭，默认开启 |

通知链路不会影响运行本身：发送异常一律吞掉只记日志。
