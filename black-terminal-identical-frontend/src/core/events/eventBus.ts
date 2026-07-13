export type EventHandler<T> = (event: T) => void;

export interface EventBus<EventMap extends Record<string, unknown>> {
  publish<K extends keyof EventMap>(type: K, event: EventMap[K]): void;
  subscribe<K extends keyof EventMap>(type: K, handler: EventHandler<EventMap[K]>): () => void;
  clear(): void;
}

export class TypedEventBus<EventMap extends Record<string, unknown>> implements EventBus<EventMap> {
  private handlers = new Map<keyof EventMap, Set<EventHandler<EventMap[keyof EventMap]>>>();
  private publishedCounts = new Map<keyof EventMap, number>();
  private pendingLatest = new Map<keyof EventMap, { event: EventMap[keyof EventMap]; timer: ReturnType<typeof setTimeout> }>();
  private totalPublishes = 0;
  private coalescedPublishes = 0;

  publish<K extends keyof EventMap>(type: K, event: EventMap[K]) {
    this.totalPublishes += 1;
    this.publishedCounts.set(type, (this.publishedCounts.get(type) ?? 0) + 1);
    const listeners = this.handlers.get(type);
    if (!listeners) return;
    for (const handler of listeners) {
      try {
        (handler as EventHandler<EventMap[K]>)(event);
      } catch (error) {
        console.error(`Event handler failed for ${String(type)}`, error);
      }
    }
  }

  publishLatest<K extends keyof EventMap>(type: K, event: EventMap[K], cadenceMs = 50) {
    const existing = this.pendingLatest.get(type);
    if (existing) {
      existing.event = event as EventMap[keyof EventMap];
      this.coalescedPublishes += 1;
      return;
    }
    const pending = {
      event: event as EventMap[keyof EventMap],
      timer: setTimeout(() => {
        const latest = this.pendingLatest.get(type);
        this.pendingLatest.delete(type);
        if (latest) this.publish(type, latest.event as EventMap[K]);
      }, Math.max(0, cadenceMs))
    };
    this.pendingLatest.set(type, pending);
  }

  subscribe<K extends keyof EventMap>(type: K, handler: EventHandler<EventMap[K]>) {
    const listeners = this.handlers.get(type) ?? new Set<EventHandler<EventMap[keyof EventMap]>>();
    listeners.add(handler as EventHandler<EventMap[keyof EventMap]>);
    this.handlers.set(type, listeners);
    return () => {
      listeners.delete(handler as EventHandler<EventMap[keyof EventMap]>);
      if (listeners.size === 0) this.handlers.delete(type);
    };
  }

  clear() {
    for (const pending of this.pendingLatest.values()) clearTimeout(pending.timer);
    this.pendingLatest.clear();
    this.handlers.clear();
  }

  diagnostics() {
    const listenersByType: Record<string, number> = {};
    for (const [type, listeners] of this.handlers.entries()) listenersByType[String(type)] = listeners.size;
    const publishedByType: Record<string, number> = {};
    for (const [type, count] of this.publishedCounts.entries()) publishedByType[String(type)] = count;
    return {
      listenerCount: [...this.handlers.values()].reduce((sum, listeners) => sum + listeners.size, 0),
      eventTypeCount: this.handlers.size,
      totalPublishes: this.totalPublishes,
      coalescedPublishes: this.coalescedPublishes,
      pendingCoalescedPublishes: this.pendingLatest.size,
      listenersByType,
      publishedByType
    };
  }
}
