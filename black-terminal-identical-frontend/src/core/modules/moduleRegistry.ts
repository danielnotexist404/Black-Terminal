export type BlackCoreModuleMode = "compact" | "expanded" | "detached-browser" | "tauri-window";

export type BlackCoreModuleDefinition = {
  id: string;
  label: string;
  description: string;
  modes: BlackCoreModuleMode[];
  version: string;
};

export class ModuleRegistry {
  private modules = new Map<string, BlackCoreModuleDefinition>();

  register(module: BlackCoreModuleDefinition) {
    this.modules.set(module.id, module);
  }

  get(moduleId: string) {
    return this.modules.get(moduleId) ?? null;
  }

  list() {
    return Array.from(this.modules.values());
  }
}

export const blackCoreModuleRegistry = new ModuleRegistry();
