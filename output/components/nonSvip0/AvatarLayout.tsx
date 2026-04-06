import styles from "../../styles/nonSvip0.module.css";
import { Avatar, AVATAR_NODE_ID } from "./Avatar";

/** Figma FRAME `头像布局` — child of `个人等级信息` */
export const AVATAR_LAYOUT_NODE_ID = "3246:22314" as const;

/** Same as `Avatar` root id `3246:22315` — kept for older imports. */
export const AVATAR_GROUP_NODE_ID = AVATAR_NODE_ID;

export type AvatarLayoutProps = {
  /** Extra class on the root `头像布局` frame */
  className?: string;
};

/**
 * 头像布局：左侧 `头像`（见 {@link Avatar}）+ 不含昵称/等级文案。
 * 对应 Figma `FRAME` {@link AVATAR_LAYOUT_NODE_ID}。
 */
export function AvatarLayout({ className }: AvatarLayoutProps) {
  const rootClass = [styles.levelInfoAvatarRow, className].filter(Boolean).join(" ");

  return (
    <div
      className={rootClass}
      data-figma-type="FRAME"
      data-figma-id={AVATAR_LAYOUT_NODE_ID}
      data-figma-name="头像布局"
    >
      <Avatar />
    </div>
  );
}
