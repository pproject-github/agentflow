import { RouteProvider, useRoute } from "./routeContext.jsx";
import { Component, useEffect, useState } from "react";
import Sidebar from "./layout/Sidebar.jsx";
import ProjectsPage from "./pages/ProjectsPage.jsx";
import MarketplacePage from "./pages/MarketplacePage.jsx";
import SpacesPage from "./pages/SpacesPage.jsx";
import SpacePage from "./pages/SpacePage.jsx";
import WorkspacePage from "./pages/WorkspacePage.jsx";
import DisplayPage from "./pages/DisplayPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import AdminUsagePage from "./pages/AdminUsagePage.jsx";
import AdminTeamsPage from "./pages/AdminTeamsPage.jsx";
import AdminUsersPage from "./pages/AdminUsersPage.jsx";
import FeedbackPage from "./pages/FeedbackPage.jsx";
import McpPage from "./pages/McpPage.jsx";
import SchedulesPage from "./pages/SchedulesPage.jsx";
import NodeStudioPage from "./pages/NodeStudioPage.jsx";
import WorkspacesPage from "./pages/WorkspacesPage.jsx";
import WorkflowsPage from "./pages/WorkflowsPage.jsx";
import WorkflowReportGuidePage from "./pages/WorkflowReportGuidePage.jsx";
import WorkflowChecklistPage from "./pages/WorkflowChecklistPage.jsx";
import LikeeContextPage from "./pages/LikeeContextPage.jsx";
import { OnboardingTour } from "./onboarding/OnboardingTour.jsx";
import RunningIndicator from "./RunningIndicator.jsx";
import AppVersionNotice from "./components/AppVersionNotice.jsx";
import agentflowIconUrl from "./assets/agentflow-icon.svg?url";

function isLikeeContextPath(path) {
  return path === "/likee-context" || path === "/likee_context";
}

function isWorkflowSharePath(path) {
  if (path !== "/workspace" && path !== "/workflow-checklist") return false;
  const params = new URLSearchParams(window.location.search);
  return Boolean(String(params.get("workflowShare") || "").trim()) || (path === "/workflow-checklist" && params.get("demo") === "1");
}

function AppLoading() {
  return (
    <div className="af-app-loading" role="status" aria-live="polite" aria-label="AgentFlow 正在启动">
      <div className="af-app-loading__content">
        <div className="af-app-loading__mark"><img src={agentflowIconUrl} alt="" /></div>
        <h1>AgentFlow</h1>
        <p>Orchestration Engine</p>
        <div className="af-app-loading__track" aria-hidden><span /></div>
        <small>正在连接工作空间…</small>
      </div>
    </div>
  );
}

function RedirectFlowToWorkspace() {
  const { navigate } = useRoute();
  useEffect(() => {
    const current = new URLSearchParams(window.location.search);
    const next = new URLSearchParams();
    const flowId = current.get("flowId") || "";
    const flowSource = current.get("flowSource") || "";
    if (flowId) next.set("flowId", flowId);
    if (flowSource) next.set("flowSource", flowSource);
    if (current.get("flowArchived")) next.set("archived", current.get("flowArchived"));
    navigate(`/workspace${next.toString() ? `?${next.toString()}` : ""}`);
  }, [navigate]);
  return null;
}

function RedirectLegacyResourceToMarketplace({ kind, scope }) {
  const { navigate } = useRoute();
  useEffect(() => {
    navigate(`/marketplace?kind=${encodeURIComponent(kind)}&scope=${encodeURIComponent(scope)}`);
  }, [kind, navigate, scope]);
  return null;
}

class UiErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[AgentFlow UI render error]", error, info);
    this.setState({ error, info });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const errorText = String(this.state.error?.stack || this.state.error?.message || this.state.error);
    const componentStack = String(this.state.info?.componentStack || "");
    return (
      <div className="af-auth-screen">
        <div className="af-auth-panel af-ui-error-panel">
          <div className="af-auth-brand">
            <span className="material-symbols-outlined">error</span>
            <div>
              <h1>AgentFlow UI Error</h1>
              <p>页面渲染失败，下面是调试堆栈。</p>
            </div>
          </div>
          <pre>{errorText}</pre>
          {componentStack ? <pre>{componentStack}</pre> : null}
        </div>
      </div>
    );
  }
}

function RoutedContent({ authUser }) {
  const { path } = useRoute();
  if (path === "/projects" || path === "/") return <ProjectsPage authUser={authUser} />;
  if (path === "/marketplace") return <MarketplacePage authUser={authUser} />;
  if (path === "/spaces") return <SpacesPage authUser={authUser} />;
  if (path === "/nodes") return <RedirectLegacyResourceToMarketplace kind="node" scope="installed" />;
  if (path === "/my-nodes") return <RedirectLegacyResourceToMarketplace kind="node" scope="owned" />;
  if (path === "/my-flows") return <RedirectLegacyResourceToMarketplace kind="flow" scope="owned" />;
  if (path === "/skills") return <ProjectsPage authUser={authUser} resourceKind="skills" />;
  if (path === "/workspaces") return <WorkspacesPage authUser={authUser} />;
  if (path === "/workflows") return <WorkflowsPage authUser={authUser} />;
  if (path === "/workflow-report") return <WorkflowReportGuidePage />;
  if (path === "/workflow-checklist") return <WorkflowChecklistPage />;
  if (path === "/mcps") return <McpPage />;
  if (path === "/schedules") return <SchedulesPage />;
  if (path === "/node-studio") return <NodeStudioPage />;
  if (path === "/flow") return <RedirectFlowToWorkspace />;
  if (path === "/workspace") return <WorkspacePage />;
  if (path.startsWith("/display")) return <DisplayPage />;
  if (path.startsWith("/s/")) return <SpacePage />;
  if (path === "/settings") return <SettingsPage authUser={authUser} />;
  if (path === "/admin/usage") return <AdminUsagePage authUser={authUser} />;
  if (path === "/admin/teams") return <AdminTeamsPage authUser={authUser} />;
  if (path === "/admin/users") return <AdminUsersPage authUser={authUser} />;
  if (path === "/feedback") return <FeedbackPage authUser={authUser} />;
  if (isLikeeContextPath(path)) return <LikeeContextPage />;
  return <ProjectsPage />;
}

function AuthGate({ children }) {
  const { path, navigate } = useRoute();
  const adminLogin = path === "/admin/login";
  const [auth, setAuth] = useState({
    loading: true,
    authenticated: false,
    user: null,
    setupRequired: false,
    casEnabled: false,
    casLoginUrl: "/api/auth/cas/login",
  });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const loadMe = async () => {
    try {
      const r = await fetch("/api/auth/me");
      const j = await r.json().catch(() => ({}));
      setAuth({
        loading: false,
        authenticated: Boolean(j.authenticated),
        user: j.user || null,
        setupRequired: Boolean(j.setupRequired),
        casEnabled: Boolean(j.casEnabled),
        casLoginUrl: String(j.casLoginUrl || "/api/auth/cas/login"),
      });
      setError(j.error ? String(j.error) : "");
    } catch (e) {
      setAuth({ loading: false, authenticated: false, user: null, setupRequired: false, casEnabled: false, casLoginUrl: "/api/auth/cas/login" });
      setError(String(e.message || e));
    }
  };

  useEffect(() => {
    loadMe();
  }, []);

  useEffect(() => {
    if (!auth.loading && auth.authenticated && adminLogin) navigate("/projects");
  }, [adminLogin, auth.authenticated, auth.loading, navigate]);

  useEffect(() => {
    if (auth.loading || auth.authenticated || adminLogin || !auth.casEnabled) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("authError")) return;
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.replace(`${auth.casLoginUrl}?returnTo=${encodeURIComponent(returnTo)}`);
  }, [adminLogin, auth.authenticated, auth.casEnabled, auth.casLoginUrl, auth.loading]);

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const r = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "登录失败");
      setUsername("");
      setPassword("");
      // Complete the credential submission with a real navigation. Chrome can
      // otherwise keep this fetch-based login pending and mistake a later
      // Workspace autosave POST for a password-change submission.
      window.location.replace(window.location.href);
      return;
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setSubmitting(false);
    }
  };

  if (auth.loading) {
    return <AppLoading />;
  }
  if (!auth.authenticated) {
    const authError = new URLSearchParams(window.location.search).get("authError") || "";
    if (!adminLogin) {
      return (
        <div className="af-auth-screen">
          <div className="af-auth-panel af-auth-panel--cas">
            <div className="af-auth-brand">
              <span className="material-symbols-outlined">shield_person</span>
              <div><h1>AgentFlow</h1><p>{!auth.casEnabled ? "CAS 登录尚未配置" : authError ? "CAS 登录未完成" : "正在前往 CAS 统一认证"}</p></div>
            </div>
            {!auth.casEnabled ? <p className="af-auth-error">普通用户仅支持 CAS 登录，请联系管理员启用 CAS。</p> : authError ? <p className={authError === "logged_out" ? "af-auth-note" : "af-auth-error"}>{authError === "logged_out" ? "你已退出 AgentFlow。" : authError === "cas_forbidden" ? "该账号是 AgentFlow 管理员，请从管理员入口使用密码登录。" : authError === "cas_unavailable" ? "CAS 服务暂时不可用，请稍后重试。" : "登录状态已过期或 ticket 无效，请重新登录。"}</p> : null}
            <button className="af-auth-submit" type="button" disabled={!auth.casEnabled} onClick={() => {
              const returnTo = `${window.location.pathname}${window.location.hash}`;
              window.location.assign(`${auth.casLoginUrl}?returnTo=${encodeURIComponent(returnTo)}`);
            }}>{authError ? "重新使用 CAS 登录" : "使用 CAS 登录"}</button>
            <a className="af-auth-admin-link" href="/admin/login">管理员登录</a>
          </div>
        </div>
      );
    }
    return (
      <div className="af-auth-screen">
        <form className="af-auth-panel" onSubmit={submit} autoComplete="on">
          <div className="af-auth-brand">
            <span className="material-symbols-outlined">account_circle</span>
            <div>
              <h1>AgentFlow</h1>
              <p>{auth.setupRequired ? "初始化管理员账号" : "管理员登录"}</p>
            </div>
          </div>
          <label className="af-auth-field">
            <span>用户名</span>
            <input
              id="agentflow-auth-username"
              name="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
            />
          </label>
          <label className="af-auth-field">
            <span>密码</span>
            <input
              id="agentflow-auth-password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={auth.setupRequired ? "new-password" : "current-password"}
            />
          </label>
          {error ? <p className="af-auth-error">{error}</p> : null}
          <button className="af-auth-submit" type="submit" disabled={submitting || !username.trim() || password.length < 4}>
            {submitting ? "处理中..." : auth.setupRequired ? "创建管理员并登录" : "管理员登录"}
          </button>
          <a className="af-auth-admin-link" href="/projects">返回 CAS 用户入口</a>
        </form>
      </div>
    );
  }
  return children({ user: auth.user, onLogout: async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    if (auth.user?.authProvider === "cas") {
      window.location.assign("/api/auth/cas/logout");
      return;
    }
    setAuth((current) => ({ ...current, loading: false, authenticated: false, user: null, setupRequired: false }));
    window.location.replace("/admin/login");
  }});
}

function AppShell({ authUser, onLogout }) {
  const { path } = useRoute();
  const workflowReportStandalone = path === "/workflow-report";
  const pipelineFullBleed = path === "/flow" || path === "/workspace" || path === "/workflow-checklist";
  const fullBleed = pipelineFullBleed || workflowReportStandalone;
  return (
    <div className="af-app">
      {path !== "/settings" && !workflowReportStandalone ? <OnboardingTour page={pipelineFullBleed ? "flow" : "projects"} /> : null}
      {!fullBleed ? <Sidebar authUser={authUser} onLogout={onLogout} /> : null}
      <div className={fullBleed ? "af-main af-main--pipeline" : "af-main"}>
        <RoutedContent authUser={authUser} />
      </div>
      <RunningIndicator />
    </div>
  );
}

export default function App() {
  return (
    <UiErrorBoundary>
      <RouteProvider>
        <PublicOrAuthedApp />
        <AppVersionNotice />
      </RouteProvider>
    </UiErrorBoundary>
  );
}

function PublicOrAuthedApp() {
  const { path } = useRoute();
  if (path.startsWith("/display")) return <DisplayPage />;
  if (path.startsWith("/s/")) return <SpacePage />;
  if (isLikeeContextPath(path)) return <LikeeContextPage />;
  if (isWorkflowSharePath(path)) return path === "/workflow-checklist" ? <WorkflowChecklistPage /> : <WorkspacePage />;
  return (
    <AuthGate>
      {({ user, onLogout }) => <AppShell authUser={user} onLogout={onLogout} />}
    </AuthGate>
  );
}
