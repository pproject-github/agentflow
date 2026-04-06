import styles from "../../styles/nonSvip0.module.css";
import { BenefitSection } from "./BenefitSection";
import { FixedHeaderBar } from "./FixedHeaderBar";
import { LevelInfoSection } from "./LevelInfoSection";
import { PageBackground } from "./PageBackground";
import { StoreSection } from "./StoreSection";

/** Figma `非SVIP0_当前在0` (3246:22308) — direct child node ids in layer order */
export const NON_SVIP0_FRAME_CHILD_IDS = [
  "3246:22309", // img_export_背景图
  "3246:22310", // restore_comp_levelInfo_default 等级信息版块
  "3246:22353", // restore_comp_benefit_default 专属权益版块
  "3246:22383", // restore_comp_store_default banner和商城版块
  "3246:22414", // restore_comp_headerBar_default 状态+标题栏 position_fixed
] as const;

export type NonSvip0ScreenProps = {
  /** Figma frame id for traceability */
  frameNodeId?: string;
};

/**
 * Root layout for FRAME `非SVIP0_当前在0` (3246:22308).
 * Figma child order: 背景 → 等级信息 → 专属权益 → 商城 → 顶栏（固定层，树中为最后一子）。
 * React: 背景与滚动主内容按序排列；顶栏置于末尾以贴合图层顺序，视觉仍由 `position: fixed` 置顶。
 */
export function NonSvip0Screen({ frameNodeId = "3246:22308" }: NonSvip0ScreenProps) {
  return (
    <div
      className={styles.root}
      role="main"
      data-figma-type="FRAME"
      data-figma-id={frameNodeId}
      data-figma-name="非SVIP0_当前在0"
    >
      <PageBackground />
      <div className={styles.scroll}>
        {/* Offset for fixed header (last in Figma tree, first visually) */}
        <div className={styles.headerScrollSpacer} aria-hidden />
        <LevelInfoSection />
        <BenefitSection />
        <StoreSection />
      </div>
      <FixedHeaderBar />
    </div>
  );
}
