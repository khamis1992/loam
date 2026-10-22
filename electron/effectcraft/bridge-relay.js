/*
 * bridge-relay.js — injected into the vendored Loam Effects page by the
 * loameffect:// protocol handler (see electron/main.cjs).
 *
 * It exposes window.effectcraft to the host Loam page over postMessage so the
 * agent bridge (packages/web/src/lib/effectcraft.ts) and the "Open in effects"
 * panel can drive the effects engine without touching the dist files
 * themselves. EffectCraft runs the render queue in Web Workers, so the page is
 * served cross-origin isolated (COOP/COEP); postMessage still crosses that
 * boundary.
 *
 * Protocol (host -> relay):
 *   { type: "effectcraft:call", id: string, method: string, args: unknown[] }
 * Protocol (relay -> host):
 *   { type: "effectcraft:ready", hasApi: boolean }
 *   { type: "effectcraft:result", id: string, ok: boolean, result?: unknown, error?: string }
 */
(function () {
  "use strict";
  if (typeof window === "undefined" || typeof window.parent === "undefined" || window.parent === window) return;

  function post(message) {
    try {
      window.parent.postMessage(message, "*");
    } catch (err) {
      console.error("[effectcraft-bridge] postMessage failed:", err);
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
    if (!data || typeof data !== "object" || data.type !== "effectcraft:call") return;
    var id = data.id;
    var method = data.method;
    var args = Array.isArray(data.args) ? data.args : [];
    Promise.resolve().then(function () {
      var api = window.effectcraft;
      if (!api || typeof api[method] !== "function") {
        throw new Error("Loam Effects engine API not ready or missing method: " + String(method));
      }
      return api[method].apply(api, args);
    }).then(
      function (result) {
        post({ type: "effectcraft:result", id: id, ok: true, result: result });
      },
      function (error) {
        post({ type: "effectcraft:result", id: id, ok: false, error: errorMessage(error) });
      },
    );
  });

  // Announce readiness once window.effectcraft appears (the wasm boot is async).
  var startedAt = Date.now();
  var pollTimer = setInterval(function () {
    if (window.effectcraft) {
      clearInterval(pollTimer);
      post({ type: "effectcraft:ready", hasApi: true });
      return;
    }
    if (Date.now() - startedAt > 120000) {
      clearInterval(pollTimer);
      post({ type: "effectcraft:ready", hasApi: false });
    }
  }, 250);
})();
