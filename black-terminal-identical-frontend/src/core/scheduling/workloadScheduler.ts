import { blackCoreResourceTracker } from "../../performance/resourceTracker";

export type WorkloadPriority = 0 | 1 | 2 | 3 | 4 | 5;

type ScheduledTask = {
  id: number;
  key?: string;
  priority: WorkloadPriority;
  run: () => void;
};

const maxQueueDepth = 128;

export class WorkloadScheduler {
  private nextId = 1;
  private queue: ScheduledTask[] = [];
  private scheduled = false;
  private dropped = 0;
  private coalesced = 0;

  schedule(priority: WorkloadPriority, run: () => void, key?: string) {
    if (priority <= 1) {
      run();
      return () => undefined;
    }

    if (key) {
      const existing = this.queue.find((task) => task.key === key);
      if (existing) {
        existing.run = run;
        existing.priority = Math.min(existing.priority, priority) as WorkloadPriority;
        this.coalesced += 1;
        return () => this.cancel(existing.id);
      }
    }

    if (this.queue.length >= maxQueueDepth) {
      const discardIndex = this.queue.findIndex((task) => task.priority >= priority && task.priority >= 4);
      if (discardIndex >= 0) {
        this.queue.splice(discardIndex, 1);
        this.dropped += 1;
      } else if (priority >= 4) {
        this.dropped += 1;
        return () => undefined;
      }
    }

    const task = { id: this.nextId++, key, priority, run };
    this.queue.push(task);
    this.updateGauge();
    this.requestDrain();
    return () => this.cancel(task.id);
  }

  diagnostics() {
    return { queueDepth: this.queue.length, dropped: this.dropped, coalesced: this.coalesced };
  }

  resetCounters() {
    this.dropped = 0;
    this.coalesced = 0;
  }

  private cancel(id: number) {
    const index = this.queue.findIndex((task) => task.id === id);
    if (index >= 0) this.queue.splice(index, 1);
    this.updateGauge();
  }

  private requestDrain() {
    if (this.scheduled || typeof window === "undefined") return;
    this.scheduled = true;
    window.requestAnimationFrame(() => this.drain());
  }

  private drain() {
    this.scheduled = false;
    const startedAt = performance.now();
    this.queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
    while (this.queue.length && performance.now() - startedAt < 6) {
      const task = this.queue.shift();
      if (!task) break;
      task.run();
    }
    this.updateGauge();
    if (this.queue.length) this.requestDrain();
  }

  private updateGauge() {
    blackCoreResourceTracker.setGauge("render-queue", "black-core-scheduler", this.queue.length);
  }
}

export const blackCoreWorkloadScheduler = new WorkloadScheduler();
