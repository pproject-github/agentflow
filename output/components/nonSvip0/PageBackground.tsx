import styles from "../../styles/nonSvip0.module.css";
import { FigmaRaster } from "./FigmaRaster";

const BG_INSTANCE_ID = "3246:22309";
/** Inner RECTANGLE — IMAGE fill for variant `等级=0` (Figma tree child of INSTANCE). */
const BG_RECTANGLE_NODE: {
  id: string;
  type: "RECTANGLE";
  name: string;
} = {
  id: "I3246:22309;314:3227",
  type: "RECTANGLE",
  name: "等级=0",
};

/**
 * Figma INSTANCE `img_export_背景图` (3246:22309) — 子节点 RECTANGLE `等级=0` (I3246:22309;314:3227) 承载全屏氛围底图。
 * 资源路径：`figma_exports/img_export_背景图.png`（由导出管线写入；与实例导出名一致）。
 */
export function PageBackground() {
  return (
    <div
      className={styles.bgLayer}
      aria-hidden
      data-figma-id={BG_INSTANCE_ID}
      data-figma-type="INSTANCE"
      data-figma-name="img_export_背景图"
      data-figma-variant-grade="0"
    >
      <FigmaRaster
        exportBaseName="img_export_背景图"
        alt=""
        style={{ minHeight: "100%" }}
        trace={{
          nodeId: BG_RECTANGLE_NODE.id,
          nodeType: BG_RECTANGLE_NODE.type,
          nodeName: BG_RECTANGLE_NODE.name,
        }}
      />
    </div>
  );
}
