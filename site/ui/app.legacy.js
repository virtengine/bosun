/* Legacy bootstrap shim.
 * The maintained UI implementation lives in app.js.
 */
(function loadModernApp() {
  if (typeof document === "undefined") return;
  const existing = document.querySelector('script[data-bosun-modern-app="1"]');
  if (existing) return;
  const script = document.createElement("script");
  script.type = "module";
  script.src = "./app.js";
  script.dataset.bosunModernApp = "1";
  document.head.appendChild(script);
})();