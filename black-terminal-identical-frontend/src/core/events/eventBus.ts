export type EventHandler<T> = (event: T) => void;

export interface EventBus<EventMap extends Record<string, unknown>> {
  publish<K extends keyof EventMap>(type: K, event: EventMap[K]): void;
  subscribe<K extends keyof EventMap>(type: K, handler: EventHandler<EventMap[K]>): () => void;
  clear(): void;
}

export class TypedEventBus<EventMap extends Record<string, unknown>> implements EventBus<EventMap> {
  private handlers = new Map<keyof EventMap, Set<EventHandler<EventMap[keyof EventMap]>>>();

  publish<K extends keyof EventMap>(type: K, event: EventMap[K]) {
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
    this.handlers.clear();
  }
}
