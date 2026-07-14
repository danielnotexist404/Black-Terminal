const OPTIONAL_AIF_PREFIXES = ["bt_aif_memory:", "bt_aif_zone_memory:"] as const;

export function readAifStorage(key: string, storage: Pick<Storage, "getItem"> = localStorage) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function writeAifSettingsStorage(key: string, value: string, storage: Storage = localStorage) {
  if (trySet(storage, key, value)) return true;
  pruneOptionalAifResearch(storage);
  return trySet(storage, key, value);
}

export function writeAifResearchStorage(
  key: string,
  value: string,
  compactValue: string,
  storage: Pick<Storage, "setItem"> & Partial<Pick<Storage, "removeItem">> = localStorage
) {
  if (trySet(storage, key, value)) return true;
  if (storage.removeItem) {
    try {
      storage.removeItem(key);
    } catch {
      return false;
    }
  }
  return trySet(storage, key, compactValue);
}

function pruneOptionalAifResearch(storage: Storage) {
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && OPTIONAL_AIF_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Settings remain live in memory when browser storage is unavailable.
  }
}

function trySet(storage: Pick<Storage, "setItem">, key: string, value: string) {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
