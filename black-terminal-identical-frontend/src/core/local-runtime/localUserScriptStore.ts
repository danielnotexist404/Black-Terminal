import { normalizeUserScripts, type UserScript } from "../../scripts/userScriptLibrary";
import { getLocalDocument, putLocalDocument } from "./localDocumentStore";
import { isLocalOnlyRuntime } from "./localRuntimeClient";

const NAMESPACE = "user-scripts";
const cache = new Map<string, { scripts: UserScript[]; revision: number }>();
const writeQueues = new Map<string, Promise<UserScript[]>>();

function ownerKey(owner?: string | null) {
  return owner?.trim().toLowerCase() || "anonymous";
}

function legacyKey(owner: string) {
  return owner === "anonymous" ? "bt_user_scripts:anonymous" : `bt_user_scripts:${owner}`;
}

function copy(scripts: UserScript[]) {
  return structuredClone(scripts);
}

export async function hydrateLocalUserScripts(owner?: string | null) {
  const key = ownerKey(owner);
  if (!isLocalOnlyRuntime()) return [];
  const stored = await getLocalDocument<UserScript[]>(NAMESPACE, key);
  if (stored) {
    const scripts = normalizeUserScripts(stored.value);
    cache.set(key, { scripts, revision: stored.revision });
    localStorage.removeItem(legacyKey(key));
    return copy(scripts);
  }
  let migrated: UserScript[] = [];
  try {
    migrated = normalizeUserScripts(JSON.parse(localStorage.getItem(legacyKey(key)) || "[]"));
  } catch {
    migrated = [];
  }
  const saved = await putLocalDocument(NAMESPACE, key, migrated, 0);
  if (!saved) throw new Error("The encrypted local script store is unavailable.");
  cache.set(key, { scripts: migrated, revision: saved.revision });
  localStorage.removeItem(legacyKey(key));
  return copy(migrated);
}

export async function loadLocalUserScripts(owner?: string | null) {
  const key = ownerKey(owner);
  const cached = cache.get(key);
  return cached ? copy(cached.scripts) : hydrateLocalUserScripts(key);
}

export function readCachedLocalUserScripts(owner?: string | null) {
  return copy(cache.get(ownerKey(owner))?.scripts || []);
}

export function saveLocalUserScripts(owner: string | null | undefined, scripts: UserScript[]) {
  const key = ownerKey(owner);
  const normalized = normalizeUserScripts(scripts);
  const prior = writeQueues.get(key)?.catch(() => readCachedLocalUserScripts(key)) || Promise.resolve(readCachedLocalUserScripts(key));
  const task = prior.then(async () => {
    const current = cache.get(key) || { scripts: await hydrateLocalUserScripts(key), revision: cache.get(key)?.revision || 0 };
    const saved = await putLocalDocument(NAMESPACE, key, normalized, current.revision);
    if (!saved) throw new Error("The encrypted local script store is unavailable.");
    cache.set(key, { scripts: normalized, revision: saved.revision });
    localStorage.removeItem(legacyKey(key));
    window.dispatchEvent(new CustomEvent("bt-local-user-scripts", { detail: { owner: key } }));
    return copy(normalized);
  });
  writeQueues.set(key, task);
  void task.finally(() => {
    if (writeQueues.get(key) === task) writeQueues.delete(key);
  }).catch(() => undefined);
  return task;
}
