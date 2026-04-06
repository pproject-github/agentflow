import styles from "../../styles/nonSvip0.module.css";
import { UpgradeButtonText } from "./UpgradeButtonText";

/** Figma INSTANCE `升级按钮` — child of `等级信息布局` (3246:22318). Component 46:3826, variants 文字 / 强_红 / 迷你（本实例填充与尺寸以节点 JSON 为准）。 */
export const UPGRADE_BUTTON_NODE_ID = "3246:22324" as const;

export type UpgradeButtonProps = {
  label: string;
  onClick?: () => void;
  className?: string;
};

/**
 * 迷你胶囊 CTA：水平居中、固定高度 48px（设计稿）、内边距与设计 auto-layout 一致。
 */
export function UpgradeButton({ label, onClick, className }: UpgradeButtonProps) {
  return (
    <button
      type="button"
      className={[styles.levelInfoUpgradeBtn, className].filter(Boolean).join(" ")}
      data-figma-id={UPGRADE_BUTTON_NODE_ID}
      data-figma-type="INSTANCE"
      data-figma-name="升级按钮"
      onClick={onClick}
    >
      <UpgradeButtonText>{label}</UpgradeButtonText>
    </button>
  );
}
