import type { ReactNode } from "react";
import styles from "../styles/nonSvip0.module.css";

export type NonSvipSectionProps = {
  /** Figma SECTION node id */
  sectionNodeId?: string;
  children: ReactNode;
};

/**
 * Figma: SECTION `非SVIP` (67:2749) — parent of FRAME `非SVIP0_当前在0` (3246:22308).
 * Full-viewport design slice; children typically render the phone-width frame.
 */
export function NonSvipSection({
  sectionNodeId = "67:2749",
  children,
}: NonSvipSectionProps) {
  return (
    <section
      className={styles.nonSvipSection}
      aria-label="非 SVIP 会员页"
      data-figma-type="SECTION"
      data-figma-id={sectionNodeId}
      data-figma-name="非SVIP"
      data-figma-scroll-behavior="SCROLLS"
    >
      {children}
    </section>
  );
}
