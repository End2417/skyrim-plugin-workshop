// UI-free rules for when the offline service worker may register.
// It must never run in dev, inside an iframe, or on any Lovable preview host,
// otherwise the preview would keep serving stale cached code.

export const SW_URL = "/sw.js";

export type SwEnv = {
  prod: boolean;
  inIframe: boolean;
  hostname: string;
  search: string;
};

const PREVIEW_DOMAINS = ["lovable.app", "gpt-eng.com", "gptengineer.run"];
const PREVIEW_LABEL = /^(?:id-preview|preview)(?:-[a-z0-9]+)?--.+$/;
const DEV_PROJECT_LABEL = /^project--[a-z0-9-]+-dev$/;

function isPreviewHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  for (const domain of PREVIEW_DOMAINS) {
    if (!host.endsWith(`.${domain}`)) continue;
    const label = host.slice(0, -(domain.length + 1));
    if (label.includes(".")) continue;
    if (PREVIEW_LABEL.test(label) || DEV_PROJECT_LABEL.test(label)) return true;
  }
  for (const domain of ["lovableproject.com", "lovableproject-dev.com", "beta.lovable.dev"]) {
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
}

export function shouldRegisterServiceWorker(env: SwEnv): boolean {
  if (!env.prod) return false;
  if (env.inIframe) return false;
  if (new URLSearchParams(env.search).get("sw") === "off") return false;
  if (isPreviewHost(env.hostname)) return false;
  return true;
}
