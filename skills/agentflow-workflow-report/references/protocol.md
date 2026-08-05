# AgentFlow Workflow Report 接入协议

## 目录

1. 接入边界
2. 认证、身份与权限
3. 数据区域模型
4. GET /api/workflows/state
5. POST /api/workflows/report
6. POST /api/workflow-artifacts/publish
7. 字段模型
8. 覆盖、合并与删除规则
9. 并发、幂等与错误码
10. 三个关键接入场景
11. prd-flow 参考映射
12. 验收清单

## 1. 接入边界

新接入只使用以下三个正式接口：

| 方法 | 路径 | 用途 | 是否修改 Workflow |
| --- | --- | --- | --- |
| `GET` | `/api/workflows/state` | 读取当前快照和资源 key 版本 | 否 |
| `POST` | `/api/workflows/report` | 上报全局信息、Action、普通产物、迭代归属和自定义区域 | 是 |
| `POST` | `/api/workflow-artifacts/publish` | 把本地 Markdown 内容发布成浏览器可访问的预览链接 | 是 |

`agentflow-workflow-report` 是接入规格；`workflow-report-client.mjs` 是可复用客户端；`agentflow-cli` 是命令行包装；AgentFlow 服务才负责鉴权、存储、合并和展示。Skill 不参与运行时传输，CLI 也不是数据生产方。

接入方负责采集业务系统事实并解释业务含义。例如 prd-flow 会读取 TAPD、ai-doc、GitLab 和 Jenkins；其他接入方可以读取完全不同的数据源。AgentFlow 不会替接入方修改这些上游系统。

当前服务端仅支持 `tapd` Workflow namespace。稳定身份为 `tapd:<short-id>`，标题、版本名或阶段名都不能作为 Workflow 身份。这是“当前身份适配器的边界”，不是 Workflow Report 数据模型只能描述 TAPD；其他 namespace 要先扩展服务端身份、协作和存储适配器，不能只改请求字符串。

## 2. 认证、身份与权限

### 2.1 认证

使用 Bearer Token：

```http
Authorization: Bearer <AGENTFLOW_TOKEN>
Content-Type: application/json
```

CLI 从 `AGENTFLOW_TOKEN` 或 `AGENTFLOW_SESSION_TOKEN` 读取凭证。不得把 Token 放入请求 JSON、Action、Artifact、日志或代码仓库。

### 2.2 权限

| 身份 | 读取 | 上报 / 发布预览 | 管理成员与分享 |
| --- | --- | --- | --- |
| Workflow owner | 是 | 是 | 是 |
| 显式 editor | 是 | 是 | 否 |
| 显式 viewer | 是 | 否 | 否 |
| owner 同团队成员 | 是，团队视图自动获得 viewer 权限 | 否 | 否 |
| 分享链接访问者 | 是 | 否 | 否 |
| 超级管理员代看 | 是 | 否，只读审阅 | 否 |

首次由已认证用户上报一个尚未登记的 TAPD ID 时，该用户成为这个 Workflow 的 owner。后续写入解析到 owner 的状态空间；没有写权限的调用返回 `403`，不会回退成调用者自己的副本。

## 3. 数据区域模型

Workflow 页面由三类数据区域组成：

### 3.1 全局区域

描述“这个需求现在是什么”：标题、状态、负责人、平台、当前分支、研发进度、版本原始事实等。

- 完整的生产方观察放在 `observation.state`。
- 可独立增量更新的生产方事实放在 `globalState`。
- 个人/团队迭代所需的版本、Sprint、里程碑归属放在 `projections.timeline`。

`globalState` 是生产方拥有的事实；`projections` 是可从事实重建的通用索引，不能反过来作为业务真相。

### 3.2 Action 时间轴

描述“关键阶段发生了什么”：方案确认、开始实现、MR 创建、提测、发布完成等。

- 阶段本身使用 `action`。
- MR、构建、测试报告、外部文档链接使用 `artifacts`。
- `action.key` 是稳定阶段身份；同一个 key 的重复上报更新同一阶段，而不是制造一条新业务阶段。

Action 是业务节点，不是运行日志。轮询、刷新、重试等技术动作不应各自创建 Action。

### 3.3 自定义区域

描述只有某个接入实现才理解的结构化面板，例如 prd-flow 的 AI Docs 和 Issues。

- 数据放入 `extensions["<producer-namespace>"]`。
- namespace 必须为小写稳定标识，例如 `prd-flow`。
- AgentFlow 对未知扩展按不透明 JSON 保存；只有注册了渲染器的 namespace 才会显示成专用面板。

AI Docs / Issues 不是通用固定字段。当前唯一注册的 extension renderer 是 `prd-flow`，它识别 AI Docs 链接列表和带父子层级、平台、MR 状态及关联链接的 Issues 树。其他 namespace 会被保存并参与 revision，但不会自动出现页面。

普通的负责人、平台、分支、风险列表和文档链接不需要 extension。优先使用下面的 `globalState.sections` 通用渲染器；只有现有组件无法表达的树形结构、复杂交互或专用业务面板，才定义新的 extension schema 和前端 renderer。

### 3.4 当前可直接使用的通用渲染器

| 页面组件 | 上报字段 | 展示样式 | 是否需要前端开发 |
| --- | --- | --- | --- |
| 需求概览 | `globalState.title/url/status` | 标题、外链和状态标签 | 否 |
| 自定义概览分区 | `globalState.sections` | 分区卡片与固定字段样式 | 否 |
| Action 时间轴 | `action` | 按日期分组的状态点、时间、标题、详情和维度标签 | 否 |
| Action 产物 | `artifacts[scope=action]` | Action 下的链接按钮 | 否 |
| 关联产物 | `artifacts[scope=global]` | 侧栏链接列表，展示标题和产物类型 | 否 |
| 迭代时间线 | `projections.timeline` | 版本/Sprint/里程碑时间线卡片与筛选 | 否 |
| prd-flow AI Docs / Issues | `extensions["prd-flow"]` | 文档链接列表、层级 Issue 卡片 | 已注册，仅供 prd-flow schema |
| 其他专用面板 | `extensions["<namespace>"]` | 由接入方设计 | 是，需要注册 schema、空态/错误态、响应式样式和 renderer |

`globalState.sections` schema：

```json
{
  "globalState": {
    "mode": "merge",
    "patch": {
      "title": "Remote Config 拉取频控",
      "url": "https://tapd.example.test/1020124",
      "status": "实现中",
      "sections": {
        "ownership": {
          "title": "归属信息",
          "fields": {
            "owner": {
              "label": "负责人",
              "type": "user",
              "value": { "username": "alice" }
            },
            "platforms": {
              "label": "平台",
              "type": "chips",
              "value": ["Android", "iOS"]
            },
            "branch": {
              "label": "需求分支",
              "type": "text",
              "value": "story/1020124"
            },
            "risks": {
              "label": "当前风险",
              "type": "list",
              "value": ["等待服务端字段确认", "灰度策略待补充"]
            },
            "design": {
              "label": "技术方案",
              "type": "link",
              "value": "打开方案文档",
              "url": "https://docs.example.test/1020124"
            }
          }
        }
      }
    }
  }
}
```

通用字段类型：

| `type` | `value` | 页面样式 |
| --- | --- | --- |
| `text` | 字符串、数字或可提取 label/name/value 的对象 | 普通文本，无胶囊背景 |
| `user` | 字符串或含 username/userId/name 的对象 | 负责人强调文本 |
| `chips` | 标量或数组 | 一个或多个标签胶囊 |
| `list` | 标量或数组 | 纵向项目符号列表 |
| `link` | 显示值，加 field 或 value 中的 `url/href` | 可点击文本和外链图标 |

section key 为 `progress` 时使用紧凑响应式网格；其他 section 默认纵向排列。空 value 不渲染，未知 type 回退为 `text`。

### 3.5 资源 key

并发冲突与所有权都落在稳定资源 key，而不是整份 JSON：

```text
action:<source>:<action.key>
artifact:<source>:<artifact.key>
projection:<source>:<kind>:<id>
global:<dot.path>
extension:<source>:<dot.path>
observation:<source>:<clientId>
```

同一请求可以触及多个 key。服务端在 Workflow 写锁内一次性校验全部 key；任意一个 key 冲突时整次请求不落库。`resourceKeys` 会随成功响应返回，便于接入方记录实际写入边界。

## 4. GET /api/workflows/state

读取当前物化快照。任何写入前都应先调用它，并保存本次会触及 key 对应的 `snapshot.resourceVersions`。

### 4.1 请求

```http
GET /api/workflows/state?workflow=tapd%3A1020124&runtimeOnly=1
Authorization: Bearer <AGENTFLOW_TOKEN>
```

| Query 参数 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `workflow` | string | 与 namespace/id 二选一 | 规范 key，例如 `tapd:1020124` |
| `namespace` | string | 与 workflow 二选一 | 当前仅支持 `tapd` |
| `id` | string | 与 workflow 二选一 | TAPD short ID |
| `runtimeOnly` | `0 \| 1` | 否 | `1` 只读取已保存运行态，不主动刷新上游；CLI 的 `--runtime-only` 使用它 |
| `flowId` | string | 否 | 关联 AgentFlow 项目时指定项目 ID |
| `flowSource` | string | 否 | 项目来源，默认 `user` |
| `workspaceId` | string | 否 | 项目工作区上下文 |
| `workflowShare` | string | 否 | 只读分享 token；不能用于写接口 |

### 4.2 成功响应

```json
{
  "ok": true,
  "workflow": { "namespace": "tapd", "id": "1020124", "key": "tapd:1020124" },
  "snapshot": {
    "runtimeRevision": "runtime:...",
    "resourceVersions": {
      "action:my-adapter:implementation:issue-1": "rv:...",
      "projection:my-adapter:version:android-123": "rv:..."
    },
    "globalState": {},
    "actions": [],
    "artifacts": [],
    "projections": { "timeline": [] },
    "extensions": {}
  }
}
```

`snapshot` 只由服务端返回。`runtimeRevision` 用于页面缓存和旧客户端的整 Workflow 严格锁；新接入使用 `resourceVersions` 做 key 级并发控制。客户端不得把一份旧 `snapshot` 原样 POST 回去。

## 5. POST /api/workflows/report

统一写入口。一次请求可以只更新一个区域，也可以原子地组合 Action、产物、全局事实、迭代归属和自定义区域。

### 5.1 请求 Envelope

```json
{
  "schemaVersion": 1,
  "workflow": { "namespace": "tapd", "id": "1020124" },
  "source": "my-adapter",
  "expectedVersions": {
    "action:my-adapter:implementation:android:issue-1": "rv:..."
  },
  "idempotencyKey": "implementation-finished:android:issue-1:v1",
  "observation": {},
  "action": {},
  "artifacts": [],
  "globalState": {},
  "projections": {},
  "extensions": {}
}
```

| 顶层字段 | 类型 | 必填 | 含义 / 写入区域 |
| --- | --- | --- | --- |
| `schemaVersion` | number | 否 | 当前固定为 `1` |
| `workflow` | object/string | 是 | `{namespace,id}` 或规范 key；当前 namespace 仅支持 `tapd` |
| `source` | string | 是 | 小写稳定的业务 Adapter 名称；`agentflow-cli` 只是传输工具，不能作为默认生产方身份 |
| `expectedVersions` | object | 修改已有资源时建议必填 | 本次触及的全部资源 key 及 GET 返回的版本；创建新 key 使用 `absent` |
| `expectedRevision` | string | 兼容字段 | 仅在没有 `expectedVersions` 时启用的整 Workflow 严格锁；新接入不要使用 |
| `idempotencyKey` | string | 强烈建议 | 一次业务语义操作的稳定身份，不使用时间戳或随机 UUID |
| `observation` | object | 条件必填 | 同一 `clientId` 的完整生产方观察 |
| `action` | object | 条件必填 | 一条关键业务阶段 |
| `artifacts` | array | 条件必填 | Action 证据或全局证据 |
| `globalState` | object | 条件必填 | 生产方事实的 merge patch / remove |
| `projections` | object | 条件必填 | 通用迭代索引；提交当前 source 的完整 `timeline` 切片 |
| `extensions` | object | 条件必填 | 按生产方 namespace 组织的自定义区域数据 |
| `flowId` | string | 否 | 关联项目 ID |
| `flowSource` | string | 否 | 关联项目来源，默认 `user` |

`observation`、`action`、`artifacts`、`globalState`、`projections`、`extensions` 至少出现一个。

### 5.2 成功响应

```json
{
  "ok": true,
  "alreadyApplied": false,
  "report": {},
  "resourceKeys": ["action:my-adapter:implementation:android:issue-1"],
  "event": {},
  "observation": { "accepted": true, "clientId": "my-adapter" },
  "snapshot": {
    "runtimeRevision": "runtime:new-revision",
    "resourceVersions": {
      "action:my-adapter:implementation:android:issue-1": "rv:new-resource-version"
    }
  }
}
```

没有 `observation` 时，响应中的 `observation` 为 `null`。同一 `workflow + source + operation + idempotencyKey` 的幂等重放返回 `alreadyApplied: true`，应按成功处理；Report 与 Artifact Publish 使用独立操作域。

## 6. POST /api/workflow-artifacts/publish：发布 Markdown 预览

把客户端本地 Markdown 内容保存成可访问的运行态副本，并返回预览链接。服务端不能读取客户端文件路径，所以必须发送 `markdown` 内容。

### 6.1 请求

```json
{
  "workflow": { "namespace": "tapd", "id": "1020124" },
  "source": "my-adapter",
  "title": "Issue1 · Android 方案草稿",
  "markdown": "# 方案内容\n...",
  "stage": "issue-plan:runtime-hook",
  "issueKey": "runtime-hook",
  "platform": "android",
  "artifactKey": "plan:runtime-hook:android",
  "artifactLabel": "方案预览",
  "durability": "temporary",
  "ttlDays": 7,
  "expectedVersions": { "artifact:my-adapter:plan:runtime-hook:android": "absent" },
  "idempotencyKey": "review:plan:runtime-hook:android:<content-digest>"
}
```

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `workflow` | object/string | 是 | 目标 Workflow |
| `source` | string | 是 | 真实业务 Adapter 的稳定名称；不是 `agentflow-cli` |
| `title` | string | 是 | Review 页面标题 |
| `markdown` | string | 是 | Markdown 实际内容，不是本地路径 |
| `stage` / `stageKey` | string | 建议 | 关联的稳定 Action 阶段 |
| `issueKey` | string | 否 | 自定义 Issue 身份 |
| `platform` | string | 否 | 平台维度 |
| `artifactKey` | string | 是 | 预览 Artifact 的稳定槽位 |
| `artifactLabel` | string | 否 | 页面按钮文案，默认 `Markdown Review` |
| `durability` | string | 否 | `temporary` 或 `durable`；默认临时 |
| `ttlDays` | number | 临时预览建议 | 1–30 的整数，通常为 7 |
| `expectedVersions` | object | 修改已有 Artifact 时建议必填 | 只需包含目标 `artifact:source:key`；创建时使用 `absent` |
| `expectedRevision` | string | 兼容字段 | 仅在没有 `expectedVersions` 时使用整 Workflow 严格锁 |
| `idempotencyKey` | string | 强烈建议 | 建议包含内容摘要；同一 source + key 重放返回同一个预览，不创建新副本 |

### 6.2 成功响应

响应包含：

- `artifact`：可挂到页面的标准 Artifact。
- `review.url`：规范预览 URL。
- `review.shortUrl`：通常可直接分享的 `/r/<code>` 短链。
- `event`：辅助运行态事件，不推进业务阶段。
- `snapshot`：发布后的最新 Workflow 快照。

发布预览不会确认方案、修改本地文件、提交 ai-doc、创建 GitLab Issue 或推进 Action。Markdown 最大 500,000 bytes；`durability` 只能是 `temporary/durable`。外部系统已经提供 HTTP URL 时，不需要调用本接口，直接在 `/api/workflows/report` 的 `artifacts` 中上报即可。

## 7. 字段模型

### 7.1 observation：完整生产方观察

```json
{
  "schema": "my-adapter/v1",
  "clientId": "my-adapter-main",
  "observedAt": "2026-08-05T10:00:00.000Z",
  "scope": "client",
  "state": { "phase": "implementing", "pointer": "Android 实现中" }
}
```

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `schema` | 否 | 生产方状态 schema，默认 `workflow-observation/v1` |
| `clientId` | 建议 | 观察来源稳定身份；同一 clientId 的新观察替换旧观察 |
| `observedAt` | 建议 | ISO 时间 |
| `scope` | 否 | 默认 `client` |
| `state` | 是 | 完整观察对象，不是 patch |

### 7.2 action：Action 时间轴节点

```json
{
  "key": "implementation:runtime-hook:android",
  "title": "Android 实现完成",
  "detail": "MR !957 已合并",
  "status": "done",
  "group": "implementation",
  "scope": "runtime-hook",
  "platform": "android",
  "issueKey": "runtime-hook",
  "tags": ["client"],
  "occurredAt": "2026-08-05T08:00:00.000Z"
}
```

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `key` | 是 | 稳定阶段身份；同 key 更新同一阶段 |
| `title` | 否 | 卡片标题，默认 key |
| `detail` | 否 | 阶段摘要，最多 4,000 字符；超限返回 `400`，不会截断 |
| `status` | 否 | `pending/running/done/error/conflict/skipped/cancelled/observed` |
| `group` | 否 | 阶段分组，例如 `implementation` |
| `scope` | 否 | 业务范围 |
| `platform` | 否 | 平台维度 |
| `issueKey` | 否 | 自定义 Issue 身份 |
| `tags` | 否 | 字符串数组 |
| `occurredAt` | 否 | 业务发生时间；不要用重试时间覆盖它 |

`completed/success` 会规范化为 `done`，`failed` 会规范化为 `error`；未知状态返回 `400`，不会静默回退。

### 7.3 artifacts：Action 或全局证据

```json
{
  "key": "implementation-mr:runtime-hook:android",
  "type": "gitlab-mr",
  "title": "实现 MR !957",
  "url": "https://git.example.test/merge_requests/957",
  "scope": "action",
  "status": "ready"
}
```

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `key` | 强烈建议 | 稳定证据身份；不要依赖标题去重 |
| `type` | 否 | 产物类型，默认 `artifact` |
| `title` | 否 | 展示标题 |
| `url` / `path` | 至少一个 | URL 只允许 `http/https` 或站内绝对路径；本地文件必须先 Publish，不能直接形成可访问链接 |
| `scope` | 否 | `action` 或 `global`；有 Action 时默认 `action` |
| `status` | 否 | 生产方定义的证据状态 |

### 7.4 globalState：全局事实 patch

```json
{
  "mode": "merge",
  "patch": { "myProducer": { "owner": "alice", "platforms": ["android"] } },
  "remove": ["myProducer.obsoleteField"]
}
```

`mode` 当前只能是 `merge`。`patch` 与 `remove` 至少有一个。

### 7.5 projections.timeline：迭代归属

```json
{
  "timeline": [{
    "kind": "version",
    "id": "android:1133202860001000338",
    "key": "my-adapter:version:android:1133202860001000338",
    "title": "Likee Android 5.63.0",
    "date": "2026-08-31",
    "source": "my-adapter",
    "dimensions": { "platform": "android" },
    "order": 0
  }]
}
```

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `kind` | 是 | `version`、`sprint`、`milestone` 等通用类型 |
| `id` | 是 | 生产方稳定身份；改名、改期时保持不变 |
| `key` | 否但建议 | 聚合身份；缺省时由 `source + kind + id` 推导 |
| `title` | 否 | 展示标题，默认 id |
| `date` | 否 | ISO 兼容日期，用于时间线排序 |
| `source` | 否 | 生产方 namespace |
| `dimensions` | 否 | 不透明筛选维度，例如 platform/team |
| `order` | 否 | 日期缺失或相同时的稳定顺序 |

每个 source 最多上报 100 条合法 timeline 项；超过限制返回错误，不会截断。

### 7.6 extensions：自定义区域

```json
{
  "prd-flow": {
    "aiDocs": [{ "key": "tech-design", "title": "技术方案", "url": "https://..." }],
    "issues": [{ "key": "runtime-hook", "title": "Runtime Hook", "platform": "android" }]
  }
}
```

扩展字段由生产方 schema 定义。一次请求只能更新 `extensions[source]`；AgentFlow 通用协议不解释 `aiDocs`、`issues` 等私有字段。

## 8. 覆盖、合并与删除规则

| 区域 | 省略字段 | 重复上报 | 删除 / 清空 |
| --- | --- | --- | --- |
| `observation.state` | 保持旧观察 | 同一 `clientId` 的完整 state 替换旧观察 | 上报生产方定义的空值结构；不要用它删除其他 client 的观察 |
| `globalState` | 不修改 | 对象递归 merge；数组和标量整体替换；首次写入路径的 source 获得该路径所有权 | patch 中 `null` 删除字段；`remove` 在 patch 后删除 dot path；其他 source 不能改写已归属路径 |
| `action` | 不修改 Action | 同 `source + action.key` 更新同一业务阶段的可见状态 | 当前协议不提供物理删除 Action；用业务状态表达取消/跳过 |
| `artifacts` | 不修改产物 | 同 `source + stable key` 更新/归并同一可见证据 | 当前协议不提供通用物理删除；不要通过改 key 伪造删除 |
| `projections.timeline` | 不修改 | 替换当前 `source` 拥有的完整切片，服务端原子保留其他 source | `[]` 只清空当前 source 的迭代归属 |
| `extensions` | 不修改扩展 | 只允许 `extensions[source]` 内对象递归 merge；数组/标量替换 | 对应字段上报 `null` 删除 |

客户端可以在兼容 payload 中携带未修改的其他 source 条目，但服务端只接受完全一致的副本且不会使用它覆盖现状。推荐只发送当前 source 的完整切片，由服务端按 `source + kind + id` 合并。

## 9. 并发、幂等与错误码

### 9.1 安全写入顺序

1. GET 当前 Workflow。
2. 根据本次业务操作计算会触及的 `resourceKeys`。
3. 从 `snapshot.resourceVersions` 复制这些 key 的版本；不存在的 key 使用 `absent`。
4. POST 时带稳定 `source`、完整的 `expectedVersions` 与 `idempotencyKey`。
5. 服务端在同一 Workflow 写锁内原子执行“校验所有 key → 合并 → 落盘”；无关 key 的变化不会冲突。
6. 收到 `409` 后只刷新 `conflict.conflicts` 列出的 key，重新计算并重试一次。

不得在资源 key 冲突后原样重放旧 payload。

### 9.2 幂等键

幂等键标识业务操作，不标识 HTTP 尝试：

```text
<operation>:<scope>:<entity>:<semantic-version>
```

例如：

```text
implementation-finished:android:runtime-hook:v1
timeline-membership:tapd-1020124:android-version-1133202860001000338:v1
```

同一 `workflow + source + operation + idempotencyKey` 的重放返回 `alreadyApplied: true`，包括 `running/error/pending` Action。`report` 与 `artifact.publish` 可以安全复用同一业务 key。Publish 会返回第一次创建的预览，不会先生成一个新文件再去重。业务内容发生变化时提高语义版本或使用内容摘要；不要使用请求时间。

### 9.3 错误码

| HTTP | 含义 | 处理方式 |
| --- | --- | --- |
| `400` | JSON、namespace、字段或 schema 不合法 | 按协议修正；不要降级校验 |
| `401` | 缺少或无效认证 | 停止并配置 Token；不要把 Token 打印出来 |
| `403` | 当前用户只有 viewer 权限或无权访问目标项目 | 停止；由 owner 授予 editor 或改用正确身份 |
| `404` | 分享链接、owner 或目标资源不存在 | 重新解析目标，不要创建影子副本 |
| `409` | 同一资源 key 已变化，或路径属于其他 source | 读取 `conflict.conflicts`，只刷新冲突资源并重试一次；所有 key 通过前请求不会部分落库 |
| `500` | 服务端异常 | 保留幂等键，记录脱敏上下文后重试或上报 |

## 10. 三个关键接入场景

### 10.1 更新迭代：绑定或切换版本

1. 从业务系统取得稳定版本 ID、标题、日期和平台。
2. GET 当前 Workflow，并读取对应 GlobalState 路径与 Projection key 的资源版本。
3. 用 `globalState.patch` 保存生产方拥有的完整版本事实。
4. 发送当前 source 的完整 `kind=version` 切片；服务端保留其他 source 的 Sprint/Version。
5. 使用这些 key 的 `expectedVersions` 上报。

版本改名或改期时保持 `id/key` 不变，只改 `title/date`；切换版本时移除旧自有 key、加入新 key；取消归属时只移除自己的版本条目。

### 10.2 上报 Action 与产物链接

1. 先完成真实业务动作，例如创建 MR 或完成构建。
2. 使用稳定 `action.key` 上报阶段结果。
3. 已有 HTTP URL 的 MR、构建、测试报告直接放入同一 Report 的 `artifacts`。
4. 本地 Markdown 先调用 Artifact Publish，取得 URL 后再作为阶段证据使用。
5. 重复刷新同一阶段继续使用原 key；不要每次新建 Action。

### 10.3 上报自定义区域

1. 先判断 `globalState.sections` 的 `text/user/chips/list/link` 是否足够；足够时直接使用通用渲染器。
2. 只有通用组件不能表达时，才定义稳定 namespace 和版本化扩展 schema。
3. 把专用结构化事实放入 `extensions[namespace]`。
4. 在 AgentFlow 前端代码中注册对应页面渲染器并重新发布；当前不是运行时插件注册。否则数据只会被保存，不会自动出现专用 UI。当前只有 `extensions["prd-flow"]` 已注册。
5. 更新数组时发送该数组的完整新值；更新对象字段时可以递归 merge；用 `null` 删除自有字段。

## 11. prd-flow 参考映射

prd-flow 只是一个接入实现，不是协议依赖：

| prd-flow 事实 | 通用协议位置 | 页面结果 |
| --- | --- | --- |
| TAPD short ID | `workflow = tapd:<id>` | 串起同一需求、权限和分享 |
| 计算出的完整当前状态 | `observation.state` | Workflow 全局概览和当前指针 |
| TAPD 当前版本原始信息 | `globalState.tapdCurrentVersion` | 保留版本业务事实 |
| 由版本事实派生的归属 | `projections.timeline[kind=version]` | 个人/团队迭代时间线 |
| 方案确认、实现、提测、发布 | `action` | Action 时间轴和进度 |
| MR、Jenkins、测试报告 URL | `artifacts` | Action 下产物入口 |
| 本地方案 Markdown | Artifact Publish | 可分享方案预览 URL |
| AI Docs / Issues | `extensions["prd-flow"]` | prd-flow 专用文档区和 Issue 区 |

旧的 `/api/prd-workflow/snapshot`、`/api/prd-workflow/event`、`/api/prd-workflow/review-link` 仅供旧客户端迁移，返回弃用提示。新接入不得使用。

## 12. 验收清单

- 能使用 Token GET 当前 Workflow，并读到 `snapshot.resourceVersions`。
- 首次写入能建立 owner；editor 能写，viewer、团队成员、分享链接和管理员代看不能写。
- `globalState` 更新不会覆盖其他生产方拥有的路径，数组替换行为符合预期。
- 同一 Action key 重报不产生重复业务阶段。
- Action 下能看到稳定 key 的 MR、构建或测试产物。
- Markdown Publish 返回可访问 URL，但不会推进业务状态。
- 版本改名/改期不产生新迭代节点，版本切换不会删除第三方 Sprint。
- 自定义 extension 能保存；注册渲染器后能显示对应文档区 / Issue 区。
- 不同资源 key 可并发更新；同 key 旧版本返回包含具体 `resourceKey` 的 409。
- 409 会触发一次 key 级 read → re-merge → retry，且失败请求不会部分落库。
- 幂等重放返回成功且不重复应用。
- Token 不出现在 JSON、日志、Artifact 或最终输出中。
