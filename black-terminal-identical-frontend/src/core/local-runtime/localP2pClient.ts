import { invoke } from "@tauri-apps/api/core";
import { getLocalDocument, putLocalDocument } from "./localDocumentStore";

export type LocalP2pStatus = {
  running: boolean;
  peerId: string;
  listenAddresses: string[];
  externalAddresses: string[];
  connectedPeers: string[];
  configuredRelayAddresses: string[];
  activeRelayAddresses: string[];
  holePunchSuccesses: number;
  holePunchFailures: number;
  receivedMessages: number;
  transportEncryption: "NOISE_XX_LINK_ENCRYPTION";
  discovery: string[];
  globalRelayConfigured: boolean;
  limitation: string;
  lastError: string | null;
};

export type LocalP2pInboxMessage = {
  messageId: string;
  topic: string;
  sourcePeerId: string;
  payload: Record<string, unknown>;
  receivedAt: number;
};

type TrustedPeerCatalog = { addresses: string[]; updatedAt: number };
type RelayCatalog = { addresses: string[]; updatedAt: number };
const TRUSTED_PEER_NAMESPACE = "p2p-network";
const TRUSTED_PEER_KEY = "trusted-addresses";
const RELAY_KEY = "relay-addresses";

export async function startLocalP2p() {
  const relayAddresses = await listConfiguredLocalP2pRelays().catch(() => []);
  const status = await invoke<LocalP2pStatus>("local_p2p_start", { relayAddresses });
  const peers = await listTrustedLocalP2pPeers().catch(() => []);
  await Promise.allSettled(peers.map((address) => invoke<void>("local_p2p_dial", { address })));
  return status;
}

export function readLocalP2pStatus() {
  return invoke<LocalP2pStatus>("local_p2p_status");
}

export function stopLocalP2p() {
  return invoke<LocalP2pStatus>("local_p2p_stop");
}

export function publishLocalP2p(topic: "social" | "alerts" | "investment-groups", payload: Record<string, unknown>) {
  return invoke<string>("local_p2p_publish", { request: { topic, payload } });
}

export async function dialLocalP2pPeer(address: string, persist = true) {
  const normalized = address.trim();
  if (!normalized || normalized.length > 512) throw new Error("Enter a valid peer multiaddress.");
  await invoke<void>("local_p2p_dial", { address: normalized });
  if (persist) await updateTrustedPeers((current) => [...current.filter((item) => item !== normalized), normalized].slice(-64));
}

export async function listTrustedLocalP2pPeers() {
  const document = await getLocalDocument<TrustedPeerCatalog>(TRUSTED_PEER_NAMESPACE, TRUSTED_PEER_KEY);
  return document?.value.addresses.filter((item) => typeof item === "string" && item.length <= 512) || [];
}

export async function forgetTrustedLocalP2pPeer(address: string) {
  await updateTrustedPeers((current) => current.filter((item) => item !== address));
}

export async function listConfiguredLocalP2pRelays() {
  const document = await getLocalDocument<RelayCatalog>(TRUSTED_PEER_NAMESPACE, RELAY_KEY);
  return document?.value.addresses.filter((item) => typeof item === "string" && item.length <= 512).slice(0, 4) || [];
}

export async function saveConfiguredLocalP2pRelays(values: string[]) {
  const addresses = Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)));
  if (addresses.length > 4) throw new Error("Configure no more than four public relay addresses.");
  if (addresses.some((item) => item.length > 512)) throw new Error("A relay multiaddress is too long.");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const document = await getLocalDocument<RelayCatalog>(TRUSTED_PEER_NAMESPACE, RELAY_KEY);
    try {
      await putLocalDocument(TRUSTED_PEER_NAMESPACE, RELAY_KEY, { addresses, updatedAt: Date.now() }, document?.revision ?? 0);
      return addresses;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("LOCAL_DOCUMENT_REVISION_CONFLICT") || attempt === 2) throw error;
    }
  }
  return addresses;
}

async function updateTrustedPeers(update: (current: string[]) => string[]) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const document = await getLocalDocument<TrustedPeerCatalog>(TRUSTED_PEER_NAMESPACE, TRUSTED_PEER_KEY);
    const addresses = Array.from(new Set(update(document?.value.addresses || []).map((item) => item.trim()).filter(Boolean))).slice(-64);
    try {
      await putLocalDocument(TRUSTED_PEER_NAMESPACE, TRUSTED_PEER_KEY, { addresses, updatedAt: Date.now() }, document?.revision ?? 0);
      return addresses;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("LOCAL_DOCUMENT_REVISION_CONFLICT") || attempt === 2) throw error;
    }
  }
  return [];
}

export function sendLocalP2pDirect(peerId: string, messageId: string, payload: Record<string, unknown>) {
  return invoke<string>("local_p2p_send_direct", { request: { peerId, messageId, payload } });
}

export function listLocalP2pInbox(limit = 100) {
  return invoke<LocalP2pInboxMessage[]>("local_p2p_inbox", { limit });
}
