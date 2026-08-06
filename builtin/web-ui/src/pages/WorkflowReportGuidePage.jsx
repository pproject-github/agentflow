import { useCallback, useState } from "react";
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

const ADMIN_VERSION_REPAIR_READ = `node skills/agentflow-cli/scripts/agentflow-cli.mjs workflow-get \\
  --workflow tapd:1013667 \\
  --runtime-only \\
  --admin-operation repair-version-membership`;

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
        "name": "Likee Android&iOS 5.63.0",
        "date": "2026-08-31",
        "platforms": ["android", "ios"]
      }
    }
  },
  "projections": {
    "timeline": [
      {
        "kind": "version",
        "id": "1133202860001000338",
        "key": "prd-flow:tapd-current-version:1133202860001000338",
        "title": "Likee Android&iOS 5.63.0",
        "date": "2026-08-31",
        "source": "prd-flow",
        "dimensions": { "platform": ["android", "ios"] }
      }
    ]
  },
  "expectedVersions": {
    "global:tapdCurrentVersion.id": "rv:<version-from-get-or-absent>",
    "global:tapdCurrentVersion.name": "rv:<version-from-get-or-absent>",
    "global:tapdCurrentVersion.date": "rv:<version-from-get-or-absent>",
    "global:tapdCurrentVersion.platforms": "rv:<version-from-get-or-absent>",
    "projection:prd-flow:version:1133202860001000338": "absent"
  },
  "idempotencyKey": "timeline:1020124:version-1133202860001000338:v1"
}`;

const ADMIN_VERSION_REPAIR = `{
  "schemaVersion": 1,
  "workflow": "tapd:1013667",
  "source": "prd-flow",
  "adminOperation": "repair-version-membership",
  "adminReason": "清理测试版本并归属到正式迭代",
  "projections": {
    "timeline": [{
      "kind": "version",
      "id": "1133202860001000338",
      "key": "prd-flow:tapd-current-version:1133202860001000338",
      "title": "Likee Android&iOS V5.63",
      "date": "2026-08-11",
      "source": "prd-flow"
    }]
  },
  "expectedRevision": "runtime:<revision-from-get>",
  "idempotencyKey": "admin-version-repair:1013667:version-1133202860001000338"
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

const CHECKLIST_REPORT = `{
  "schemaVersion": 1,
  "workflow": "tapd:1020124",
  "source": "release-bot",
  "action": {
    "key": "release-readiness",
    "title": "发布检查",
    "status": "running",
    "checklist": {
      "schemaVersion": 1,
      "completionPolicy": "all_required",
      "document": { "title": "发布检查详情" },
      "items": [{
        "key": "smoke-test",
        "title": "冒烟测试",
        "required": true,
        "evidenceRequired": true,
        "detail": {
          "summary": "验证发布后的核心链路",
          "sections": [{
            "key": "steps",
            "title": "执行步骤",
            "content": ["打开应用", "完成一次核心操作", "检查结果"]
          }]
        }
      }, {
        "key": "metrics",
        "title": "核心指标检查",
        "required": true
      }]
    }
  },
  "expectedVersions": {
    "action:release-bot:release-readiness": "absent"
  },
  "idempotencyKey": "release-readiness:1020124:v1"
}`;

const CHECKLIST_UPDATE = `PATCH /api/workflows/checklist
Content-Type: application/json

{
  "workflow": "tapd:1020124",
  "source": "release-bot",
  "actionKey": "release-readiness",
  "itemKey": "smoke-test",
  "status": "passed",
  "note": "核心链路通过",
  "evidence": [{
    "title": "测试报告",
    "url": "https://example.test/reports/smoke"
  }],
  "expectedVersion": "absent",
  "idempotencyKey": "release-readiness:smoke-test:passed:v1"
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

const OVERVIEW_MINIMAL_REPORT = `{
  "workflow": "tapd:1020124",
  "source": "my-adapter",
  "globalState": {
    "mode": "merge",
    "patch": {
      "title": "Remote Config 拉取频控",
      "status": "实现中",
      "sections": {
        "ownership": {
          "title": "归属信息",
          "fields": {
            "owner": { "label": "负责人", "type": "user", "value": "alice" },
            "platforms": { "label": "平台", "type": "chips", "value": ["Android", "iOS"] }
          }
        }
      }
    }
  }
}`;

const ACTION_MINIMAL_REPORT = `{
  "workflow": "tapd:1020124",
  "source": "my-adapter",
  "action": {
    "key": "implementation:android",
    "title": "Android 实现完成",
    "detail": "MR !957 已合并",
    "status": "done",
    "platform": "android",
    "issueKey": "runtime-hook",
    "occurredAt": "2026-08-05T08:25:00.000Z"
  }
}`;

const CHECKLIST_MINIMAL_REPORT = `{
  "workflow": "tapd:1020124",
  "source": "release-bot",
  "action": {
    "key": "release-readiness",
    "title": "发布检查",
    "status": "running",
    "checklist": {
      "document": { "title": "发布检查详情" },
      "items": [
        { "key": "smoke-test", "title": "冒烟测试", "required": true },
        { "key": "metrics", "title": "核心指标检查", "required": true }
      ]
    }
  }
}`;

const ARTIFACT_MINIMAL_REPORT = `{
  "workflow": "tapd:1020124",
  "source": "build-bot",
  "artifacts": [{
    "key": "android-build-8451",
    "type": "build",
    "title": "Jenkins Build #8451",
    "url": "https://jenkins.example.test/job/android/8451",
    "scope": "global",
    "status": "ready"
  }]
}`;

const ARTIFACT_COMPLETE_REPORT = `{
  "schemaVersion": 1,
  "workflow": "tapd:1020124",
  "source": "build-bot",
  "artifacts": [{
    "key": "android-build-8451",
    "type": "build",
    "title": "Jenkins Build #8451",
    "url": "https://jenkins.example.test/job/android/8451",
    "scope": "global",
    "status": "ready"
  }, {
    "key": "android-package-8451",
    "type": "package",
    "title": "Android 测试包",
    "url": "https://downloads.example.test/android-8451.apk",
    "scope": "global",
    "status": "ready"
  }, {
    "key": "android-qr-8451",
    "type": "qr-code",
    "title": "扫码安装",
    "url": "https://downloads.example.test/android-8451/qr",
    "scope": "global",
    "status": "ready"
  }],
  "expectedVersions": {
    "artifact:build-bot:android-build-8451": "absent",
    "artifact:build-bot:android-package-8451": "absent",
    "artifact:build-bot:android-qr-8451": "absent"
  },
  "idempotencyKey": "android-build-artifacts:8451:v1"
}`;

const TIMELINE_MINIMAL_REPORT = `{
  "workflow": "tapd:1020124",
  "source": "release-plan",
  "projections": {
    "timeline": [{
      "kind": "version",
      "id": "v5.63.0",
      "key": "release-plan:version:v5.63.0",
      "title": "Likee Android 5.63.0",
      "date": "2026-08-31",
      "dimensions": { "platform": ["Android"] }
    }]
  }
}`;

const EFFECT_AGENT_GUIDES = {
  overview: `我要在 AgentFlow Workflow 的“需求概览”区域展示结构化信息。请使用 $agentflow-workflow-report，把标题、状态和普通业务字段上报到 globalState.sections。字段优先使用 text、user、chips、list、link 通用类型，不要为普通键值创建 extensions。先 GET 当前 resourceVersions，再以稳定 source 执行 report 并 verify。`,
  action: `我要在 AgentFlow Workflow 的 Action 时间轴展示一个关键业务节点。请使用 $agentflow-workflow-report，上报稳定 action.key、用户可理解的 title/detail、status、occurredAt，并按需提供 platform、issueKey。已有 HTTP 证据链接放入 artifacts；刷新同一阶段时保持 action.key 不变。`,
  checklist: `我要让 AgentFlow Workflow 的当前 Action 展示可执行 TodoList。请使用 $agentflow-workflow-report，在稳定 Action 中上报 action.checklist，给每个条目设置稳定且唯一的 items[].key 和 title；详细步骤放入 detail.sections。定义由 Producer 上报，逐项状态由 AgentFlow Checklist API 保存，不要把勾选状态写回 Action 定义。`,
  artifact: `我要在 AgentFlow Workflow 展示构建、测试报告或外部文档链接。请使用 $agentflow-workflow-report，上报具有稳定 key、type、title、url、scope 和 status 的 artifacts。已有 HTTP URL 直接上报；本地 Markdown 内容先通过 workflow-artifacts/publish 发布。`,
  timeline: `我要让需求出现在 AgentFlow 的个人/团队迭代时间线上。请使用 $agentflow-workflow-report，把版本、Sprint 或里程碑作为 projections.timeline 上报。kind、id 和 key 必须稳定；timeline 是当前 source 的完整切片，更新时保留本 source 仍有效的所有条目。`,
};

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

生产方上报有三个正式接口，TAPD 人员权限另有一个控制面接口；Action Checklist 还提供通用交互接口：
0. POST /api/workflows/access/sync：把 TAPD Owner 和参与人同步为 Workflow 派生权限；它不写业务状态。
1. GET /api/workflows/state：读取当前状态和 snapshot.resourceVersions。
2. POST /api/workflows/report：写全局信息、Action、普通产物、迭代投影或自定义区域。
3. POST /api/workflow-artifacts/publish：把本地 Markdown 内容发布成预览 URL。
4. GET/PATCH /api/workflows/checklist：读取或更新 Action 的逐项执行状态；不是 prd-flow 专属接口。

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
- owner/reporter 才能做普通上报；viewer、团队成员、分享链接、管理员代看只读。唯一例外是超级管理员显式使用 adminOperation=repair-version-membership，只能修复 kind=version 的 timeline 归属。
- globalState 只 patch 自己拥有的路径；对象递归合并，数组/标量替换。
- source 使用真实业务 Adapter 的稳定小写名称；agentflow-cli 只是传输工具。
- 同一 source + action.key 更新同一阶段，不为刷新或重试创建新 key。
- 有人工执行项时使用 action.checklist；生产方拥有定义，AgentFlow 单独保存逐项状态，重报 Action 不覆盖勾选结果。
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
  {
    method: "GET / PATCH",
    path: "/api/workflows/checklist",
    title: "Action Checklist",
    detail: "读取清单文档，或按 itemKey 保存执行状态、备注和证据。",
    permission: "读取同 Workflow；写入仅 owner / reporter",
    effect: "只更新 AgentFlow 托管的逐项状态，不推进外部业务系统",
  },
];

const STATE_QUERY_FIELDS = [
  ["workflow", "string", "二选一", "规范 Workflow key，例如 tapd:1020124"],
  ["namespace + id", "string", "二选一", "拆分传入身份；当前 namespace 仅支持 tapd"],
  ["runtimeOnly", "0 | 1", "否", "1 只读已保存运行态，不主动刷新上游"],
  ["adminOperation", "string", "管理员版本修复时", "仅 repair-version-membership；受限读取 runtimeRevision，服务端强制 runtime-only"],
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
  ["adminOperation", "string", "管理员特例", "仅 repair-version-membership；请求只能含 kind=version 的 projections.timeline，且必须带 expectedRevision 与 idempotencyKey"],
  ["adminReason", "string", "管理 UI 必填", "版本归属修复原因，最多 500 字符；写入管理员审计事件"],
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
  ["checklist", "object", "否", "通用执行清单定义；卡片只显示进度和标题，详情进入独立文档"],
];

const CHECKLIST_FIELDS = [
  ["schemaVersion", "number", "否", "当前固定为 1"],
  ["completionPolicy", "enum", "否", "all_required / any_required / manual；默认 all_required"],
  ["document.title", "string", "否", "独立详情文档标题"],
  ["items[].key", "string", "是", "Action 内稳定且唯一的条目 key"],
  ["items[].title", "string", "是", "Action 卡片只展示该标题"],
  ["items[].required", "boolean", "否", "是否参与完成策略，默认 true"],
  ["items[].evidenceRequired", "boolean", "否", "通过前是否必须提交证据链接"],
  ["items[].detail.summary", "string", "否", "独立文档内的条目摘要"],
  ["items[].detail.sections", "array", "否", "详情章节：key/title/content；content 可为文本或字符串数组"],
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
  ["timeline[].id", "string", "是", "业务对象稳定 ID；改名、改期或平台范围变化时不改变"],
  ["timeline[].key", "string", "建议", "建议 source:kind:id；不要拼入 platform 等筛选维度"],
  ["timeline[].title / date", "string", "否", "卡片标题和 YYYY-MM-DD 排期"],
  ["timeline[].source", "string", "建议", "条目所有者，用于 read-merge 时识别自有条目"],
  ["timeline[].dimensions", "object", "否", "平台、发布列车等不透明筛选维度；多值可使用数组"],
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

const TRIGGER_QUICKSTART = `# 1. 发现当前账号可运行的 Flow；不要猜 flowId / flowSource
node skills/agentflow-cli/scripts/agentflow-cli.mjs list-flows

# 2. 确认图、Run 节点和 Provide 输入名
node skills/agentflow-cli/scripts/agentflow-cli.mjs get-graph \\
  --flow-id <flow-id> \\
  --flow-source <source>

# 3. 触发整个 Flow；run 会保持连接并等待本次执行完成
node skills/agentflow-cli/scripts/agentflow-cli.mjs run \\
  --flow-id <flow-id> \\
  --flow-source <source> \\
  --input topic=hello

# 只触发某个 Run 节点时再提供：
# --run-node-id <run-node-id> --run-alias <readable-name>`;

const TRIGGER_MONITORING = `# run 尚未返回时，在另一个终端查询活动状态
node skills/agentflow-cli/scripts/agentflow-cli.mjs status \\
  --flow-id <flow-id> --flow-source <source>

# run 返回后查找历史 runId，再读取完整事件与节点日志
node skills/agentflow-cli/scripts/agentflow-cli.mjs list-run-by-workspace \\
  --workspace <flow-id> --flow-source <source> --limit 20
node skills/agentflow-cli/scripts/agentflow-cli.mjs logs --run-id <run-id>

# 单独读取当前图中 Display 节点的结构化输出
node skills/agentflow-cli/scripts/agentflow-cli.mjs display-outputs \\
  --flow-id <flow-id> --flow-source <source>`;

const TRIGGER_API_REQUEST = `# CLI 会先 GET 当前图，再提交运行；直接调用 API 也可以省略 graph，
# 此时服务端运行已经保存的当前图
GET /api/workspace/graph?flowId=<flow-id>&flowSource=<source>
Authorization: Bearer <AGENTFLOW_TOKEN>

POST /api/workspace/run
Authorization: Bearer <AGENTFLOW_TOKEN>
Content-Type: application/json

{
  "flowId": "<flow-id>",
  "flowSource": "<source>",
  "runNodeId": "",
  "runAlias": "release-build",
  "graph": "<可选：GET graph 返回的 graph 对象>",
  "inputs": { "topic": "hello" }
}`;

const TRIGGER_STATUS_RESPONSE = `{
  "running": true,
  "state": "running",
  "flowId": "<flow-id>",
  "flowSource": "user",
  "runs": [{
    "runId": "workspace-<id>",
    "runNodeId": "",
    "label": "release-build",
    "startedAt": 1785987600000,
    "plannedNodeIds": ["provide_job", "jenkins_build", "wecom_notify"],
    "scheduled": false,
    "state": "running"
  }]
}`;

const JENKINS_TRIGGER_COMMAND = `# 团队先在自己的 Project 创建包含 Jenkins Build 的 Flow，
# 再使用 list-flows 返回的真实 flowId / flowSource
node skills/agentflow-cli/scripts/agentflow-cli.mjs run \\
  --flow-id <team-jenkins-flow-id> \\
  --flow-source <source> \\
  --input job=like-android \\
  --input parameters='{"BRANCH":"develop"}' \\
  --input credential_ref=team-ci \\
  --input webhook_key=<configured-key>`;

const TRIGGER_AGENT_GUIDE = `使用 $agentflow-cli 触发 AgentFlow 中已经存在的 Flow。

1. 先执行 config，确认 AGENTFLOW_BASE_URL 与 AGENTFLOW_TOKEN 已配置；禁止打印 Token。
2. 执行 list-flows 发现目标，只使用返回的 flowId 和 flowSource，不凭名称猜测。
3. 执行 get-graph，确认 Run 节点以及 Provide 节点需要的 inputs；缺少业务参数就停止并列出缺项。
4. 执行 run，并把业务输入逐项作为 --input key=value 传入。run 命令会等待执行完成，不要在同一进程里再写 sleep 轮询。
5. 等待期间如需展示进度，从另一进程调用 status；完成后使用 list-run-by-workspace 找到 runId，再用 logs 查看节点事件。
6. 读取 run 返回的 displayOutputs；需要复查最终展示值时调用 display-outputs。
7. 401/403 立即停止并报告权限问题；409 说明与活动 Run 共享节点，不要并发重试；内置或归档 Flow 不可直接运行，应先保存为个人/团队 Flow。
8. /api/workflows/report 只用于 Workflow 页面上报与展示，绝不能拿它触发 Flow。`;

const TRIGGER_FIELDS = [
  ["flowId", "string", "是", "目标 Flow；必须来自 list-flows"],
  ["flowSource", "user | workspace", "是", "个人或团队来源；使用 list-flows 返回值"],
  ["runNodeId", "string", "否", "只运行某个 Run 节点及其计划子图；空值运行整张图"],
  ["runAlias", "string", "否", "本次运行在人类可读日志中的名称"],
  ["inputs", "object", "按图而定", "按 Provide 输入名传入的业务参数"],
  ["graph", "object", "否", "待运行图；省略时使用服务端已保存图，CLI 会自动 GET 并填入"],
];

const TOC_ITEMS = [
  ["api", "快速开始", "rocket_launch"],
  ["model", "区域模型", "account_tree"],
  ["renderers", "展示效果", "widgets"],
  ["trigger", "触发 Workflow", "play_circle"],
  ["reference", "参数参考", "data_object"],
  ["scenarios", "关键场景", "route"],
  ["safety", "权限与覆盖", "verified_user"],
  ["design", "设计思想", "architecture"],
  ["ai", "AI 引导", "smart_toy"],
];

const DISPLAY_EFFECTS = [
  { key: "overview", icon: "dashboard", title: "需求概览", target: "展示负责人、平台、分支、风险和链接", schema: "globalState.sections", minimum: OVERVIEW_MINIMAL_REPORT, complete: GENERIC_SECTION_REPORT },
  { key: "action", icon: "timeline", title: "Action 时间轴", target: "展示关键阶段、状态、详情和阶段证据", schema: "action + artifacts", minimum: ACTION_MINIMAL_REPORT, complete: ACTION_REPORT },
  { key: "checklist", icon: "checklist", title: "Action TodoList", target: "展示可展开的执行清单和完成进度", schema: "action.checklist", minimum: CHECKLIST_MINIMAL_REPORT, complete: CHECKLIST_REPORT },
  { key: "artifact", icon: "inventory_2", title: "产物与外链", target: "展示 Jenkins、测试报告和外部文档", schema: "artifacts", minimum: ARTIFACT_MINIMAL_REPORT, complete: ARTIFACT_COMPLETE_REPORT },
  { key: "timeline", icon: "event_upcoming", title: "迭代时间线", target: "按版本、Sprint 或里程碑归属需求", schema: "projections.timeline", minimum: TIMELINE_MINIMAL_REPORT, complete: VERSION_REPORT },
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
  ["action.checklist 状态", "每个 source + actionKey + itemKey 独立更新", "pending 可重置；定义由 Producer 管理", "带 expectedVersion，不能被 Action 重报覆盖"],
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
  ["超级管理员代看", "可读", "仅版本归属修复", "普通 Report 仍拒绝；显式审计操作只能改 kind=version timeline"],
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

function GenericChecklistPreview({ variant = "current" }) {
  const completed = variant === "completed";
  const blocked = variant === "blocked";
  const expanded = variant === "current";
  const completedCount = completed ? 3 : 1;
  const percent = completed ? 100 : 33;
  return (
    <div className={`af-prd-workflow-action af-prd-workflow-action--${completed ? "done" : blocked ? "blocked" : "current"} af-wr-render-preview`}>
      <div className="af-prd-workflow-action__rail"><span className="af-prd-workflow-action__dot" /></div>
      <div className="af-prd-workflow-action__body">
        <div className="af-prd-workflow-action__top"><div><div className="af-prd-workflow-action__title"><strong>发布检查</strong></div></div><span className="af-prd-workflow-action__status">{completed ? "完成" : blocked ? "阻塞" : "当前"}</span></div>
        <section className="af-prd-workflow-checklist">
          <div className="af-prd-workflow-checklist__head"><div><strong>执行清单</strong><span>{completedCount}/3</span></div><div><small>{percent}%</small><span className="material-symbols-outlined" aria-hidden>{expanded ? "expand_less" : "expand_more"}</span></div></div>
          <div className="af-prd-workflow-checklist__meter"><span style={{ width: `${percent}%` }} /></div>
          {expanded ? <>
            <div className="af-prd-workflow-checklist__items">
              <button type="button"><span className="af-prd-workflow-checklist__state is-passed"><span className="material-symbols-outlined" aria-hidden>check</span></span><strong>冒烟测试</strong><span className="material-symbols-outlined" aria-hidden>open_in_new</span></button>
              <button type="button"><span className="af-prd-workflow-checklist__state"><span className="material-symbols-outlined" aria-hidden>radio_button_unchecked</span></span><strong>核心指标检查</strong><span className="material-symbols-outlined" aria-hidden>open_in_new</span></button>
              <button type="button"><span className="af-prd-workflow-checklist__state"><span className="material-symbols-outlined" aria-hidden>radio_button_unchecked</span></span><strong>回滚预案确认</strong><span className="material-symbols-outlined" aria-hidden>open_in_new</span></button>
            </div>
            <button type="button" className="af-prd-workflow-checklist__open"><span>查看发布检查详情</span><span className="material-symbols-outlined" aria-hidden>open_in_new</span></button>
          </> : null}
        </section>
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

function DisplayEffectPreview({ effectKey, previewState }) {
  if (effectKey === "overview") return <GenericOverviewPreview />;
  if (effectKey === "action") return <GenericActionPreview />;
  if (effectKey === "artifact") return <GenericArtifactPreview />;
  if (effectKey === "timeline") return <GenericTimelinePreview />;
  return <GenericChecklistPreview variant={previewState} />;
}

function DisplayEffectsLab({ selectedEffect, onSelectEffect, copied, onCopy, onOpenDemo }) {
  const [codeMode, setCodeMode] = useState("minimum");
  const [previewState, setPreviewState] = useState("current");
  const effect = DISPLAY_EFFECTS.find((item) => item.key === selectedEffect) || DISPLAY_EFFECTS[0];
  const codeValue = codeMode === "agent" ? EFFECT_AGENT_GUIDES[effect.key] : codeMode === "complete" ? effect.complete : effect.minimum;
  const codeTitle = codeMode === "agent" ? "复制给 Agent 的实现要求" : codeMode === "complete" ? "完整上报示例" : "产生该效果的最小上报内容";
  return (
    <div className="af-wr-effects-lab">
      <div className="af-wr-effect-picker" aria-label="选择要展示的效果">
        {DISPLAY_EFFECTS.map((item) => (
          <button type="button" key={item.key} className={effect.key === item.key ? "is-active" : ""} onClick={() => { onSelectEffect(item.key); setCodeMode("minimum"); }}>
            <span className="material-symbols-outlined" aria-hidden>{item.icon}</span>
            <span><strong>{item.title}</strong><small>{item.target}</small><code>{item.schema}</code></span>
          </button>
        ))}
      </div>
      <div className="af-wr-effect-workbench">
        <section className="af-wr-effect-preview">
          <header>
            <div><small>最终展示效果</small><h3>{effect.title}</h3><p>{effect.target}</p></div>
            {effect.key === "checklist" ? (
              <div className="af-wr-effect-states" aria-label="预览 Action 状态">
                {[["current", "当前"], ["completed", "已完成"], ["blocked", "阻塞"]].map(([value, label]) => <button type="button" key={value} className={previewState === value ? "is-active" : ""} onClick={() => setPreviewState(value)}>{label}</button>)}
              </div>
            ) : null}
          </header>
          <div className="af-wr-effect-preview__canvas"><DisplayEffectPreview effectKey={effect.key} previewState={previewState} /></div>
          <footer><span className="material-symbols-outlined" aria-hidden>info</span><p>这是 Workflow 页面使用的真实样式。用户只需上报语义数据，AgentFlow 负责选择并渲染组件。</p>{effect.key === "checklist" ? <button type="button" onClick={onOpenDemo}>打开可操作预览</button> : null}</footer>
        </section>
        <section className="af-wr-effect-recipe">
          <header>
            <div><small>上报配方</small><h3>要传什么内容</h3></div>
            <div className="af-wr-effect-code-tabs" role="tablist" aria-label="示例类型">
              {[["minimum", "最小 JSON"], ["complete", "完整示例"], ["agent", "交给 Agent"]].map(([value, label]) => <button type="button" role="tab" aria-selected={codeMode === value} key={value} className={codeMode === value ? "is-active" : ""} onClick={() => setCodeMode(value)}>{label}</button>)}
            </div>
          </header>
          <CodePanel title={codeTitle} value={codeValue} copyKey={`effect-${effect.key}-${codeMode}`} copied={copied} onCopy={onCopy} wrap={codeMode === "agent"} />
          <div className="af-wr-effect-rules"><strong>接入规则</strong><span>使用稳定 source 和业务 key</span><span>写前读取 resourceVersions</span><span>上报后再次 GET 验证</span></div>
        </section>
      </div>
    </div>
  );
}

function TriggerWorkflowLifecycle() {
  const steps = [
    ["search", "发现", "list-flows", "找到真实 flowId / source"],
    ["account_tree", "确认输入", "get-graph", "检查 Run 与 Provide 节点"],
    ["play_arrow", "触发", "run", "提交 inputs 并保持连接"],
    ["monitor_heart", "观察", "status", "从另一进程读取活动状态"],
    ["task_alt", "取结果", "logs / outputs", "查看终态、URL 和展示输出"],
  ];
  return (
    <div className="af-wr-trigger-lifecycle" aria-label="Workflow 触发生命周期">
      {steps.map(([icon, title, command, detail], index) => (
        <div className="af-wr-trigger-lifecycle__item" key={command}>
          <article>
            <span className="material-symbols-outlined" aria-hidden>{icon}</span>
            <small>STEP {index + 1}</small>
            <strong>{title}</strong>
            <code>{command}</code>
            <p>{detail}</p>
          </article>
          {index < steps.length - 1 ? <i className="material-symbols-outlined" aria-hidden>arrow_forward</i> : null}
        </div>
      ))}
    </div>
  );
}

export default function WorkflowReportGuidePage() {
  const { navigate } = useRoute();
  const [copied, setCopied] = useState("");
  const [activeSection, setActiveSection] = useState(() => {
    const requested = new URLSearchParams(window.location.search).get("tab") || "api";
    return TOC_ITEMS.some(([id]) => id === requested) ? requested : "api";
  });
  const [selectedEffect, setSelectedEffect] = useState(() => {
    const requested = new URLSearchParams(window.location.search).get("effect") || "checklist";
    return DISPLAY_EFFECTS.some((item) => item.key === requested) ? requested : "checklist";
  });
  const copy = useCallback(async (key, value) => {
    setCopied(await copyTextToClipboard(value) ? key : `failed:${key}`);
  }, []);
  const updateGuideLocation = useCallback((tab, effect = selectedEffect) => {
    const params = new URLSearchParams(window.location.search);
    params.set("tab", tab);
    if (effect) params.set("effect", effect);
    window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
  }, [selectedEffect]);
  const selectSection = useCallback((section) => {
    setActiveSection(section);
    updateGuideLocation(section);
    document.querySelector(".af-wr-page")?.scrollTo?.({ top: 0, behavior: "smooth" });
  }, [updateGuideLocation]);
  const selectEffect = useCallback((effect) => {
    setSelectedEffect(effect);
    updateGuideLocation("renderers", effect);
  }, [updateGuideLocation]);

  return (
    <div className="af-wr-page">
      <div className="af-wr-inner">
        <section className="af-wr-hero">
          <div>
            <span className="af-wr-kicker">WORKFLOW REPORT · API REFERENCE</span>
            <h1>Workflow 接入文档</h1>
            <p>用 3 个生产方上报接口、1 个 Checklist 交互接口和 1 个权限控制面接口，把人员权限、全局信息、Action 时间轴、执行清单、产物链接、迭代归属和自定义面板接入 AgentFlow；也可以在独立 Tab 查看如何触发平台已有 Flow 并等待结果。数据协议面向任意 Adapter；当前服务端的 Workflow 身份与权限适配器只支持 TAPD，prd-flow 仅作为 TAPD 研发场景的参考实现。</p>
            <div className="af-wr-hero__boundary"><strong>当前边界</strong><span>可接入任意事实来源</span><i>·</i><span>Workflow key 目前必须是 tapd:&lt;short-id&gt;</span></div>
          </div>
          <div className="af-wr-hero__actions">
            <button type="button" onClick={() => navigate("/workflows")}>
              <span className="material-symbols-outlined" aria-hidden>arrow_back</span>
              返回 Workflow Dashboard
            </button>
            <button type="button" className="is-primary" onClick={() => void copy("ai", AI_GUIDE)}>
              <span className="material-symbols-outlined" aria-hidden>{copied === "ai" ? "check" : "smart_toy"}</span>
              {copied === "ai" ? "已复制 AI 引导" : "复制 AI 接入引导"}
            </button>
          </div>
        </section>

        <div className="af-wr-doc-shell">
          <nav className="af-wr-toc" aria-label="接入文档目录">
            <strong>接入文档</strong>
            {TOC_ITEMS.map(([id, label, icon]) => <button type="button" key={id} className={activeSection === id ? "is-active" : ""} aria-current={activeSection === id ? "page" : undefined} onClick={() => selectSection(id)}><span className="material-symbols-outlined" aria-hidden>{icon}</span><span>{label}</span>{id === "renderers" ? <em>效果 → JSON</em> : id === "trigger" ? <em>执行 → 结果</em> : null}</button>)}
          </nav>
          <main className="af-wr-doc-content">

        <section className="af-wr-section" id="api" hidden={activeSection !== "api"}>
          <SectionHead number="01" title="5 分钟跑通一次上报" detail="生产方上报接口保持三个，Checklist 的人工执行状态由独立通用交互接口维护，人员权限由控制面接口同步。先准备登录 Token 和稳定 source，再执行 access sync → read → merge → report → verify；旧 /api/prd-workflow/* 仅为兼容入口。" />
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

        <section className="af-wr-section" id="model" hidden={activeSection !== "model"}>
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

        <section className="af-wr-section" id="renderers" hidden={activeSection !== "renderers"}>
          <SectionHead number="03" title="想展示这种效果，应该上报什么？" detail="先选择目标 UI 效果，再复制最小 JSON、完整请求或交给 Agent 的实现要求。预览使用与 Workflow 详情页相同的样式和折叠规则。" />
          <DisplayEffectsLab selectedEffect={selectedEffect} onSelectEffect={selectEffect} copied={copied} onCopy={copy} onOpenDemo={() => navigate("/workflow-checklist?demo=1")} />
          <div className="af-wr-renderer-notice">
            <span className="material-symbols-outlined" aria-hidden>info</span>
            <p><strong>当前可直接使用的通用渲染器：</strong>负责人、平台、分支、风险列表、文档链接等，直接使用 <code>globalState.sections</code>，普通自定义信息不要放进 extensions。只有通用组件无法表达的树形结构、复杂交互或专用业务面板，才需要 <code>extensions</code> 和前端 renderer。</p>
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
          <div className="af-wr-renderer-feature">
            <div className="af-wr-renderer-feature__copy">
              <span>GENERIC · NEW FEATURE</span>
              <h3>Action Checklist / 独立详情文档</h3>
              <p>任意 Workflow Report 客户端都可以在 Action 中声明执行清单。时间轴卡片只显示完成进度和条目标题；点击后进入独立文档查看步骤、预期结果、备注和证据。</p>
              <dl>
                <div><dt>Producer</dt><dd>拥有 Action、条目标题和详情定义</dd></div>
                <div><dt>AgentFlow</dt><dd>单独保存状态、证据、操作者和版本</dd></div>
                <div><dt>重报安全</dt><dd>Action 刷新不会覆盖人工勾选结果</dd></div>
                <div><dt>客户端</dt><dd>release-bot、验收机器人、prd-flow 等均可接入</dd></div>
              </dl>
              <button type="button" className="af-wr-demo-link" onClick={() => navigate("/workflow-checklist?demo=1")}>打开本地 Todo 预览 <span className="material-symbols-outlined" aria-hidden>arrow_forward</span></button>
            </div>
            <GenericChecklistPreview />
          </div>
          <div className="af-wr-code-grid">
            <CodePanel title="非 prd-flow 客户端：上报发布检查" value={CHECKLIST_REPORT} copyKey="checklist-report" copied={copied} onCopy={copy} />
            <CodePanel title="AgentFlow 交互态：标记条目通过" value={CHECKLIST_UPDATE} copyKey="checklist-update" copied={copied} onCopy={copy} />
          </div>
          <div className="af-wr-extension-registry">
            <div><span>REGISTERED EXTENSION</span><h3><code>extensions["prd-flow"]</code></h3><p>当前唯一已注册的专用 extension renderer。支持 AI Docs 链接列表和带父子层级、平台、MR 状态及关联链接的 Issues 树。</p><PrdFlowExtensionPreview /></div>
            <div><strong>其他 namespace 当前如何显示？</strong><p>数据会被保存并参与 revision，但不会自动出现面板。若现有 sections / Action / Artifact / timeline 足够，应优先使用通用组件；确实需要新布局时，再提交扩展 schema、空态/错误态、响应式样式和 renderer 实现。</p></div>
          </div>
        </section>

        <section className="af-wr-section" id="trigger" hidden={activeSection !== "trigger"}>
          <SectionHead number="04" title="触发预设 Flow，并等待最终结果" detail="面向用户、Agent 和外部系统说明如何找到可运行 Flow、传入 Provide 参数、观察执行状态并读取最终输出。这里调用的是 Workspace Run；Workflow Report 只负责把事实上报到需求页面，两者不能混用。" />

          <div className="af-wr-trigger-boundary">
            <div><span className="material-symbols-outlined" aria-hidden>play_circle</span><p><strong>触发执行</strong><code>POST /api/workspace/run</code><small>真正运行节点、等待任务并产出结果</small></p></div>
            <i className="material-symbols-outlined" aria-hidden>compare_arrows</i>
            <div><span className="material-symbols-outlined" aria-hidden>dashboard</span><p><strong>上报展示</strong><code>POST /api/workflows/report</code><small>记录业务事实，不会启动 Jenkins 或其他 Flow</small></p></div>
          </div>

          <TriggerWorkflowLifecycle />

          <div className="af-wr-trigger-semantics">
            <article><span>同步调用</span><strong>run 等到终态再返回</strong><p>CLI 的 <code>run</code> 会自动读取当前 graph、提交 inputs，并保持请求直到本次运行成功、失败或停止。返回内容已经包含最终 graph 和 <code>displayOutputs</code>。</p></article>
            <article><span>活动进度</span><strong>status 只看正在运行</strong><p>需要在等待期间展示进度时，从另一进程调用 <code>status</code>。运行结束后活动状态会消失，历史结果应通过 run logs 查询。</p></article>
            <article><span>历史证据</span><strong>先找 runId，再读日志</strong><p><code>list-run-by-workspace</code> 返回历史记录；拿到 <code>runId</code> 后用 <code>logs</code> 查看节点事件、失败原因和终态。</p></article>
          </div>

          <div className="af-wr-code-grid af-wr-trigger-commands">
            <CodePanel title="发现、确认并触发" value={TRIGGER_QUICKSTART} copyKey="trigger-quickstart" copied={copied} onCopy={copy} />
            <CodePanel title="运行中观察与完成后取证" value={TRIGGER_MONITORING} copyKey="trigger-monitoring" copied={copied} onCopy={copy} />
          </div>

          <article className="af-wr-endpoint af-wr-trigger-api">
            <EndpointHeader method="POST" path="/api/workspace/run" title="运行整个 Flow 或指定 Run 节点" permission="Flow owner / runnable collaborator" effect="执行节点并写入运行态与日志" />
            <p className="af-wr-endpoint__intro">推荐使用 CLI：它会先读取服务端当前图，再提交运行。直接调用 API 可以携带 <code>graph</code>，省略时服务端使用已经保存的当前图；非流式请求在终态返回，若要消费逐节点事件，可发送 <code>Accept: application/x-ndjson</code>。</p>
            <FieldTable rows={TRIGGER_FIELDS} label="Workflow trigger 参数" />
            <div className="af-wr-code-grid">
              <CodePanel title="直接调用 API 的请求结构" value={TRIGGER_API_REQUEST} copyKey="trigger-api" copied={copied} onCopy={copy} />
              <CodePanel title="GET /api/workspace/run/status 活动响应" value={TRIGGER_STATUS_RESPONSE} copyKey="trigger-status" copied={copied} onCopy={copy} />
            </div>
          </article>

          <div className="af-wr-trigger-jenkins">
            <div className="af-wr-trigger-jenkins__copy">
              <span>TEAM FLOW EXAMPLE · JENKINS</span>
              <h3>构建完成后发送企业微信</h3>
              <p>团队在自己的 Project 中创建并维护构建通知 Flow，平台只提供通用的 <code>Jenkins Build</code> 节点，不安装预制 Workflow。下方仅说明推荐连接方式与触发参数。</p>
              <div className="af-wr-trigger-graph">
                <span>Provide<br /><small>job / parameters</small></span><i>→</i>
                <span className="is-running">Jenkins Build<br /><small>内部等待 queued → running → complete</small></span><i>→</i>
                <span>企业微信<br /><small>status / url / qrUrl</small></span>
              </div>
              <ul><li>Jenkins 凭据使用 <code>credential_ref</code>，不要把用户名、Token 写入 Flow。</li><li>节点内部持久化等待构建结果，外层不需要自行循环或阻塞 sleep。</li><li>最终直接消费 <code>status</code>、<code>url</code>、可选 <code>qrUrl</code>；完整诊断信息留在运行日志。</li></ul>
            </div>
            <CodePanel title="like-android 构建示例" value={JENKINS_TRIGGER_COMMAND} copyKey="trigger-jenkins" copied={copied} onCopy={copy} />
          </div>

          <div className="af-wr-trigger-errors">
            <div><code>400</code><p>内置/归档 Flow 不可运行，或参数、图结构无效</p></div>
            <div><code>401 / 403</code><p>Token 缺失，或当前协作者没有 runnable 权限</p></div>
            <div><code>409</code><p>本次计划与活动 Run 共享节点；等待现有 Run 结束</p></div>
            <div><code>failed / stopped</code><p>读取 logs 定位节点错误；不要用盲目循环掩盖失败</p></div>
          </div>

          <CodePanel title="复制给 Agent：安全触发已有 Workflow" value={TRIGGER_AGENT_GUIDE} copyKey="trigger-agent" copied={copied} onCopy={copy} wrap />
        </section>

        <section className="af-wr-section" id="reference" hidden={activeSection !== "reference"}>
          <SectionHead number="05" title="接口与参数参考" detail="以下字段来自当前服务端真实校验与合并逻辑；可以按区域只提交本次需要更新的部分。" />

          <article className="af-wr-endpoint">
            <EndpointHeader method="POST" path="/api/workflows/access/sync" title="同步 TAPD 派生权限" permission="首次：TAPD Owner；后续：当前 Owner / 管理员" effect="只改权限控制面，不写运行态" />
            <p className="af-wr-endpoint__intro">Adapter 读取 TAPD Story 后，先把 Owner 与参与人同步到 AgentFlow。Owner 必须已注册 AgentFlow；未匹配的参与人会在 <code>unresolvedParticipants</code> 中返回，注册后下次同步即可获得 Viewer。</p>
            <FieldTable rows={ACCESS_SYNC_FIELDS} label="Workflow access sync 参数" />
            <CodePanel title="权限同步请求" value={ACCESS_SYNC_REQUEST} copyKey="access-sync" copied={copied} onCopy={copy} />
            <div className="af-wr-callout"><span className="material-symbols-outlined" aria-hidden>security</span><p><strong>派生权限与显式授权分开保存。</strong>TAPD 参与人只自动获得 Viewer；Owner 可在 Workflow 分享弹窗把某人提升为 Reporter。后续 TAPD 同步会替换派生参与人，但不会覆盖显式授权。</p></div>
          </article>

          <article className="af-wr-endpoint">
            <EndpointHeader method="GET" path="/api/workflows/state" title="读取当前 Workflow" permission="owner / reporter / viewer / team viewer / share viewer；管理员显式版本修复意图" effect="无" />
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
            <EndpointHeader method="POST" path="/api/workflows/report" title="统一上报 Workflow" permission="owner / reporter；管理员仅限显式版本归属修复" effect="修改运行态并返回新 snapshot" />
            <p className="af-wr-endpoint__intro">至少提交 observation、globalState、action、artifacts、projections、extensions 之一。一次请求可以组合多个区域：每个业务 key 独立校验版本，任一冲突则整次请求原子失败，不会只写入一半。</p>
            <h4>Envelope</h4>
            <FieldTable rows={REPORT_FIELDS} label="Workflow Report 顶层参数" />
            <div className="af-wr-subreference">
              <div><h4>action</h4><p>业务阶段，不是运行日志。</p><FieldTable rows={ACTION_FIELDS} label="Action 参数" /></div>
              <div><h4>artifacts</h4><p>已有 HTTP URL 的证据直接上报。</p><FieldTable rows={ARTIFACT_FIELDS} label="Artifact 参数" /></div>
            </div>
            <div className="af-wr-subreference">
              <div><h4>action.checklist</h4><p>面向任意客户端的执行清单定义；不承载人工运行态。</p><FieldTable rows={CHECKLIST_FIELDS} label="Action Checklist 参数" /></div>
              <div className="af-wr-result-list"><h4>定义与状态分离</h4><p>Producer 通过 Report 更新清单定义。</p><p>AgentFlow 通过 Checklist API 保存逐项状态。</p><p>逐项资源 key 为 <code>checklist:&lt;source&gt;:&lt;actionKey&gt;:&lt;itemKey&gt;</code>。</p><strong>重新上报 Action 不会覆盖已经填写的状态、备注和证据。</strong></div>
            </div>
            <div className="af-wr-schema-reference">
              <article><h4>observation</h4><p>同一 clientId 的完整生产方观察。</p><FieldTable rows={OBSERVATION_FIELDS} label="Observation 参数" /></article>
              <article><h4>globalState</h4><p>可独立更新的全局事实和通用分区。</p><FieldTable rows={GLOBAL_STATE_FIELDS} label="Global State 参数" /></article>
              <article><h4>globalState.sections</h4><p>无需前端开发的通用字段渲染器。</p><FieldTable rows={SECTION_FIELDS} label="Global State Section 参数" /></article>
              <article><h4>projections.timeline</h4><p>个人/团队 Dashboard 使用的可重建索引。</p><FieldTable rows={PROJECTION_FIELDS} label="Timeline Projection 参数" /></article>
              <article><h4>extensions</h4><p>只有专用 renderer 才能显示的 namespace 数据。</p><FieldTable rows={EXTENSION_FIELDS} label="Workflow Extensions 参数" /></article>
            </div>
            <p className="af-wr-table-note"><strong>生产方隔离：</strong>Action、Artifact、Projection、Observation 和 Extension 都使用带 <code>source</code> 的资源 key；不同 source 可以复用相同业务 key。<code>globalState</code> 按叶子路径分 key 并记录首次写入者，不能覆盖其他 source 的路径；timeline 只替换当前 source 的切片。</p>
            <div className="af-wr-callout"><span className="material-symbols-outlined" aria-hidden>admin_panel_settings</span><p><strong>管理员版本归属修复是唯一窄写例外。</strong>先在 GET state 显式携带 <code>adminOperation=repair-version-membership</code> 读取当前 <code>runtimeRevision</code>；再用同一意图执行 Report。Report 只能包含 <code>kind=version</code> 的 <code>projections.timeline</code>，并提供整 Workflow 的 <code>expectedRevision</code> 与幂等键；管理 UI 还必须填写 <code>adminReason</code>。version id 必须是版本自身的稳定 ID，不能使用 TAPD 需求 ID。Action、Artifact、observation、globalState、extensions 和非版本投影都会被拒绝；事件记录管理员 actor、原因和时间供审计。</p></div>
            <CodePanel title="管理员：读取版本修复严格锁" value={ADMIN_VERSION_REPAIR_READ} copyKey="admin-version-repair-read" copied={copied} onCopy={copy} />
            <CodePanel title="管理员：仅修复版本归属" value={ADMIN_VERSION_REPAIR} copyKey="admin-version-repair" copied={copied} onCopy={copy} />
          </article>

          <article className="af-wr-endpoint">
            <EndpointHeader method="GET / PATCH" path="/api/workflows/checklist" title="读取或更新 Action Checklist" permission="读取：Workflow viewer；写入：owner / reporter" effect="只改 AgentFlow 逐项运行态，不推进外部业务" />
            <p className="af-wr-endpoint__intro">GET 使用 workflow、source、actionKey 定位清单；PATCH 再提供 itemKey、status、expectedVersion，可附带 note 和 evidence。状态支持 pending、passed、failed、blocked、skipped。</p>
            <div className="af-wr-publish-layout">
              <div className="af-wr-result-list"><h4>完成语义</h4><p>卡片进度由服务端从逐项状态计算。</p><p>达到 completionPolicy 时显示“可确认完成”。</p><p>真正的业务完成仍由生产方命令或上游系统确认。</p><strong>在页面勾选不会静默修改 TAPD、GitLab、Jenkins 或调用方本地工作区。</strong></div>
              <CodePanel title="逐项状态更新" value={CHECKLIST_UPDATE} copyKey="checklist-reference" copied={copied} onCopy={copy} />
            </div>
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

        <section className="af-wr-section" id="scenarios" hidden={activeSection !== "scenarios"}>
          <SectionHead number="06" title="五个关键接入场景" detail="同时给出 prd-flow 与非研发客户端示例；prd-flow 是 TAPD 研发流程的一种实现，不是协议依赖。" />
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
          <div className="af-wr-scenario">
            <div className="af-wr-scenario__copy"><span>场景 D · NEW FEATURE</span><h3>让 Action 带可执行 Checklist</h3><ol><li>release-bot 等任意 Adapter 用稳定 action.key 和 items[].key 上报定义。</li><li>卡片只显示进度和标题，完整内容进入独立详情文档。</li><li>Owner/Reporter 用通用 Checklist API 写状态、备注和证据；Viewer 只读。</li><li>业务完成由 Adapter 读取运行态后确认，AgentFlow 不替它修改外部系统。</li></ol><p>prd-flow 自测只是首个参考接入；发布验收、运营检查、合规审阅等客户端使用同一能力。</p></div>
            <CodePanel title="release-bot 通用 Checklist" value={CHECKLIST_REPORT} copyKey="checklist-scenario" copied={copied} onCopy={copy} />
          </div>
          <div className="af-wr-scenario">
            <div className="af-wr-scenario__copy"><span>场景 E · ADMIN AUDIT</span><h3>批量修复错误的版本归属</h3><ol><li>管理员用 <code>adminOperation=repair-version-membership</code> GET 当前 Workflow，保存 <code>runtimeRevision</code>。</li><li>核对版本自身的稳定 ID；不能把 TAPD 需求 ID 当作 version id。</li><li>Report 使用同一意图，只提交目标 source 的 version 切片，并填写 <code>adminReason</code>。</li><li>服务端保留该 source 的非版本投影及其他 source 数据，并记录管理员 actor、原因和时间。</li><li>发生并发变化返回 409；刷新后重新核对，只重试一次。</li></ol><p>这不是 Reporter 替代方案。普通 Workflow Report、Action 和业务状态写入仍必须由 Owner 或 Reporter 完成。</p></div>
            <CodePanel title="管理员版本归属修复" value={ADMIN_VERSION_REPAIR} copyKey="admin-version-scenario" copied={copied} onCopy={copy} />
          </div>
        </section>

        <section className="af-wr-section" id="safety" hidden={activeSection !== "safety"}>
          <SectionHead number="07" title="权限、覆盖和冲突" detail="接入前必须明确谁能写、每个区域怎么更新，以及冲突发生时是否可能误删其他生产方的数据。" />
          <div className="af-wr-safety-grid">
            <div><h3>权限矩阵</h3><FieldTable columns={["身份", "读取", "上报", "说明"]} rows={PERMISSIONS} label="Workflow 权限矩阵" /><p className="af-wr-table-note">完成 TAPD 权限同步后，Owner 和参与人以 TAPD 为准；参与人默认只读。尚未同步过的历史 Workflow 保留原 Owner，直到当前 Owner 或管理员执行首次同步。</p></div>
            <div><h3>覆盖矩阵</h3><FieldTable columns={["区域", "重复上报", "删除/清空", "接入方责任"]} rows={OVERWRITE_RULES} label="Workflow 覆盖矩阵" /></div>
          </div>
          <div className="af-wr-conflict-flow"><span>GET snapshot.resourceVersions</span><i>→</i><span>计算触及的 resource keys</span><i>→</i><span>POST + expectedVersions + idempotencyKey</span><i>→</i><span>409 时只刷新冲突 key / 重算 / 重试一次</span></div>
          <div className="af-wr-errors">
            <div><code>400</code><p>字段或 schema 错误；按协议修正</p></div><div><code>401</code><p>缺少认证；停止并配置 Token</p></div><div><code>403</code><p>普通写入无权限；由 Owner 授权 Reporter，版本治理才使用管理员修复模式</p></div><div><code>409</code><p>资源 key 冲突、路径属于其他 source，或权限快照过旧</p></div>
          </div>
        </section>

        <section className="af-wr-section" id="design" hidden={activeSection !== "design"}>
          <SectionHead number="08" title="设计思想与运行关系" detail="业务解释留在 Adapter，传输和存储保持通用；这样新生产方不需要复制 prd-flow 的 TAPD 私有模型。" />
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

        <section className="af-wr-section af-wr-ai" id="ai" hidden={activeSection !== "ai"}>
          <SectionHead number="09" title="给 AI 的接入引导" detail="复制后交给 AI，它会先输出事实到页面区域的映射，再按真实协议实现。" />
          <CodePanel title="$agentflow-workflow-report" value={AI_GUIDE} copyKey="ai-bottom" copied={copied} onCopy={copy} wrap />
        </section>
          </main>
        </div>
      </div>
    </div>
  );
}
