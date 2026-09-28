/* Theme preference is the only value saved locally. PDF files never enter storage. */
(function () {
  "use strict";
  var key = "pdf-unwatermark-theme", root = document.documentElement;
  var media = window.matchMedia("(prefers-color-scheme: dark)");
  try {
    var saved = localStorage.getItem(key);
    if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
  } catch (_) { /* Storage may be disabled; system preference still works. */ }

  function current() { return root.getAttribute("data-theme") || (media.matches ? "dark" : "light"); }
  function update() {
    var dark = current() === "dark";
    var button = document.getElementById("theme-toggle");
    if (!button) return;
    button.setAttribute("aria-pressed", String(dark));
    button.setAttribute("aria-label", dark ? "เปลี่ยนเป็นโหมดสว่าง" : "เปลี่ยนเป็นโหมดมืด");
    document.getElementById("theme-label").textContent = dark ? "โหมดสว่าง" : "โหมดมืด";
    document.getElementById("theme-icon").setAttribute("href", dark ? "#i-sun" : "#i-moon");
  }
  document.addEventListener("DOMContentLoaded", function () {
    var button = document.getElementById("theme-toggle");
    button.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem(key, next); } catch (_) { /* Keep the current page setting. */ }
      update();
    });
    if (media.addEventListener) media.addEventListener("change", update);
    else if (media.addListener) media.addListener(update);
    update();
  });
})();
