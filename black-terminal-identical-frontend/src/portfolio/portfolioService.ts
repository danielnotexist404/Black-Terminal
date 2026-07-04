import { blackCoreEventBus } from "../core/blackCore";
import type { Balance, OrderUpdate } from "../execution/types";
import type { PortfolioPosition } from "../positions/types";

export type PortfolioAccountState = {
  accountId: string;
  balances: Balance[];
  positions: PortfolioPosition[];
  orders: OrderUpdate[];
  updatedAt: number;
};

export class PortfolioService {
  private accounts = new Map<string, PortfolioAccountState>();

  updateAccount(state: PortfolioAccountState) {
    this.accounts.set(state.accountId, state);
    blackCoreEventBus.publish("portfolio.updated", { accountId: state.accountId, time: state.updatedAt });
  }

  updatePosition(accountId: string, position: PortfolioPosition) {
    const state = this.accounts.get(accountId) ?? { accountId, balances: [], positions: [], orders: [], updatedAt: Date.now() };
    const positions = [position, ...state.positions.filter((item) => item.id !== position.id)];
    this.updateAccount({ ...state, positions, updatedAt: Date.now() });
    blackCoreEventBus.publish("position.updated", { accountId, symbol: position.symbol, time: Date.now() });
  }

  getAccount(accountId: string) {
    return this.accounts.get(accountId);
  }

  listAccounts() {
    return Array.from(this.accounts.values());
  }
}

export const blackCorePortfolioService = new PortfolioService();
