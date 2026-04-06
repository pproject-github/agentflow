/**
 * Relative paths under `output/figma_exports/` — filled by the export pipeline.
 * Keep names aligned with Figma instance prefixes `img_export_*` / `icon_export_*`.
 */
export type FigmaImageKey =
  | "img_export_背景图"
  | "img_export_头像"
  | "img_export_头像框"
  /** RECTANGLE `头像挂件 1` under `等级=0未达成` — raster export of imageRef layer */
  | "头像挂件_1"
  | "img_export_等级装饰"
  | "img_export_当前等级"
  | "img_export_banner（swiper项）"
  | "img_export_权益图片"
  | "img_export_商品图片";

export type FigmaIconKey =
  | "icon_export_底座"
  | "icon_export_勋章"
  | "icon_export_钻石"
  | "icon_export_锁"
  | "icon_export_积分"
  | "icon_export_箭头"
  | "icon_export_详情"
  | "icon_export_联系官方"
  | "icon_export_返回"
  | "icon_export_警告";

/** Resolve relative to the HTML document / dev server root that contains `figma_exports/`. */
const BASE = "figma_exports";

export function figmaExportPath(
  baseName: string,
  ext: "png" | "webp" | "svg" = "png"
): string {
  const safe = baseName.replace(/[/\\]/g, "_");
  return `${BASE}/${safe}.${ext}`;
}
