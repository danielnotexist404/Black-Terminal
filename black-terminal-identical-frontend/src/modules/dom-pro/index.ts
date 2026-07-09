import { blackCoreModuleRegistry, type BlackCoreModuleDefinition } from "../../core/modules/moduleRegistry";

export const domProModule: BlackCoreModuleDefinition = {
  id: "dom-pro",
  label: "DOM Pro+",
  description: "Detachable institutional depth and order-flow cockpit.",
  modes: ["compact", "expanded", "detached-browser", "tauri-window"],
  version: "0.1.0"
};

export function registerDomProModule() {
  blackCoreModuleRegistry.register(domProModule);
}

export { DomProWindow } from "./components/DomProWindow";
