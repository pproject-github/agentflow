import styles from "../../styles/nonSvip0.module.css";
import { FigmaRaster } from "./FigmaRaster";

/** Mirrors Figma `商品卡片容器` ×4 — TEXT 与标签组合见节点树 3313:13405 / 3246:22409 / 3246:22411 / 3246:22413 */
export type MallProductCardModel = {
  figmaCardId: string;
  title: string;
  subtitle: string;
  points: string;
  stockText: string;
  /** e.g. SVIP1 — shown on lock ribbon */
  tierRequirement?: string;
  /** First card: standalone Locked; others use tier + lock */
  lockedLabel?: "Locked" | "none";
  stockVariant?: "warning" | "soldOut";
};

export type ProductCardProps = {
  model: MallProductCardModel;
};

export function ProductCard({ model }: ProductCardProps) {
  const {
    figmaCardId,
    title,
    subtitle,
    points,
    stockText,
    tierRequirement,
    lockedLabel = "none",
    stockVariant = "warning",
  } = model;

  return (
    <article
      className={styles.productCard}
      data-figma-id={figmaCardId}
      data-figma-name="商品卡片"
    >
      <div className={styles.productCardImageWrap}>
        <FigmaRaster
          exportBaseName="img_export_商品图片"
          alt=""
          className={styles.productCardImage}
        />
        {lockedLabel === "Locked" && (
          <div className={styles.productCardLockedFloat} role="status">
            Locked
          </div>
        )}
        {tierRequirement && (
          <div className={styles.productCardTierRibbon}>
            <FigmaRaster
              exportBaseName="icon_export_锁"
              alt=""
              className={styles.productCardTierLock}
            />
            <span>{tierRequirement}</span>
          </div>
        )}
        <div
          className={
            stockVariant === "soldOut"
              ? styles.productCardStockSoldOut
              : styles.productCardStockWarn
          }
        >
          {stockVariant === "warning" && (
            <FigmaRaster
              exportBaseName="icon_export_警告"
              alt=""
              className={styles.productCardStockIcon}
            />
          )}
          <span>{stockText}</span>
        </div>
      </div>
      <div className={styles.productCardBody}>
        <p className={styles.productCardTitle}>{title}</p>
        <p className={styles.productCardSubtitle}>{subtitle}</p>
        <div className={styles.productCardPointsRow}>
          <FigmaRaster
            exportBaseName="icon_export_积分"
            alt=""
            className={styles.productCardPointsIcon}
          />
          <span className={styles.productCardPoints}>{points}</span>
        </div>
      </div>
    </article>
  );
}
