import { invoke } from "@tauri-apps/api/core";
import { isLocalOnlyRuntime, isTauriRuntime } from "./localRuntimeClient";

export type LocalDocument<T> = {
  namespace: string;
  key: string;
  value: T;
  revision: number;
  updatedAt: number;
};

export async function getLocalDocument<T>(namespace: string, key: string) {
  if (!isTauriRuntime()) return null;
  return await invoke<LocalDocument<T> | null>("local_document_get", { namespace, key });
}

export async function putLocalDocument<T>(namespace: string, key: string, value: T, expectedRevision?: number) {
  if (!isTauriRuntime()) return null;
  return await invoke<LocalDocument<T>>("local_document_put", {
    request: { namespace, key, value, expectedRevision },
  });
}

export async function listLocalDocuments<T>(namespace: string) {
  if (!isTauriRuntime()) return [];
  return await invoke<Array<LocalDocument<T>>>("local_document_list", { namespace });
}

export async function deleteLocalDocument(namespace: string, key: string, expectedRevision?: number) {
  if (!isTauriRuntime()) return false;
  return await invoke<boolean>("local_document_delete", { namespace, key, expectedRevision });
}

export function mirrorLocalDocument<T>(namespace: string, key: string, value: T) {
  if (!isLocalOnlyRuntime()) return;
  void putLocalDocument(namespace, key, value).catch((error) => {
    console.error(`Failed to mirror local ${namespace}/${key} document`, error);
  });
}

type WorkspaceBootstrap = {
  names: string[];
  snapshots: Record<string, unknown>;
  active: string;
};

export async function hydrateLocalPreferenceCache() {
  if (!isLocalOnlyRuntime()) return;
  const [settings, workspaces, alerts] = await Promise.all([
    getLocalDocument<Record<string, unknown>>("settings", "terminal"),
    getLocalDocument<WorkspaceBootstrap>("workspaces", "catalog"),
    getLocalDocument<unknown[]>("automation", "indicator-alerts"),
  ]);
  if (settings) localStorage.setItem("bt_terminal_settings", JSON.stringify(settings.value));
  if (workspaces) {
    localStorage.setItem("bt_workspace_names_v1", JSON.stringify(workspaces.value.names));
    localStorage.setItem("bt_workspaces_v1", JSON.stringify(workspaces.value.snapshots));
    localStorage.setItem("bt_active_workspace_v1", workspaces.value.active);
  }
  if (alerts) localStorage.setItem("bt_indicator_alerts_v1", JSON.stringify(alerts.value));
}
