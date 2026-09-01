import { invoke } from "@tauri-apps/api/core";
import { getLocalDocument, putLocalDocument } from "./localDocumentStore";
import { isLocalOnlyRuntime } from "./localRuntimeClient";
import {
  defaultLocalEmailProvider,
  normalizeLocalEmailProviderSettings,
  type LocalEmailProviderSettings,
} from "./localEmailModel";
export { defaultLocalEmailProvider, normalizeLocalEmailProviderSettings, type LocalEmailProviderSettings } from "./localEmailModel";

const SETTINGS_NAMESPACE = "settings";
const SETTINGS_KEY = "email-provider";

export async function readLocalEmailProviderSettings() {
  if (!isLocalOnlyRuntime()) return defaultLocalEmailProvider;
  const document = await getLocalDocument<LocalEmailProviderSettings>(SETTINGS_NAMESPACE, SETTINGS_KEY);
  return normalizeLocalEmailProviderSettings(document?.value || defaultLocalEmailProvider);
}

export async function saveLocalEmailProviderSettings(settings: LocalEmailProviderSettings) {
  if (!isLocalOnlyRuntime()) throw new Error("Local SMTP is available only in the installed runtime.");
  const cleaned = normalizeLocalEmailProviderSettings(settings);
  await putLocalDocument(SETTINGS_NAMESPACE, SETTINGS_KEY, cleaned);
  return cleaned;
}

export async function storeLocalEmailCredential(credentialId: string, username: string, secret: string) {
  if (!isLocalOnlyRuntime()) throw new Error("Local SMTP is available only in the installed runtime.");
  return await invoke<{ credentialId: string; configured: boolean }>("secure_store_email_credentials", {
    credentials: { credentialId, username, secret },
  });
}

export async function localEmailCredentialStatus(credentialId: string) {
  if (!isLocalOnlyRuntime()) return { credentialId, configured: false };
  return await invoke<{ credentialId: string; configured: boolean }>("secure_email_credentials_status", { credentialId });
}

export async function deleteLocalEmailCredential(credentialId: string) {
  if (!isLocalOnlyRuntime()) return;
  await invoke("secure_delete_email_credentials", { credentialId });
}

export async function sendLocalEmail(input: {
  provider: LocalEmailProviderSettings;
  to: string;
  subject: string;
  body: string;
}) {
  if (!isLocalOnlyRuntime()) throw new Error("Local SMTP is available only in the installed runtime.");
  const provider = normalizeLocalEmailProviderSettings(input.provider);
  if (!provider.enabled) throw new Error("Local SMTP delivery is disabled.");
  return await invoke<{ accepted: boolean; response: string }>("local_email_send", {
    request: {
      credentialId: provider.credentialId,
      smtpHost: provider.smtpHost,
      smtpPort: provider.smtpPort,
      transport: provider.transport,
      fromAddress: provider.fromAddress,
      fromName: provider.fromName,
      to: input.to.trim(),
      subject: input.subject,
      body: input.body,
    },
  });
}
