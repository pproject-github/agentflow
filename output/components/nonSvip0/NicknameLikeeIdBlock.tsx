import styles from "../../styles/nonSvip0.module.css";
import { LikeeIdText } from "./LikeeIdText";
import { NicknameText } from "./NicknameText";

/** Figma FRAME `昵称+Likee ID` — VERTICAL auto-layout, itemSpacing 4 (3246:22319). */
export const NICKNAME_LIKEE_ID_FRAME_NODE_ID = "3246:22319" as const;

export type NicknameLikeeIdBlockProps = {
  nickname: string;
  likeeIdLabel: string;
};

/**
 * 两行文本：昵称（TEXT 3246:22320）与 Likee ID（TEXT 3246:22321）。
 * 对应设计稿中独立 FRAME，便于与节点树 1:1 对照。
 */
export function NicknameLikeeIdBlock({ nickname, likeeIdLabel }: NicknameLikeeIdBlockProps) {
  return (
    <div
      className={styles.levelInfoNameRow}
      data-figma-type="FRAME"
      data-figma-id={NICKNAME_LIKEE_ID_FRAME_NODE_ID}
      data-figma-name="昵称+Likee ID"
    >
      <NicknameText nickname={nickname} />
      <LikeeIdText likeeIdLabel={likeeIdLabel} />
    </div>
  );
}
