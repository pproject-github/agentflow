import styles from "../../styles/nonSvip0.module.css";
import { StatusInfoText, STATUS_INFO_TEXT_NODE_ID } from "./StatusInfoText";

/** Figma FRAME `状态信息` — child of `等级信息布局` (3246:22318). */
export const STATUS_INFO_FRAME_NODE_ID = "3246:22322" as const;

export { STATUS_INFO_TEXT_NODE_ID };

export type StatusInfoFrameProps = {
  /** Bound to design sample `SVIP0 Locked`; replace with real status from app data. */
  statusLine: string;
};

/**
 * FRAME `状态信息`: `layoutMode` VERTICAL, `itemSpacing` 8, `maxWidth` 320 (Figma px).
 * Single TEXT child: {@link StatusInfoText}.
 */
export function StatusInfoFrame({ statusLine }: StatusInfoFrameProps) {
  return (
    <div
      className={styles.statusInfoFrame}
      data-figma-type="FRAME"
      data-figma-id={STATUS_INFO_FRAME_NODE_ID}
      data-figma-name="状态信息"
    >
      <StatusInfoText>{statusLine}</StatusInfoText>
    </div>
  );
}
