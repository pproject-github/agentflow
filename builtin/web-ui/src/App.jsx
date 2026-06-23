import { RouteProvider, useRoute } from "./routeContext.jsx";
import { useEffect, useState } from "react";
import Sidebar from "./layout/Sidebar.jsx";
import ProjectsPage from "./pages/ProjectsPage.jsx";
import FlowEditorPage from "./pages/FlowEditorPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import { OnboardingTour } from "./onboarding/OnboardingTour.jsx";
import RunningIndicator from "./RunningIndicator.jsx";

function RoutedContent() {
  const { path } = useRoute();
  if (path === "/projects" || path === "/") return <ProjectsPage />;
  if (path === "/nodes") return <ProjectsPage resourceKind="nodes" />;
  if (path === "/skills") return <ProjectsPage resourceKind="skills" />;
  if (path === "/flow") return <FlowEditorPage />;
  if (path === "/settings") return <SettingsPage />;
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
  const pipelineFullBleed = path === "/flow";
  return (
    <div className="af-app">
      {path !== "/settings" ? <OnboardingTour page={pipelineFullBleed ? "flow" : "projects"} /> : null}
      {!pipelineFullBleed ? <Sidebar authUser={authUser} onLogout={onLogout} /> : null}
      <div className={pipelineFullBleed ? "af-main af-main--pipeline" : "af-main"}>
        <RoutedContent />
      </div>
      <RunningIndicator />
    </div>
  );
}

export default function App() {
  return (
    <RouteProvider>
      <AuthGate>
        {({ user, onLogout }) => <AppShell authUser={user} onLogout={onLogout} />}
      </AuthGate>
    </RouteProvider>
  );
}
