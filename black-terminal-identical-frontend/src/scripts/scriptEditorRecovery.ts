export type ScriptEditorRecoveryDraft = {
  schemaVersion: 1;
  selectedScriptId: string | null;
  name: string;
  kind: "indicator" | "strategy";
  source: string;
  updatedAt: number;
};

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const keyFor = (owner: string) => `bt_script_editor_recovery_v1:${owner.trim().toLowerCase() || "anonymous"}`;

export function readScriptEditorRecovery(storage: DraftStorage, owner: string): ScriptEditorRecoveryDraft | null {
  try {
    const raw = storage.getItem(keyFor(owner));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ScriptEditorRecoveryDraft>;
    if (value.schemaVersion !== 1) return null;
    if (value.kind !== "indicator" && value.kind !== "strategy") return null;
    if (typeof value.name !== "string" || typeof value.source !== "string") return null;
    if (value.source.length > 100_000) return null;
    return {
      schemaVersion: 1,
      selectedScriptId: typeof value.selectedScriptId === "string" ? value.selectedScriptId : null,
      name: value.name.slice(0, 80),
      kind: value.kind,
      source: value.source,
      updatedAt: typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function writeScriptEditorRecovery(storage: DraftStorage, owner: string, draft: Omit<ScriptEditorRecoveryDraft, "schemaVersion" | "updatedAt">) {
  storage.setItem(keyFor(owner), JSON.stringify({
    schemaVersion: 1,
    ...draft,
    name: draft.name.slice(0, 80),
    source: draft.source.slice(0, 100_000),
    updatedAt: Date.now(),
  } satisfies ScriptEditorRecoveryDraft));
}

export function clearScriptEditorRecovery(storage: DraftStorage, owner: string) {
  storage.removeItem(keyFor(owner));
}
