import { useState } from "react";
import styles from "../../styles/nonSvip0.module.css";
import { FigmaRaster } from "./FigmaRaster";
import { LevelDecorSubtract } from "./LevelDecorSubtract";

/** Figma INSTANCE `img_export_等级装饰` — 等级 Tab 行内的弧形装饰条（PNG 导出） */
export const LEVEL_DECOR_INSTANCE_ID = "3246:22328" as const;

export const LEVEL_DECOR_EXPORT_BASE = "img_export_等级装饰" as const;

export type LevelDecorProps = {
  /** 对齐 Figma `componentProperties.等级`（如 `0` / `1` …），仅作 data 属性便于对照 */
  level?: string;
  className?: string;
  imgClassName?: string;
  alt?: string;
};

/**
 * INSTANCE {@link LEVEL_DECOR_INSTANCE_ID} — 设计尺寸约 720×120（`absoluteBoundingBox`），
 * 资源路径 {@link LEVEL_DECOR_EXPORT_BASE} → `figma_exports/img_export_等级装饰.png`。
 */
export function LevelDecor({
  level = "0",
  className,
  imgClassName,
  alt = "",
}: LevelDecorProps) {
  const wrap = [styles.levelInfoDecor, className].filter(Boolean).join(" ");
  const img = [styles.levelInfoDecorImg, styles.levelDecorRaster, imgClassName].filter(Boolean).join(" ");
  const [rasterState, setRasterState] = useState<"loading" | "ok" | "failed">("loading");

  return (
    <div
      className={wrap}
      data-figma-id={LEVEL_DECOR_INSTANCE_ID}
      data-figma-type="INSTANCE"
      data-figma-name="img_export_等级装饰"
      data-figma-variant-level={level}
    >
      <div className={styles.levelDecorInner}>
        {rasterState !== "ok" ? <LevelDecorSubtract /> : null}
        <FigmaRaster
          exportBaseName={LEVEL_DECOR_EXPORT_BASE}
          alt={alt}
          className={img}
          onLoad={() => setRasterState("ok")}
          onError={() => setRasterState("failed")}
        />
      </div>
    </div>
  );
}
