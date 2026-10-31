/**
 * Vault client: secure API key storage via Electron safeStorage.
 * 
 * In desktop mode, keys are encrypted with Windows DPAPI and stored in
 * userData/model-secrets/<uuid>.dpapi.
 * 
 * In web mode (or when safeStorage unavailable), falls back to environment
 * variables (auth.type = "env").
 */

import { log } from "../../log.js";

/**
 * Vault interface (same as migrate.ts VaultClient for DI).
 */
export interface VaultClient {
  put(value: string, label: string): Promise<{ credentialId: string; hint: string }>;
  get(credentialId: string): Promise<string | undefined>;
  hints(): Promise<Record<string, string>>;
  delete(credentialId: string): Promise<boolean>;
}

/**
 * Message channel vault client (desktop mode).
 * 
 * Communicates with electron/model-secrets.cjs via utility process message channel.
 */
class MessageChannelVault implements VaultClient {
  private requestId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  constructor() {
    // Listen for responses from main process
    if (typeof process !== "undefined" && process.parentPort) {
      process.parentPort.on("message", (message: any) => {
        if (!message || !message.type) return;

        if (message.type === "loam:model-secrets:put-response") {
          const cb = this.pending.get(message.requestId);
          if (!cb) return;
          this.pending.delete(message.requestId);
          
          if (message.ok) {
            cb.resolve({ credentialId: message.id, hint: message.hint });
          } else {
            cb.reject(new Error(message.error || "Failed to store credential"));
          }
        } else if (message.type === "loam:model-secrets:get-response") {
          const cb = this.pending.get(message.requestId);
          if (!cb) return;
          this.pending.delete(message.requestId);
          
          if (message.error) {
            cb.resolve(undefined); // Not found or decryption failed
          } else {
            cb.resolve(message.value);
          }
        } else if (message.type === "loam:model-secrets:hints-response") {
          const cb = this.pending.get(message.requestId);
          if (!cb) return;
          this.pending.delete(message.requestId);
          cb.resolve(message.hints);
        } else if (message.type === "loam:model-secrets:delete-response") {
          const cb = this.pending.get(message.requestId);
          if (!cb) return;
          this.pending.delete(message.requestId);
          cb.resolve(message.ok);
        }
      });
    }
  }

  private sendRequest(type: string, data: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const requestId = ++this.requestId;
      this.pending.set(requestId, { resolve, reject });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          reject(new Error(`Vault request timeout (${type})`));
        }
      }, 10000);

      if (typeof process !== "undefined" && process.parentPort) {
        process.parentPort.postMessage({ type, requestId, ...data });
      } else {
        reject(new Error("Message channel not available"));
      }
    });
  }

  async put(value: string, label: string): Promise<{ credentialId: string; hint: string }> {
    const id = crypto.randomUUID();
    return await this.sendRequest("loam:model-secrets:put", { id, value, label });
  }

  async get(credentialId: string): Promise<string | undefined> {
    return await this.sendRequest("loam:model-secrets:get", { id: credentialId });
  }

  async hints(): Promise<Record<string, string>> {
    return await this.sendRequest("loam:model-secrets:hints", {});
  }

  async delete(credentialId: string): Promise<boolean> {
    return await this.sendRequest("loam:model-secrets:delete", { id: credentialId });
  }
}

/**
 * Null vault (web mode fallback).
 * 
 * Always returns empty/failed results. The migration will use auth.type = "env"
 * instead when this vault is provided.
 */
class NullVault implements VaultClient {
  async put(): Promise<{ credentialId: string; hint: string }> {
    throw new Error("Vault not available (web mode or safeStorage unavailable)");
  }

  async get(): Promise<string | undefined> {
    return undefined;
  }

  async hints(): Promise<Record<string, string>> {
    return {};
  }

  async delete(): Promise<boolean> {
    return false;
  }
}

/**
 * Get the appropriate vault client for the current runtime.
 * 
 * - Desktop mode: MessageChannelVault (via utility process)
 * - Web mode: NullVault (falls back to env vars)
 * 
 * @returns VaultClient instance
 */
export function getVault(): VaultClient {
  // Check if we're in a Node.js utility process (desktop mode)
  if (typeof process !== "undefined" && process.parentPort) {
    return new MessageChannelVault();
  }

  // Web mode or renderer process without message channel
  log.warn("[vault] Running in web mode or without message channel; keys will use environment variables");
  return new NullVault();
}

/**
 * Check if the vault is available (desktop mode with safeStorage).
 */
export function isVaultAvailable(): boolean {
  return typeof process !== "undefined" && !!process.parentPort;
}
