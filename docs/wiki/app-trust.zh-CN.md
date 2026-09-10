# 应用互信（Ed25519 签名）

## 为什么不是「互发私钥」

私钥一旦发给对方就不再是私钥：泄露时分不清是谁漏的，也无法证明某个请求确实出自对方。
两边各自生成密钥对、**只交换公钥**，各自用自己的私钥签名——任何一边被拖库，攻击者都
伪造不了另一边的请求。Node 内置 Ed25519，不引依赖。

同理，也不用「共享密钥 + Bearer」：明文密钥只要在一条日志、一次抓包、一个错误堆栈里
出现过就等于永久失守；签名泄露只损失那一次请求。

## 签什么

规范化串，不是只签 body：

```
agentflow-app-v1
<METHOD>
<path>
<sha256(body) 十六进制>
<timestamp 毫秒>
<nonce>
```

- 方法和路径进签名 → 合法请求不能被原样重放到别的接口；
- body 摘要进签名 → 内容改一个字节就验不过；
- 时间戳 ±5 分钟 + nonce 去重 → 抓到包也重放不了。

请求头：

```
x-agentflow-app:        <appId>
x-agentflow-timestamp:  <毫秒>
x-agentflow-nonce:      <16-64 位十六进制>
x-agentflow-signature:  <base64(ed25519 签名)>
```

nonce 只在**验签通过之后**才记，否则伪造请求可以刷爆 nonce 表，变成一条拒绝服务路径。
nonce 记忆窗口是时钟窗口的两倍，避免过期的 nonce 被重新接受。当前实现是进程内记忆，
多进程部署要换成共享存储。

## 密钥放在哪

`<dataRoot>/admin/app-trust.json`，文件权限 `0600`：

- `self`：本机密钥对。私钥**只**存在这个文件里——不进环境变量面板（那对管理员是明文
  可读的）、不进任何接口响应、不进日志；
- `peers.<appId>`：对方的公钥、允许的 scopes、会话 TTL、是否要求 privilege 绑定。

管理接口 `GET/POST/DELETE /api/admin/app-trust` 只回本机**公钥**和对端指纹。

## 换会话

```
POST /api/app/tokens/exchange     （签名请求）
Body: { "wecomUserId": "00320" }
→ 201 { token, tokenType, expiresAt, appId, userId, username, scopes }
```

服务端做四件事：验签 → 用企微 userid 反查 AgentFlow 用户 → 按该应用登记的 scopes 和
TTL 发会话 → 落审计。

两条身份约束：

1. 只认**已绑定**的企微 userid，查不到直接 404，不做模糊匹配；
2. 默认只认绑定来源为 `privilege` 的身份。`manual` 是管理员手填的，可能填错，不能当强
   身份使用（按应用可用 `requirePrivilegeBinding: false` 放开）。

会话的 `kind` 记成 `app:<appId>`，运行记录里一眼能看出这不是本人操作，而是哪个应用代劳。
每次换取都会写一条 `kind: "app-trust"` 的 ledger 事件。

## 失败信息

对外一律 `401 应用签名校验失败`，不区分「应用不存在 / 时钟偏了 / 签名不对 / 重放」——
那是免费的探测信道。具体原因只写日志。

## 部署

两端同机时，这组路由应当只监听 loopback，网关层不要暴露 `/api/app/*`。跨机部署必须走
HTTPS：签名保证的是**完整性和来源**，不是机密性。
