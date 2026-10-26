// Main-process side of the matters-key handoff (Design decision LD-8).
// Wire-up in electron/main.cjs, right after `serverChild = utilityProcess.fork(...)`:
//   require("./legal-key.cjs").attachLegalKey(serverChild, app, safeStorage);
// The data key is random, generated once, stored ONLY wrapped by
// safeStorage (Windows DPAPI, bound to the signed-in Windows user), and sent to
// the server over the utility-process message channel when the server asks.
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const KEY_REQUEST = "loam:legal-key-request";
const KEY_RESPONSE = "loam:legal-key";

function keyFile(app) {
  return path.join(app.getPath("userData"), "legal", ".matters-key.dpapi");
}

function loadOrCreateKeyHex(app, safeStorage) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("safeStorage (DPAPI) is not available; legal matters stay locked");
  const file = keyFile(app);
  if (fs.existsSync(file)) {
    const hex = safeStorage.decryptString(fs.readFileSync(file));
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("legal key file is corrupt; legal matters stay locked");
    return hex;
  }
  const hex = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, safeStorage.encryptString(hex));
  fs.renameSync(tmp, file);
  return hex;
}

function attachLegalKey(child, app, safeStorage) {
  child.on("message", (message) => {
    if (!message || message.type !== KEY_REQUEST) return;
    try {
      child.postMessage({ type: KEY_RESPONSE, key: loadOrCreateKeyHex(app, safeStorage) });
    } catch (error) {
      // Never log the key; the server keeps failing closed without it.
      console.error("[electron] legal key: " + (error && error.message ? error.message : String(error)));
    }
  });
}

module.exports = { attachLegalKey, loadOrCreateKeyHex, KEY_REQUEST, KEY_RESPONSE };
