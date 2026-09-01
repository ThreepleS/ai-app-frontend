// Service worker registration.
// Works from any origin (GitHub Pages subpath or custom domain) because the
// scope is derived from where this file is served. API calls go to a separate
// origin (the backend tunnel) and are left untouched by the SW.
if ("serviceWorker" in navigator && !(window.Telegram && window.Telegram.WebApp)) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
