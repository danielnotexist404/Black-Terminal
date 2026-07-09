import type { BlackCoreModuleMode } from "../modules/moduleRegistry";

export type DockedWindowState = {
  id: string;
  moduleId: string;
  mode: BlackCoreModuleMode;
  isOpen: boolean;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
};

type WindowListener = (windows: DockedWindowState[]) => void;

export class WindowDockManager {
  private windows = new Map<string, DockedWindowState>();
  private listeners = new Set<WindowListener>();
  private zIndex = 1000;

  open(moduleId: string, title: string, mode: BlackCoreModuleMode = "expanded") {
    const current = this.windows.get(moduleId);
    const next: DockedWindowState = {
      id: current?.id ?? `${moduleId}:${Date.now()}`,
      moduleId,
      mode,
      isOpen: true,
      title,
      x: current?.x ?? 140,
      y: current?.y ?? 54,
      width: current?.width ?? 1320,
      height: current?.height ?? 820,
      zIndex: ++this.zIndex
    };
    this.windows.set(moduleId, next);
    this.notify();
    return next;
  }

  close(moduleId: string) {
    const current = this.windows.get(moduleId);
    if (!current) return;
    this.windows.set(moduleId, { ...current, isOpen: false });
    this.notify();
  }

  update(moduleId: string, patch: Partial<DockedWindowState>) {
    const current = this.windows.get(moduleId);
    if (!current) return;
    this.windows.set(moduleId, { ...current, ...patch });
    this.notify();
  }

  get(moduleId: string) {
    return this.windows.get(moduleId) ?? null;
  }

  list() {
    return Array.from(this.windows.values());
  }

  subscribe(listener: WindowListener) {
    this.listeners.add(listener);
    listener(this.list());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    const windows = this.list();
    for (const listener of this.listeners) listener(windows);
  }
}

export const blackCoreWindowDockManager = new WindowDockManager();
