import { blackCoreEventBus } from "../core/blackCore";
import { createId } from "../core/ids";
import type { ExecutionReport, ExecutionRequest } from "../execution/types";
import type {
  ManagedPosition,
  PortfolioPosition,
  PositionHealth,
  PositionLifecycleEvent,
  PositionLifecycleState,
  PositionProtectionOrder,
  PositionProtectionType,
  PositionTimelineEvent,
  PositionTimelineEventType
} from "./types";

type PositionListener = (positions: ManagedPosition[]) => void;

type ProtectionPatch = {
  price?: number;
  trailBy?: number;
  trailMode?: PositionProtectionOrder["trailMode"];
  activation?: PositionProtectionOrder["activation"];
  activationPrice?: number;
  orderId?: string;
  metadata?: Record<string, unknown>;
};

export class PositionManager {
  private positions = new Map<string, ManagedPosition>();
  private listeners = new Set<PositionListener>();

  subscribe(listener: PositionListener) {
    this.listeners.add(listener);
    listener(this.listActivePositions());
    return () => {
      this.listeners.delete(listener);
    };
  }

  listPositions() {
    return Array.from(this.positions.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listActivePositions() {
    return this.listPositions().filter((position) => !["closed", "archived"].includes(position.lifecycleState));
  }

  getPosition(positionId: string) {
    return this.positions.get(positionId) ?? null;
  }

  findActivePosition(symbol: string, exchange?: string) {
    const normalized = normalizeSymbol(symbol);
    return this.listActivePositions().find((position) => {
      const sameSymbol = normalizeSymbol(position.symbol) === normalized;
      const sameExchange = !exchange || position.exchange === exchange;
      return sameSymbol && sameExchange;
    }) ?? null;
  }

  syncExternalPositions(positions: PortfolioPosition[], source = "portfolio-sync") {
    for (const position of positions) {
      const current = this.positions.get(position.id);
      if (current) {
        this.patchPosition(position.id, {
          ...position,
          health: this.calculateHealth({ ...current, ...position }),
          updatedAt: Date.now()
        }, "position-updated", `${position.symbol} synchronized from ${source}.`);
        continue;
      }
      const managed = this.toManagedPosition(position, source);
      this.positions.set(managed.id, managed);
      this.emitTimeline(managed, "position-opened", `${managed.symbol} synchronized as managed position.`, { source });
    }
    this.notify();
  }

  ingestExecutionReport(report: ExecutionReport, request: ExecutionRequest) {
    if (!["filled", "partially-filled", "accepted"].includes(report.status)) return null;
    const executedQuantity = report.filledQuantity > 0 ? report.filledQuantity : report.status === "filled" ? request.quantity : 0;
    if (executedQuantity <= 0) return null;

    const sideDirection = request.side === "buy" ? "long" : "short";
    const price = report.averageFillPrice || request.referencePrice || request.limitPrice || request.stopPrice || 1;
    const existing = this.findPositionForExecution(request.accountId, request.symbol, request.exchange);

    if (request.reduceOnly && existing) {
      const nextQuantity = Math.max(0, existing.quantity - executedQuantity);
      const state: PositionLifecycleState = nextQuantity <= 0 ? "closed" : "scaling";
      const patched = this.patchPosition(existing.id, {
        quantity: nextQuantity,
        realizedPnl: existing.realizedPnl,
        lifecycleState: state,
        currentPrice: price,
        health: this.calculateHealth({ ...existing, quantity: nextQuantity, currentPrice: price }),
        closedAt: state === "closed" ? Date.now() : existing.closedAt
      }, state === "closed" ? "position-closed" : "partial-close", state === "closed"
        ? `${existing.symbol} position closed.`
        : `${existing.symbol} reduced by ${executedQuantity}.`, { report, request });
      return patched;
    }

    if (existing && existing.direction === sideDirection) {
      const nextQuantity = existing.quantity + executedQuantity;
      const nextAverage = ((existing.averagePrice * existing.quantity) + (price * executedQuantity)) / nextQuantity;
      return this.patchPosition(existing.id, {
        quantity: nextQuantity,
        averagePrice: nextAverage,
        currentPrice: price,
        sourceOrderIds: [...new Set([...existing.sourceOrderIds, report.orderId])],
        health: this.calculateHealth({ ...existing, quantity: nextQuantity, averagePrice: nextAverage, currentPrice: price })
      }, "added-to-position", `${existing.symbol} increased by ${executedQuantity}.`, { report, request });
    }

    const position = this.toManagedPosition({
      id: createId("pos"),
      accountId: request.accountId,
      exchange: request.exchange,
      symbol: request.symbol,
      direction: sideDirection,
      quantity: executedQuantity,
      averagePrice: price,
      currentPrice: price,
      unrealizedPnl: 0,
      realizedPnl: 0,
      margin: Math.abs(executedQuantity * price) / Math.max(1, request.leverage || 1),
      leverage: request.leverage || 1,
      liquidationPrice: undefined,
      stopLoss: request.stopLoss,
      takeProfit: request.takeProfit,
      openedAt: Date.now()
    }, request.source);
    position.sourceOrderIds = [report.orderId];
    this.positions.set(position.id, position);
    this.emitTimeline(position, "position-opened", `${position.symbol} position created from filled order.`, { report, request });

    if (request.takeProfit) this.setProtection(position.id, "take-profit", { price: request.takeProfit, orderId: report.orderId });
    if (request.stopLoss) this.setProtection(position.id, "stop-loss", { price: request.stopLoss, orderId: report.orderId });
    this.notify();
    return position;
  }

  setProtection(positionId: string, type: PositionProtectionType, patch: ProtectionPatch) {
    const position = this.requirePosition(positionId);
    const existing = position.protections.find((item) => item.type === type && !["cancelled", "triggered"].includes(item.status));
    const now = Date.now();
    const protection: PositionProtectionOrder = {
      id: existing?.id ?? createId("prot"),
      type,
      status: "active",
      price: patch.price ?? existing?.price,
      trailBy: patch.trailBy ?? existing?.trailBy,
      trailMode: patch.trailMode ?? existing?.trailMode,
      activation: patch.activation ?? existing?.activation,
      activationPrice: patch.activationPrice ?? existing?.activationPrice,
      orderId: patch.orderId ?? existing?.orderId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      metadata: { ...(existing?.metadata ?? {}), ...(patch.metadata ?? {}) }
    };
    const protections = [protection, ...position.protections.filter((item) => item.id !== protection.id)];
    const next = this.patchPosition(positionId, {
      protections,
      takeProfit: type === "take-profit" ? protection.price : position.takeProfit,
      stopLoss: type === "stop-loss" || type === "break-even" ? protection.price : position.stopLoss,
      lifecycleState: "protected",
      health: this.calculateHealth({ ...position, protections })
    }, timelineTypeForProtection(type, existing ? "modify" : "add"), protectionMessage(type, protection.price, Boolean(existing)), { protection });
    return next;
  }

  moveProtection(positionId: string, protectionId: string, price: number) {
    const position = this.requirePosition(positionId);
    const protection = position.protections.find((item) => item.id === protectionId);
    if (!protection) throw new Error(`Protection not found: ${protectionId}`);
    return this.setProtection(positionId, protection.type, {
      ...protection,
      price,
      metadata: { movedFrom: protection.price, source: "chart-drag" }
    });
  }

  cancelProtection(positionId: string, type: PositionProtectionType) {
    const position = this.requirePosition(positionId);
    const protections = position.protections.map((item) =>
      item.type === type && item.status === "active" ? { ...item, status: "cancelled" as const, updatedAt: Date.now() } : item
    );
    return this.patchPosition(positionId, {
      protections,
      takeProfit: type === "take-profit" ? undefined : position.takeProfit,
      stopLoss: type === "stop-loss" || type === "break-even" ? undefined : position.stopLoss,
      health: this.calculateHealth({ ...position, protections })
    }, "protection-cancelled", `${labelProtection(type)} cancelled.`);
  }

  enableTrailingStop(positionId: string, patch: ProtectionPatch) {
    return this.setProtection(positionId, "trailing-stop", patch);
  }

  addNote(positionId: string, note: string) {
    const position = this.requirePosition(positionId);
    const trimmed = note.trim();
    if (!trimmed) return position;
    return this.patchPosition(positionId, {
      notes: [trimmed, ...position.notes]
    }, "note-added", `Trade note added: ${trimmed}`);
  }

  setTags(positionId: string, tags: string[]) {
    const position = this.requirePosition(positionId);
    const nextTags = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
    return this.patchPosition(positionId, { tags: nextTags }, "tags-updated", `${position.symbol} tags updated.`);
  }

  closePosition(positionId: string) {
    const position = this.requirePosition(positionId);
    return this.patchPosition(positionId, {
      quantity: 0,
      lifecycleState: "closed",
      closedAt: Date.now()
    }, "position-closed", `${position.symbol} position closed.`);
  }

  reversePosition(positionId: string) {
    const position = this.requirePosition(positionId);
    return this.patchPosition(positionId, {
      direction: position.direction === "long" ? "short" : "long",
      lifecycleState: "open"
    }, "position-reversed", `${position.symbol} position reversed.`);
  }

  scaleIn(positionId: string, quantity: number, price?: number) {
    const position = this.requirePosition(positionId);
    const nextQuantity = position.quantity + quantity;
    const fillPrice = price || position.currentPrice || position.averagePrice;
    const nextAverage = ((position.averagePrice * position.quantity) + (fillPrice * quantity)) / nextQuantity;
    return this.patchPosition(positionId, {
      quantity: nextQuantity,
      averagePrice: nextAverage,
      lifecycleState: "scaling",
      health: this.calculateHealth({ ...position, quantity: nextQuantity, averagePrice: nextAverage })
    }, "scaled-in", `${position.symbol} scaled in by ${quantity}.`);
  }

  scaleOut(positionId: string, quantity: number) {
    const position = this.requirePosition(positionId);
    const nextQuantity = Math.max(0, position.quantity - quantity);
    return this.patchPosition(positionId, {
      quantity: nextQuantity,
      lifecycleState: nextQuantity > 0 ? "scaling" : "closed",
      closedAt: nextQuantity > 0 ? position.closedAt : Date.now(),
      health: this.calculateHealth({ ...position, quantity: nextQuantity })
    }, nextQuantity > 0 ? "scaled-out" : "position-closed", `${position.symbol} scaled out by ${quantity}.`);
  }

  partialClose(positionId: string, quantity: number) {
    return this.scaleOut(positionId, quantity);
  }

  mergePositions(positionIds: string[]) {
    const positions = positionIds.map((id) => this.requirePosition(id));
    const [primary] = positions;
    if (!primary) throw new Error("No positions selected.");
    const quantity = positions.reduce((sum, item) => sum + item.quantity, 0);
    const averagePrice = positions.reduce((sum, item) => sum + item.averagePrice * item.quantity, 0) / Math.max(1, quantity);
    for (const position of positions.slice(1)) this.positions.delete(position.id);
    return this.patchPosition(primary.id, {
      quantity,
      averagePrice,
      sourceOrderIds: [...new Set(positions.flatMap((item) => item.sourceOrderIds))]
    }, "position-updated", `${primary.symbol} positions merged.`);
  }

  splitPosition(positionId: string, quantity: number) {
    const position = this.requirePosition(positionId);
    if (quantity <= 0 || quantity >= position.quantity) throw new Error("Split quantity must be inside the position size.");
    const child = this.toManagedPosition({
      ...position,
      id: createId("pos"),
      quantity
    }, "split");
    const parent = this.patchPosition(positionId, {
      quantity: position.quantity - quantity
    }, "position-updated", `${position.symbol} split by ${quantity}.`);
    this.positions.set(child.id, child);
    this.emitTimeline(child, "position-opened", `${child.symbol} split from ${position.id}.`);
    this.notify();
    return { parent, child };
  }

  archivePosition(positionId: string) {
    const position = this.requirePosition(positionId);
    return this.patchPosition(positionId, {
      lifecycleState: "archived",
      archivedAt: Date.now()
    }, "position-archived", `${position.symbol} archived.`);
  }

  private findPositionForExecution(accountId: string, symbol: string, exchange: string) {
    return this.listActivePositions().find((position) =>
      position.accountId === accountId &&
      position.exchange === exchange &&
      normalizeSymbol(position.symbol) === normalizeSymbol(symbol)
    ) ?? null;
  }

  private toManagedPosition(position: PortfolioPosition, source?: string): ManagedPosition {
    const now = Date.now();
    const protections: PositionProtectionOrder[] = [
      position.takeProfit ? this.createProtection("take-profit", position.takeProfit) : null,
      position.stopLoss ? this.createProtection("stop-loss", position.stopLoss) : null
    ].filter(Boolean) as PositionProtectionOrder[];

    const managed: ManagedPosition = {
      ...position,
      lifecycleState: protections.length > 0 ? "protected" : "open",
      protections,
      timeline: [],
      health: emptyHealth(position),
      notes: [],
      tags: [],
      sourceOrderIds: [],
      updatedAt: now
    };
    managed.health = this.calculateHealth(managed);
    managed.timeline = [{
      id: createId("ptl"),
      positionId: managed.id,
      type: "position-opened",
      message: source ? `Position imported from ${source}.` : "Position opened.",
      time: position.openedAt || now,
      price: position.averagePrice,
      quantity: position.quantity
    }];
    return managed;
  }

  private createProtection(type: PositionProtectionType, price: number): PositionProtectionOrder {
    const now = Date.now();
    return {
      id: createId("prot"),
      type,
      status: "active",
      price,
      createdAt: now,
      updatedAt: now
    };
  }

  private patchPosition(positionId: string, patch: Partial<ManagedPosition>, eventType: PositionTimelineEventType, message: string, metadata?: Record<string, unknown>) {
    const current = this.requirePosition(positionId);
    const next: ManagedPosition = {
      ...current,
      ...patch,
      protections: patch.protections ?? current.protections,
      timeline: patch.timeline ?? current.timeline,
      notes: patch.notes ?? current.notes,
      tags: patch.tags ?? current.tags,
      sourceOrderIds: patch.sourceOrderIds ?? current.sourceOrderIds,
      health: patch.health ?? this.calculateHealth({ ...current, ...patch }),
      updatedAt: Date.now()
    };
    this.positions.set(positionId, next);
    this.emitTimeline(next, eventType, message, metadata);
    this.notify();
    return this.positions.get(positionId)!;
  }

  private emitTimeline(position: ManagedPosition, type: PositionTimelineEventType, message: string, metadata?: Record<string, unknown>) {
    const event: PositionTimelineEvent = {
      id: createId("ptl"),
      positionId: position.id,
      type,
      message,
      time: Date.now(),
      price: position.currentPrice,
      quantity: position.quantity,
      metadata
    };
    const next = {
      ...position,
      timeline: [event, ...position.timeline].slice(0, 250),
      updatedAt: Date.now()
    };
    this.positions.set(position.id, next);
    const lifecycleEvent: PositionLifecycleEvent = {
      type,
      positionId: position.id,
      accountId: position.accountId,
      symbol: position.symbol,
      exchange: position.exchange,
      time: event.time,
      message,
      metadata
    };
    blackCoreEventBus.publish("position.lifecycle", lifecycleEvent);
    blackCoreEventBus.publish("position.updated", { accountId: position.accountId, symbol: position.symbol, time: event.time });
  }

  private calculateHealth(position: Pick<ManagedPosition, keyof PortfolioPosition | "protections">): PositionHealth {
    const currentPnl = position.unrealizedPnl + position.realizedPnl;
    const tp = position.protections.find((item) => item.type === "take-profit" && item.status === "active")?.price ?? position.takeProfit;
    const sl = position.protections.find((item) => item.type === "stop-loss" && item.status === "active")?.price ?? position.stopLoss;
    const distanceToTp = tp ? Math.abs(tp - position.currentPrice) : undefined;
    const distanceToSl = sl ? Math.abs(position.currentPrice - sl) : undefined;
    return {
      entryPrice: position.averagePrice,
      markPrice: position.currentPrice,
      averageEntry: position.averagePrice,
      currentPnl,
      realizedPnl: position.realizedPnl,
      unrealizedPnl: position.unrealizedPnl,
      currentRisk: distanceToSl ? distanceToSl * position.quantity : 0,
      distanceToTp,
      distanceToSl,
      riskReward: distanceToTp && distanceToSl ? distanceToTp / Math.max(0.0000001, distanceToSl) : undefined,
      marginUsed: position.margin,
      liquidationPrice: position.liquidationPrice,
      fundingPaid: 0,
      fees: 0,
      maxFavorableExcursion: Math.max(0, currentPnl),
      maxAdverseExcursion: Math.min(0, currentPnl),
      timeInTradeMs: Date.now() - position.openedAt,
      executionQuality: "unknown"
    };
  }

  private requirePosition(positionId: string) {
    const position = this.positions.get(positionId);
    if (!position) throw new Error(`Position not found: ${positionId}`);
    return position;
  }

  private notify() {
    const active = this.listActivePositions();
    for (const listener of this.listeners) listener(active);
  }
}

function normalizeSymbol(symbol: string) {
  return symbol.replace(/[-_/:\s]/g, "").toUpperCase();
}

function emptyHealth(position: PortfolioPosition): PositionHealth {
  return {
    entryPrice: position.averagePrice,
    markPrice: position.currentPrice,
    averageEntry: position.averagePrice,
    currentPnl: position.unrealizedPnl + position.realizedPnl,
    realizedPnl: position.realizedPnl,
    unrealizedPnl: position.unrealizedPnl,
    currentRisk: 0,
    marginUsed: position.margin,
    liquidationPrice: position.liquidationPrice,
    fundingPaid: 0,
    fees: 0,
    maxFavorableExcursion: 0,
    maxAdverseExcursion: 0,
    timeInTradeMs: Date.now() - position.openedAt,
    executionQuality: "unknown"
  };
}

function timelineTypeForProtection(type: PositionProtectionType, mode: "add" | "modify"): PositionTimelineEventType {
  if (mode === "modify") return "protection-modified";
  if (type === "take-profit") return "tp-added";
  if (type === "stop-loss") return "sl-added";
  if (type === "trailing-stop") return "trailing-enabled";
  return "position-protected";
}

function labelProtection(type: PositionProtectionType) {
  if (type === "take-profit") return "Take profit";
  if (type === "stop-loss") return "Stop loss";
  if (type === "trailing-stop") return "Trailing stop";
  if (type === "break-even") return "Break even";
  return "OCO";
}

function protectionMessage(type: PositionProtectionType, price: number | undefined, modified: boolean) {
  const action = modified ? "modified" : "added";
  const suffix = price ? ` at ${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "";
  return `${labelProtection(type)} ${action}${suffix}.`;
}

export const blackCorePositionManager = new PositionManager();
