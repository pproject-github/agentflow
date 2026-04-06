import styles from "../../styles/nonSvip0.module.css";
import { FigmaRaster } from "./FigmaRaster";
import { LevelTab } from "./LevelTab";
import type { LevelInfoContent } from "./LevelInfoPlateContent";

/** Figma FRAME `等级信息` — tab + progress (node 3246:22325). */
export const LEVEL_INFO_FRAME_NODE_ID = "3246:22325" as const;

export type LevelInfoFrameContent = Pick<
  LevelInfoContent,
  | "nextLevelTitle"
  | "progressPrefix"
  | "progressTargetAmount"
  | "progressMiddle"
  | "progressLevelTag"
  | "currentDiamonds"
  | "goalPrefix"
  | "goalAmount"
>;

export type LevelInfoFrameProps = {
  content: LevelInfoFrameContent;
  /** Progress fill 0–1 */
  progressRatio: number;
};

/**
 * FRAME `等级信息` ({@link LEVEL_INFO_FRAME_NODE_ID}): `等级tab` → `进度信息`.
 */
export function LevelInfoFrame({ content, progressRatio }: LevelInfoFrameProps) {
  const clamped = Math.min(1, Math.max(0, progressRatio));
  const fillPct = `${(clamped * 100).toFixed(2)}%`;

  return (
    <div
      className={styles.levelInfoProgressBlock}
      data-figma-type="FRAME"
      data-figma-id={LEVEL_INFO_FRAME_NODE_ID}
      data-figma-name="等级信息"
    >
      <LevelTab nextLevelTitle={content.nextLevelTitle} />

      <div className={styles.levelInfoProgressWrap} data-figma-id="3246:22330" data-figma-name="进度信息">
        <div className={styles.levelInfoHintLine} data-figma-id="3246:22331" data-figma-name="进度提示文案">
          <span data-figma-id="3246:22332" data-figma-type="TEXT" data-figma-name="Top up a total of">
            {content.progressPrefix}
          </span>
          <span className={styles.levelInfoHintDiamonds} data-figma-id="3246:22333" data-figma-name="进度所需钻石数量">
            <DiamondIcon
              instanceId="3246:22334"
              trace={{ nodeId: "I3246:22334;326:3174", nodeType: "RECTANGLE", nodeName: "钻石" }}
              size="md"
            />
            <span data-figma-id="3246:22335" data-figma-type="TEXT" data-figma-name="1000">
              {content.progressTargetAmount}
            </span>
          </span>
          <span data-figma-id="3246:22336" data-figma-type="TEXT" data-figma-name="to unlock">
            {content.progressMiddle}
          </span>
          <span className={styles.levelInfoHintTag} data-figma-id="3246:22337" data-figma-type="TEXT" data-figma-name="SVIP0">
            {content.progressLevelTag}
          </span>
        </div>

        <div className={styles.levelInfoBarSection} data-figma-id="3246:22338" data-figma-name="进度条">
          <div className={styles.levelInfoBarOuter} data-figma-id="3246:22339" data-figma-name="进度条">
            <div className={styles.levelInfoBarInner} data-figma-id="3246:22340" data-figma-name="进度条容器">
              <div
                className={styles.levelInfoBarFill}
                data-figma-id="3246:22341"
                data-figma-name="进度条进度（百分比）"
                style={{ width: fillPct }}
              />
            </div>
          </div>
          <div className={styles.levelInfoBarCaption} data-figma-id="3246:22342" data-figma-name="进度信息">
            <span className={styles.levelInfoCaptionLeft} data-figma-id="3246:22343" data-figma-name="当前钻石数量">
              <DiamondIcon
                instanceId="3246:22344"
                trace={{ nodeId: "I3246:22344;326:3174", nodeType: "RECTANGLE", nodeName: "钻石" }}
                size="sm"
              />
              <span data-figma-id="3246:22345" data-figma-type="TEXT" data-figma-name="0">
                {content.currentDiamonds}
              </span>
            </span>
            <span className={styles.levelInfoCaptionRight} data-figma-id="3246:22346" data-figma-name="目标钻石数量">
              <span data-figma-id="3246:22347" data-figma-type="TEXT" data-figma-name="SVIP0:">
                {content.goalPrefix}
              </span>
              <DiamondIcon
                instanceId="3246:22348"
                trace={{ nodeId: "I3246:22348;326:3174", nodeType: "RECTANGLE", nodeName: "钻石" }}
                size="sm"
              />
              <span data-figma-id="3246:22349" data-figma-type="TEXT" data-figma-name="1000">
                {content.goalAmount}
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function DiamondIcon({
  instanceId,
  trace,
  size,
}: {
  instanceId: string;
  trace: { nodeId: string; nodeType: string; nodeName: string };
  size: "sm" | "md";
}) {
  const cls = size === "md" ? styles.levelInfoDiamondMd : styles.levelInfoDiamondSm;
  return (
    <span
      className={cls}
      data-figma-id={instanceId}
      data-figma-type="INSTANCE"
      data-figma-name="icon_export_钻石"
    >
      <FigmaRaster exportBaseName="icon_export_钻石" alt="" className={styles.levelInfoDiamondImg} trace={trace} />
    </span>
  );
}
