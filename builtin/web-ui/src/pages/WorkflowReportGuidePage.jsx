import { useCallback, useState } from "react";
import { useRoute } from "../routeContext.jsx";
import "./WorkflowReportGuidePage.css";

const INSTALL_COMMANDS = `# 安装通用 CLI
skillhub install agentflow-cli --global --agent codex

# 安装 Workflow 上报规格 Skill
skillhub install agentflow-workflow-report --global --agent codex

# 配置鉴权；不要把 Token 写进上报内容
export AGENTFLOW_TOKEN=<your-token>
# 本地联调时再覆盖：
# export AGENTFLOW_BASE_URL=http://127.0.0.1:8875`;

const READ_COMMAND = `node skills/agentflow-cli/scripts/agentflow-cli.mjs workflow-get \\
  --workflow tapd:1015046 \\
  --runtime-only`;

const REPORT_COMMAND = `node skills/agentflow-cli/scripts/agentflow-cli.mjs workflow-report \\
  --workflow tapd:1015046 \\
  --file workflow-report.json \\
  --expected-revision 'runtime:current-revision' \\
  --idempotency-key 'implementation-finished:android:issue-2:v1'`;

const REPORT_EXAMPLE = `{
  "schemaVersion": 1,
  "workflow": { "namespace": "tapd", "id": "1015046" },
  "source": "prd-flow",
  "action": {
    "key": "implementation:android:issue-2",
    "title": "Android 实现完成",
    "status": "done",
    "group": "implementation",
    "platform": "android",
    "issueKey": "issue-2"
  },
  "artifacts": [{
    "key": "implementation-mr:issue-2:android",
    "type": "gitlab-mr",
    "title": "Android 实现 MR",
    "url": "https://git.example.test/merge_requests/123",
    "scope": "action",
    "status": "ready"
  }],
  "globalState": {
    "mode": "merge",
    "patch": {
      "producerOwnedState": { "status": "implementing" }
    },
    "remove": []
  },
  "projections": {
    "timeline": [{
      "kind": "version",
      "id": "android-5.63.0",
      "title": "Likee Android 5.63.0",
      "date": "2026-08-20",
      "source": "prd-flow",
      "dimensions": { "platform": "android" }
    }]
  }
}`;

const AI_GUIDE = `请使用 $agentflow-workflow-report 为当前生产方接入 AgentFlow Workflow 上报。

目标：
1. 生产方自行定义并维护 globalState 的业务格式，AgentFlow 不解析其私有字段。
2. 从生产方当前状态确定性生成完整的 projections.timeline，用于个人和团队迭代汇总。
3. 支持 action、artifacts、globalState 和 projections 的组合或独立上报。

执行要求：
1. 完整阅读 Skill 中 references/protocol.md 的协议规格。
2. 先用 workflow-get 读取当前 snapshot，并保留 runtimeRevision。
3. 只合并本次语义变化，不覆盖不属于生产方的 globalState 字段。
4. timeline 每项必须有稳定的 kind 和 id；title/date 变化不能改变身份；dimensions 保持通用，不在 AgentFlow 中硬编码平台或版本结构。
5. projections.timeline 出现时必须发送当前完整数组；用空数组显式清空；省略 projections 表示不修改。
6. workflow-report 必须携带 expectedRevision 和稳定 idempotencyKey。
7. 遇到 409 时重新读取、重放语义修改，只重试一次；禁止用旧快照覆盖。
8. 不得在命令、日志、产物或最终回复中打印 Token。
9. 完成后验证返回 snapshot，并确认个人/团队迭代页面的时间线聚合正确。

请先检查现有生产方的数据模型和上报链路，再给出最小兼容改造并执行测试。`;

const CAPABILITIES = [
  ["action", "进度事实", "用稳定 key 上报阶段、状态和发生时间。"],
  ["artifacts", "证据产物", "关联 MR、文档、看板或其他可审查证据。"],
  ["globalState", "生产方状态", "只定义 merge/remove 操作，不限定业务数据结构。"],
  ["projections", "通用投影", "以完整替换语义提供版本、Sprint、里程碑等时间线归属。"],
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

function CodePanel({ title, value, copyKey, copied, onCopy }) {
  return (
    <div className="af-wr-code-panel">
      <div className="af-wr-code-panel__head">
        <span>{title}</span>
        <button type="button" onClick={() => void onCopy(copyKey, value)}>
          <span className="material-symbols-outlined" aria-hidden>{copied === copyKey ? "check" : "content_copy"}</span>
          {copied === copyKey ? "已复制" : copied === "failed" ? "复制失败" : "复制"}
        </button>
      </div>
      <pre>{value}</pre>
    </div>
  );
}

export default function WorkflowReportGuidePage() {
  const { navigate } = useRoute();
  const [copied, setCopied] = useState("");
  const copy = useCallback(async (key, value) => {
    setCopied(await copyTextToClipboard(value) ? key : "failed");
  }, []);

  return (
    <div className="af-wr-page">
      <div className="af-wr-inner">
        <section className="af-wr-hero">
          <div className="af-wr-hero__copy">
            <span className="af-wr-kicker">WORKFLOW REPORTING PROTOCOL · V1</span>
            <h1>Workflow 上报接入</h1>
            <p>为 prd-flow 和其他生产方提供稳定的 Action、产物、全局状态与时间线投影上报协议。业务格式由生产方维护，AgentFlow 只负责安全物化与通用汇总。</p>
            <div className="af-wr-hero__actions">
              <button type="button" className="is-primary" onClick={() => void copy("ai", AI_GUIDE)}>
                <span className="material-symbols-outlined" aria-hidden>{copied === "ai" ? "check" : "smart_toy"}</span>
                {copied === "ai" ? "已复制 AI 引导" : "复制 AI 接入引导"}
              </button>
              <button type="button" onClick={() => navigate("/workflows")}>查看迭代汇总</button>
            </div>
          </div>
          <div className="af-wr-boundary" aria-label="协议边界">
            <span className="material-symbols-outlined" aria-hidden>schema</span>
            <strong>一个明确边界</strong>
            <p>globalState 是生产方事实；projections 是 AgentFlow 通用索引。</p>
            <ul>
              <li>不解析业务私有字段</li>
              <li>不复制第二份业务真相</li>
              <li>用 revision 和幂等键保护写入</li>
            </ul>
          </div>
        </section>

        <section className="af-wr-section">
          <div className="af-wr-section__head">
            <span>01</span>
            <div><h2>上报能力</h2><p>同一个报告可以组合这些能力，也可以只同步其中一种。</p></div>
          </div>
          <div className="af-wr-capabilities">
            {CAPABILITIES.map(([key, title, detail]) => (
              <article key={key}>
                <code>{key}</code>
                <h3>{title}</h3>
                <p>{detail}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="af-wr-section">
          <div className="af-wr-section__head">
            <span>02</span>
            <div><h2>接入流程</h2><p>必须使用 read → merge → report 顺序，不允许直接覆盖远端状态。</p></div>
          </div>
          <div className="af-wr-flow" aria-label="接入流程">
            {[
              ["1", "读取", "workflow-get 获取当前 snapshot 和 runtimeRevision"],
              ["2", "计算", "合并本次语义变化，并从生产方状态派生完整投影"],
              ["3", "上报", "携带 expectedRevision 和稳定 idempotencyKey"],
              ["4", "验证", "检查返回快照以及个人/团队时间线聚合"],
            ].map(([number, title, detail]) => (
              <div key={number}><span>{number}</span><strong>{title}</strong><p>{detail}</p></div>
            ))}
          </div>
          <div className="af-wr-code-grid">
            <CodePanel title="安装与配置" value={INSTALL_COMMANDS} copyKey="install" copied={copied} onCopy={copy} />
            <div className="af-wr-code-stack">
              <CodePanel title="读取当前状态" value={READ_COMMAND} copyKey="read" copied={copied} onCopy={copy} />
              <CodePanel title="提交报告" value={REPORT_COMMAND} copyKey="report" copied={copied} onCopy={copy} />
            </div>
          </div>
        </section>

        <section className="af-wr-section">
          <div className="af-wr-section__head">
            <span>03</span>
            <div><h2>协议示例</h2><p>这里的 globalState 仅为占位，真实结构由 prd-flow 或其他生产方决定。</p></div>
          </div>
          <div className="af-wr-contract">
            <CodePanel title="workflow-report.json" value={REPORT_EXAMPLE} copyKey="payload" copied={copied} onCopy={copy} />
            <div className="af-wr-rules">
              <h3>写入约束</h3>
              <ul>
                <li><strong>Action：</strong>必须有稳定 key。</li>
                <li><strong>Artifact：</strong>使用稳定 key，不依赖标题去重。</li>
                <li><strong>Global State：</strong>只 patch 自己拥有的字段；数组为替换语义。</li>
                <li><strong>Timeline：</strong>每项必须有 kind 和 id；出现时发送完整数组。</li>
                <li><strong>清空归属：</strong>发送 <code>{`{"projections":{"timeline":[]}}`}</code>。</li>
                <li><strong>冲突：</strong>409 后重新读取并重放语义修改，只重试一次。</li>
              </ul>
              <div className="af-wr-endpoints">
                <div><span>READ</span><code>GET /api/workflows/state</code></div>
                <div><span>WRITE</span><code>POST /api/workflows/report</code></div>
              </div>
            </div>
          </div>
        </section>

        <section className="af-wr-section af-wr-ai">
          <div className="af-wr-section__head">
            <span>04</span>
            <div><h2>给 AI 的接入引导</h2><p>复制后交给 Codex、Claude Code 或其他支持 Skill 的编码 Agent。</p></div>
          </div>
          <CodePanel title="$agentflow-workflow-report" value={AI_GUIDE} copyKey="ai" copied={copied} onCopy={copy} />
          {copied === "failed" ? <p className="af-wr-copy-error">浏览器禁止访问剪贴板，请手动选择代码块内容。</p> : null}
        </section>
      </div>
    </div>
  );
}

