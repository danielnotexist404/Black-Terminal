import { invoke } from "@tauri-apps/api/core";
import { getLocalDocument, putLocalDocument } from "./localDocumentStore";

export type LocalAiProviderSettings = { endpoint: string; model: string; updatedAt: number };
export type LocalAiChatMessage = { role: "user" | "assistant"; content: string };

const NAMESPACE = "local-ai";
const PROVIDER_KEY = "provider";

export const defaultLocalAiProvider: LocalAiProviderSettings = {
  endpoint: "http://127.0.0.1:11434/api/chat",
  model: "llama3.2",
  updatedAt: 0,
};

export async function readLocalAiProviderSettings() {
  const document = await getLocalDocument<LocalAiProviderSettings>(NAMESPACE, PROVIDER_KEY);
  return { ...defaultLocalAiProvider, ...document?.value };
}

export async function saveLocalAiProviderSettings(value: Pick<LocalAiProviderSettings, "endpoint" | "model">) {
  const endpoint = value.endpoint.trim();
  const model = value.model.trim();
  if (!/^http:\/\/(127\.0\.0\.1|\[::1\])(?::\d{1,5})?\/api\/chat\/?$/i.test(endpoint)) throw new Error("Use an explicit numeric loopback Ollama-compatible /api/chat endpoint.");
  if (!/^[A-Za-z0-9._:/-]{1,120}$/.test(model)) throw new Error("Enter a valid local model identifier.");
  const current = await getLocalDocument<LocalAiProviderSettings>(NAMESPACE, PROVIDER_KEY);
  const saved = await putLocalDocument(NAMESPACE, PROVIDER_KEY, { endpoint: endpoint.replace(/\/$/, ""), model, updatedAt: Date.now() }, current?.revision ?? 0);
  if (!saved) throw new Error("The encrypted local provider settings are only available in the desktop runtime.");
  return saved.value;
}

export async function requestLocalAiChat(messages: LocalAiChatMessage[], systemContext: string) {
  const provider = await readLocalAiProviderSettings();
  return invoke<{ content: string; model: string; done: boolean }>("local_ai_chat", { request: { endpoint: provider.endpoint, model: provider.model, messages, systemContext } });
}
