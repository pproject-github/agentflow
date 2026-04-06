import { DesignCanvas } from "./components/DesignCanvas";

/**
 * SVIP 页面设计还原 — 文档根入口（Figma Document `0:0`）。
 * CANVAS `设计稿`（55:3651）→ SECTION `非SVIP`（67:2749）→ FRAME `非SVIP0_当前在0`（3246:22308）。
 */
export default function App() {
  return <DesignCanvas />;
}

export { DesignCanvas } from "./components/DesignCanvas";
export { NonSvipSection } from "./components/NonSvipSection";
export { NonSvip0Screen } from "./components/nonSvip0/NonSvip0Screen";
