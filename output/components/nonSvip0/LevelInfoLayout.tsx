import styles from "../../styles/nonSvip0.module.css";
import { NicknameLikeeIdBlock } from "./NicknameLikeeIdBlock";
import { StatusInfoFrame } from "./StatusInfoFrame";
import { UpgradeButton } from "./UpgradeButton";

/** Figma FRAME `等级信息布局` — child of `个人等级信息` (3246:22313). */
export const LEVEL_INFO_LAYOUT_NODE_ID = "3246:22318" as const;

export type LevelInfoLayoutData = {
  nickname: string;
  likeeIdLabel: string;
  statusLine: string;
  upgradeLabel: string;
};

export type LevelInfoLayoutProps = {
  data: LevelInfoLayoutData;
};

/**
 * 昵称 / Likee ID / 状态文案 / 升级 CTA 的纵向布局（与 Figma auto-layout 子顺序一致）。
 */
export function LevelInfoLayout({ data }: LevelInfoLayoutProps) {
  return (
    <div
      className={styles.levelInfoTextBlock}
      data-figma-type="FRAME"
      data-figma-id={LEVEL_INFO_LAYOUT_NODE_ID}
      data-figma-name="等级信息布局"
    >
      <NicknameLikeeIdBlock nickname={data.nickname} likeeIdLabel={data.likeeIdLabel} />
      <StatusInfoFrame statusLine={data.statusLine} />
      <UpgradeButton label={data.upgradeLabel} />
    </div>
  );
}
