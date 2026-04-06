import { useId } from "react";
import styles from "../../styles/nonSvip0.module.css";

/** Figma `BOOLEAN_OPERATION` `Subtract` under INSTANCE `img_export_等级装饰` — two ellipses, SUBTRACT, + blur */
export const LEVEL_DECOR_SUBTRACT_NODE_ID = "I3246:22328;29:708" as const;

/** Geometry from `absoluteBoundingBox` vs `3246:22328` (720×120): offset (30, 9.178…), size 660×65.2 */
const SUB_W = 660.02734375;
const SUB_H = 65.203125;

/** Child ellipses in coordinates relative to Subtract frame origin (top-left). */
const E1 = { cx: 331.934, cy: -60.2755, rx: 378.366, ry: 125.4785 };
const E2 = { cx: 332.32, cy: -66.453, rx: 392.651, ry: 124.706 };

const VIEW_X = -120;
const VIEW_Y = -220;
const VIEW_W = 900;
const VIEW_H = 420;

const FILL = "#d9d9d9";
const BLUR_STD = 6.599790573120117;

/** Matches INSTANCE `3246:22328` frame vs. child `Subtract` bounding boxes from Figma JSON */
export const LEVEL_DECOR_SUBTRACT_LAYOUT = {
  parentW: 720,
  parentH: 120,
  offsetX: 30,
  offsetY: 9.1780395507812,
  width: SUB_W,
  height: SUB_H,
} as const;

export type LevelDecorSubtractProps = {
  className?: string;
};

/**
 * Vector fallback for the Figma boolean subtract (layer blur in file). When the parent
 * `img_export_等级装饰` raster loads, this layer is unmounted in {@link LevelDecor} to avoid
 * double-drawing the same pixels.
 */
export function LevelDecorSubtract({ className }: LevelDecorSubtractProps) {
  const rawId = useId().replace(/:/g, "");
  const blurId = `figma-subtract-blur-${rawId}`;
  const maskId = `figma-subtract-mask-${rawId}`;

  const wrap = [styles.levelDecorSubtract, className].filter(Boolean).join(" ");
  const L = LEVEL_DECOR_SUBTRACT_LAYOUT;
  const positionStyle = {
    left: `calc(100% * ${L.offsetX} / ${L.parentW})`,
    top: `calc(100% * ${L.offsetY} / ${L.parentH})`,
    width: `calc(100% * ${L.width} / ${L.parentW})`,
    height: `calc(100% * ${L.height} / ${L.parentH})`,
  } as const;

  return (
    <div
      className={wrap}
      style={positionStyle}
      data-figma-id={LEVEL_DECOR_SUBTRACT_NODE_ID}
      data-figma-type="BOOLEAN_OPERATION"
      data-figma-name="Subtract"
      data-figma-boolean-op="SUBTRACT"
      aria-hidden
    >
      <svg
        className={styles.levelDecorSubtractSvg}
        viewBox={`${VIEW_X} ${VIEW_Y} ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        width="100%"
        height="100%"
      >
        <defs>
          <filter id={blurId} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation={BLUR_STD} />
          </filter>
          <mask id={maskId} maskUnits="userSpaceOnUse">
            <ellipse cx={E1.cx} cy={E1.cy} rx={E1.rx} ry={E1.ry} fill="white" />
            <ellipse cx={E2.cx} cy={E2.cy} rx={E2.rx} ry={E2.ry} fill="black" />
          </mask>
        </defs>
        <rect
          x={VIEW_X}
          y={VIEW_Y}
          width={VIEW_W}
          height={VIEW_H}
          fill={FILL}
          mask={`url(#${maskId})`}
          filter={`url(#${blurId})`}
        />
      </svg>
    </div>
  );
}
