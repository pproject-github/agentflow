import styles from "../../styles/nonSvip0.module.css";

/** Figma TEXT `昵称` — node id 3246:22320 */
export const NICKNAME_TEXT_NODE_ID = "3246:22320" as const;

export type NicknameTextProps = {
  /** 展示用昵称；勿写死设计稿示例名，由业务数据注入 */
  nickname: string;
};

/**
 * 个人等级区主昵称行（TEXT）。
 * 设计：Likee Font Medium、32px、行高 37.5px、字间距 0、填充 #D9D9D9（Figma `style` + `fills`）。
 */
export function NicknameText({ nickname }: NicknameTextProps) {
  const text = nickname.trim() || "\u00a0";

  return (
    <p
      className={styles.levelInfoNickname}
      data-figma-id={NICKNAME_TEXT_NODE_ID}
      data-figma-type="TEXT"
      data-figma-name="昵称"
    >
      {text}
    </p>
  );
}
