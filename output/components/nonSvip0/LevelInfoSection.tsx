import styles from "../../styles/nonSvip0.module.css";
import { StatusBarHeightReserve } from "./StatusBarHeightReserve";
import { TitleBarHeightReserve } from "./TitleBarHeightReserve";
import {
  DEFAULT_LEVEL_INFO_CONTENT,
  LevelInfoPlateContent,
  type LevelInfoContent,
  type LevelInfoPlateContentProps,
} from "./LevelInfoPlateContent";

const SECTION_NODE_ID = "3246:22310";

export type { LevelInfoContent };

export type LevelInfoSectionProps = {
  /** Copy and amounts — wire to app state / API */
  content?: Partial<LevelInfoContent>;
  /** Progress fill 0–1 (330/656 ≈ 0.5 in design) */
  progressRatio?: LevelInfoPlateContentProps["progressRatio"];
};

/**
 * Figma FRAME `restore_comp_levelInfo_default 等级信息版块` ({@link SECTION_NODE_ID}).
 * Layout: 状态栏/标题栏预留 → {@link LevelInfoPlateContent}（`3246:22312` 等级信息板块内容）。
 */
export function LevelInfoSection({
  content: contentOverrides,
  progressRatio = 330 / 656,
}: LevelInfoSectionProps) {
  const content: LevelInfoContent = { ...DEFAULT_LEVEL_INFO_CONTENT, ...contentOverrides };

  return (
    <section
      className={styles.levelInfoSection}
      aria-label="等级信息版块"
      data-figma-type="FRAME"
      data-figma-id={SECTION_NODE_ID}
      data-figma-name="restore_comp_levelInfo_default 等级信息版块"
    >
      <StatusBarHeightReserve />
      <TitleBarHeightReserve />

      <LevelInfoPlateContent content={content} progressRatio={progressRatio} />
    </section>
  );
}
