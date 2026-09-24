import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';
import { BASE_PATH } from './src/config/paths';

// The 7 question-translation bundles (src/data/i18n/questions.<lang>.json) and
// the 7 non-English UI locale bundles (src/i18n/ui.<lang>.json, excluding
// `en` which is imported eagerly as the fallback and lives in the main
// bundle) are loaded via `import()` in src/i18n/index.ts, so each becomes its
// own JS chunk named `ui.<lang>-<hash>.js` / `questions.<lang>-<hash>.js`
// (Rollup derives the chunk name from the imported module's basename).
// Those chunks are intentionally EXCLUDED from the precache manifest — left
// unfiltered, workbox's default `**/*.js` glob would eagerly download all 14
// of them (~1.5MB) for every visitor, even though most people only ever use
// one or two languages. Instead they are fetched on demand and cached the
// first time they're used via the CacheFirst runtimeCaching rule below, so
// offline support still works for whichever languages a user actually picks.
const LAZY_I18N_GLOB_IGNORES = ['assets/ui.??-*.js', 'assets/questions.??-*.js'];

export default defineConfig({
  base: BASE_PATH,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // We call `registerSW()` from `virtual:pwa-register` ourselves in
      // src/main.tsx (so it runs inside the same module graph as the rest of
      // app startup) — disable the plugin's own auto-injected <script> to
      // avoid registering the service worker twice.
      injectRegister: false,
      manifest: {
        id: BASE_PATH,
        name: 'Einbürgerungstest',
        short_name: 'Einbürgerung',
        description: 'Study for the German naturalization test — all 16 Bundesländer, offline-first.',
        theme_color: '#1f6f54',
        background_color: '#fbf7ee',
        start_url: BASE_PATH,
        scope: BASE_PATH,
        display: 'standalone',
        orientation: 'portrait-primary',
        lang: 'de',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell, the eagerly-bundled questions.json + English UI strings,
        // the 42 question images, and the self-hosted fonts all get precached
        // normally via the default globPatterns (js/css/html/woff2/jpg/png/svg).
        globPatterns: ['**/*.{js,css,html,woff2,jpg,png,svg,ico}'],
        globIgnores: LAZY_I18N_GLOB_IGNORES,
        navigateFallback: `${BASE_PATH}index.html`,
        runtimeCaching: [
          {
            // Lazily-loaded UI locale chunks (ui.tr-*.js, ui.ar-*.js, ...)
            // and question-translation chunks (questions.tr-*.js, ...).
            // CacheFirst: once a user picks a language, cache it indefinitely
            // so offline works for it too, without ever precaching all 7+7.
            urlPattern: ({ url }: { url: URL }) =>
              /\/(ui|questions)\.[a-z]{2}-[\w-]+\.js$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'i18n-lazy-locales',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
