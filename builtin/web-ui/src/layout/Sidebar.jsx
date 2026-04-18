import { useRoute } from "../routeContext.jsx";
import { useTranslation } from "react-i18next";
import agentflowIconUrl from "../assets/agentflow-icon.svg?url";

/** 暂时不展示「Nodes」(/flow) 入口，流水线仅从 Projects 卡片进入 */
const ITEMS = [
  { to: "/projects", label: "Projects", icon: "folder_open" },
  { to: "/settings", label: "Settings", icon: "settings" },
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
  return path === to || path.startsWith(to + "/");
}

export default function Sidebar() {
  const { path, navigate } = useRoute();
  const { t } = useTranslation();
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
        {ITEMS.map((item) => (
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
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="af-sidebar-footer">
        {EXTERNAL_LINKS.map((link) => {
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
