import type { ScriptInputValue } from "../components/ScriptCompiler";

export type UserScriptPublication = {
  assetId: string;
  visibility: "public";
  publishedAt: number;
};

export type UserScript = {
  id: string;
  name: string;
  kind: "indicator" | "strategy";
  source: string;
  createdAt: number;
  updatedAt?: number;
  inputValues?: Record<string, ScriptInputValue>;
  publication?: UserScriptPublication;
};

export function normalizeUserScripts(value: unknown): UserScript[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): UserScript[] => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Partial<UserScript>;
    if (typeof row.id !== "string" || !row.id.trim() || typeof row.source !== "string") return [];
    if (row.kind !== "indicator" && row.kind !== "strategy") return [];
    const inputValues = row.inputValues && typeof row.inputValues === "object" && !Array.isArray(row.inputValues)
      ? Object.fromEntries(Object.entries(row.inputValues).filter(([, input]) => ["number", "boolean", "string"].includes(typeof input))) as Record<string, ScriptInputValue>
      : undefined;
    const publication = row.publication
      && typeof row.publication.assetId === "string"
      && row.publication.visibility === "public"
      && Number.isFinite(row.publication.publishedAt)
      ? row.publication
      : undefined;
    return [{
      id: row.id,
      name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : "Untitled Script",
      kind: row.kind,
      source: row.source,
      createdAt: Number.isFinite(row.createdAt) ? Number(row.createdAt) : Date.now(),
      updatedAt: Number.isFinite(row.updatedAt) ? Number(row.updatedAt) : undefined,
      inputValues,
      publication
    }];
  });
}
