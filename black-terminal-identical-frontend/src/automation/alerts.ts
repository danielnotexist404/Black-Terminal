import type { Timeframe } from "../market-data/types";

export type AlertIndicatorTarget = "price" | "hdlxProfile" | "vwap" | "ema20" | "ema50" | "ema200";
export type AlertCondition = "testing" | "crossingAbove" | "crossingBelow";
export type AlertRunMode = "once" | "perpetual";
export type AlertLevelTarget = "any" | "poc" | "vah" | "val" | "lvn";

export type IndicatorAlertDefinition = {
  id: string;
  enabled: boolean;
  name: string;
  symbol: string;
  exchange: string;
  timeframe: Timeframe;
  indicator: AlertIndicatorTarget;
  levelTarget?: AlertLevelTarget;
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
