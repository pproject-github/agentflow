import type { CSSProperties } from "react";
import { useCallback, useState } from "react";
import { figmaExportPath } from "../../lib/figmaAssets";

/** Optional mapping from React `<img>` to a specific Figma RECTANGLE / raster layer (nested under an INSTANCE). */
export type FigmaRasterTrace = {
  nodeId: string;
  nodeType: string;
  nodeName: string;
};

export type FigmaRasterProps = {
  /** Base name without extension, e.g. `img_export_背景图` */
  exportBaseName: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
  /** Default png; switch when export pipeline emits webp/svg */
  ext?: "png" | "webp" | "svg";
  /** When true (default), hide raster if load fails so parent background shows */
  hideOnError?: boolean;
  /** When set, written as `data-figma-*` on the `<img>` for the concrete raster node in the tree */
  trace?: FigmaRasterTrace;
  /** Fires after the image loads successfully */
  onLoad?: () => void;
  /** Fires when the image fails to load (before optional unmount when `hideOnError`) */
  onError?: () => void;
};

/**
 * Raster placeholder for `img_export_*` / `icon_export_*` assets.
 */
export function FigmaRaster({
  exportBaseName,
  alt,
  className,
  style,
  ext = "png",
  hideOnError = true,
  trace,
  onLoad,
  onError: onErrorProp,
}: FigmaRasterProps) {
  const [failed, setFailed] = useState(false);
  const onError = useCallback(() => {
    onErrorProp?.();
    if (hideOnError) setFailed(true);
  }, [hideOnError, onErrorProp]);
  const handleLoad = useCallback(() => {
    onLoad?.();
  }, [onLoad]);

  if (failed) {
    return null;
  }

  return (
    <img
      className={className}
      style={style}
      src={figmaExportPath(exportBaseName, ext)}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={onError}
      onLoad={handleLoad}
      {...(trace
        ? {
            "data-figma-id": trace.nodeId,
            "data-figma-type": trace.nodeType,
            "data-figma-name": trace.nodeName,
          }
        : {})}
    />
  );
}
