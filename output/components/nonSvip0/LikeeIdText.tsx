import styles from "../../styles/nonSvip0.module.css";

/** Figma TEXT `Likee ID` — node id 3246:22321 */
export const LIKEE_ID_TEXT_NODE_ID = "3246:22321" as const;

export type LikeeIdTextProps = {
  /**
   * 整行展示文案，例如 `Likee ID: 7162919826`。
   * 勿写死设计稿示例 ID，由业务数据注入（语义提纲要求）。
   */
  likeeIdLabel: string;
};

/**
 * 个人等级区 Likee ID 行（TEXT）。
 * 设计：Likee Font Regular 400、22px、行高 ~25.78px、填充 #D9D9D9、图层不透明度 0.65（Figma `style` + `fills` + `opacity`）。
 */
export function LikeeIdText({ likeeIdLabel }: LikeeIdTextProps) {
  const text = likeeIdLabel.trim() || "\u00a0";

  return (
    <p
      className={styles.levelInfoLikeeId}
      data-figma-id={LIKEE_ID_TEXT_NODE_ID}
      data-figma-type="TEXT"
      data-figma-name="Likee ID"
    >
      {text}
    </p>
  );
}
