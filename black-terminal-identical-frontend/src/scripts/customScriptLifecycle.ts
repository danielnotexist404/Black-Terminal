import type {
  CompileResult,
  CompiledMarker,
  CompiledPlot,
  CompiledScriptActivation
} from "../components/ScriptCompiler";

export type MountedCustomScript = {
  activation: CompiledScriptActivation;
  result: CompileResult;
};

export function mountCustomScript(
  mounted: readonly MountedCustomScript[],
  next: MountedCustomScript
): MountedCustomScript[] {
  const existingIndex = mounted.findIndex(({ activation }) => activation.id === next.activation.id);
  if (existingIndex < 0) return [...mounted, next];
  const updated = [...mounted];
  updated[existingIndex] = next;
  return updated;
}

export function unmountCustomScript(
  mounted: readonly MountedCustomScript[],
  scriptId: string
): MountedCustomScript[] {
  return mounted.filter(({ activation }) => activation.id !== scriptId);
}

export function mergeCustomScriptOutput(
  mounted: readonly MountedCustomScript[]
): { plots: CompiledPlot[]; markers: CompiledMarker[] } {
  return mounted.reduce<{ plots: CompiledPlot[]; markers: CompiledMarker[] }>(
    (combined, script) => {
      if (script.activation.visible === false) return combined;
      combined.plots.push(...script.result.plots.map((plot) => ({
        ...plot,
        name: `${script.activation.id}:${plot.name}`
      })));
      combined.markers.push(...script.result.markers.map((marker) => ({
        ...marker,
        id: `${script.activation.id}:${marker.id}`
      })));
      return combined;
    },
    { plots: [], markers: [] }
  );
}
