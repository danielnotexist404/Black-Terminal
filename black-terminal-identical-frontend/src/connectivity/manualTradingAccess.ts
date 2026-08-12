import type { ConnectionLifecycleState } from "./types";

type ManualTradingAccount = {
  permissions: string[];
  riskControls?: {
    tradingEnabled: boolean;
    readOnlyMode: boolean;
    emergencyStop: boolean;
  } | null;
};

const MANUAL_TRADING_LIFECYCLES = new Set<ConnectionLifecycleState>([
  "CONNECTED_TRADING",
  // This state can mean that Black Cloud/private-stream execution is unavailable.
  // Authenticated manual REST orders remain independently protected by server risk checks.
  "EXECUTION_BLOCKED"
]);

export function allowsManualExchangeTrading(account: ManualTradingAccount, lifecycle: ConnectionLifecycleState): boolean {
  if (!account.permissions.includes("place-orders")) return false;
  if (!MANUAL_TRADING_LIFECYCLES.has(lifecycle)) return false;

  const controls = account.riskControls;
  if (!controls) return true;
  return controls.tradingEnabled === true && controls.readOnlyMode !== true && controls.emergencyStop !== true;
}

export function isCloudExecutionReady(lifecycle: ConnectionLifecycleState): boolean {
  return lifecycle === "CONNECTED_TRADING";
}
