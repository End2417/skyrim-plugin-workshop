// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// Never set ssr.external or resolve.external: the Worker has no runtime module resolution, so
// the build fails. Never add compression (compressPublicAssets, vite-plugin-compression):
// hosting already compresses at the edge.
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { Plugin } from "vite";
import { VitePWA, type VitePWAOptions } from "vite-plugin-pwa";

const pwaOptions: Partial<VitePWAOptions> = {
  strategies: "generateSW",
  filename: "sw.js",
  registerType: "autoUpdate",
  // src/lib/pwa/register.ts is the only registrar; the plugin must not inject one.
  injectRegister: null,
  devOptions: { enabled: false },
  // The manifest is a static file in public/.
  manifest: false,
  workbox: {
    // Hashed build assets and icons are precached; HTML is never precached.
    globPatterns: ["**/*.{js,css,png,ico,svg,woff2,webmanifest}"],
    navigateFallback: null,
    cleanupOutdatedCaches: true,
    clientsClaim: true,
    skipWaiting: true,
    runtimeCaching: [
      {
        // Pages: always try the network first, fall back to the last copy offline.
        urlPattern: ({ request, url }) =>
          request.mode === "navigate" && !url.pathname.startsWith("/~oauth"),
        handler: "NetworkFirst",
        options: {
          cacheName: "pages",
          networkTimeoutSeconds: 4,
          expiration: { maxEntries: 20 },
        },
      },
      {
        urlPattern: ({ url }) =>
          url.origin === "https://fonts.googleapis.com" ||
          url.origin === "https://fonts.gstatic.com",
        handler: "StaleWhileRevalidate",
        options: {
          cacheName: "google-fonts",
          expiration: { maxEntries: 30 },
          cacheableResponse: { statuses: [0, 200] },
        },
      },
    ],
  },
};

// TanStack Start writes browser files to the client environment's own folder
// (not build.outDir), so the service worker must be generated there too.
function pwaClientOutDir(): Plugin {
  return {
    name: "pwa-client-outdir",
    enforce: "pre",
    configResolved(config) {
      const clientOut = config.environments?.client?.build?.outDir;
      if (clientOut) pwaOptions.outDir = clientOut;
    },
  };
}

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  plugins: [pwaClientOutDir(), VitePWA(pwaOptions)],
});
