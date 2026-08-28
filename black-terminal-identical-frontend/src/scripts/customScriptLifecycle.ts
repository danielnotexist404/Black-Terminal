import {
  BLACK_TERMINAL_PYTHON_RUNTIME_VERSION,
  compileAndRunScript,
  finalizedScriptResult,
  type ScriptInputValue,
  type CompileResult,
  type CompiledMarker,
  type CompiledPlot,
  type CompiledScriptActivation
} from "../components/ScriptCompiler.ts";
import type { Candle } from "../chart-engine/types";
import type { UserScript } from "./userScriptLibrary";

/*
 * Do not collapse this import back to a type-only block. Cold-start restoration
 * intentionally creates a pending projection before chart history is ready.
 */
export type MountedCustomScript = {
  activation: CompiledScriptActivation;
  result: CompileResult;
};

export type CustomScriptChartActivation = {
  active: boolean;
  visible: boolean;
};

export function restoreMountedCustomScripts(
  scripts: readonly UserScript[],
  candles: readonly Candle[],
  inputFeed: CompiledScriptActivation["inputFeed"],
): MountedCustomScript[] {
  return scripts.flatMap((script) => {
    if (script.chartActivation?.active !== true) return [];
    const compiled = compileAndRunScript(script.source, [...candles].slice(-20_000), script.inputValues);
    if (candles.length >= 2 && !compiled.success) return [];
    const latestConfirmedTime = candles.at(-2)?.time ?? Number.NEGATIVE_INFINITY;
    const result = compiled.success
      ? finalizedScriptResult(compiled, latestConfirmedTime)
      : pendingCompileResult(compiled.sourceHash);
    return [{
      activation: {
        id: script.id,
        name: script.name,
        kind: script.kind,
        source: script.source,
        sourceHash: compiled.sourceHash,
        inputFeed,
        inputValues: script.inputValues,
        visible: script.chartActivation.visible,
      },
      result,
    }];
  });
}

export function updateScriptChartActivation(
  scripts: readonly UserScript[],
  scriptId: string,
  activation: CustomScriptChartActivation,
): UserScript[] {
  return scripts.map((script) => script.id === scriptId
    ? { ...script, chartActivation: activation, updatedAt: Date.now() }
    : script);
}

export function updateScriptInputs(
  scripts: readonly UserScript[],
  scriptId: string,
  inputValues: Record<string, ScriptInputValue>,
): UserScript[] {
  return scripts.map((script) => script.id === scriptId
    ? { ...script, inputValues, updatedAt: Date.now() }
    : script);
}

function pendingCompileResult(sourceHash: string): CompileResult {
  return {
    success: true,
    errors: [],
    plots: [],
    markers: [],
    alertConditions: [],
    events: [],
    strategy: null,
    runtimeVersion: BLACK_TERMINAL_PYTHON_RUNTIME_VERSION,
    sourceHash,
  };
}

/**
 * Produces an application-scoped projection revision. Chart engines are
 * replaced when the market or timeframe changes and their own feed revision
 * counters restart from zero, so those engine-local values cannot safely be
 * stored directly in React state.
 */
export function nextCustomScriptProjectionRevision(current: number): number {
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}

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
