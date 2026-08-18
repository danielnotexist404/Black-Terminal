import type { Timeframe } from "../market-data/types";
import type { DDAProEventType } from "../modules/dda-pro/core/types";

export type AlertIndicatorTarget = "price" | "hdlxProfile" | "vwap" | "ema20" | "ema50" | "ema200" | "ddaPro";
export type AlertCondition = "testing" | "crossingAbove" | "crossingBelow";
export type AlertRunMode = "once" | "perpetual";
export type AlertLevelTarget = "any" | "poc" | "vah" | "val" | "lvn" | "srZone" | "supportZone" | "resistanceZone";
export type DDAProAlertSignal = DDAProEventType | "BC_RDA_ANY_SIGNAL" | "BC_RDA_LONG_SIGNAL" | "BC_RDA_SHORT_SIGNAL";

export type IndicatorAlertDefinition = {
  id: string;
  enabled: boolean;
  name: string;
  symbol: string;
  exchange: string;
  timeframe: Timeframe;
  indicator: AlertIndicatorTarget;
  levelTarget?: AlertLevelTarget;
  ddaSignal?: DDAProAlertSignal;
  targetPrice?: number;
  color?: string;
  condition: AlertCondition;
  runMode: AlertRunMode;
  cooldownSeconds: number;
  webhookUrl?: string;
  p2pEndpoint?: string;
  sshTarget?: string;
  emailTo?: string;
  message: string;
  script: string;
  createdAt: number;
  fired: boolean;
};
