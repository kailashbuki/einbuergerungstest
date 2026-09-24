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
//
// **`de` is deliberately absent from this list, and must stay absent.** German
// is the app's default interface language and the manifest `lang`, but it is
// lazy like every locale except `en`, so the blanket `assets/ui.??-*.js` this
// replaces silently kept the *default UI* out of the precache: a German user
// who installed the PWA and first opened it offline got the English fallback —
// the one locale combination we most need to work. The six genuinely optional
// UI locales are listed by name instead of matched by wildcard, so adding a
// locale can no longer drop something load-bearing by accident.
const LAZY_I18N_GLOB_IGNORES = [
  'assets/ui.{tr,ru,fr,ar,uk,hi}-*.js',
  // No `questions.de` exists — German is the source text, not a translation —
  // so all 7 of these are genuinely optional and stay wildcarded.
  'assets/questions.??-*.js',
];

// The Firebase *SDK* is forced into one predictably-named chunk so the service
// worker can target it. Without this it splits into three chunks all basenamed
// `index.esm` (@firebase/app, /auth, /firestore) — ~715 KB total, unglobbable
// without also catching unrelated vendor code by accident.
//
// The `-sdk` suffix matters: `src/lib/firebase.ts` emits `firebase-<hash>.js`,
// and a bare `firebase` name here would make the glob below match that too —
// silently dropping a 1.3 KB module the app shell imports *statically* out of the
// precache manifest, to save nothing.
const FIREBASE_CHUNK = 'firebase-sdk';

/**
 * Everything the first visit does NOT need.
 *
 *  - 13 of the 15 lazy i18n chunks: nobody studies in 8 interface languages at
 *    once. `ui.de` is the exception and is precached — see above.
 *  - The Firebase SDK: sync is an OPTIONAL upgrade that most users never enable.
 *    (The shipped config is a real, live Firebase project — this comment used to
 *    claim it was a placeholder, which it no longer is. The reasoning is
 *    unchanged: most visitors never sign in.) It is already absent from the entry
 *    module graph, but the default `**\/*.js` glob would precache it anyway —
 *    handing every single visitor ~715 KB for a feature they have not enabled.
 *  - The 42 question images (~4.6 MB): see the note on the image runtime rule.
 *
 * Each of these has a CacheFirst runtime rule below, so anything a user actually
 * reaches still ends up available offline. This is about what we download
 * *unprompted on a first visit over mobile data*, not about offline support.
 */
const DEFERRED_GLOB_IGNORES = [
  ...LAZY_I18N_GLOB_IGNORES,
  `assets/${FIREBASE_CHUNK}-*.js`,
  'img/*',
];

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
        // Precached: the app shell, the eagerly-bundled questions.json, the
        // English UI strings, the icons, and the two self-hosted non-Latin
        // webfonts. That is the set needed to open the app and study the 417
        // text-only questions with no network at all.
        globPatterns: ['**/*.{js,css,html,woff2,jpg,png,svg,ico}'],
        globIgnores: DEFERRED_GLOB_IGNORES,
        navigateFallback: `${BASE_PATH}index.html`,
        // `skipWaiting` alone is not enough: a new worker activates but does not
        // take over pages that are already open, so no `controllerchange` fires,
        // `registerType: 'autoUpdate'` never reloads, and the user keeps seeing
        // the previous build's assets until they navigate again — which in an
        // installed PWA can be days. `clientsClaim` makes the new worker adopt
        // the open page, which is what actually delivers the update.
        clientsClaim: true,
        runtimeCaching: [
          {
            // The 42 question images.
            //
            // Deliberately NOT precached. At ~4.6 MB they were 70% of a 6.5 MB
            // first visit — for 43 of 460 questions, on an app whose users are
            // often on metered mobile data. CacheFirst instead: an image is
            // fetched the first time its question comes up and is then offline
            // forever. The honest cost is that a picture question reached for the
            // very first time while offline shows no image; the benefit is that
            // the app opens at all on a slow connection. See README.
            urlPattern: ({ url }: { url: URL }) => /\/img\/[^/]+$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'question-images',
              // 42 images today; the ceiling leaves room without being unbounded.
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // The Firebase SDK chunk, loaded only if the user configures sync and
            // signs in. Same reasoning as the images: available offline once
            // fetched, never downloaded for someone who does not use it.
            // Written as a literal regex, NOT built from `FIREBASE_CHUNK`.
            // Workbox serialises this function's *source* into `sw.js`, where
            // build-time closure variables do not exist — interpolating one
            // emitted `new RegExp(\`/${FIREBASE_CHUNK}-...\`)` into the worker and
            // threw `ReferenceError: FIREBASE_CHUNK is not defined` on every
            // request that reached this matcher. A regex literal is
            // self-contained, so it survives serialisation. Keep the two in step
            // by hand; `sw-routes.test.ts` fails if they drift.
            urlPattern: ({ url }: { url: URL }) => /\/firebase-sdk-[\w-]+\.js$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'firebase-sdk',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
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
  build: {
    rollupOptions: {
      output: {
        // Collapse the Firebase SDK into one chunk with a name the service
        // worker's globIgnores can match. Left alone it emits three chunks all
        // called `index.esm-<hash>.js`, and there is no glob that excludes those
        // without risking unrelated vendor chunks that happen to share the name.
        manualChunks(id: string) {
          if (/node_modules\/(@firebase|firebase)\//.test(id)) return FIREBASE_CHUNK;
          return undefined;
        },
      },
    },
  },
});
