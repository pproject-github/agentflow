import styles from "../../styles/nonSvip0.module.css";

/** Figma TEXT `状态信息文本` (node 3246:22323). */
export const STATUS_INFO_TEXT_NODE_ID = "3246:22323" as const;

export type StatusInfoTextProps = {
  /** Design sample: `SVIP0 Locked`; bind from app state. */
  children: string;
  /** Optional id for tests / analytics. */
  id?: string;
};

/**
 * TEXT `状态信息文本`: Likee Font Regular 24px, line-height 28.125px, fill #D9D9D9 @ 65% layer opacity,
 * `textAlignHorizontal` LEFT, `layoutSizingHorizontal` FILL / `layoutSizingVertical` HUG.
 */
export function StatusInfoText({ children, id }: StatusInfoTextProps) {
  return (
    <p
      id={id}
      className={styles.statusInfoText}
      data-figma-id={STATUS_INFO_TEXT_NODE_ID}
      data-figma-type="TEXT"
      data-figma-name="状态信息文本"
    >
      {children}
    </p>
  );
}
