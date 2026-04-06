import styles from "../../styles/nonSvip0.module.css";

/** Figma `status_bar_height 状态栏高度预留` — empty FRAME, design height 48px @ 720px artboard width */
export const STATUS_BAR_HEIGHT_RESERVE_FIGMA = {
  nodeId: "3246:22311",
  nodeName: "status_bar_height 状态栏高度预留",
  /** `absoluteBoundingBox.height` in design pixels */
  designHeightPx: 48,
} as const;

export type StatusBarHeightReserveProps = {
  /** Extra class names (e.g. for Storybook / tests) */
  className?: string;
};

/**
 * Layout spacer for the status-bar region inside `等级信息版块`.
 * Height scales with `.levelInfoSection`’s `--design-w` / `--s` (see `nonSvip0.module.css`).
 * Matches Figma node {@link STATUS_BAR_HEIGHT_RESERVE_FIGMA.nodeId} (opacity 0 in file — non-visual).
 */
export function StatusBarHeightReserve({ className }: StatusBarHeightReserveProps) {
  const { nodeId, nodeName } = STATUS_BAR_HEIGHT_RESERVE_FIGMA;
  return (
    <div
      className={[styles.levelInfoStatusReserve, className].filter(Boolean).join(" ")}
      aria-hidden
      data-figma-type="FRAME"
      data-figma-id={nodeId}
      data-figma-name={nodeName}
    />
  );
}
