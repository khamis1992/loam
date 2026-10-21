/*
 * bridge-relay.js — injected into the vendored Loam Video page by the
 * loamfilm:// protocol handler (see electron/main.cjs).
 *
 * It exposes window.filmcraft to the host Loam page over postMessage so the
 * agent bridge (packages/web/src/lib/filmcraft.ts) can drive the editor
 * without touching the dist files themselves.
 *
 * Protocol (host -> relay):
 *   { type: "filmcraft:call", id: string, method: string, args: unknown[] }
 * Protocol (relay -> host):
 *   { type: "filmcraft:ready", hasApi: boolean }
 *   { type: "filmcraft:result", id: string, ok: boolean, result?: unknown, error?: string }
 */
(function () {
  "use strict";
  if (typeof window === "undefined" || typeof window.parent === "undefined" || window.parent === window) return;

  function post(message) {
    try {
      window.parent.postMessage(message, "*");
    } catch (err) {
      console.error("[filmcraft-bridge] postMessage failed:", err);
    }
  }

  function errorMessage(err) {
    if (!err) return String(err);
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    try {
      return JSON.stringify(err);
    } catch (_e) {
      return String(err);
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.type !== "filmcraft:call") return;
    var id = data.id;
    var method = data.method;
    var args = Array.isArray(data.args) ? data.args : [];
    Promise.resolve().then(function () {
      var api = window.filmcraft;
      if (!api || typeof api[method] !== "function") {
        throw new Error("Loam Video editor API not ready or missing method: " + String(method));
      }
      return api[method].apply(api, args);
    }).then(
      function (result) {
        post({ type: "filmcraft:result", id: id, ok: true, result: result });
      },
      function (error) {
        post({ type: "filmcraft:result", id: id, ok: false, error: errorMessage(error) });
      },
    );
  });

  // Announce readiness once window.filmcraft appears (the wasm boot is async).
  var startedAt = Date.now();
  var pollTimer = setInterval(function () {
    if (window.filmcraft) {
      clearInterval(pollTimer);
      post({ type: "filmcraft:ready", hasApi: true });
      return;
    }
    if (Date.now() - startedAt > 120000) {
      clearInterval(pollTimer);
      post({ type: "filmcraft:ready", hasApi: false });
    }
  }, 250);
})();