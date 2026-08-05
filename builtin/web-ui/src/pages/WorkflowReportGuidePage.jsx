import { useCallback, useEffect, useState } from "react";
import { useRoute } from "../routeContext.jsx";
import "./WorkflowReportGuidePage.css";

const INSTALL_COMMANDS = `skillhub install agentflow-cli --global --agent codex
skillhub install agentflow-workflow-report --global --agent codex

export AGENTFLOW_BASE_URL=http://ai.mengma.bigo.inner
export AGENTFLOW_TOKEN=<your-token>

# 本地联调
# export AGENTFLOW_BASE_URL=http://127.0.0.1:8765`;

const QUICKSTART_REPORT = `{
  "schemaVersion": 1,
  "workflow": { "namespace": "tapd", "id": "1020124" },
  "source": "my-adapter",
  "action": {
    "key": "requirement-imported",
    "title": "需求已同步",
    "status": "done",
    "occurredAt": "2026-08-05T08:00:00.000Z"
  },
  "expectedVersions": {
    "action:my-adapter:requirement-imported": "absent"
  },
  "idempotencyKey": "requirement-imported:1020124:v1"
}`;

const QUICKSTART_COMMANDS = `# 1. 读取；记录本次要修改 key 的 snapshot.resourceVersions
node skills/agentflow-cli/scripts/agentflow-cli.mjs workflow-get \\
  --workflow tapd:1020124 --runtime-only

# 2. 将右侧 JSON 保存为 workflow-report.json 后上报
node skills/agentflow-cli/scripts/agentflow-cli.mjs workflow-report \\
  --workflow tapd:1020124 \\
  --file workflow-report.json

# 3. 再读一次，确认 action 和对应 resourceVersions 已更新
node skills/agentflow-cli/scripts/agentflow-cli.mjs workflow-get \\
  --workflow tapd:1020124 --runtime-only`;

const READ_REQUEST = `GET /api/workflows/state?workflow=tapd%3A1020124&runtimeOnly=1
Authorization: Bearer <AGENTFLOW_TOKEN>`;

const READ_RESPONSE = `{
  "ok": true,
  "workflow": {
    "namespace": "tapd",
    "id": "1020124",
    "key": "tapd:1020124"
  },
  "snapshot": {
    "runtimeRevision": "runtime:<current-revision>",
    "resourceVersions": {
      "action:my-adapter:requirement-imported": "rv:<resource-version>"
    },
    "globalState": {},
    "actions": [],
    "artifacts": [],
    "projections": { "timeline": [] },
    "extensions": {}
  }
}`;

const ACCESS_SYNC_REQUEST = `{
  "workflow": { "namespace": "tapd", "id": "1020124" },
  "authority": {
    "type": "tapd",
    "owner": { "username": "alice" },
    "participants": ["alice", "bob", "carol"],
    "observedAt": "2026-08-05T08:00:00.000Z",
    "revision": "tapd-story-modified-at-or-content-digest"
  }
}`;

const VERSION_REPORT = `{
  "schemaVersion": 1,
  "workflow": { "namespace": "tapd", "id": "1020124" },
  "source": "prd-flow",
  "globalState": {
    "mode": "merge",
    "patch": {
      "tapdCurrentVersion": {
        "id": "1133202860001000338",
        "name": "Likee Android 5.63.0",
        "date": "2026-08-31",
        "platform": "android"
      }
    }
  },
  "projections": {
    "timeline": [
      {
        "kind": "version",
        "id": "android:1133202860001000338",
        "key": "prd-flow:version:android:1133202860001000338",
        "title": "Likee Android 5.63.0",
        "date": "2026-08-31",
        "source": "prd-flow",
        "dimensions": { "platform": "android" }
      }
    ]
  },
  "expectedVersions": {
    "global:tapdCurrentVersion.id": "rv:<version-from-get-or-absent>",
    "global:tapdCurrentVersion.name": "rv:<version-from-get-or-absent>",
    "global:tapdCurrentVersion.date": "rv:<version-from-get-or-absent>",
    "global:tapdCurrentVersion.platform": "rv:<version-from-get-or-absent>",
    "projection:prd-flow:version:android:1133202860001000338": "absent"
  },
  "idempotencyKey": "timeline:1020124:android-version-1133202860001000338:v1"
}`;

const ACTION_REPORT = `{
  "schemaVersion": 1,
  "workflow": { "namespace": "tapd", "id": "1020124" },
  "source": "prd-flow",
  "action": {
    "key": "implementation:runtime-hook:android",
    "title": "Android 实现完成",
    "detail": "MR !957 已合并",
    "status": "done",
    "group": "implementation",
    "platform": "android",
    "issueKey": "runtime-hook",
    "occurredAt": "2026-08-05T08:25:00.000Z"
  },
  "artifacts": [{
    "key": "implementation-mr:runtime-hook:android",
    "type": "gitlab-mr",
    "title": "实现 MR !957",
    "url": "https://git.example.test/merge_requests/957",
    "scope": "action",
    "status": "ready"
  }],
  "expectedVersions": {
    "action:prd-flow:implementation:runtime-hook:android": "absent",
    "artifact:prd-flow:implementation-mr:runtime-hook:android": "absent"
  },
  "idempotencyKey": "implementation-finished:android:runtime-hook:v1"
}`;

const EXTENSION_REPORT = `{
  "schemaVersion": 1,
  "workflow": { "namespace": "tapd", "id": "1020124" },
  "source": "prd-flow",
  "extensions": {
    "prd-flow": {
      "aiDocs": [{
        "key": "tech-design",
        "title": "技术方案",
        "url": "https://ai-doc.example.test/docs/123"
      }],
      "issues": [{
        "key": "runtime-hook",
        "title": "Runtime Hook",
        "platform": "android",
        "status": "implementing"
      }]
    }
  },
  "expectedVersions": {
    "extension:prd-flow:aiDocs": "rv:<version-from-get-or-absent>",
    "extension:prd-flow:issues": "rv:<version-from-get-or-absent>"
  },
  "idempotencyKey": "prd-panels:1020124:<semantic-digest>"
}`;

const GENERIC_SECTION_REPORT = `{
  "workflow": { "namespace": "tapd", "id": "1020124" },
  "source": "my-adapter",
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
}`;

const PUBLISH_REQUEST = `POST /api/workflow-artifacts/publish
Authorization: Bearer <AGENTFLOW_TOKEN>
Content-Type: application/json

{
  "workflow": { "namespace": "tapd", "id": "1020124" },
  "source": "prd-flow",
  "title": "Issue1 · Android 方案草稿",
  "markdown": "# 方案内容\\n...",
  "stage": "issue-plan:runtime-hook",
  "issueKey": "runtime-hook",
  "platform": "android",
  "artifactKey": "plan:runtime-hook:android",
  "artifactLabel": "方案预览",
  "durability": "temporary",
  "ttlDays": 7,
  "expectedVersions": {
    "artifact:prd-flow:plan:runtime-hook:android": "absent"
  },
  "idempotencyKey": "review:plan:runtime-hook:android:<content-digest>"
}`;

const AI_GUIDE = `请使用 $agentflow-workflow-report 接入一个生产方，并完整阅读 references/protocol.md。

运行态数据只有三个正式接口，TAPD 人员权限另有一个控制面接口：
0. POST /api/workflows/access/sync：把 TAPD Owner 和参与人同步为 Workflow 派生权限；它不写业务状态。
1. GET /api/workflows/state：读取当前状态和 snapshot.resourceVersions。
2. POST /api/workflows/report：写全局信息、Action、普通产物、迭代投影或自定义区域。
3. POST /api/workflow-artifacts/publish：把本地 Markdown 内容发布成预览 URL。

先输出接入映射表：
- 稳定 Workflow 身份是什么；当前服务支持 tapd:<short-id>。
- 哪些事实进入 observation.state / globalState。
- 哪些关键业务节点进入 action；每个稳定 action.key 是什么。
- 哪些外部链接进入 artifacts；哪些本地 Markdown 需要先 publish。
- 哪些版本/Sprint/里程碑进入 projections.timeline。
- 普通自定义信息是否可用 globalState.sections 的 text/user/chips/list/link 渲染器表达。
- 只有通用渲染器不够时，才设计 extensions namespace/schema/前端渲染器。

实现 access sync → read → merge → report → verify：
- TAPD Owner 映射为 Workflow Owner；TAPD 参与人默认 Viewer；Owner 可在 AgentFlow 中显式授予 Reporter。
- owner/reporter 才能写；viewer、团队成员、分享链接、管理员代看只读。
- globalState 只 patch 自己拥有的路径；对象递归合并，数组/标量替换。
- source 使用真实业务 Adapter 的稳定小写名称；agentflow-cli 只是传输工具。
- 同一 source + action.key 更新同一阶段，不为刷新或重试创建新 key。
- timeline 只提交当前 source 的完整切片；服务端原子保留其他生产方条目。
- globalState.sections 是当前通用自定义卡片能力；优先使用现有 field type。
- extensions 只写自己的 namespace；当前仅 prd-flow 注册了 AI Docs / Issues 专用 renderer，保存其他 namespace 不会自动出现 UI。
- 为本次触及的每个业务 key 携带 expectedVersions 与稳定 idempotencyKey；任一 key 冲突时整次请求不落库，刷新冲突 key 后只重试一次。
- 不输出 Token，不新增生产方专用写接口，不使用 /api/prd-workflow/* 兼容接口。

最后验证 Workflow 全局区域、Action 时间轴、产物链接、个人/团队迭代和自定义区域。`;

const ENDPOINTS = [
  {
    method: "POST",
    path: "/api/workflows/access/sync",
    title: "同步 TAPD 权限",
    detail: "把 TAPD Owner 和参与人投影为 Workflow 派生权限；不传业务状态。",
    permission: "首次为 TAPD Owner；后续为当前 Owner / 管理员",
    effect: "更新 Owner 与 TAPD Viewer，保留显式授权",
  },
  {
    method: "GET",
    path: "/api/workflows/state",
    title: "读取当前 Workflow",
    detail: "取得服务端物化快照与每个业务 key 的 resourceVersions；安全写入的第一步。",
    permission: "可访问该 Workflow 的用户可读",
    effect: "只读，不修改任何状态",
  },
  {
    method: "POST",
    path: "/api/workflows/report",
    title: "统一上报",
    detail: "写入全局信息、Action、普通产物、迭代归属和自定义区域。",
    permission: "owner / reporter",
    effect: "按区域执行替换、合并或更新",
  },
  {
    method: "POST",
    path: "/api/workflow-artifacts/publish",
    title: "发布 Markdown 预览",
    detail: "上传 Markdown 内容，生成可供浏览器查看的规范 URL 与短链。",
    permission: "owner / reporter",
    effect: "保存预览副本与辅助 Artifact，不推进阶段",
  },
];

const STATE_QUERY_FIELDS = [
  ["workflow", "string", "二选一", "规范 Workflow key，例如 tapd:1020124"],
  ["namespace + id", "string", "二选一", "拆分传入身份；当前 namespace 仅支持 tapd"],
  ["runtimeOnly", "0 | 1", "否", "1 只读已保存运行态，不主动刷新上游"],
  ["flowId / flowSource", "string", "否", "关联 AgentFlow 项目上下文；flowSource 默认 user"],
  ["workspaceId", "string", "否", "关联项目的工作区上下文"],
  ["workflowShare", "string", "否", "只读分享 token，不能用于写接口"],
];

const STATE_RESPONSE_FIELDS = [
  ["workflow", "object", "规范身份 {namespace,id,key}"],
  ["snapshot.resourceVersions", "object", "业务 key 到并发版本的映射；新接入按本次触及 key 取值"],
  ["snapshot.runtimeRevision", "string", "整份运行态版本；页面缓存与旧客户端兼容使用"],
  ["snapshot.globalState", "object", "服务端合并后的全局区域"],
  ["snapshot.actions", "array", "已物化的 Action 时间轴"],
  ["snapshot.artifacts", "array", "已物化的全局产物"],
  ["snapshot.projections.timeline", "array", "当前完整迭代归属"],
  ["snapshot.extensions", "object", "所有已保存的 namespace 数据"],
];

const REPORT_FIELDS = [
  ["schemaVersion", "number", "否", "当前固定为 1"],
  ["workflow", "object | string", "是", "{namespace,id} 或规范 key"],
  ["source", "string", "是", "真实业务 Adapter 的稳定小写名称；agentflow-cli 仅负责传输"],
  ["expectedVersions", "object", "生产建议", "本次触及的每个 resource key 及读取时版本；新建 key 使用 absent"],
  ["expectedRevision", "string", "兼容", "仅未提供 expectedVersions 时启用的整 Workflow 锁"],
  ["idempotencyKey", "string", "建议", "业务操作稳定身份，不使用时间戳或随机 UUID"],
  ["observation", "object", "条件", "同一 clientId 的完整生产方观察"],
  ["globalState", "object", "条件", "全局事实的 merge patch 与 remove"],
  ["action", "object", "条件", "一个关键业务阶段；key 必填"],
  ["artifacts", "array", "条件", "Action 证据或全局证据"],
  ["projections", "object", "条件", "当前 source 的完整 timeline 迭代归属切片"],
  ["extensions", "object", "条件", "按生产方 namespace 组织的自定义区域"],
];

const ACCESS_SYNC_FIELDS = [
  ["workflow", "object | string", "是", "规范 Workflow 身份；当前仅 tapd:<short-id>"],
  ["authority.type", "string", "是", "当前固定为 tapd；表示权限事实来源，不是 report source"],
  ["authority.owner", "string | object", "是", "TAPD 需求 Owner 的 AgentFlow username/userId；必须已登录或注册"],
  ["authority.participants", "array", "否", "TAPD 参与人用户名；匹配到账号后自动获得 Viewer"],
  ["authority.observedAt", "ISO date", "建议", "读取 TAPD 人员快照的时间；旧于已保存快照时返回 409"],
  ["authority.revision", "string", "建议", "TAPD modified 值或人员内容摘要，供审计和排查"],
];

const ACTION_FIELDS = [
  ["key", "string", "是", "稳定阶段身份；同 key 更新同一阶段"],
  ["title / detail", "string", "否", "时间轴卡片标题与摘要"],
  ["status", "enum", "否", "pending/running/done/error/conflict/skipped/cancelled/observed"],
  ["group / scope", "string", "否", "阶段分组与业务范围"],
  ["platform / issueKey", "string", "否", "平台和自定义 Issue 维度"],
  ["tags", "string[]", "否", "额外筛选标签"],
  ["occurredAt", "ISO date", "否", "业务发生时间，不是 HTTP 重试时间"],
];

const OBSERVATION_FIELDS = [
  ["schema", "string", "否", "生产方观察 schema，建议带版本，例如 my-adapter/v1"],
  ["clientId", "string", "建议", "稳定客户端身份；决定哪份完整观察被替换"],
  ["observedAt", "ISO date", "建议", "本次事实采集时间"],
  ["scope", "string", "否", "观察范围，默认 client"],
  ["state", "object", "是", "该 clientId 的完整当前观察，不是 patch"],
];

const GLOBAL_STATE_FIELDS = [
  ["mode", "merge", "是", "当前只支持 merge"],
  ["patch", "object", "条件", "对象递归合并；数组、标量整体替换；null 删除字段"],
  ["remove", "string[]", "条件", "显式删除点路径，例如 sections.progress.fields.owner"],
];

const SECTION_FIELDS = [
  ["sections.<key>.title", "string", "建议", "分区标题；key=progress 使用紧凑网格"],
  ["fields.<key>.label", "string", "建议", "字段显示名"],
  ["fields.<key>.type", "enum", "否", "text / user / chips / list / link；未知值回退 text"],
  ["fields.<key>.value", "any", "是", "展示值；空值不渲染"],
  ["fields.<key>.url", "string", "link 条件", "link 类型的跳转地址"],
];

const PROJECTION_FIELDS = [
  ["timeline", "array", "是", "替换当前 source 的完整切片；省略 projections 才表示不修改"],
  ["timeline[].kind", "string", "是", "version / sprint / milestone 或生产方自定义类型"],
  ["timeline[].id", "string", "是", "业务对象稳定 ID；改名或改期不改变"],
  ["timeline[].key", "string", "建议", "建议 source:kind:id，避免不同生产方碰撞"],
  ["timeline[].title / date", "string", "否", "卡片标题和 YYYY-MM-DD 排期"],
  ["timeline[].source", "string", "建议", "条目所有者，用于 read-merge 时识别自有条目"],
  ["timeline[].dimensions", "object", "否", "平台、发布列车等不透明筛选维度"],
];

const EXTENSION_FIELDS = [
  ["extensions.<namespace>", "object", "是", "生产方自有、带版本约定的结构化 JSON"],
  ["namespace", "string", "是", "小写稳定标识；建议与 report.source 相同"],
  ["对象字段", "object", "否", "递归合并；null 删除"],
  ["数组 / 标量", "any", "否", "整体替换，不做元素级 merge"],
  ["renderer", "前端注册", "展示条件", "未知 namespace 只保存，不自动出现面板"],
];

const ARTIFACT_FIELDS = [
  ["key", "string", "建议", "稳定证据身份；不要依赖标题去重"],
  ["type", "string", "否", "gitlab-mr/build/test-report/document 等"],
  ["title", "string", "否", "页面展示标题"],
  ["url / path", "string", "至少一个", "外部地址或可识别路径"],
  ["scope", "action | global", "否", "有 Action 时默认 action"],
  ["status", "string", "否", "生产方定义的证据状态"],
];

const PUBLISH_FIELDS = [
  ["workflow", "object | string", "是", "目标 Workflow"],
  ["source", "string", "是", "真实生产方身份；agentflow-cli 只是传输工具"],
  ["title", "string", "是", "Review 页面标题"],
  ["markdown", "string", "是", "Markdown 实际内容，不是本地文件路径"],
  ["stage / stageKey", "string", "建议", "关联的稳定 Action 阶段"],
  ["issueKey / platform", "string", "否", "Issue 与平台维度"],
  ["artifactKey", "string", "是", "预览 Artifact 的稳定槽位"],
  ["artifactLabel", "string", "否", "页面按钮文案"],
  ["durability", "enum", "否", "temporary 或 durable"],
  ["ttlDays", "number", "临时建议", "临时预览有效期，通常 7 天"],
  ["expectedVersions", "object", "生产建议", "目标 artifact:source:key 的当前版本；新建使用 absent"],
  ["expectedRevision", "string", "兼容", "仅未提供 expectedVersions 时启用的整 Workflow 锁"],
  ["idempotencyKey", "string", "建议", "包含内容摘要；同 source + key 重放返回同一预览"],
];

const TOC_ITEMS = [
  ["api", "快速开始"],
  ["model", "区域模型"],
  ["renderers", "渲染效果"],
  ["reference", "参数参考"],
  ["scenarios", "关键场景"],
  ["safety", "权限与覆盖"],
  ["design", "设计思想"],
  ["ai", "AI 引导"],
];

const DATA_REGIONS = [
  {
    icon: "dashboard",
    name: "全局区域",
    question: "这个需求现在是什么？",
    fields: "observation.state · globalState · projections.timeline",
    detail: "标题、状态、负责人、平台、版本事实和迭代归属。事实留在 globalState，迭代列表只读取可重建的 projection。",
  },
  {
    icon: "timeline",
    name: "Action 时间轴",
    question: "关键阶段发生了什么？",
    fields: "action · artifacts",
    detail: "方案确认、实现、提测、发布等业务节点及其 MR、构建、测试或文档证据。Action 不是刷新日志。",
  },
  {
    icon: "extension",
    name: "自定义展示",
    question: "生产方还需要展示什么？",
    fields: "globalState.sections · extensions[namespace]",
    detail: "普通键值、标签、列表和链接优先使用通用 sections；只有需要树形结构或专用交互时才使用 extensions 并开发 renderer。",
  },
];

const OVERWRITE_RULES = [
  ["observation.state", "同一 clientId 完整替换", "省略不改", "只替换自己的完整观察"],
  ["globalState", "对象递归合并；数组/标量替换", "null 或 remove 删除", "只 patch 自己拥有的路径"],
  ["action", "同 source + action.key 更新同一阶段", "无通用物理删除", "取消/跳过使用业务状态表达"],
  ["artifacts", "同 source + 稳定 key 更新/归并", "无通用物理删除", "不要改 key 来伪造删除"],
  ["projections.timeline", "当前 source 的完整切片替换", "[] 只清空当前 source", "其他生产方条目由服务端原子保留"],
  ["extensions", "仅 extensions[source] 内对象递归合并；数组/标量替换", "null 删除自有字段", "不能写别人的 namespace"],
];

const PERMISSIONS = [
  ["TAPD Owner", "可读", "可写", "Workflow Owner；可管理成员和分享"],
  ["显式 Reporter", "可读", "可写", "Owner 主动授权；不能管理成员"],
  ["TAPD 参与人", "可读", "只读", "由 TAPD 派生；移出 TAPD 后自动收回"],
  ["显式 Viewer", "可读", "只读", "Owner 主动授权；不依赖 TAPD"],
  ["同团队成员", "可读", "只读", "自动获得 team viewer"],
  ["分享链接", "可读", "只读", "不能用于上报"],
  ["超级管理员代看", "可读", "只读", "不会以管理员身份覆盖数据"],
];

async function copyTextToClipboard(text) {
  const value = String(text || "");
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

function SectionHead({ number, title, detail }) {
  return (
    <div className="af-wr-section__head">
      <span>{number}</span>
      <div><h2>{title}</h2><p>{detail}</p></div>
    </div>
  );
}

function CodePanel({ title, value, copyKey, copied, onCopy, wrap = false }) {
  const failed = copied === `failed:${copyKey}`;
  return (
    <div className={`af-wr-code-panel${wrap ? " is-wrap" : ""}`}>
      <div className="af-wr-code-panel__head">
        <span>{title}</span>
        <button type="button" onClick={() => void onCopy(copyKey, value)}>
          <span className="material-symbols-outlined" aria-hidden>{copied === copyKey ? "check" : "content_copy"}</span>
          {copied === copyKey ? "已复制" : "复制"}
        </button>
      </div>
      <pre>{value}</pre>
      {failed ? <p className="af-wr-copy-error">浏览器禁止访问剪贴板，请手动选择代码块内容。</p> : null}
    </div>
  );
}

function FieldTable({ columns = ["参数", "类型", "必填", "含义"], rows, label }) {
  return (
    <div className={`af-wr-table is-${columns.length}-columns`} role="table" aria-label={label}>
      <div className="af-wr-table__row is-head" role="row">
        {columns.map((column) => <span role="columnheader" key={column}>{column}</span>)}
      </div>
      {rows.map((row) => (
        <div className="af-wr-table__row" role="row" key={row[0]}>
          {row.map((cell, index) => <span role="cell" data-label={columns[index]} key={`${row[0]}-${index}`}>{cell}</span>)}
        </div>
      ))}
    </div>
  );
}

function EndpointHeader({ method, path, title, permission, effect }) {
  return (
    <div className="af-wr-endpoint__head">
      <div className="af-wr-endpoint__identity">
        <span className={`is-${method.toLowerCase()}`}>{method}</span>
        <code>{path}</code>
        <h3>{title}</h3>
      </div>
      <dl>
        <div><dt>权限</dt><dd>{permission}</dd></div>
        <div><dt>副作用</dt><dd>{effect}</dd></div>
      </dl>
    </div>
  );
}

function GenericOverviewPreview() {
  return (
    <article className="af-prd-workflow-card af-prd-overall af-wr-render-preview">
      <div className="af-prd-workflow-card__head"><h2>需求概览</h2><span className="af-prd-overall__status">实现中</span></div>
      <div className="af-prd-overall__requirement"><strong>Remote Config 拉取频控</strong></div>
      <div className="af-prd-overall__platforms">
        <section className="af-prd-overall-platform">
          <div className="af-prd-overall-platform__head"><strong>归属信息</strong></div>
          <div className="af-prd-overall-platform__fields">
            <div className="af-prd-overall-platform__row af-prd-overall-platform__row--user"><small>负责人 · user</small><div><span>alice</span></div></div>
            <div className="af-prd-overall-platform__row af-prd-overall-platform__row--chips"><small>平台 · chips</small><div><span>Android</span><span>iOS</span></div></div>
            <div className="af-prd-overall-platform__row af-prd-overall-platform__row--text"><small>需求分支 · text</small><div><span>story/1020124</span></div></div>
            <div className="af-prd-overall-platform__rules"><small>当前风险 · list</small><ul><li>等待服务端字段确认</li><li>灰度策略待补充</li></ul></div>
            <div className="af-prd-overall-platform__row af-prd-overall-platform__row--link"><small>技术方案 · link</small><span className="af-wr-preview-link"><span>打开方案文档</span><span className="material-symbols-outlined" aria-hidden>open_in_new</span></span></div>
          </div>
        </section>
      </div>
    </article>
  );
}

function GenericActionPreview() {
  return (
    <div className="af-prd-workflow-action af-prd-workflow-action--done af-wr-render-preview">
      <div className="af-prd-workflow-action__rail"><span className="af-prd-workflow-action__dot" /></div>
      <div className="af-prd-workflow-action__body">
        <div className="af-prd-workflow-action__top">
          <div>
            <div className="af-prd-workflow-action__title"><time>16:25:40</time><strong>Android 实现完成</strong></div>
            <p>MR !957 已合并</p>
            <div className="af-prd-workflow-action__meta"><span className="af-prd-workflow-action__meta-item af-prd-workflow-action__meta-item--issue"><b>Issue</b><span className="af-prd-workflow-action__meta-value">runtime-hook</span></span><span className="af-prd-workflow-action__meta-item af-prd-workflow-action__meta-item--platform"><b>平台</b><span className="af-prd-workflow-action__meta-value">Android</span></span></div>
          </div>
          <span className="af-prd-workflow-action__status">完成</span>
        </div>
        <div className="af-prd-workflow-action__links"><span className="af-wr-preview-link"><span>实现 MR !957</span><span className="material-symbols-outlined" aria-hidden>open_in_new</span></span></div>
      </div>
    </div>
  );
}

function GenericArtifactPreview() {
  return (
    <article className="af-prd-workflow-card af-wr-render-preview">
      <div className="af-prd-workflow-card__head"><h2>关联产物</h2><span>2</span></div>
      <div className="af-prd-workflow-list">
        <span className="af-wr-preview-link"><span>测试报告 #128</span><small>test-report</small></span>
        <span className="af-wr-preview-link"><span>Jenkins Build #8451</span><small>build</small></span>
      </div>
    </article>
  );
}

function GenericTimelinePreview() {
  return (
    <section className="af-workflows-timeline af-wr-render-preview">
      <div className="af-workflows-timeline__heading"><div><span>迭代时间线</span><strong>按排期归属汇总</strong></div></div>
      <div className="af-workflows-timeline__rail">
        <button type="button" className="is-active"><span className="af-workflows-timeline__date">2026/08/31<em>计划中</em></span><strong>Likee Android 5.63.0</strong><small>Android · 3 项 · 1 项需关注</small></button>
      </div>
    </section>
  );
}

function PrdFlowExtensionPreview() {
  return (
    <div className="af-wr-extension-preview">
      <section>
        <div><span>AI DOCS</span><strong>2</strong></div>
        <p>技术方案</p><p>测试与灰度说明</p>
      </section>
      <section>
        <div><span>ISSUES</span><strong>2 / 3</strong></div>
        <p><i className="is-done" /> Runtime Hook · Android</p>
        <p><i /> iOS 容器适配</p>
      </section>
    </div>
  );
}

export default function WorkflowReportGuidePage() {
  const { navigate } = useRoute();
  const [copied, setCopied] = useState("");
  const [activeSection, setActiveSection] = useState("api");
  const copy = useCallback(async (key, value) => {
    setCopied(await copyTextToClipboard(value) ? key : `failed:${key}`);
  }, []);

  useEffect(() => {
    const sections = TOC_ITEMS.map(([id]) => document.getElementById(id)).filter(Boolean);
    if (!sections.length || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
      if (visible[0]?.target?.id) setActiveSection(visible[0].target.id);
    }, { rootMargin: "-18% 0px -68% 0px", threshold: [0, 0.1] });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="af-wr-page">
      <div className="af-wr-inner">
        <section className="af-wr-hero">
          <div>
            <span className="af-wr-kicker">WORKFLOW REPORT · API REFERENCE</span>
            <h1>Workflow 接入文档</h1>
            <p>用 3 个运行态数据接口和 1 个权限控制面接口，把生产流程的人员权限、全局信息、Action 时间轴、产物链接、迭代归属和自定义面板接入 AgentFlow。数据协议面向任意 Adapter；当前服务端的 Workflow 身份与权限适配器只支持 TAPD，prd-flow 仅作为 TAPD 研发场景的参考实现。</p>
            <div className="af-wr-hero__boundary"><strong>当前边界</strong><span>可接入任意事实来源</span><i>·</i><span>Workflow key 目前必须是 tapd:&lt;short-id&gt;</span></div>
          </div>
          <div className="af-wr-hero__actions">
            <button type="button" className="is-primary" onClick={() => void copy("ai", AI_GUIDE)}>
              <span className="material-symbols-outlined" aria-hidden>{copied === "ai" ? "check" : "smart_toy"}</span>
              {copied === "ai" ? "已复制 AI 引导" : "复制 AI 接入引导"}
            </button>
            <button type="button" onClick={() => navigate("/workflows")}>打开 Workflow Dashboard</button>
          </div>
        </section>

        <nav className="af-wr-toc" aria-label="接入文档目录">
          {TOC_ITEMS.map(([id, label]) => <a key={id} className={activeSection === id ? "is-active" : ""} href={`#${id}`}>{label}</a>)}
        </nav>

        <section className="af-wr-section" id="api">
          <SectionHead number="01" title="5 分钟跑通一次上报" detail="运行态数据接口只有三个，人员权限由独立控制面接口同步。先准备登录 Token 和稳定 source，再执行 access sync → read → merge → report → verify；旧 /api/prd-workflow/* 仅为兼容入口。" />
          <div className="af-wr-endpoint-grid">
            {ENDPOINTS.map((endpoint) => (
              <article key={endpoint.path}>
                <div><span className={`is-${endpoint.method.toLowerCase()}`}>{endpoint.method}</span><code>{endpoint.path}</code></div>
                <h3>{endpoint.title}</h3><p>{endpoint.detail}</p>
                <dl><div><dt>权限</dt><dd>{endpoint.permission}</dd></div><div><dt>副作用</dt><dd>{endpoint.effect}</dd></div></dl>
              </article>
            ))}
          </div>
          <div className="af-wr-quickstart">
            <div><strong>开始前准备</strong><p>在 AgentFlow 的 MCP 页面点击“使用当前登录 Token”，仅在本机设置 <code>AGENTFLOW_TOKEN</code>。当前 Workflow 身份必须使用 <code>tapd:&lt;short-id&gt;</code>；<code>source</code> 填业务 Adapter 名，不能填传输工具名。</p></div>
            <CodePanel title="安装与认证" value={INSTALL_COMMANDS} copyKey="install" copied={copied} onCopy={copy} />
          </div>
          <div className="af-wr-code-grid af-wr-quickstart-run">
            <CodePanel title="可直接执行的三步命令" value={QUICKSTART_COMMANDS} copyKey="quickstart" copied={copied} onCopy={copy} />
            <CodePanel title="workflow-report.json 最小请求" value={QUICKSTART_REPORT} copyKey="quickstart-report" copied={copied} onCopy={copy} />
          </div>
          <div className="af-wr-success-check"><span className="material-symbols-outlined" aria-hidden>check_circle</span><p><strong>成功标准：</strong>POST 返回 <code>ok: true</code> 和实际 <code>resourceKeys</code>，再次 GET 能看到 <code>requirement-imported</code>，且对应 <code>snapshot.resourceVersions</code> 已从 <code>absent</code> 变为新版本。</p></div>
        </section>

        <section className="af-wr-section" id="model">
          <SectionHead number="02" title="先决定数据进入哪个区域" detail="页面区域和协议字段一一对应。不要把所有内容都塞进一个 snapshot，也不要从 Action 标题反推结构化数据。" />
          <div className="af-wr-region-grid">
            {DATA_REGIONS.map((region) => (
              <article key={region.name}>
                <span className="material-symbols-outlined" aria-hidden>{region.icon}</span>
                <div><small>{region.question}</small><h3>{region.name}</h3><code>{region.fields}</code><p>{region.detail}</p></div>
              </article>
            ))}
          </div>
          <div className="af-wr-model-note">
            <strong>核心原则</strong>
            <span>globalState.sections 解决通用自定义展示</span><i>→</i><span>Action 表达关键业务节点</span><i>→</i><span>projection 只做聚合索引</span><i>→</i><span>extension 承载专用结构</span>
          </div>
        </section>

        <section className="af-wr-section" id="renderers">
          <SectionHead number="03" title="当前可直接使用的通用渲染器" detail="这些 schema 已经由 AgentFlow 页面识别，接入方只需上报数据，不需要开发前端。下面的预览使用与 Workflow 详情页相同的样式类。" />
          <div className="af-wr-renderer-notice">
            <span className="material-symbols-outlined" aria-hidden>info</span>
            <p><strong>普通自定义信息不要放进 extensions。</strong>负责人、平台、分支、风险列表、文档链接等，直接使用 <code>globalState.sections</code>。只有通用组件无法表达的树形结构、复杂交互或专用业务面板，才需要 <code>extensions</code> 和前端 renderer。</p>
          </div>
          <div className="af-wr-renderer-feature">
            <div className="af-wr-renderer-feature__copy">
              <span>GENERIC · GLOBAL STATE</span>
              <h3>概览分区 / 字段渲染器</h3>
              <p>每个 section 生成一张分区卡片；字段按 <code>type</code> 选择固定样式。section key 为 <code>progress</code> 时使用紧凑响应式网格，其余分区纵向排列。</p>
              <dl>
                <div><dt>text</dt><dd>普通文本，无胶囊背景</dd></div>
                <div><dt>user</dt><dd>负责人文本，使用强调色</dd></div>
                <div><dt>chips</dt><dd>一个或多个标签胶囊</dd></div>
                <div><dt>list</dt><dd>纵向项目符号列表</dd></div>
                <div><dt>link</dt><dd>可点击文本与外链图标</dd></div>
              </dl>
            </div>
            <GenericOverviewPreview />
          </div>
          <CodePanel title="globalState.sections 上报示例" value={GENERIC_SECTION_REPORT} copyKey="generic-section" copied={copied} onCopy={copy} />
          <div className="af-wr-renderer-grid">
            <article>
              <div className="af-wr-renderer-grid__head"><span>GENERIC</span><h3>Action 时间轴</h3><code>action + artifacts[scope=action]</code><p>按日期分组，展示状态点、时间、标题、详情、Issue/平台标签和阶段产物按钮。</p></div>
              <GenericActionPreview />
            </article>
            <article>
              <div className="af-wr-renderer-grid__head"><span>GENERIC</span><h3>关联产物列表</h3><code>artifacts[scope=global]</code><p>用于构建、测试报告、外部文档等全局链接；显示标题、类型与跳转状态。</p></div>
              <GenericArtifactPreview />
            </article>
            <article>
              <div className="af-wr-renderer-grid__head"><span>GENERIC</span><h3>迭代时间线</h3><code>projections.timeline</code><p>根据 kind/id/title/date/dimensions 聚合个人与团队迭代，支持横向时间线和筛选。</p></div>
              <GenericTimelinePreview />
            </article>
          </div>
          <div className="af-wr-extension-registry">
            <div><span>REGISTERED EXTENSION</span><h3><code>extensions["prd-flow"]</code></h3><p>当前唯一已注册的专用 extension renderer。支持 AI Docs 链接列表和带父子层级、平台、MR 状态及关联链接的 Issues 树。</p><PrdFlowExtensionPreview /></div>
            <div><strong>其他 namespace 当前如何显示？</strong><p>数据会被保存并参与 revision，但不会自动出现面板。若现有 sections / Action / Artifact / timeline 足够，应优先使用通用组件；确实需要新布局时，再提交扩展 schema、空态/错误态、响应式样式和 renderer 实现。</p></div>
          </div>
        </section>

        <section className="af-wr-section" id="reference">
          <SectionHead number="04" title="接口与参数参考" detail="以下字段来自当前服务端真实校验与合并逻辑；可以按区域只提交本次需要更新的部分。" />

          <article className="af-wr-endpoint">
            <EndpointHeader method="POST" path="/api/workflows/access/sync" title="同步 TAPD 派生权限" permission="首次：TAPD Owner；后续：当前 Owner / 管理员" effect="只改权限控制面，不写运行态" />
            <p className="af-wr-endpoint__intro">Adapter 读取 TAPD Story 后，先把 Owner 与参与人同步到 AgentFlow。Owner 必须已注册 AgentFlow；未匹配的参与人会在 <code>unresolvedParticipants</code> 中返回，注册后下次同步即可获得 Viewer。</p>
            <FieldTable rows={ACCESS_SYNC_FIELDS} label="Workflow access sync 参数" />
            <CodePanel title="权限同步请求" value={ACCESS_SYNC_REQUEST} copyKey="access-sync" copied={copied} onCopy={copy} />
            <div className="af-wr-callout"><span className="material-symbols-outlined" aria-hidden>security</span><p><strong>派生权限与显式授权分开保存。</strong>TAPD 参与人只自动获得 Viewer；Owner 可在 Workflow 分享弹窗把某人提升为 Reporter。后续 TAPD 同步会替换派生参与人，但不会覆盖显式授权。</p></div>
          </article>

          <article className="af-wr-endpoint">
            <EndpointHeader method="GET" path="/api/workflows/state" title="读取当前 Workflow" permission="owner / reporter / viewer / team viewer / share viewer" effect="无" />
            <p className="af-wr-endpoint__intro">写入前读取当前快照，从 <code>snapshot.resourceVersions</code> 保存本次将触及的业务 key 版本；不存在的 key 使用 <code>absent</code>。客户端提交的完整状态叫 <code>observation.state</code>；只有服务端返回的数据才叫 <code>snapshot</code>。</p>
            <FieldTable rows={STATE_QUERY_FIELDS} label="Workflow state query 参数" />
            <h4>成功响应</h4>
            <FieldTable columns={["字段", "类型", "含义"]} rows={STATE_RESPONSE_FIELDS} label="Workflow state 成功响应" />
            <div className="af-wr-code-grid">
              <CodePanel title="请求" value={READ_REQUEST} copyKey="read-request" copied={copied} onCopy={copy} />
              <CodePanel title="关键响应字段" value={READ_RESPONSE} copyKey="read-response" copied={copied} onCopy={copy} />
            </div>
          </article>

          <article className="af-wr-endpoint">
            <EndpointHeader method="POST" path="/api/workflows/report" title="统一上报 Workflow" permission="owner / reporter" effect="修改运行态并返回新 snapshot" />
            <p className="af-wr-endpoint__intro">至少提交 observation、globalState、action、artifacts、projections、extensions 之一。一次请求可以组合多个区域：每个业务 key 独立校验版本，任一冲突则整次请求原子失败，不会只写入一半。</p>
            <h4>Envelope</h4>
            <FieldTable rows={REPORT_FIELDS} label="Workflow Report 顶层参数" />
            <div className="af-wr-subreference">
              <div><h4>action</h4><p>业务阶段，不是运行日志。</p><FieldTable rows={ACTION_FIELDS} label="Action 参数" /></div>
              <div><h4>artifacts</h4><p>已有 HTTP URL 的证据直接上报。</p><FieldTable rows={ARTIFACT_FIELDS} label="Artifact 参数" /></div>
            </div>
            <div className="af-wr-schema-reference">
              <article><h4>observation</h4><p>同一 clientId 的完整生产方观察。</p><FieldTable rows={OBSERVATION_FIELDS} label="Observation 参数" /></article>
              <article><h4>globalState</h4><p>可独立更新的全局事实和通用分区。</p><FieldTable rows={GLOBAL_STATE_FIELDS} label="Global State 参数" /></article>
              <article><h4>globalState.sections</h4><p>无需前端开发的通用字段渲染器。</p><FieldTable rows={SECTION_FIELDS} label="Global State Section 参数" /></article>
              <article><h4>projections.timeline</h4><p>个人/团队 Dashboard 使用的可重建索引。</p><FieldTable rows={PROJECTION_FIELDS} label="Timeline Projection 参数" /></article>
              <article><h4>extensions</h4><p>只有专用 renderer 才能显示的 namespace 数据。</p><FieldTable rows={EXTENSION_FIELDS} label="Workflow Extensions 参数" /></article>
            </div>
            <p className="af-wr-table-note"><strong>生产方隔离：</strong>Action、Artifact、Projection、Observation 和 Extension 都使用带 <code>source</code> 的资源 key；不同 source 可以复用相同业务 key。<code>globalState</code> 按叶子路径分 key 并记录首次写入者，不能覆盖其他 source 的路径；timeline 只替换当前 source 的切片。</p>
          </article>

          <article className="af-wr-endpoint">
            <EndpointHeader method="POST" path="/api/workflow-artifacts/publish" title="发布 Markdown 预览" permission="owner / reporter" effect="保存预览副本和辅助 Artifact；不推进 Action" />
            <p className="af-wr-endpoint__intro">客户端读取本地 Markdown，再发送实际内容。服务端不能访问调用方本地路径；外部系统已有 URL 时直接使用 Report artifacts，无需发布副本。</p>
            <FieldTable rows={PUBLISH_FIELDS} label="Artifact Publish 参数" />
            <div className="af-wr-publish-layout">
              <div className="af-wr-result-list">
                <h4>返回什么</h4>
                <p><code>artifact</code>：页面可识别的标准产物</p>
                <p><code>review.url</code>：规范预览地址</p>
                <p><code>review.shortUrl</code>：通常为 <code>/r/&lt;code&gt;</code> 的分享短链</p>
                <p><code>snapshot</code>：发布后的最新 Workflow 状态</p>
                <strong>不会确认方案、修改原文件、提交 ai-doc、创建 Issue 或推进阶段。</strong>
              </div>
              <CodePanel title="发布请求" value={PUBLISH_REQUEST} copyKey="publish" copied={copied} onCopy={copy} />
            </div>
          </article>
        </section>

        <section className="af-wr-section" id="scenarios">
          <SectionHead number="05" title="三个关键接入场景" detail="以 prd-flow 为例说明接口组合；它是 TAPD 研发流程的一种实现，不是协议依赖。" />
          <div className="af-wr-scenario">
            <div className="af-wr-scenario__copy"><span>场景 A</span><h3>更新迭代：绑定或切换版本</h3><ol><li>Adapter 从业务系统得到稳定 version ID、标题、日期、平台；prd-flow 的来源恰好是 TAPD。</li><li>GET 当前 snapshot，取版本事实叶子路径及自有 projection 的 resourceVersions。</li><li>版本事实写入 globalState；归属索引写入 kind=version projection。</li><li>只提交当前 source 的完整投影切片；其他 source 的 Sprint/版本由服务端保留。</li></ol><p><strong>改名/改期：</strong>保持 ID 和 key 不变。<strong>取消归属：</strong>移除自有条目后上报剩余自有切片；发送空数组只清空当前 source。</p></div>
            <CodePanel title="版本事实 + 当前生产方迭代投影" value={VERSION_REPORT} copyKey="version" copied={copied} onCopy={copy} />
          </div>
          <div className="af-wr-scenario">
            <div className="af-wr-scenario__copy"><span>场景 B</span><h3>上报 Action 和产物链接</h3><ol><li>先完成真实业务动作，例如创建并合并 MR。</li><li>用稳定 action.key 报告阶段，用 artifact.key 报告证据。</li><li>同一阶段刷新继续使用相同 key；occurredAt 使用业务时间。</li><li>本地 Markdown 先 publish，已有 HTTP URL 直接作为 Artifact。</li></ol><p>AgentFlow 只记录和展示结果，不替接入方操作 TAPD、GitLab 或 Jenkins。</p></div>
            <CodePanel title="实现完成 + MR" value={ACTION_REPORT} copyKey="action" copied={copied} onCopy={copy} />
          </div>
          <div className="af-wr-scenario">
            <div className="af-wr-scenario__copy"><span>场景 C</span><h3>上报自定义文档区 / Issue 区</h3><ol><li>定义生产方 namespace 和版本化 schema。</li><li>把结构化数组写入 extensions[namespace]。</li><li>数组上报完整新值，对象字段可以递归合并。</li><li>实现并注册专用渲染器，页面才会出现对应区域。</li></ol><p>prd-flow 已有 AI Docs / Issues 渲染；其他生产方不能仅通过改字段名复用它。</p></div>
            <CodePanel title="prd-flow 专用扩展示例" value={EXTENSION_REPORT} copyKey="extension" copied={copied} onCopy={copy} />
          </div>
        </section>

        <section className="af-wr-section" id="safety">
          <SectionHead number="06" title="权限、覆盖和冲突" detail="接入前必须明确谁能写、每个区域怎么更新，以及冲突发生时是否可能误删其他生产方的数据。" />
          <div className="af-wr-safety-grid">
            <div><h3>权限矩阵</h3><FieldTable columns={["身份", "读取", "上报", "说明"]} rows={PERMISSIONS} label="Workflow 权限矩阵" /><p className="af-wr-table-note">完成 TAPD 权限同步后，Owner 和参与人以 TAPD 为准；参与人默认只读。尚未同步过的历史 Workflow 保留原 Owner，直到当前 Owner 或管理员执行首次同步。</p></div>
            <div><h3>覆盖矩阵</h3><FieldTable columns={["区域", "重复上报", "删除/清空", "接入方责任"]} rows={OVERWRITE_RULES} label="Workflow 覆盖矩阵" /></div>
          </div>
          <div className="af-wr-conflict-flow"><span>GET snapshot.resourceVersions</span><i>→</i><span>计算触及的 resource keys</span><i>→</i><span>POST + expectedVersions + idempotencyKey</span><i>→</i><span>409 时只刷新冲突 key / 重算 / 重试一次</span></div>
          <div className="af-wr-errors">
            <div><code>400</code><p>字段或 schema 错误；按协议修正</p></div><div><code>401</code><p>缺少认证；停止并配置 Token</p></div><div><code>403</code><p>只读或无权限；由 Owner 授权 Reporter</p></div><div><code>409</code><p>资源 key 冲突、路径属于其他 source，或权限快照过旧</p></div>
          </div>
        </section>

        <section className="af-wr-section" id="design">
          <SectionHead number="07" title="设计思想与运行关系" detail="业务解释留在 Adapter，传输和存储保持通用；这样新生产方不需要复制 prd-flow 的 TAPD 私有模型。" />
          <div className="af-wr-runtime">
            <article><small>事实来源</small><strong>TAPD / GitLab / Jenkins / 其他系统</strong><p>提供原始业务事实。</p></article><i>→</i>
            <article className="is-focus"><small>你需要实现</small><strong>业务 Adapter</strong><p>先同步上游人员权限，再解释阶段、定义稳定 key、生成 Report。prd-flow 是一个现有 Adapter。</p></article><i>→</i>
            <article><small>通用传输</small><strong>Workflow Report Client / agentflow-cli</strong><p>负责地址、Token、JSON 和 HTTP，不理解业务。</p></article><i>→</i>
            <article><small>接收与展示</small><strong>AgentFlow 服务与页面</strong><p>鉴权、合并、存储并渲染三类区域。</p></article>
          </div>
          <div className="af-wr-design-rules">
            <article><strong>事实与投影分离</strong><p>版本完整信息属于 globalState；个人/团队迭代只读取 projection。投影可以重建，不成为第二份真相。</p></article>
            <article><strong>业务节点与技术日志分离</strong><p>Action 只表达可理解的阶段。轮询、重试、刷新留在接入方日志，不污染时间轴。</p></article>
            <article><strong>通用存储与专用渲染分离</strong><p>extensions 可以保存任意生产方结构，但专用面板必须显式注册 schema 和 renderer。</p></article>
          </div>
          <div className="af-wr-callout">
            <span className="material-symbols-outlined" aria-hidden>psychology</span>
            <p><strong>Workflow AI 不属于 Report 协议。</strong>需求 Owner 在详情页“协作 → AI 知识工作区”绑定平台已有的 Git 知识工作区；成员通过顶部 AI 提问。AgentFlow 会把当前 Workflow snapshot 与隔离的 detached commit 快照一并交给 AI：优先使用上报且能匹配仓库的 commit/ref，否则使用绑定分支或本地 HEAD。它不会 fetch、切换或修改真实仓库，公开只读链接也不能调用 AI。绑定配置由 <code>GET/PUT /api/workflows/knowledge-bindings</code> 管理，问答使用 <code>POST /api/workflows/query</code>，不会写入 <code>globalState</code>、Action、Artifact 或 extensions。</p>
          </div>
        </section>

        <section className="af-wr-section af-wr-ai" id="ai">
          <SectionHead number="08" title="给 AI 的接入引导" detail="复制后交给 AI，它会先输出事实到页面区域的映射，再按真实协议实现。" />
          <CodePanel title="$agentflow-workflow-report" value={AI_GUIDE} copyKey="ai-bottom" copied={copied} onCopy={copy} wrap />
        </section>
      </div>
    </div>
  );
}
