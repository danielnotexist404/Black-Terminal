import { invoke } from "@tauri-apps/api/core";
import type { ExchangeId } from "../market-data/types";

export type ExchangeCredentialInput = {
  accountId: string;
  exchange: ExchangeId;
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
};

export type StoredCredentialReference = {
  accountId: string;
  exchange: ExchangeId;
  vaultKey: string;
  storedAt: number;
};

export interface SecureCredentialStore {
  storeExchangeCredentials(credentials: ExchangeCredentialInput): Promise<StoredCredentialReference>;
  deleteExchangeCredentials(accountId: string): Promise<void>;
}

export class TauriSecureCredentialStore implements SecureCredentialStore {
  async storeExchangeCredentials(credentials: ExchangeCredentialInput): Promise<StoredCredentialReference> {
    const vaultKey = `exchange:${credentials.exchange}:${credentials.accountId}`;
    return await invoke<StoredCredentialReference>("secure_store_exchange_credentials", {
      vaultKey,
      credentials
    });
  }

  async deleteExchangeCredentials(accountId: string) {
    await invoke("secure_delete_exchange_credentials", { accountId });
  }
}
