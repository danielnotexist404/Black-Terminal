type Listener = (active: boolean) => void;

class DomInteractionCoordinator {
  private active = false;
  private timer: number | null = null;
  private listeners = new Set<Listener>();

  begin() {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    if (this.active) return;
    this.active = true;
    this.emit();
  }

  endAfter(delayMs = 160) {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.active = false;
      this.emit();
    }, delayMs);
  }

  isActive() { return this.active; }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.active);
    return () => { this.listeners.delete(listener); };
  }

  private emit() {
    for (const listener of this.listeners) listener(this.active);
  }
}

export const domInteractionCoordinator = new DomInteractionCoordinator();
