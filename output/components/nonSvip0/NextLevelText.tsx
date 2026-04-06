import styles from "../../styles/nonSvip0.module.css";

/** Figma TEXT `下一等级文本` — node id 3246:22327 */
export const NEXT_LEVEL_TEXT_NODE_ID = "3246:22327" as const;

export type NextLevelTextProps = {
  /**
   * 下一档等级标题，例如设计稿默认 `SVIP 1`；由业务数据注入，勿写死为固定档。
   */
  nextLevelTitle: string;
};

/**
 * `等级tab` 内首行标题（TEXT）。
 * 设计：Likee Font Regular 400、28px、行高 ~32.8125px、填充 #D9D9D9、图层不透明度 0.65、水平居中（Figma `style` + `fills` + `opacity` + `textAlignHorizontal`）。
 */
export function NextLevelText({ nextLevelTitle }: NextLevelTextProps) {
  const text = nextLevelTitle.trim() || "\u00a0";

  return (
    <p
      className={styles.levelInfoNextLevel}
      data-figma-id={NEXT_LEVEL_TEXT_NODE_ID}
      data-figma-type="TEXT"
      data-figma-name="下一等级文本"
    >
      {text}
    </p>
  );
}
