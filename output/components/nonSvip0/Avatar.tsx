import styles from "../../styles/nonSvip0.module.css";
import { AvatarFrame } from "./AvatarFrame";
import { FigmaRaster } from "./FigmaRaster";

/** Figma FRAME `头像` — circular raster + decorative frame overlay; child of `头像布局`. */
export const AVATAR_NODE_ID = "3246:22315" as const;

/** Figma `ELLIPSE` `图像图片` — circular user photo; raster export `img_export_头像`. */
export const AVATAR_IMAGE_ELLIPSE_NODE_ID = "3246:22316" as const;

/** Figma `图像图片` — raster ellipse */
const AVATAR_RASTER = "img_export_头像" as const;

export type AvatarProps = {
  className?: string;
};

/**
 * 头像：圆形 `图像图片` + `img_export_头像框` 叠层。
 * 对应 Figma `FRAME` {@link AVATAR_NODE_ID}。
 */
export function Avatar({ className }: AvatarProps) {
  const rootClass = [styles.levelInfoAvatarWrap, className].filter(Boolean).join(" ");

  return (
    <div
      className={rootClass}
      data-figma-type="FRAME"
      data-figma-id={AVATAR_NODE_ID}
      data-figma-name="头像"
    >
      <div
        className={styles.levelInfoAvatarCircle}
        data-figma-id={AVATAR_IMAGE_ELLIPSE_NODE_ID}
        data-figma-name="图像图片"
        data-figma-type="ELLIPSE"
      >
        <FigmaRaster
          exportBaseName={AVATAR_RASTER}
          alt=""
          className={styles.levelInfoAvatarImg}
          trace={{
            nodeId: AVATAR_IMAGE_ELLIPSE_NODE_ID,
            nodeType: "ELLIPSE",
            nodeName: "图像图片",
          }}
        />
      </div>
      <AvatarFrame />
    </div>
  );
}
