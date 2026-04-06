import styles from "../../styles/nonSvip0.module.css";

/** Figma TEXT `升级按钮文本` — child of INSTANCE `升级按钮` (3246:22324). */
export const UPGRADE_BUTTON_TEXT_NODE_ID = "I3246:22324;13:1512" as const;

/** Design file `characters` when not overridden (LikeeFont-Medium 24 / 28.125, black @ 65% fill). */
export const FIGMA_UPGRADE_BUTTON_TEXT_DEFAULT = "Upgrade" as const;

export type UpgradeButtonTextProps = {
  /** Button label — bind to i18n / CMS; default mock matches Figma. */
  children: string;
  className?: string;
};

/**
 * Renders only the TEXT layer: centered, HUG×HUG, fill black @ 65% opacity per Figma `fills`.
 */
export function UpgradeButtonText({ children, className }: UpgradeButtonTextProps) {
  return (
    <span
      className={[styles.levelInfoUpgradeBtnText, className].filter(Boolean).join(" ")}
      data-figma-id={UPGRADE_BUTTON_TEXT_NODE_ID}
      data-figma-type="TEXT"
      data-figma-name="升级按钮文本"
    >
      {children}
    </span>
  );
}
