import type { DBUser } from "../../lib/supabase";
import { getLocalDocument, putLocalDocument } from "./localDocumentStore";
import { getCachedLocalRuntimeStatus } from "./localRuntimeClient";

const namespace = "account";
const key = "private-profile-v1";

function baseProfile(): DBUser {
  const config = getCachedLocalRuntimeStatus()?.config;
  if (!config) throw new Error("The local owner profile is unavailable.");
  const now = new Date().toISOString();
  return {
    username: config.profile.username,
    displayName: config.profile.displayName,
    email: config.profile.email,
    role: "admin",
    status: "online",
    createdAt: new Date(config.initializedAt).toISOString(),
    lastLogin: now,
    allowedIndicators: [],
    activeIndicators: [],
    productTier: "admin",
    permissions: ["admin.override"],
    emailVerified: true,
  };
}

export async function readLocalAccountProfile() {
  const base = baseProfile();
  const saved = await getLocalDocument<DBUser>(namespace, key);
  return { ...base, ...(saved?.value || {}), username: base.username, email: base.email, role: base.role };
}

export async function updateLocalAccountProfile(patch: Partial<DBUser>) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await getLocalDocument<DBUser>(namespace, key);
    const base = baseProfile();
    const value: DBUser = {
      ...base,
      ...(current?.value || {}),
      ...patch,
      username: base.username,
      email: base.email,
      role: base.role,
      lastLogin: new Date().toISOString(),
    };
    try {
      const saved = await putLocalDocument(namespace, key, value, current?.revision ?? 0);
      if (!saved) throw new Error("The encrypted local account store is unavailable.");
      return saved.value;
    } catch (error) {
      if (!String(error).includes("LOCAL_DOCUMENT_REVISION_CONFLICT") || attempt === 3) throw error;
    }
  }
  throw new Error("The local account profile changed concurrently.");
}
