/* Applies the saved theme on every page so sub-pages never mismatch the main
 * window, and gives every page a consistent, visible back control. */
(function () {
  var KEY = "loam-theme";

  function normalize(t) {
    if (t === "light") return "light";
    if (t === "system") {
      try {
        return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      } catch (e) {
        return "dark";
      }
    }
    return t === "dark" ? "dark" : "light";
  }

  // Apply immediately (no flash) from the local mirror.
  var theme = "light";
  try {
    theme = localStorage.getItem(KEY) || localStorage.getItem("manus-theme") || "light";
  } catch (e) {
    /* storage unavailable */
  }
  document.documentElement.dataset.theme = normalize(theme);
  function applyPagePalette() {
    var parts = location.hash.replace(/^#\/?/, "").split("/");
    var page = location.pathname.split("/").pop().replace(/\.html$/, "");
    var palette = page && page !== "index" ? page : (parts[1] || parts[0] || "home");
    if (location.pathname.indexOf("/studios/") === 0) palette = parts[0] || "mobile";
    document.documentElement.dataset.palette = palette === "media" ? "creative" : palette;
  }
  applyPagePalette();
  window.addEventListener("hashchange", applyPagePalette);
  // Other open pages and embedded studios follow the shell without reloading.
  window.addEventListener("storage", function (event) {
    if (event.key === KEY) document.documentElement.dataset.theme = normalize(event.newValue);
  });

  // The server setting is the source of truth; mirror it back locally.
  try {
    fetch("/api/settings")
      .then(function (r) {
        return r.json();
      })
      .then(function (s) {
        if (!s || !s.theme) return;
        var t = normalize(s.theme);
        document.documentElement.dataset.theme = t;
        try {
          localStorage.setItem(KEY, t);
        } catch (e) {
          /* ignore */
        }
      })
      .catch(function () {});
  } catch (e) {
    /* offline */
  }

  // When rendered inside the app shell, the page keeps the sidebar, so its own
  // "back" control is redundant.
  try {
    if (location.search.indexOf("embed=1") !== -1) document.documentElement.classList.add("embed");
  } catch (e) {
    /* ignore */
  }

  // Esc returns to the main window from any sub-page, unless the page is using
  // Esc for its own overlay (drawer/modal).
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    var tag = (ev.target && ev.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (document.querySelector(".drawer.on, .scrim.on, dialog[open]")) return;
    if (location.pathname !== "/" && location.pathname !== "/index.html") {
      location.href = "/";
    }
  });
})();
