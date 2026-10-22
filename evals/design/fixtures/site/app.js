// Minimal progressive enhancement for the Northlight Roast landing fixture.
// It only adds a subtle scroll state to the header; the page is fully usable
// without JavaScript.
(function () {
  "use strict";
  var header = document.querySelector(".site-header");
  if (!header) return;
  var onScroll = function () {
    if (window.scrollY > 8) header.classList.add("is-scrolled");
    else header.classList.remove("is-scrolled");
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
})();
