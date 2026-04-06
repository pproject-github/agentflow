import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootPkg = JSON.parse(readFileSync(path.join(__dirname, "../../package.json"), "utf8"));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version || "0.0.0"),
  },
  plugins: [react()],
  /** 本地 `npm run dev` 时把 /api 转到 agentflow ui（默认 8765），否则侧栏等接口会拿到 index.html 导致一直“加载中” */
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8765",
        changeOrigin: true,
      },
    },
  },
  build: {
    /** 与 agentflow ui 静态目录一致；构建前旧 dist 会被覆盖 */
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "assets",
  },
  base: "/",
});
