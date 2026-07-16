import { useRoute } from "../routeContext.jsx";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import agentflowIconUrl from "../assets/agentflow-icon.svg?url";

const ITEMS = [
  { to: "/projects", labelKey: "common:nav.projects", icon: "folder_open" },
  { to: "/workspaces", label: "知识库", icon: "folder_managed" },
  { to: "/nodes", labelKey: "common:nav.nodes", icon: "account_tree" },
  { to: "/my-flows", labelKey: "common:nav.myFlows", icon: "schema" },
  { to: "/skills", labelKey: "common:nav.skills", icon: "extension" },
  { to: "/mcps", labelKey: "common:nav.mcps", icon: "hub" },
  { to: "/node-studio", label: "节点编辑器", icon: "draw" },
  { to: "/schedules", label: "定时任务", icon: "event_busy" },
  { to: "/admin/usage", label: "管理看板", icon: "query_stats", adminOnly: true },
  { to: "/feedback", labelKey: "common:nav.feedback", icon: "rate_review" },
  { to: "/settings", labelKey: "common:nav.settings", icon: "settings" },
];

const EXTERNAL_LINKS = [
  { href: "https://agentflow-hub.com", icon: "hub", labelKey: "common:links.hub" },
  { href: "https://docs.agentflow-hub.com", icon: "menu_book", labelKey: "common:links.docs" },
  {
    href: "https://github.com/pproject-github/agentflow",
    icon: "code",
    labelKey: "common:links.github",
  },
];

function isActive(path, to) {
  if (to === "/projects") return path === "/projects" || path === "/";
  if (to === "/nodes") return path === "/nodes" || path === "/my-nodes";
  return path === to || path.startsWith(to + "/");
}

export default function Sidebar({ authUser, onLogout }) {
  const { path, navigate } = useRoute();
  const { t } = useTranslation();
  const [hideCommunityLinks, setHideCommunityLinks] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/ui-context")
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) setHideCommunityLinks(Boolean(j.hideCommunityLinks));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <aside className="af-sidebar" aria-label={t("flow:sidebar.mainNav")}>
      <div className="af-brand">
        <div className="af-brand-mark" aria-hidden>
          <img src={agentflowIconUrl} alt="" width="36" height="36" decoding="async" />
        </div>
        <div>
          <h1 className="af-brand-title">Agentflow</h1>
          <p className="af-brand-tag">Orchestration Engine</p>
        </div>
      </div>
      <nav className="af-nav">
        {ITEMS.filter((item) => !item.adminOnly || authUser?.isAdmin).map((item) => (
          <button
            key={item.to}
            type="button"
            className={
              "af-nav-link" +
              (isActive(path, item.to) ? " af-nav-link--active" : "")
            }
            onClick={() => navigate(item.to)}
          >
            <span className="material-symbols-outlined">{item.icon}</span>
            <span>{item.label || t(item.labelKey)}</span>
          </button>
        ))}
      </nav>
      <div className="af-sidebar-footer">
        <div className="af-sidebar-user" title={authUser?.username || authUser?.userId || ""}>
          <span className="material-symbols-outlined">person</span>
          <span>{authUser?.username || authUser?.userId || ""}</span>
          {authUser?.isAdmin ? <span className="af-sidebar-admin-badge">Admin</span> : null}
          <button type="button" className="af-sidebar-logout" onClick={onLogout} aria-label="Logout" title="Logout">
            <span className="material-symbols-outlined">logout</span>
          </button>
        </div>
        {!hideCommunityLinks && EXTERNAL_LINKS.map((link) => {
          const label = t(link.labelKey);
          return (
            <a
              key={link.href}
              className="af-sidebar-ext"
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={label}
              title={label}
            >
              <span className="material-symbols-outlined">{link.icon}</span>
            </a>
          );
        })}
      </div>
    </aside>
  );
}
