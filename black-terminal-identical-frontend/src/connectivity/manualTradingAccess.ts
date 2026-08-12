import type { ConnectionLifecycleState } from "./types";

type ManualTradingAccount = {
  permissions: string[];
  riskControls?: {
    tradingEnabled: boolean;
    readOnlyMode: boolean;
    emergencyStop: boolean;
  } | null;
};

export function allowsManualExchangeTrading(account: ManualTradingAccount): boolean {
  if (!account.permissions.includes("place-orders")) return false;

  const controls = account.riskControls;
  if (!controls) return true;
  return controls.tradingEnabled === true && controls.readOnlyMode !== true && controls.emergencyStop !== true;
}

export function isCloudExecutionReady(lifecycle: ConnectionLifecycleState): boolean {
  return lifecycle === "CONNECTED_TRADING";
}
