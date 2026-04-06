import { useCallback, useState } from "react";
import styles from "../../styles/nonSvip0.module.css";
import { FigmaRaster } from "./FigmaRaster";
import { ProductCard, type MallProductCardModel } from "./ProductCard";

const SECTION_FRAME_ID = "3246:22383";
const SWIPER_FRAME_ID = "3328:13757";
const INDICATOR_PARENT_ID = "3328:13759";

/** 与 Figma 商品列表 c_list 下四个实例一致的文案与标签（见节点树 TEXT 抽取） */
const MALL_PRODUCTS: MallProductCardModel[] = [
  {
    figmaCardId: "3313:13405",
    title: "7 Days",
    subtitle: "Svip icon",
    points: "500",
    stockText: "2 Left",
    lockedLabel: "Locked",
    stockVariant: "warning",
  },
  {
    figmaCardId: "3246:22409",
    title: "7 Days",
    subtitle: "Svip icon",
    points: "600",
    stockText: "2 Left",
    tierRequirement: "SVIP1",
    stockVariant: "warning",
  },
  {
    figmaCardId: "3246:22411",
    title: "7 Days",
    subtitle: "Svip icon",
    points: "600",
    stockText: "2 Left",
    tierRequirement: "SVIP2",
    stockVariant: "warning",
  },
  {
    figmaCardId: "3246:22413",
    title: "7 Days",
    subtitle: "Svip icon",
    points: "600",
    stockText: "Sold out",
    tierRequirement: "SVIP3",
    stockVariant: "soldOut",
  },
];

const BANNER_SLIDE_COUNT = 4;

/**
 * Figma: `restore_comp_store_default banner和商城版块` — banner（swiper + 指示器）+ 商城板块。
 */
export function StoreSection() {
  const [activeBanner, setActiveBanner] = useState(0);

  const goBanner = useCallback((index: number) => {
    setActiveBanner(((index % BANNER_SLIDE_COUNT) + BANNER_SLIDE_COUNT) % BANNER_SLIDE_COUNT);
  }, []);

  return (
    <section
      className={styles.storeSection}
      aria-label="Banner 与积分商城"
      data-figma-type="FRAME"
      data-figma-id={SECTION_FRAME_ID}
      data-figma-name="restore_comp_store_default banner和商城版块"
    >
      <div className={styles.storeBannerBlock}>
        <div
          className={styles.storeSwiper}
          data-figma-id={SWIPER_FRAME_ID}
          data-figma-name="c_comp_swiper_banner swiper 容器 v-for"
        >
          <FigmaRaster
            exportBaseName="img_export_banner（swiper项）"
            alt=""
            className={styles.storeBannerImg}
          />
          <span className={styles.storeBannerSlideHint} aria-live="polite">
            {activeBanner + 1} / {BANNER_SLIDE_COUNT}
          </span>
        </div>
        <div
          className={styles.storeBannerDots}
          role="tablist"
          aria-label="Banner indicators"
          data-figma-id={INDICATOR_PARENT_ID}
          data-figma-name="当前激活banner指示器 v-for"
        >
          {Array.from({ length: BANNER_SLIDE_COUNT }, (_, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={activeBanner === i}
              className={
                activeBanner === i ? styles.storeDotActive : styles.storeDot
              }
              onClick={() => goBanner(i)}
            />
          ))}
        </div>
      </div>

      <div className={styles.storeMall} data-figma-name="商城板块">
        <div className={styles.storeMallHeader}>
          <div className={styles.storeMallTitleRow}>
            <span className={styles.storeMallTitle}>Points Mall</span>
            <span className={styles.storeMallProgress}>(0/30)</span>
          </div>
          <div className={styles.storeMallBalanceRow}>
            <div className={styles.storeMallBalance}>
              <span className={styles.storeMallBalanceLabel}>Points balance:</span>
              <FigmaRaster
                exportBaseName="icon_export_积分"
                alt=""
                className={styles.storeMallCoin}
              />
              <span className={styles.storeMallBalanceNum}>400</span>
            </div>
            <button type="button" className={styles.storeMallViewMore}>
              <span>View more</span>
              <FigmaRaster
                exportBaseName="icon_export_箭头"
                alt=""
                className={styles.storeMallArrow}
              />
            </button>
          </div>
        </div>

        <div
          className={styles.storeProductGrid}
          data-figma-id="3246:22405"
          data-figma-name="商品列表 c_list"
        >
          {MALL_PRODUCTS.map((m) => (
            <ProductCard key={m.figmaCardId} model={m} />
          ))}
        </div>
      </div>
    </section>
  );
}
