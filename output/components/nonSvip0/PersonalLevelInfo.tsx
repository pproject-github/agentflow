import styles from "../../styles/nonSvip0.module.css";
import { AvatarLayout } from "./AvatarLayout";
import { LevelInfoLayout, type LevelInfoLayoutData } from "./LevelInfoLayout";

/** Figma FRAME `个人等级信息` — child of `等级信息板块内容` (3246:22312). */
export const PERSONAL_LEVEL_INFO_NODE_ID = "3246:22313" as const;

export type PersonalLevelInfoData = LevelInfoLayoutData;

export type PersonalLevelInfoProps = {
  data: PersonalLevelInfoData;
};

/**
 * 头像布局 + {@link LevelInfoLayout}（昵称 / Likee ID / 状态 / 升级 CTA）。
 * Does not include `等级信息` or `勋章展示` — those are sibling frames in Figma.
 */
export function PersonalLevelInfo({ data }: PersonalLevelInfoProps) {
  return (
    <div
      className={styles.levelInfoPersonal}
      data-figma-type="FRAME"
      data-figma-id={PERSONAL_LEVEL_INFO_NODE_ID}
      data-figma-name="个人等级信息"
    >
      <AvatarLayout />
      <LevelInfoLayout data={data} />
    </div>
  );
}
