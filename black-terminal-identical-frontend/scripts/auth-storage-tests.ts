import assert from "node:assert/strict";
import {
  BLACK_TERMINAL_AUTH_STORAGE_KEY,
  legacySupabaseAuthStorageKeys,
  migrateSupabaseAuthStorage
} from "../src/auth/supabaseAuthStorage.ts";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const session = (expiresAt: number) => JSON.stringify({
  access_token: `access-${expiresAt}`,
  refresh_token: `refresh-${expiresAt}`,
  expires_at: expiresAt
});

{
  const keys = legacySupabaseAuthStorageKeys("https://project-ref.supabase.co", "https://black-terminal.live");
  assert.deepEqual(keys, ["sb-project-ref-auth-token", "sb-black-terminal-auth-token"]);
}

{
  const storage = new MemoryStorage();
  storage.setItem("sb-project-ref-auth-token", session(100));
  storage.setItem("sb-black-terminal-auth-token", session(200));
  const result = migrateSupabaseAuthStorage(storage, "https://project-ref.supabase.co", "https://black-terminal.live");
  assert.equal(result.migrated, true);
  assert.equal(result.sourceKey, "sb-black-terminal-auth-token");
  assert.equal(storage.getItem(BLACK_TERMINAL_AUTH_STORAGE_KEY), session(200));
  assert.equal(storage.getItem("sb-project-ref-auth-token"), null);
  assert.equal(storage.getItem("sb-black-terminal-auth-token"), null);
}

{
  const storage = new MemoryStorage();
  storage.setItem(BLACK_TERMINAL_AUTH_STORAGE_KEY, session(300));
  storage.setItem("sb-black-terminal-auth-token", session(400));
  const result = migrateSupabaseAuthStorage(storage, "https://black-terminal.live", "https://black-terminal.live");
  assert.equal(result.migrated, false);
  assert.equal(storage.getItem(BLACK_TERMINAL_AUTH_STORAGE_KEY), session(300));
  assert.equal(storage.getItem("sb-black-terminal-auth-token"), null);
}

{
  const storage = new MemoryStorage();
  storage.setItem("sb-black-terminal-auth-token", "not-a-session");
  const result = migrateSupabaseAuthStorage(storage, "https://black-terminal.live", "https://black-terminal.live");
  assert.equal(result.migrated, false);
  assert.equal(storage.getItem(BLACK_TERMINAL_AUTH_STORAGE_KEY), null);
}

console.log("Supabase auth storage migration tests: PASS");
