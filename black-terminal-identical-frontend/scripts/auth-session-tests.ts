import assert from "node:assert/strict";
import {
  SECURE_SESSION_UNAVAILABLE_CODE,
  resolveAuthenticatedSession,
  type AuthSessionClient,
} from "../src/auth/authenticatedSession.ts";
import {
  clearScriptEditorRecovery,
  readScriptEditorRecovery,
  writeScriptEditorRecovery,
} from "../src/scripts/scriptEditorRecovery.ts";
import {
  AuthBootstrapTimeoutError,
  withAuthBootstrapTimeout,
} from "../src/auth/authBootstrap.ts";

function authClient(input: { current?: string | null; refreshed?: string | null; valid?: string[] }) {
  let refreshes = 0;
  const client: AuthSessionClient = {
    async getSession() { return { data: { session: input.current ? { access_token: input.current } : null } }; },
    async refreshSession() { refreshes += 1; return { data: { session: input.refreshed ? { access_token: input.refreshed } : null } }; },
    async getUser(token) { return { data: { user: input.valid?.includes(String(token)) ? { id: `user:${token}` } : null } }; },
  };
  return { client, refreshes: () => refreshes };
}

assert.equal(await withAuthBootstrapTimeout(Promise.resolve("ready"), 20), "ready");
await assert.rejects(
  () => withAuthBootstrapTimeout(new Promise<never>(() => undefined), 10),
  AuthBootstrapTimeoutError,
  "a stalled auth client must release the full-screen bootstrap"
);

{
  const auth = authClient({ current: "valid-current", refreshed: "unused", valid: ["valid-current"] });
  const result = await resolveAuthenticatedSession(auth.client);
  assert.equal(result.accessToken, "valid-current");
  assert.equal(result.user.id, "user:valid-current");
  assert.equal(auth.refreshes(), 0, "a validated current token must not be refreshed");
}

{
  const auth = authClient({ current: "expired", refreshed: "valid-refresh", valid: ["valid-refresh"] });
  const result = await resolveAuthenticatedSession(auth.client);
  assert.equal(result.accessToken, "valid-refresh");
  assert.equal(auth.refreshes(), 1, "an invalid access token receives one refresh attempt");
}

{
  const auth = authClient({ current: null, refreshed: "recovered", valid: ["recovered"] });
  const result = await resolveAuthenticatedSession(auth.client);
  assert.equal(result.user.id, "user:recovered");
}

{
  const auth = authClient({ current: null, refreshed: null, valid: [] });
  await assert.rejects(() => resolveAuthenticatedSession(auth.client), (error: unknown) => {
    assert.equal((error as { code?: string }).code, SECURE_SESSION_UNAVAILABLE_CODE);
    return true;
  });
}

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

{
  const storage = new MemoryStorage();
  writeScriptEditorRecovery(storage, "Trader@Example.com", {
    selectedScriptId: "script-1",
    name: "SuperATR 7-Step Profit",
    kind: "strategy",
    source: "strategy.entry(\"Long Entry\", strategy.long)",
  });
  const recovered = readScriptEditorRecovery(storage, "trader@example.com");
  assert.equal(recovered?.name, "SuperATR 7-Step Profit");
  assert.equal(recovered?.kind, "strategy");
  assert.equal(recovered?.selectedScriptId, "script-1");
  assert.equal(readScriptEditorRecovery(storage, "another@example.com"), null, "draft recovery must remain owner-scoped");
  clearScriptEditorRecovery(storage, "TRADER@example.com");
  assert.equal(readScriptEditorRecovery(storage, "trader@example.com"), null);
}

console.log("Authenticated session refresh and Script Editor draft recovery tests: PASS");
