import { RouteProvider, useRoute } from "./routeContext.jsx";
import Sidebar from "./layout/Sidebar.jsx";
import ProjectsPage from "./pages/ProjectsPage.jsx";
import FlowEditorPage from "./pages/FlowEditorPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";

function RoutedContent() {
  const { path } = useRoute();
  if (path === "/projects" || path === "/") return <ProjectsPage />;
  if (path === "/flow") return <FlowEditorPage />;
  if (path === "/settings") return <SettingsPage />;
  return <ProjectsPage />;
}

function AppShell() {
  const { path } = useRoute();
  const pipelineFullBleed = path === "/flow";
  return (
    <div className="af-app">
      {!pipelineFullBleed ? <Sidebar /> : null}
      <div className={pipelineFullBleed ? "af-main af-main--pipeline" : "af-main"}>
        <RoutedContent />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <RouteProvider>
      <AppShell />
    </RouteProvider>
  );
}
