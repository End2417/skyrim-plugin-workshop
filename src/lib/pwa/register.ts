// The only place the app registers its offline service worker.
import { SW_URL, shouldRegisterServiceWorker } from "./guard";

const PAGES_CACHE = "pages";

function inIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

async function unregisterAppWorkers(): Promise<void> {
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.allSettled(
    regs
      .filter((r) => {
        const url = r.active?.scriptURL ?? r.waiting?.scriptURL ?? r.installing?.scriptURL ?? "";
        return url !== "" && new URL(url).pathname === SW_URL;
      })
      .map((r) => r.unregister()),
  );
}

export function setupServiceWorker(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

  const allowed = shouldRegisterServiceWorker({
    prod: import.meta.env.PROD,
    inIframe: inIframe(),
    hostname: window.location.hostname.toLowerCase(),
    search: window.location.search,
  });

  if (!allowed) {
    void unregisterAppWorkers().catch(() => {});
    return;
  }

  navigator.serviceWorker
    .register(SW_URL, { scope: "/" })
    .then(() => navigator.serviceWorker.ready)
    .then(async () => {
      // The page that installed the worker loaded before it existed, so store
      // the start page now; otherwise the first offline launch has nothing to show.
      const cache = await caches.open(PAGES_CACHE);
      if (!(await cache.match("/"))) await cache.add("/");
    })
    .catch((err) => console.warn("Offline support unavailable:", err));
}
