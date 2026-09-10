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
| 查看全员 | `GET /api/admin/wecom-bindings` |

## 绑定完必须真发一条

ID 对不对是一回事，人在不在这个应用（`WECOM_AGENT_ID`）的可见范围内是另一回事，
只有发出去才知道——线上那批 `81013` 里两种都有。

- `POST /api/me/wecom-binding/test`：给自己发；
- `POST /api/admin/wecom-bindings/test` + `{"userId":"..."}`：管理员替某人试发，
  不需要本人登录。

两个接口在失败时都会带上 `hint`，指明 81013 的两种可能。
