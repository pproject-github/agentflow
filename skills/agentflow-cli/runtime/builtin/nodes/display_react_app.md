---
# Built-in node: React App Display
runtime: native
description: Display a small React project in a sandboxed workspace iframe and pass the project JSON downstream
displayName: React App
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: content
    default: ""
    required: true
    showOnNode: true
  - type: file
    name: filePath
    default: ""
    showOnNode: false
  - type: text
    name: workspaceContext
    default: ""
    showOnNode: false
output:
  - type: text
    name: content
    default: ""
    showOnNode: true
  - type: node
    name: next
    default: ""
---
{
  "title": "React App",
  "entry": "src/App.jsx",
  "packageJson": {
    "scripts": {
      "dev": "vite --host 0.0.0.0",
      "build": "vite build"
    },
    "dependencies": {
      "@vitejs/plugin-react": "latest",
      "vite": "latest",
      "react": "latest",
      "react-dom": "latest"
    },
    "devDependencies": {}
  },
  "files": {
    "src/App.jsx": "export default function App() {\\n  return (\\n    <main>\\n      <h1>React App</h1>\\n      <p>Ask an Agent to replace this with a React project.</p>\\n    </main>\\n  );\\n}\\n",
    "src/styles.css": "body { margin: 0; background: #111112; color: #f4f0ff; font-family: Inter, system-ui, sans-serif; }\\nmain { min-height: 100vh; padding: 24px; }\\nh1 { margin: 0 0 8px; font-size: 28px; }\\np { margin: 0; color: rgba(244, 240, 255, 0.68); }\\n"
  },
  "inputs": {}
}
