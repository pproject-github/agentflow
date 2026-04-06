import styles from "../../styles/nonSvip0.module.css";
import { FigmaRaster } from "./FigmaRaster";
import { LevelInfoFrame } from "./LevelInfoFrame";
import { PersonalLevelInfo } from "./PersonalLevelInfo";
import { FIGMA_UPGRADE_BUTTON_TEXT_DEFAULT } from "./UpgradeButtonText";

/** Figma FRAME `等级信息板块内容` */
export const LEVEL_INFO_PLATE_NODE_ID = "3246:22312" as const;

export type LevelInfoContent = {
  /** Display name — replace with live user data in production */
  nickname: string;
  likeeIdLabel: string;
  statusLine: string;
  nextLevelTitle: string;
  upgradeLabel: string;
  progressPrefix: string;
  progressTargetAmount: string;
  progressMiddle: string;
  progressLevelTag: string;
  currentDiamonds: string;
  goalPrefix: string;
  goalAmount: string;
};

export const DEFAULT_LEVEL_INFO_CONTENT: LevelInfoContent = {
  nickname: "Nickname",
  likeeIdLabel: "Likee ID: —",
  statusLine: "SVIP0 Locked",
  nextLevelTitle: "SVIP 1",
  upgradeLabel: FIGMA_UPGRADE_BUTTON_TEXT_DEFAULT,
  progressPrefix: "Top up a total of",
  progressTargetAmount: "1000",
  progressMiddle: "to unlock",
  progressLevelTag: "SVIP0",
  currentDiamonds: "0",
  goalPrefix: "SVIP0:",
  goalAmount: "1000",
};

export type LevelInfoPlateContentProps = {
  /** Copy and amounts — wire to app state / API */
  content: LevelInfoContent;
  /** Progress fill 0–1 (330/656 ≈ 0.5 in design) */
  progressRatio: number;
};

/**
 * Figma FRAME `等级信息板块内容` ({@link LEVEL_INFO_PLATE_NODE_ID}).
 * Child order in file: `个人等级信息` → `等级信息` → `勋章展示`; layout uses a hero row
 * (personal + medal) then full-width progress to match absolute positions.
 */
export function LevelInfoPlateContent({ content, progressRatio }: LevelInfoPlateContentProps) {
  return (
    <div
      className={styles.levelInfoSheet}
      data-figma-type="FRAME"
      data-figma-id={LEVEL_INFO_PLATE_NODE_ID}
      data-figma-name="等级信息板块内容"
    >
      <div className={styles.levelInfoHeroRow}>
        <PersonalLevelInfo
          data={{
            nickname: content.nickname,
            likeeIdLabel: content.likeeIdLabel,
            statusLine: content.statusLine,
            upgradeLabel: content.upgradeLabel,
          }}
        />

        <div
          className={styles.levelInfoMedal}
          data-figma-id="3246:22350"
          data-figma-name="勋章展示"
        >
          <div
            className={styles.levelInfoMedalBase}
            data-figma-id="3320:13677"
            data-figma-name="icon_export_底座"
          >
            <FigmaRaster
              exportBaseName="icon_export_底座"
              alt=""
              className={styles.levelInfoMedalBaseImg}
              trace={{ nodeId: "3320:13678", nodeType: "RECTANGLE", nodeName: "等级=0" }}
            />
          </div>
          <div
            className={styles.levelInfoMedalIcon}
            data-figma-id="3320:13679"
            data-figma-name="icon_export_勋章"
          >
            <FigmaRaster
              exportBaseName="icon_export_勋章"
              alt=""
              className={styles.levelInfoMedalIconImg}
              trace={{ nodeId: "I3320:13680;66:6664", nodeType: "RECTANGLE", nodeName: "svip_03 1" }}
            />
          </div>
        </div>
      </div>

      <LevelInfoFrame
        content={{
          nextLevelTitle: content.nextLevelTitle,
          progressPrefix: content.progressPrefix,
          progressTargetAmount: content.progressTargetAmount,
          progressMiddle: content.progressMiddle,
          progressLevelTag: content.progressLevelTag,
          currentDiamonds: content.currentDiamonds,
          goalPrefix: content.goalPrefix,
          goalAmount: content.goalAmount,
        }}
        progressRatio={progressRatio}
      />
    </div>
  );
}
