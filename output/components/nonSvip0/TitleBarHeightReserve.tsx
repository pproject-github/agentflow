import styles from "../../styles/nonSvip0.module.css";

/** Figma `标题栏高度预留` — empty FRAME for title-bar / nav chrome overlap */
export const TITLE_BAR_HEIGHT_RESERVE_FIGMA = {
  nodeId: "3303:13159",
  nodeName: "标题栏高度预留",
  /** `absoluteBoundingBox.height` in design pixels (@ 720px-wide frame) */
  designHeightPx: 96,
} as const;

export type TitleBarHeightReserveProps = {
  className?: string;
};

/**
 * Layout spacer below {@link StatusBarHeightReserve} inside `等级信息版块`.
 * Height scales with `--design-w` / `--s` (see `nonSvip0.module.css`).
 * Matches Figma node {@link TITLE_BAR_HEIGHT_RESERVE_FIGMA.nodeId}.
 */
export function TitleBarHeightReserve({ className }: TitleBarHeightReserveProps) {
  const { nodeId, nodeName } = TITLE_BAR_HEIGHT_RESERVE_FIGMA;
  return (
    <div
      className={[styles.levelInfoTitleReserve, className].filter(Boolean).join(" ")}
      aria-hidden
      data-figma-type="FRAME"
      data-figma-id={nodeId}
      data-figma-name={nodeName}
    />
  );
}
