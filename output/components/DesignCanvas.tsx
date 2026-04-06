import styles from "../styles/nonSvip0.module.css";
import { NonSvipSection } from "./NonSvipSection";
import { NonSvip0Screen } from "./nonSvip0/NonSvip0Screen";

/** Figma CANVAS `设计稿` — matches `tool_fetch_figma_snapshot` document.children[0].id */
export const FIGMA_DESIGN_CANVAS_ID = "55:3651" as const;
/** Figma SECTION `非SVIP` — parent of FRAME `非SVIP0_当前在0` (3246:22308) */
export const FIGMA_NON_SVIP_SECTION_ID = "67:2749" as const;

export type DesignCanvasProps = {
  /** Figma CANVAS node id */
  canvasNodeId?: string;
  /** Figma SECTION node id */
  sectionNodeId?: string;
};

/**
 * Figma hierarchy: CANVAS `设计稿` → SECTION `非SVIP` → FRAME `非SVIP0_当前在0` (see NonSvip0Screen).
 * Keeps data attributes aligned with node_tool_fetch_figma_snapshot tree for traceability.
 */
export function DesignCanvas({
  canvasNodeId = FIGMA_DESIGN_CANVAS_ID,
  sectionNodeId = FIGMA_NON_SVIP_SECTION_ID,
}: DesignCanvasProps) {
  return (
    <div
      className={styles.designCanvas}
      data-figma-type="CANVAS"
      data-figma-id={canvasNodeId}
      data-figma-name="设计稿"
    >
      <NonSvipSection sectionNodeId={sectionNodeId}>
        <NonSvip0Screen />
      </NonSvipSection>
    </div>
  );
}
