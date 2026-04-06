import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

const RouteContext = createContext(null);

function normalizePath(pathname) {
  let p = pathname || "/";
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p || "/";
}

/** 根路径默认进入 Projects */
function getInitialPath() {
  const raw = normalizePath(window.location.pathname);
  if (raw === "/") {
    window.history.replaceState({}, "", "/projects");
    return "/projects";
  }
  return raw;
}

export function RouteProvider({ children }) {
  const [path, setPath] = useState(getInitialPath);

  useEffect(() => {
    const onPop = () => setPath(normalizePath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to) => {
    const href = to.startsWith("/") ? to : `/${to}`;
    let url;
    try {
      url = new URL(href, window.location.origin);
    } catch {
      url = new URL("/", window.location.origin);
    }
    const next = normalizePath(url.pathname);
    const search = url.search || "";
    window.history.pushState({}, "", next + search);
    setPath(next);
  }, []);

  const value = useMemo(() => ({ path, navigate }), [path, navigate]);
  return <RouteContext.Provider value={value}>{children}</RouteContext.Provider>;
}

export function useRoute() {
  const ctx = useContext(RouteContext);
  if (!ctx) throw new Error("useRoute must be used within RouteProvider");
  return ctx;
}
