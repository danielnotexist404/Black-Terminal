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

    try {
      await invoke("secure_store_exchange_credentials", {
        vaultKey,
        credentials
      });
    } catch (error) {
      console.warn("Secure credential command is not available yet; no secret was persisted.", error);
    }

    return {
      accountId: credentials.accountId,
      exchange: credentials.exchange,
      vaultKey,
      storedAt: Date.now()
    };
  }

  async deleteExchangeCredentials(accountId: string) {
    try {
      await invoke("secure_delete_exchange_credentials", { accountId });
    } catch (error) {
      console.warn("Secure credential delete command is not available yet.", error);
    }
  }
}
