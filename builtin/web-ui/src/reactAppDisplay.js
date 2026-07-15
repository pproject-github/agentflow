function stripCodeFence(text) {
  let value = String(text || "").trim();
  const fenced = value.match(/```(?:json|jsx|tsx|javascript|js)?\s*\n?([\s\S]*?)```/i);
  if (fenced && fenced[1]) value = fenced[1].trim();
  else {
    const openFence = value.match(/```(?:json|jsx|tsx|javascript|js)?\s*\n?([\s\S]*)$/i);
    if (openFence && openFence[1]) value = openFence[1].trim();
  }
  return value.replace(/```\s*$/g, "").trim();
}

function parseReactAppProject(content) {
  const text = stripCodeFence(content);
  if (!text) {
    return {
      title: "React App",
      entry: "src/App.jsx",
      files: {
        "src/App.jsx": "export default function App() { return <main><h1>React App</h1><p>No project files yet.</p></main>; }",
      },
      inputs: {},
    };
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const files = parsed.files && typeof parsed.files === "object" && !Array.isArray(parsed.files) ? parsed.files : {};
      return {
        title: String(parsed.title || parsed.name || "React App"),
        entry: String(parsed.entry || parsed.main || "src/App.jsx"),
        files: Object.fromEntries(Object.entries(files).map(([key, value]) => [String(key), String(value ?? "")])),
        packageJson: parsed.packageJson && typeof parsed.packageJson === "object" ? parsed.packageJson : null,
        inputs: parsed.inputs && typeof parsed.inputs === "object" && !Array.isArray(parsed.inputs) ? parsed.inputs : {},
      };
    }
  } catch {
    /* raw JSX fallback */
  }
  return {
    title: "React App",
    entry: "src/App.jsx",
    files: { "src/App.jsx": text },
    inputs: {},
  };
}

function normalizeEntrySource(source) {
  let code = String(source || "");
  code = code.replace(/^\s*import\s+[^;]+;\s*$/gm, "");
  code = code.replace(/^\s*import\s+["'][^"']+["'];\s*$/gm, "");
  code = code.replace(/\bexport\s+default\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g, "const __AgentFlowDefault = function $1(");
  code = code.replace(/\bexport\s+default\s+function\s*\(/g, "const __AgentFlowDefault = function App(");
  code = code.replace(/\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)\s+extends/g, "const __AgentFlowDefault = class $1 extends");
  code = code.replace(/\bexport\s+default\s+class\s+extends/g, "const __AgentFlowDefault = class extends");
  code = code.replace(/\bexport\s+default\s+(\([^)]*\)\s*=>)/g, "const __AgentFlowDefault = $1");
  code = code.replace(/\bexport\s+default\s+([A-Za-z_$][\w$]*\s*=>)/g, "const __AgentFlowDefault = $1");
  code = code.replace(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?/g, "const __AgentFlowDefault = $1;");
  code = code.replace(/\bexport\s+(const|let|var|function|class)\s+/g, "$1 ");
  code = code.replace(/^\s*export\s+\{[^}]+\};?\s*$/gm, "");
  return code.trim();
}

function safeScriptText(text) {
  return String(text || "").replace(/<\/script/gi, "<\\/script");
}

export function normalizeReactAppDisplayContent(content) {
  const project = parseReactAppProject(content);
  return JSON.stringify({
    title: project.title,
    entry: project.entry,
    packageJson: project.packageJson || {
      scripts: { dev: "vite --host 0.0.0.0", build: "vite build" },
      dependencies: { "@vitejs/plugin-react": "latest", vite: "latest", react: "latest", "react-dom": "latest" },
      devDependencies: {},
    },
    files: project.files,
    inputs: project.inputs,
  }, null, 2);
}

export function reactAppDisplaySrcDoc(content, frameId = "") {
  const project = parseReactAppProject(content);
  const files = project.files || {};
  const entryPath = files[project.entry] != null ? project.entry : Object.keys(files).find((name) => /(?:^|\/)App\.[jt]sx$/i.test(name)) || Object.keys(files).find((name) => /\.[jt]sx?$/i.test(name)) || project.entry;
  const entrySource = normalizeEntrySource(files[entryPath] || "");
  const css = Object.entries(files)
    .filter(([name]) => /\.css$/i.test(name))
    .map(([, value]) => String(value || ""))
    .join("\n\n");
  const title = String(project.title || "React App");
  const frameIdJson = JSON.stringify(String(frameId || ""));
  const inputsJson = JSON.stringify(project.inputs || {});
  const code = safeScriptText(entrySource || "function App() { return <main><h1>React App</h1><p>No entry file content.</p></main>; }");
  const cssText = css || `
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #111112; color: #f4f0ff; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { min-height: 100vh; padding: 24px; }
    button, input, select, textarea { font: inherit; }
  `;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <base target="_self" />
  <title>${title.replace(/[<&>]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[ch]))}</title>
  <style>${cssText.replace(/<\/style/gi, "<\\/style")}</style>
</head>
<body>
  <div id="root"></div>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script>
    window.AGENTFLOW_INPUTS = ${inputsJson};
    window.addEventListener("error", (event) => {
      const root = document.getElementById("root");
      if (root && !root.__agentflowRendered) {
        root.innerHTML = '<pre style="margin:16px;padding:16px;border:1px solid rgba(255,117,117,.35);border-radius:8px;background:rgba(127,29,29,.18);color:#ffb8b8;white-space:pre-wrap;">' + String(event.message || event.error || 'React app failed').replace(/[<>&]/g, (ch) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch])) + '</pre>';
      }
    });
  </script>
  <script type="text/babel">
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    ${code}
    const RootComponent = typeof __AgentFlowDefault !== "undefined" ? __AgentFlowDefault : (typeof App !== "undefined" ? App : function MissingApp() {
      return <main><h1>React App</h1><p>Entry file must export or define an App component.</p></main>;
    });
    ReactDOM.createRoot(document.getElementById("root")).render(<RootComponent inputs={window.AGENTFLOW_INPUTS} />);
    document.getElementById("root").__agentflowRendered = true;
  </script>
  <script>
    (() => {
      const frameId = ${frameIdJson};
      const postSize = () => {
        const doc = document.documentElement;
        const body = document.body;
        const height = Math.ceil(Math.max(
          doc ? doc.scrollHeight : 0,
          doc ? doc.offsetHeight : 0,
          doc ? doc.clientHeight : 0,
          body ? body.scrollHeight : 0,
          body ? body.offsetHeight : 0,
          body ? body.clientHeight : 0,
          window.innerHeight || 0
        ));
        window.parent.postMessage({ source: "agentflow-html-display-size", frameId, height }, "*");
      };
      window.addEventListener("load", postSize);
      window.addEventListener("resize", postSize);
      requestAnimationFrame(postSize);
      setTimeout(postSize, 300);
      setTimeout(postSize, 1000);
      if (typeof ResizeObserver !== "undefined") {
        const resizeObserver = new ResizeObserver(postSize);
        resizeObserver.observe(document.documentElement);
        if (document.body) resizeObserver.observe(document.body);
      }
    })();
  </script>
</body>
</html>`;
}
