import { TypedEventBus } from "./events/eventBus";
import type { MarketEventMap } from "./events/marketEvents";
import { blackCoreServices } from "./services/serviceRegistry";

export const blackCoreEventBus = new TypedEventBus<MarketEventMap>();

export function registerBlackCoreService<T>(key: string, service: T) {
  blackCoreServices.register(key, service);
}

export function getBlackCoreService<T>(key: string) {
  return blackCoreServices.get<T>(key);
}
