import styles from "../../styles/nonSvip0.module.css";
import { FigmaRaster } from "./FigmaRaster";
import { LevelDecor } from "./LevelDecor";
import { NextLevelText } from "./NextLevelText";

/** Figma FRAME `等级tab` — 下一等级文案 + 等级装饰 + 当前等级徽章 */
export const LEVEL_TAB_NODE_ID = "3246:22326" as const;

export type LevelTabProps = {
  /** 下一等级文本 — e.g. "SVIP 1" */
  nextLevelTitle: string;
};

/**
 * FRAME `等级tab` ({@link LEVEL_TAB_NODE_ID}).
 * Child order: `下一等级文本` → `img_export_等级装饰` → `img_export_当前等级`.
 */
export function LevelTab({ nextLevelTitle }: LevelTabProps) {
  return (
    <div
      className={styles.levelInfoTabRow}
      data-figma-type="FRAME"
      data-figma-id={LEVEL_TAB_NODE_ID}
      data-figma-name="等级tab"
    >
      <NextLevelText nextLevelTitle={nextLevelTitle} />
      <LevelDecor />
      <div
        className={styles.levelInfoCurrentBadge}
        data-figma-id="3246:22329"
        data-figma-type="INSTANCE"
        data-figma-name="img_export_当前等级"
      >
        <FigmaRaster
          exportBaseName="img_export_当前等级"
          alt=""
          className={styles.levelInfoCurrentBadgeImg}
          trace={{ nodeId: "I3246:22329;314:3475", nodeType: "RECTANGLE", nodeName: "等级=0" }}
        />
      </div>
    </div>
  );
}
