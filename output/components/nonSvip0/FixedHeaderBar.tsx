import styles from "../../styles/nonSvip0.module.css";
import { FigmaRaster } from "./FigmaRaster";

const HEADER_NODE = "restore_comp_headerBar_default";

/**
 * Figma: `restore_comp_headerBar_default 状态+标题栏 position_fixed`
 * 返回 / Tab / 右侧操作图标 — 资源由 `figma_exports/icon_export_*.png` 提供。
 */
export function FixedHeaderBar() {
  return (
    <header
      className={styles.fixedHeader}
      data-figma-node={HEADER_NODE}
    >
      <div className={styles.fixedHeaderInner}>
        <button type="button" className={styles.fixedHeaderIconBtn} aria-label="返回">
          <FigmaRaster
            exportBaseName="icon_export_返回"
            alt=""
            className={styles.fixedHeaderIcon}
          />
        </button>
        <div className={styles.fixedHeaderTabs} role="tablist" aria-label="SVIP tabs">
          <span className={styles.fixedHeaderTabActive} role="tab" aria-selected="true">
            SVIP
          </span>
          <span className={styles.fixedHeaderTabInactive} role="tab" aria-selected="false">
            SVIP+
          </span>
        </div>
        <div className={styles.fixedHeaderRight}>
          <button type="button" className={styles.fixedHeaderIconBtn} aria-label="联系官方">
            <FigmaRaster
              exportBaseName="icon_export_联系官方"
              alt=""
              className={styles.fixedHeaderIcon}
            />
          </button>
          <button type="button" className={styles.fixedHeaderIconBtn} aria-label="详情">
            <FigmaRaster
              exportBaseName="icon_export_详情"
              alt=""
              className={styles.fixedHeaderIcon}
            />
          </button>
        </div>
      </div>
    </header>
  );
}
