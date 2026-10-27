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
    return "dark";
  }

  // Apply immediately (no flash) from the local mirror.
  var theme = "dark";
  try {
    theme = localStorage.getItem(KEY) || localStorage.getItem("manus-theme") || "dark";
  } catch (e) {
    /* storage unavailable */
  }
  document.documentElement.dataset.theme = normalize(theme);
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

  // Standalone tools have a safe route home; embedded links leave the frame.
  document.addEventListener('DOMContentLoaded', function () {
    var servicePages=['skills','memory','brain','learning','companions','screen','integrations','terminal'];
    var name=location.pathname.split('/').pop().replace(/\.html$/, '');
    var supported=servicePages.indexOf(name)!==-1 || ['mobile','security','swarm'].indexOf(name)!==-1 || location.pathname==='/studios/index.html';
    if(!supported)return;
    var parentUrl=servicePages.indexOf(name)!==-1?'/#/services':'/#/home';
    document.querySelectorAll('a[href="/"],a[href="/index.html"]').forEach(function(a){a.target='_top';});
    if(window.self!==window.top)return;
    var nav=document.createElement('nav');nav.setAttribute('aria-label','العودة إلى مساحة العمل');
    nav.style.cssText='position:fixed;bottom:12px;inset-inline-start:16px;z-index:1000;display:flex;gap:8px;padding:8px;border:1px solid var(--border,#425448);border-radius:10px;background:var(--panel,#182820);box-shadow:0 3px 15px #0003;font:13px Arial';
    var back=document.createElement('a');back.textContent='عودة';back.href=parentUrl;
    try{var ref=new URL(document.referrer);if(ref.origin===location.origin&&(ref.pathname==='/'||ref.pathname==='/index.html'))back.href=ref.href;}catch(e){}
    var home=document.createElement('a');home.textContent='الرئيسية';home.href='/#/home';
    [back,home].forEach(function(a){a.style.cssText='display:inline-flex;align-items:center;min-height:32px;padding:4px 12px;border-radius:6px;color:var(--text,#eef6f1);text-decoration:underline';nav.appendChild(a);});
    document.body.appendChild(nav);
  });
})();
