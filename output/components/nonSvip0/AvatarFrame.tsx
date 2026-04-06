import styles from "../../styles/nonSvip0.module.css";
import { AvatarPendant } from "./AvatarPendant";

/** Figma `INSTANCE` `img_export_头像框` — decorative frame over the circular avatar (variant e.g. 等级=0). */
export const AVATAR_FRAME_INSTANCE_NODE_ID = "3246:22317" as const;

/**
 * Nested variant inside {@link AVATAR_FRAME_INSTANCE_NODE_ID} — `等级=0未达成` (component `24:648`).
 * Sub-layers: {@link AVATAR_FRAME_ELLIPSE_1_NODE_ID} `Ellipse 1` / `Ellipse 2` + {@link AvatarPendant}（RECTANGLE `头像挂件 1`）；缺省切图时回退 `img_export_头像框`。
 */
export const AVATAR_FRAME_VARIANT_LEVEL0_NOT_ACHIEVED_NODE_ID = "I3246:22317;27:699" as const;

/** ELLIPSE `Ellipse 1` — first child under `等级=0未达成` (vector ring; hidden in Figma). */
export const AVATAR_FRAME_ELLIPSE_1_NODE_ID = "I3246:22317;27:699;24:649" as const;

/** ELLIPSE `Ellipse 2` — solid light-gray circle under `头像挂件 1` / composite raster (Figma `visible: false`; restored as vector fallback). */
export const AVATAR_FRAME_ELLIPSE_2_NODE_ID = "I3246:22317;27:699;24:650" as const;

export const IMG_EXPORT_AVATAR_FRAME = "img_export_头像框" as const;

export type AvatarFrameProps = {
  className?: string;
};

/**
 * 头像框切图叠层，对应 Figma {@link AVATAR_FRAME_INSTANCE_NODE_ID}，内层实例 {@link AVATAR_FRAME_VARIANT_LEVEL0_NOT_ACHIEVED_NODE_ID}。
 * 挂件位图：`figma_exports/头像挂件_1.png`；回退整框：`figma_exports/img_export_头像框.png`。
 */
export function AvatarFrame({ className }: AvatarFrameProps) {
  const wrapClass = [styles.levelInfoAvatarFrame, className].filter(Boolean).join(" ");

  return (
    <div
      className={wrapClass}
      data-figma-id={AVATAR_FRAME_INSTANCE_NODE_ID}
      data-figma-type="INSTANCE"
      data-figma-name={IMG_EXPORT_AVATAR_FRAME}
    >
      <div
        className={styles.levelInfoAvatarFrameVariant}
        data-figma-id={AVATAR_FRAME_VARIANT_LEVEL0_NOT_ACHIEVED_NODE_ID}
        data-figma-type="INSTANCE"
        data-figma-name="等级=0未达成"
      >
        <div
          className={styles.levelInfoAvatarFrameEllipse1}
          data-figma-id={AVATAR_FRAME_ELLIPSE_1_NODE_ID}
          data-figma-type="ELLIPSE"
          data-figma-name="Ellipse 1"
          aria-hidden
        />
        <div
          className={styles.levelInfoAvatarFrameEllipse2}
          data-figma-id={AVATAR_FRAME_ELLIPSE_2_NODE_ID}
          data-figma-type="ELLIPSE"
          data-figma-name="Ellipse 2"
          aria-hidden
        />
        <AvatarPendant />
      </div>
    </div>
  );
}
