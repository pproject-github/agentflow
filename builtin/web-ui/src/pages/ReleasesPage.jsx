import { useEffect, useState } from "react";
import { useRoute } from "../routeContext.jsx";

const STATUS_LABELS = {
  planning: "规划中",
  testing: "提测中",
  releasing: "发布中",
  released: "已完成",
  blocked: "已阻塞",
  cancelled: "已取消",
};

function todayDate() {
  const date = new Date();
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 10);
}

function toBusinessLine(project) {
  return String(project || "").trim().toLowerCase();
}

function toWorkflowPlatform(platform) {
  const value = String(platform || "").trim().toLowerCase();
  if (value === "ios" || value === "iphone") return "ios";
  if (value === "android") return "android";
  return value;
}

// 用户需求点: 列表存两级大版本（如 5.64），流程页内部自动补齐首包小版本。
function toWorkflowVersion(version) {
  const value = String(version || "").trim().replace(/^v/i, "");
  if (/^\d+\.\d+$/.test(value)) return `${value}.0`;
  return value || "1.0.0";
}

function buildWorkflowHref({ project, platform, version }) {
  const params = new URLSearchParams({
    businessLine: toBusinessLine(project),
    platform: toWorkflowPlatform(platform),
    version: toWorkflowVersion(version),
  });
  return `/releases/run?${params.toString()}`;
}

export default function ReleasesPage() {
  const { navigate } = useRoute();
  const [project, setProject] = useState("Likee");
  const [platform, setPlatform] = useState("Android");
  const [projects, setProjects] = useState(["Likee", "Bigolive", "Hello"]);
  const [platforms, setPlatforms] = useState(["iOS", "Android"]);
  const [releases, setReleases] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ version: "", releaseDate: todayDate() });
  const [saving, setSaving] = useState(false);

  // 用户需求点: 页面数据必须来自后端持久化存储，并随项目、平台和搜索条件刷新。
  async function loadReleases(signal) {
    setLoading(true);
    try {
      const [metaResponse, dataResponse] = await Promise.all([
        fetch("/api/release/projects", { signal }),
        fetch(
          `/api/releases?project=${encodeURIComponent(project)}&platform=${encodeURIComponent(platform)}&query=${encodeURIComponent(query)}${query ? "" : "&syncTapd=1"}`,
          { signal },
        ),
      ]);
      const readJson = async (response) => {
        const type = response.headers.get("content-type") || "";
        if (!type.includes("application/json")) throw new Error("发版服务接口不可用，请重启服务");
        return response.json();
      };
      const meta = await readJson(metaResponse);
      const data = await readJson(dataResponse);
      if (!metaResponse.ok || !dataResponse.ok) {
        throw new Error(meta.error || data.error || "读取发版数据失败");
      }
      setProjects(meta.projects || projects);
      setPlatforms(meta.platforms || platforms);
      setReleases(data.releases || []);
      setError("");
    } catch (e) {
      if (e?.name !== "AbortError") setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadReleases(controller.signal);
    return () => controller.abort();
  }, [project, platform, query]);

  useEffect(() => {
    if (!showCreate) return undefined;
    // 用户需求点: 新建版本使用可关闭的弹窗交互，按 Escape 可快速退出。
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !saving) setShowCreate(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showCreate, saving]);

  // 用户需求点: 新建版本提交后必须持久化，并立即刷新当前筛选下的版本列表。
  async function createRelease(event) {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await fetch("/api/releases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, project, platform }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "创建失败");
      setShowCreate(false);
      setForm({ version: "", releaseDate: todayDate() });
      await loadReleases();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  function openReleaseWorkflow(item) {
    navigate(buildWorkflowHref({
      project: item.project || project,
      platform: item.platform || platform,
      version: item.version,
    }));
  }

  return (
    <main className="af-releases-page">
      <header className="af-releases-header">
        <div>
          <p className="af-page-eyebrow">RELEASE MANAGEMENT</p>
          <h1>发版</h1>
          <p>选择业务平台与版本，进入对应发版流程</p>
        </div>
        <div className="af-releases-actions">
          <label className="af-release-select">
            <span className="material-symbols-outlined">swap_horiz</span>
            <span>项目</span>
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              {projects.map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          <label className="af-release-select">
            <span className="material-symbols-outlined">devices</span>
            <span>平台</span>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              {platforms.map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          <button type="button" className="af-primary-btn" onClick={() => setShowCreate(true)}>
            <span className="material-symbols-outlined">add</span>
            创建版本
          </button>
        </div>
      </header>

      <section className="af-releases-toolbar">
        <strong>
          {project} · {platform} <small>· 版本列表</small>
        </strong>
        <label>
          <span className="material-symbols-outlined">search</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索版本号" />
        </label>
      </section>

      {error ? <div className="af-marketplace-error">{error}</div> : null}

      <section className="af-release-table" aria-label="版本列表">
        <div className="af-release-row af-release-row--head">
          <span>大版本号</span>
          <span>发版时间</span>
          <span>当前发版进度</span>
          <span>状态</span>
        </div>
        {loading ? (
          <div className="af-release-empty">正在读取版本数据…</div>
        ) : (
          releases.map((item) => (
            <button
              type="button"
              className="af-release-row af-release-row--action"
              key={item.id}
              onClick={() => openReleaseWorkflow(item)}
            >
              <strong>v{item.version}</strong>
              <span>{item.releaseDate}</span>
              <div className="af-release-progress">
                <div><i style={{ width: `${item.progress || 0}%` }} /></div>
                <b>{item.progress || 0}%</b>
              </div>
              <span className="af-release-status is-blue">
                {STATUS_LABELS[item.status] || item.status}
              </span>
            </button>
          ))
        )}
        {!loading && !releases.length ? <div className="af-release-empty">暂无版本</div> : null}
      </section>

      {showCreate ? (
        <div className="af-modal-backdrop">
          <form className="af-release-create-modal" onSubmit={createRelease}>
            <h2>新建版本</h2>
            <p>{project} · {platform}</p>
            <label>
              大版本号
              <input
                required
                pattern="[0-9]+\.[0-9]+"
                placeholder="例如 5.64"
                value={form.version}
                onChange={(e) => setForm({ ...form, version: e.target.value })}
              />
            </label>
            <label>
              发版时间
              <input
                type="date"
                value={form.releaseDate}
                onChange={(e) => setForm({ ...form, releaseDate: e.target.value })}
              />
            </label>
            <footer>
              <button type="button" className="af-secondary-btn" onClick={() => setShowCreate(false)} disabled={saving}>
                取消
              </button>
              <button type="submit" className="af-primary-btn" disabled={saving}>
                {saving ? "创建中…" : "确认创建"}
              </button>
            </footer>
          </form>
        </div>
      ) : null}
    </main>
  );
}
