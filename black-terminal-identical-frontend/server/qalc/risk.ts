import type { QalcConfig, QalcPaperExecution, QalcPaperInventory, QalcRiskState } from "./contracts.ts";

export class QalcRiskEngine {
  private readonly config: QalcConfig;
  private stateValue: QalcRiskState = { suspended: false, dailyPnl: 0, dailyDrawdownPercent: 0, consecutiveLosses: 0, toxicExits10m: 0, recentMarkoutsBps: [] };
  private highWaterEquity: number;
  private toxicExitTimes: number[] = [];

  constructor(config: QalcConfig) { this.config = config; this.highWaterEquity = config.paperEquity; }

  state() { return { ...this.stateValue, recentMarkoutsBps: [...this.stateValue.recentMarkoutsBps] }; }

  size(price: number, tickSize: number, quantityStep: number) {
    if (![price, tickSize, quantityStep].every((value) => Number.isFinite(value) && value > 0)) return 0;
    const riskBudget = this.config.paperEquity * this.config.riskPerTradePercent / 100;
    const riskPerUnit = Math.max(tickSize, this.config.hardStopTicks * tickSize);
    const leverageCap = this.config.paperEquity * this.config.maximumLeverage / Math.max(price, 0.000001);
    const raw = Math.min(riskBudget / riskPerUnit, leverageCap);
    return Math.max(0, Math.floor(raw / quantityStep) * quantityStep);
  }

  recordClosed(realizedPnl: number, now: number, toxic: boolean) {
    this.stateValue.dailyPnl += realizedPnl;
    this.stateValue.consecutiveLosses = realizedPnl < 0 ? this.stateValue.consecutiveLosses + 1 : 0;
    if (toxic) this.toxicExitTimes.push(now);
    this.toxicExitTimes = this.toxicExitTimes.filter((time) => time >= now - 600_000);
    this.stateValue.toxicExits10m = this.toxicExitTimes.length;
    const equity = this.config.paperEquity + this.stateValue.dailyPnl;
    this.highWaterEquity = Math.max(this.highWaterEquity, equity);
    this.stateValue.dailyDrawdownPercent = this.highWaterEquity > 0 ? Math.max(0, (this.highWaterEquity - equity) / this.highWaterEquity * 100) : 100;
    this.evaluate();
  }

  recordMarkout(markoutBps: number) {
    this.stateValue.recentMarkoutsBps.push(markoutBps);
    if (this.stateValue.recentMarkoutsBps.length > 100) this.stateValue.recentMarkoutsBps.shift();
  }

  applyExecution(inventory: QalcPaperInventory | undefined, execution: QalcPaperExecution) {
    const signedQuantity = execution.side === "BUY" ? execution.quantity : -execution.quantity;
    if (!inventory) {
      return {
        side: signedQuantity > 0 ? "LONG" as const : "SHORT" as const,
        quantity: Math.abs(signedQuantity), averagePrice: execution.price, openedAt: execution.time,
        entryFees: execution.fee, realizedPnl: 0, unrealizedPnl: -execution.fee, lastMarkPrice: execution.price,
      };
    }
    const currentSigned = inventory.side === "LONG" ? inventory.quantity : -inventory.quantity;
    if (Math.sign(currentSigned) === Math.sign(signedQuantity)) {
      const quantity = inventory.quantity + Math.abs(signedQuantity);
      return { ...inventory, quantity, averagePrice: (inventory.averagePrice * inventory.quantity + execution.price * Math.abs(signedQuantity)) / quantity, entryFees: inventory.entryFees + execution.fee };
    }
    const closed = Math.min(inventory.quantity, Math.abs(signedQuantity));
    const gross = inventory.side === "LONG" ? (execution.price - inventory.averagePrice) * closed : (inventory.averagePrice - execution.price) * closed;
    const realizedPnl = inventory.realizedPnl + gross - execution.fee - inventory.entryFees * (closed / inventory.quantity);
    const remaining = inventory.quantity - closed;
    if (remaining <= 1e-12) return undefined;
    return { ...inventory, quantity: remaining, realizedPnl, entryFees: inventory.entryFees * (remaining / inventory.quantity) };
  }

  private evaluate() {
    const reason = this.stateValue.dailyDrawdownPercent >= this.config.maximumDailyLossPercent ? "MAXIMUM_DAILY_LOSS"
      : this.stateValue.consecutiveLosses >= this.config.maximumConsecutiveLosses ? "CONSECUTIVE_LOSS_LIMIT"
        : this.stateValue.toxicExits10m >= this.config.maximumToxicExits10m ? "TOXIC_EXIT_LIMIT" : undefined;
    this.stateValue.suspended = !!reason;
    this.stateValue.reason = reason;
  }
}
