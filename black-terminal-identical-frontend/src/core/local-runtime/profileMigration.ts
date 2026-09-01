import { isLocalOnlyRuntime } from "./localRuntimeClient";
import { putLocalDocument } from "./localDocumentStore";
import { loadLocalUserScripts, saveLocalUserScripts } from "./localUserScriptStore";
import { normalizeUserScripts, type UserScript } from "../../scripts/userScriptLibrary";

const ARCHIVE_KIND = "BLACK_TERMINAL_ENCRYPTED_PROFILE";
const ARCHIVE_VERSION = 1;
const KDF_ITERATIONS = 600_000;
const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024;
const AAD = new TextEncoder().encode("black-terminal-profile-migration-v1");

const exactKeys = new Set([
  "bt_terminal_settings",
  "bt_workspace_names_v1",
  "bt_workspaces_v1",
  "bt_active_workspace_v1",
  "bt_visible_indicators_v1",
  "bt_indicator_alerts_v1",
  "bt_stored_alerts",
  "bt_alert_event_logs",
  "bt_watchlist",
  "bt_last_symbol",
  "bt_last_timeframe",
  "bt_last_chart_type",
  "bt_chart_snap_to_latest",
  "bt_active_nav",
  "bt_aif_custom_preset",
  "bt_black_horizon_candles_v1",
  "bt_performance_hud_visible",
  "bt_positions_orders_panel_height",
  "bt_qalc_strategy_handoff_v1",
  "bt_scanner_presets_v1",
]);

const allowedPrefixes = [
  "bt_user_scripts:",
  "bt_multi_chart_workspace_v1:",
  "bt_aif_settings:",
  "bt_aif_memory:",
  "bt_aif_zone_memory:",
  "bt_dom_pro_settings:",
  "bt_dom_pro_panel_settings:",
  "bt:dom-pro-layout:v",
  "bt:dom-pro-layout-preset:",
  "bt:chart-docked-depth-ladder:",
];

type ProfilePayload = {
  schemaVersion: 1;
  owner: string;
  exportedAt: number;
  origin: string;
  entries: Record<string, string>;
  exclusions: string[];
};

type EncryptedArchive = {
  kind: typeof ARCHIVE_KIND;
  version: 1;
  kdf: { name: "PBKDF2-SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-256-GCM"; iv: string; ciphertext: string };
};

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

function normalizedOwner(value: string) {
  const owner = value.trim().toLowerCase();
  if (!owner.includes("@") || owner.length > 254) throw new Error("A valid profile owner email is required.");
  return owner;
}

function allowedKey(key: string) {
  return exactKeys.has(key) || allowedPrefixes.some((prefix) => key.startsWith(prefix));
}

function assertPassphrase(value: string) {
  if (value.length < 12 || value.length > 256) throw new Error("Migration passphrase must contain between 12 and 256 characters.");
}

async function deriveKey(passphrase: string, salt: Uint8Array, usages: KeyUsage[]) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: ownedBuffer(salt), iterations: KDF_ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

function collectEntries() {
  const entries: Record<string, string> = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || !allowedKey(key)) continue;
    const value = localStorage.getItem(key);
    if (value !== null) entries[key] = sanitizeMigratedEntry(key, value);
  }
  return entries;
}

function sanitizeMigratedEntry(key: string, value: string) {
  if (key !== "bt_indicator_alerts_v1" && key !== "bt_stored_alerts") return value;
  try {
    const alerts = JSON.parse(value);
    if (!Array.isArray(alerts)) return "[]";
    return JSON.stringify(alerts.map((alert) => {
      if (!alert || typeof alert !== "object" || Array.isArray(alert)) return alert;
      return { ...alert, webhookUrl: "", p2pEndpoint: "", sshTarget: "", emailTo: "" };
    }));
  } catch {
    return "[]";
  }
}

export async function createEncryptedProfileArchive(ownerEmail: string, passphrase: string) {
  assertPassphrase(passphrase);
  const payload: ProfilePayload = {
    schemaVersion: 1,
    owner: normalizedOwner(ownerEmail),
    exportedAt: Date.now(),
    origin: window.location.origin,
    entries: collectEntries(),
    exclusions: ["broker credentials", "authentication tokens", "passwords", "private keys", "active sessions", "webhook secrets"],
  };
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  if (encoded.length > MAX_ARCHIVE_BYTES) throw new Error("The selected profile exceeds the encrypted migration size limit.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ownedBuffer(iv), additionalData: ownedBuffer(AAD) },
    key,
    ownedBuffer(encoded),
  ));
  const archive: EncryptedArchive = {
    kind: ARCHIVE_KIND,
    version: ARCHIVE_VERSION,
    kdf: { name: "PBKDF2-SHA-256", iterations: KDF_ITERATIONS, salt: bytesToBase64(salt) },
    cipher: { name: "AES-256-GCM", iv: bytesToBase64(iv), ciphertext: bytesToBase64(encrypted) },
  };
  return JSON.stringify(archive, null, 2);
}

export function downloadEncryptedProfileArchive(contents: string, ownerEmail: string) {
  const date = new Date().toISOString().slice(0, 10);
  const owner = normalizedOwner(ownerEmail).split("@")[0]?.replace(/[^a-z0-9_-]/g, "-") || "profile";
  const url = URL.createObjectURL(new Blob([contents], { type: "application/vnd.black-terminal.profile+json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `black-terminal-${owner}-${date}.btprofile`;
  link.click();
  URL.revokeObjectURL(url);
}

export async function importEncryptedProfileArchive(contents: string, ownerEmail: string, passphrase: string) {
  if (!isLocalOnlyRuntime()) throw new Error("Encrypted profile import is available only in the standalone local runtime.");
  assertPassphrase(passphrase);
  if (contents.length > MAX_ARCHIVE_BYTES * 2) throw new Error("The encrypted migration archive exceeds the safety limit.");
  const archive = JSON.parse(contents) as EncryptedArchive;
  if (archive.kind !== ARCHIVE_KIND || archive.version !== ARCHIVE_VERSION
    || archive.kdf?.name !== "PBKDF2-SHA-256" || archive.kdf.iterations !== KDF_ITERATIONS
    || archive.cipher?.name !== "AES-256-GCM") {
    throw new Error("This is not a supported Black Terminal migration archive.");
  }
  const salt = base64ToBytes(archive.kdf.salt);
  const iv = base64ToBytes(archive.cipher.iv);
  if (salt.length !== 16 || iv.length !== 12) throw new Error("The migration archive cryptographic parameters are invalid.");
  const key = await deriveKey(passphrase, salt, ["decrypt"]);
  let decrypted: ArrayBuffer;
  try {
    decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ownedBuffer(iv), additionalData: ownedBuffer(AAD) },
      key,
      ownedBuffer(base64ToBytes(archive.cipher.ciphertext)),
    );
  } catch {
    throw new Error("The migration passphrase is wrong or the archive was modified.");
  }
  const payload = JSON.parse(new TextDecoder().decode(decrypted)) as ProfilePayload;
  if (payload.schemaVersion !== 1 || normalizedOwner(payload.owner) !== normalizedOwner(ownerEmail)) {
    throw new Error("The archive owner does not match this local Black Terminal profile.");
  }
  const entries = Object.entries(payload.entries || {}).filter(([key, value]) => allowedKey(key) && typeof value === "string");
  for (const [key, value] of entries) localStorage.setItem(key, sanitizeMigratedEntry(key, value));
  await mirrorImportedNativeDocuments(payload.owner, entries);
  return { owner: payload.owner, exportedAt: payload.exportedAt, importedEntries: entries.length };
}

async function mirrorImportedNativeDocuments(owner: string, entries: Array<[string, string]>) {
  const parse = <T>(key: string, fallback: T): T => {
    try { return JSON.parse(localStorage.getItem(key) || "") as T; } catch { return fallback; }
  };
  const settings = parse<Record<string, unknown>>("bt_terminal_settings", {});
  const names = parse<string[]>("bt_workspace_names_v1", []);
  const snapshots = parse<Record<string, unknown>>("bt_workspaces_v1", {});
  const active = localStorage.getItem("bt_active_workspace_v1") || names[0] || "Default";
  const alerts = parse<unknown[]>("bt_indicator_alerts_v1", []);
  await Promise.all([
    putLocalDocument("settings", "terminal", settings),
    putLocalDocument("workspaces", "catalog", { names, snapshots, active }),
    putLocalDocument("automation", "indicator-alerts", alerts),
  ]);
  const scriptEntry = entries.find(([key]) => key === `bt_user_scripts:${owner}`)
    || entries.find(([key]) => key.startsWith("bt_user_scripts:"));
  if (scriptEntry) {
    let scripts: UserScript[] = [];
    try { scripts = normalizeUserScripts(JSON.parse(scriptEntry[1])); } catch { scripts = []; }
    await loadLocalUserScripts(owner);
    await saveLocalUserScripts(owner, scripts);
    for (const [key] of entries.filter(([key]) => key.startsWith("bt_user_scripts:"))) localStorage.removeItem(key);
  }
}
