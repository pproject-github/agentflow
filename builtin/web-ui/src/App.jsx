import { RouteProvider, useRoute } from "./routeContext.jsx";
import { Component, useEffect, useState } from "react";
import Sidebar from "./layout/Sidebar.jsx";
import ProjectsPage from "./pages/ProjectsPage.jsx";
import FlowEditorPage from "./pages/FlowEditorPage.jsx";
import WorkspacePage from "./pages/WorkspacePage.jsx";
import DisplayPage from "./pages/DisplayPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import AdminUsagePage from "./pages/AdminUsagePage.jsx";
import FeedbackPage from "./pages/FeedbackPage.jsx";
import McpPage from "./pages/McpPage.jsx";
import LikeeContextPage from "./pages/LikeeContextPage.jsx";
import { OnboardingTour } from "./onboarding/OnboardingTour.jsx";
import RunningIndicator from "./RunningIndicator.jsx";

function isLikeeContextPath(path) {
  return path === "/likee-context" || path === "/likee_context";
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
  if (path === "/nodes") return <ProjectsPage authUser={authUser} resourceKind="nodes" />;
  if (path === "/my-nodes") return <ProjectsPage authUser={authUser} resourceKind="my-nodes" />;
  if (path === "/my-flows") return <ProjectsPage authUser={authUser} resourceKind="my-flows" />;
  if (path === "/skills") return <ProjectsPage authUser={authUser} resourceKind="skills" />;
  if (path === "/mcps") return <McpPage />;
  if (path === "/flow") return <FlowEditorPage />;
  if (path === "/workspace") return <WorkspacePage />;
  if (path.startsWith("/display")) return <DisplayPage />;
  if (path === "/settings") return <SettingsPage authUser={authUser} />;
  if (path === "/admin/usage") return <AdminUsagePage authUser={authUser} />;
  if (path === "/feedback") return <FeedbackPage />;
  if (isLikeeContextPath(path)) return <LikeeContextPage />;
  return <ProjectsPage />;
}

function AuthGate({ children }) {
  const [auth, setAuth] = useState({ loading: true, authenticated: false, user: null, setupRequired: false });
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
      });
      setError(j.error ? String(j.error) : "");
    } catch (e) {
      setAuth({ loading: false, authenticated: false, user: null, setupRequired: false });
      setError(String(e.message || e));
    }
  };

  useEffect(() => {
    loadMe();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "登录失败");
      setAuth({ loading: false, authenticated: true, user: j.user || null, setupRequired: false });
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setSubmitting(false);
    }
  };

  if (auth.loading) {
    return <div className="af-auth-screen"><div className="af-auth-panel">Loading...</div></div>;
  }
  if (!auth.authenticated) {
    return (
      <div className="af-auth-screen">
        <form className="af-auth-panel" onSubmit={submit}>
          <div className="af-auth-brand">
            <span className="material-symbols-outlined">account_circle</span>
            <div>
              <h1>AgentFlow</h1>
              <p>{auth.setupRequired ? "初始化管理员账号" : "登录或创建用户"}</p>
            </div>
          </div>
          <label className="af-auth-field">
            <span>用户名</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
          </label>
          <label className="af-auth-field">
            <span>密码</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={auth.setupRequired ? "new-password" : "current-password"} />
          </label>
          {error ? <p className="af-auth-error">{error}</p> : null}
          <button className="af-auth-submit" type="submit" disabled={submitting || !username.trim() || password.length < 4}>
            {submitting ? "处理中..." : auth.setupRequired ? "创建并登录" : "登录"}
          </button>
        </form>
      </div>
    );
  }
  return children({ user: auth.user, onLogout: async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setAuth({ loading: false, authenticated: false, user: null, setupRequired: false });
  }});
}

function AppShell({ authUser, onLogout }) {
  const { path } = useRoute();
  const pipelineFullBleed = path === "/flow" || path === "/workspace";
  return (
    <div className="af-app">
      {path !== "/settings" ? <OnboardingTour page={pipelineFullBleed ? "flow" : "projects"} /> : null}
      {!pipelineFullBleed ? <Sidebar authUser={authUser} onLogout={onLogout} /> : null}
      <div className={pipelineFullBleed ? "af-main af-main--pipeline" : "af-main"}>
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
      </RouteProvider>
    </UiErrorBoundary>
  );
}

function PublicOrAuthedApp() {
  const { path } = useRoute();
  if (path.startsWith("/display")) return <DisplayPage />;
  if (isLikeeContextPath(path)) return <LikeeContextPage />;
  return (
    <AuthGate>
      {({ user, onLogout }) => <AppShell authUser={user} onLogout={onLogout} />}
    </AuthGate>
  );
}
