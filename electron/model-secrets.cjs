/**
 * Model registry credential vault (Electron main process).
 * 
 * Stores API keys encrypted with safeStorage (Windows DPAPI).
 * Wire-up in electron/main.cjs after utilityProcess.fork:
 *   require("./model-secrets.cjs").attachModelSecrets(serverChild, app, safeStorage);
 * 
 * Message protocol (utility process <-> main process):
 * - Server -> Main: { type: "loam:model-secrets:put", id, value, label }
 * - Main -> Server: { type: "loam:model-secrets:put-response", id, ok, error?, hint }
 * - Server -> Main: { type: "loam:model-secrets:get", id }
 * - Main -> Server: { type: "loam:model-secrets:get-response", id, value, error? }
 * - Server -> Main: { type: "loam:model-secrets:hints" }
 * - Main -> Server: { type: "loam:model-secrets:hints-response", hints: { id: hint } }
 * - Server -> Main: { type: "loam:model-secrets:delete", id }
 * - Main -> Server: { type: "loam:model-secrets:delete-response", id, ok }
 */

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MSG_PUT = "loam:model-secrets:put";
const MSG_PUT_RESPONSE = "loam:model-secrets:put-response";
const MSG_GET = "loam:model-secrets:get";
const MSG_GET_RESPONSE = "loam:model-secrets:get-response";
const MSG_HINTS = "loam:model-secrets:hints";
const MSG_HINTS_RESPONSE = "loam:model-secrets:hints-response";
const MSG_DELETE = "loam:model-secrets:delete";
const MSG_DELETE_RESPONSE = "loam:model-secrets:delete-response";

function vaultDir(app) {
  return path.join(app.getPath("userData"), "model-secrets");
}

function indexFile(app) {
  return path.join(vaultDir(app), "index.json");
}

function credentialFile(app, id) {
  return path.join(vaultDir(app), `${id}.dpapi`);
}

/**
 * Load the vault index (metadata only, no secret values).
 * 
 * @returns {{ [id: string]: { label: string, createdAt: string, hint: string } }}
 */
function loadIndex(app) {
  const file = indexFile(app);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error("[model-secrets] Failed to load index:", error.message);
    return {};
  }
}

/**
 * Save the vault index.
 */
function saveIndex(app, index) {
  const dir = vaultDir(app);
  fs.mkdirSync(dir, { recursive: true });
  
  const file = indexFile(app);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Put a credential into the vault.
 * 
 * @param id - UUID credential ID
 * @param value - Plaintext secret value
 * @param label - Human-readable label
 * @returns {{ ok: true, hint: string } | { ok: false, error: string }}
 */
function putCredential(app, safeStorage, id, value, label) {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: "safeStorage (DPAPI) is not available" };
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return { ok: false, error: "Invalid credential ID (must be UUID)" };
  }

  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, error: "Secret value cannot be empty" };
  }

  try {
    const dir = vaultDir(app);
    fs.mkdirSync(dir, { recursive: true });

    // Encrypt and save
    const file = credentialFile(app, id);
    const encrypted = safeStorage.encryptString(value);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, encrypted);
    fs.renameSync(tmp, file);

    // Update index
    const index = loadIndex(app);
    const hint = value.length >= 4 ? `...${value.slice(-4)}` : "«set»";
    index[id] = {
      label: label || "API Key",
      createdAt: new Date().toISOString(),
      hint,
    };
    saveIndex(app, index);

    return { ok: true, hint };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

/**
 * Get a credential from the vault.
 * 
 * @param id - UUID credential ID
 * @returns {{ value: string } | { error: string }}
 */
function getCredential(app, safeStorage, id) {
  if (!safeStorage.isEncryptionAvailable()) {
    return { error: "safeStorage (DPAPI) is not available" };
  }

  try {
    const file = credentialFile(app, id);
    if (!fs.existsSync(file)) {
      return { error: "Credential not found" };
    }

    const encrypted = fs.readFileSync(file);
    const value = safeStorage.decryptString(encrypted);
    return { value };
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

/**
 * Get all credential hints (for availability checks).
 * 
 * @returns {{ [id: string]: string }}
 */
function getHints(app) {
  const index = loadIndex(app);
  const hints = {};
  for (const [id, meta] of Object.entries(index)) {
    hints[id] = meta.hint;
  }
  return hints;
}

/**
 * Delete a credential from the vault.
 * 
 * @param id - UUID credential ID
 * @returns {{ ok: true } | { ok: false }}
 */
function deleteCredential(app, id) {
  try {
    const file = credentialFile(app, id);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }

    const index = loadIndex(app);
    delete index[id];
    saveIndex(app, index);

    return { ok: true };
  } catch (error) {
    console.error("[model-secrets] Failed to delete credential:", error.message);
    return { ok: false };
  }
}

/**
 * Attach vault message handlers to the utility process.
 * 
 * @param child - UtilityProcess instance
 * @param app - Electron app
 * @param safeStorage - Electron safeStorage
 */
function attachModelSecrets(child, app, safeStorage) {
  child.on("message", (message) => {
    if (!message || !message.type) return;

    try {
      if (message.type === MSG_PUT) {
        const result = putCredential(app, safeStorage, message.id, message.value, message.label);
        child.postMessage({
          type: MSG_PUT_RESPONSE,
          requestId: message.requestId,
          id: message.id,
          ok: result.ok,
          error: result.ok ? undefined : result.error,
          hint: result.ok ? result.hint : undefined,
        });
      } else if (message.type === MSG_GET) {
        const result = getCredential(app, safeStorage, message.id);
        child.postMessage({
          type: MSG_GET_RESPONSE,
          requestId: message.requestId,
          id: message.id,
          value: result.value,
          error: result.error,
        });
      } else if (message.type === MSG_HINTS) {
        child.postMessage({
          type: MSG_HINTS_RESPONSE,
          requestId: message.requestId,
          hints: getHints(app),
        });
      } else if (message.type === MSG_DELETE) {
        const result = deleteCredential(app, message.id);
        child.postMessage({
          type: MSG_DELETE_RESPONSE,
          requestId: message.requestId,
          id: message.id,
          ok: result.ok,
        });
      }
    } catch (error) {
      console.error("[model-secrets] Handler error:", error.message);
    }
  });
}

module.exports = {
  attachModelSecrets,
  putCredential,
  getCredential,
  getHints,
  deleteCredential,
  MSG_PUT,
  MSG_PUT_RESPONSE,
  MSG_GET,
  MSG_GET_RESPONSE,
  MSG_HINTS,
  MSG_HINTS_RESPONSE,
  MSG_DELETE,
  MSG_DELETE_RESPONSE,
};
