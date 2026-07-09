import { registerBlackCoreService } from "./blackCore";
import { blackCoreBrokerFramework } from "../broker/brokerFramework";
import { blackCoreConnectionManager } from "../connectivity/connectionManager";
import { registerConnectivityAdapters } from "../connectivity/registerConnectivity";
import { blackCoreMarketDataEngine } from "../market-data/engine/marketDataEngine";
import { blackCoreNotificationCenter } from "../notifications/notificationCenter";
import { blackCoreOrderSyncService } from "../orders/orderSyncService";
import { blackCorePortfolioService } from "../portfolio/portfolioService";
import { blackCorePositionManager } from "../positions/positionManager";
import { PerformanceMonitor } from "../performance/performanceMonitor";
import { blackCoreWalletFramework } from "../wallets/walletFramework";
import { registerDomProModule } from "../modules/dom-pro";

let registered = false;

export function registerBlackCoreServices() {
  if (registered) return;
  registered = true;
  registerConnectivityAdapters();
  registerDomProModule();

  registerBlackCoreService("connections", blackCoreConnectionManager);
  registerBlackCoreService("marketData", blackCoreMarketDataEngine);
  registerBlackCoreService("brokerFramework", blackCoreBrokerFramework);
  registerBlackCoreService("walletFramework", blackCoreWalletFramework);
  registerBlackCoreService("portfolio", blackCorePortfolioService);
  registerBlackCoreService("positions", blackCorePositionManager);
  registerBlackCoreService("orders", blackCoreOrderSyncService);
  registerBlackCoreService("notifications", blackCoreNotificationCenter);
  registerBlackCoreService("performance", new PerformanceMonitor());
}
