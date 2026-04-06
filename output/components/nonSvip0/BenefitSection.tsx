import styles from "../../styles/nonSvip0.module.css";
import { FigmaRaster } from "./FigmaRaster";

const SECTION_FRAME_ID = "3246:22353";
const BENEFIT_CARD_IDS = [
  "3246:22358",
  "3246:22363",
  "3246:22368",
  "3246:22373",
  "3246:22378",
] as const;

/**
 * Figma: `restore_comp_benefit_default 专属权益版块` — 权益板块标题 + 权益卡片列表 c_list（5×权益卡片容器）。
 */
export function BenefitSection() {
  return (
    <section
      className={styles.benefitSection}
      aria-label="专属权益版块"
      data-figma-type="FRAME"
      data-figma-id={SECTION_FRAME_ID}
      data-figma-name="restore_comp_benefit_default 专属权益版块"
    >
      <div className={styles.benefitSectionHeader}>
        <h2 className={styles.benefitSectionTitle}>SVIP0 Exclusive Outfit</h2>
        <div
          className={styles.benefitLockedPill}
          data-figma-node="3246:22356"
          aria-label="未解锁"
        >
          <FigmaRaster
            exportBaseName="icon_export_锁"
            alt=""
            className={styles.benefitLockedIcon}
          />
          <span>Locked</span>
        </div>
      </div>
      <ul className={styles.benefitGrid}>
        {BENEFIT_CARD_IDS.map((containerId) => (
          <li
            key={containerId}
            className={styles.benefitCard}
            data-figma-id={containerId}
            data-figma-name="权益卡片容器"
          >
            <div className={styles.benefitCardImage}>
              <FigmaRaster
                exportBaseName="img_export_权益图片"
                alt=""
                className={styles.benefitCardImg}
              />
            </div>
            <p className={styles.benefitCardCaption}>Svip icon</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
