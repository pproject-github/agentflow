import { useCallback, useState } from "react";
import styles from "../../styles/nonSvip0.module.css";
import { figmaExportPath } from "../../lib/figmaAssets";
import { FigmaRaster } from "./FigmaRaster";

/** Figma RECTANGLE `头像挂件 1` — IMAGE fill on top of Ellipse 1/2 inside `等级=0未达成`. */
export const AVATAR_PENDANT_RECT_NODE_ID = "I3246:22317;27:699;24:651" as const;

/** Export basename → `figma_exports/头像挂件_1.png` (or webp when pipeline emits). */
export const AVATAR_PENDANT_EXPORT_BASE = "头像挂件_1" as const;

const IMG_EXPORT_AVATAR_FRAME_FALLBACK = "img_export_头像框" as const;

/**
 * 头像挂件位图：对应节点 {@link AVATAR_PENDANT_RECT_NODE_ID}（165×141，与父 INSTANCE 同框）。
 * Figma 上对图层有 exposure / saturation 调整；CSS 用近似 filter 占位。
 * 若单独切图不存在，回退为整框实例导出 {@link IMG_EXPORT_AVATAR_FRAME_FALLBACK}。
 */
export function AvatarPendant() {
  const [useFrameComposite, setUseFrameComposite] = useState(false);

  const onPendantError = useCallback(() => {
    setUseFrameComposite(true);
  }, []);

  if (useFrameComposite) {
    return (
      <FigmaRaster
        exportBaseName={IMG_EXPORT_AVATAR_FRAME_FALLBACK}
        alt=""
        className={styles.levelInfoAvatarFrameImg}
        trace={{
          nodeId: AVATAR_PENDANT_RECT_NODE_ID,
          nodeType: "RECTANGLE",
          nodeName: "头像挂件 1 (fallback: img_export_头像框)",
        }}
      />
    );
  }

  return (
    <img
      className={styles.levelInfoAvatarFramePendant}
      src={figmaExportPath(AVATAR_PENDANT_EXPORT_BASE, "png")}
      alt=""
      loading="lazy"
      decoding="async"
      onError={onPendantError}
      data-figma-id={AVATAR_PENDANT_RECT_NODE_ID}
      data-figma-type="RECTANGLE"
      data-figma-name="头像挂件 1"
    />
  );
}
