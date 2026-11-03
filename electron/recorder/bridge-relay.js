/*
 * Injected into the Loam Recorder page by loamrecorder://.
 * Defines window.electronAPI inside the iframe and forwards each call to the
 * Loam host. The host accepts only channels on the recorder allow-list.
 *
 * Host -> app: { type: "recorder:call", id, method, params }
 * App -> host: { type: "recorder:ready", app: "recordercraft", version: 1 }
 *              { type: "recorder:result", id, ok, result?, error? }
 *              { type: "recorder:ipc", id, channel, args }
 */
(function () {
  "use strict";
  if (typeof window === "undefined" || window.parent === window) return;

  var pending = Object.create(null);
  var seq = 0;

  function post(message) {
    window.parent.postMessage(message, "*");
  }

  function fail(id, message) {
    post({
      type: "recorder:result",
      id: id,
      ok: false,
      error: { code: "BRIDGE", message: message, retrySafe: false },
    });
  }

  function invoke(channel) {
    var args = Array.prototype.slice.call(arguments, 1);
    var id = "ipc-" + (++seq);
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      post({ type: "recorder:ipc", id: id, channel: channel, args: args });
    });
  }

  var api = {
    invoke: invoke,
    send: function (channel) {
      var args = Array.prototype.slice.call(arguments, 1);
      post({ type: "recorder:ipc", id: "send-" + (++seq), channel: channel, args: args });
    },
    getPlatform: function () { return "win32"; },
    assetBaseUrl: "loamrecorder://app/",
    getShortcuts: function () { return Promise.resolve(null); },
    getAppInfo: function () { return Promise.resolve({ version: "loam", canCheckForUpdates: false }); },
    canCheckForUpdatesNow: function () { return Promise.resolve(false); },
    getCurrentRecordingSession: function () {
      return Promise.resolve({ success: true, session: null });
    },
    setCurrentRecordingSession: function () {
      return Promise.resolve({ success: true });
    },
    setHasUnsavedChanges: function () { return undefined; },
    setAiEditionOpenProject: function () { return undefined; },
    setLocale: function () { return undefined; },
    setTitleBarOverlay: function () { return undefined; },
    stt: {},
    invokeNativeBridge: function (request) {
      return invoke("native-bridge:invoke", request);
    },
  };
  window.electronAPI = new Proxy(api, {
    get: function (target, prop) {
      if (prop in target) return target[prop];
      var name = String(prop);
      if (name.indexOf("on") === 0) return function () { return function () {}; };
      return function () { return undefined; };
    },
  });

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "recorder:ipc-result" && pending[data.id]) {
      var waiter = pending[data.id];
      delete pending[data.id];
      if (data.ok) waiter.resolve(data.result);
      else waiter.reject(new Error((data.error && data.error.message) || "rejected"));
      return;
    }
    if (data.type !== "recorder:call") return;
    var id = data.id;
    var method = data.method;
    if (typeof method !== "string" || !method) {
      fail(id, "missing method");
      return;
    }
    Promise.resolve()
      .then(function () {
        return window.electronAPI.invoke(method, data.params || {});
      })
      .then(
        function (result) { post({ type: "recorder:result", id: id, ok: true, result: result }); },
        function (error) { fail(id, error && error.message ? error.message : String(error)); },
      );
  });

  post({ type: "recorder:ready", app: "recordercraft", version: 1 });
})();
