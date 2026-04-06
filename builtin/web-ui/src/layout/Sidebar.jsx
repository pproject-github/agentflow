import { useRoute } from "../routeContext.jsx";
import agentflowIconUrl from "../assets/agentflow-icon.svg?url";

/** 暂时不展示「Nodes」(/flow) 入口，流水线仅从 Projects 卡片进入 */
const ITEMS = [
  { to: "/projects", label: "Projects", icon: "folder_open" },
  { to: "/settings", label: "Settings", icon: "settings" },
];

function isActive(path, to) {
  if (to === "/projects") return path === "/projects" || path === "/";
  return path === to || path.startsWith(to + "/");
}

export default function Sidebar() {
  const { path, navigate } = useRoute();
  return (
    <aside className="af-sidebar" aria-label="主导航">
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
    </aside>
  );
}
