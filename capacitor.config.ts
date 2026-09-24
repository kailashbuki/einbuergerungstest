import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor wraps the ordinary Vite build in a native shell. There is no second
 * codebase: the app loaded here is exactly what `npm run build:native` produces,
 * which is exactly what GitHub Pages serves apart from the base path. See
 * `src/config/target.ts` for the one module that knows the difference.
 */
const config: CapacitorConfig = {
  /**
   * The bundle identifier, and effectively permanent: Apple ties it to the App
   * ID and the App Store listing, so it cannot be changed after the first
   * submission without creating a *new* app. Change it now if you want something
   * else.
   *
   * Reverse-DNS of a domain the project actually controls
   * (`kailashbuki.github.io`), which is the convention Apple expects and which
   * Google Play accepts.
   */
  appId: 'io.github.kailashbuki.einbuergerungstest',

  /**
   * Shown under the home-screen icon. iOS truncates the label at roughly 12
   * characters, so this will display as something like "Einbürgerun…" — set a
   * shorter `CFBundleDisplayName` in Xcode if that matters. The full name still
   * appears on the store listing.
   */
  appName: 'Einbürgerungstest',

  /**
   * `npm run build:native`, not `npm run build`. The web output in `dist/` is
   * mounted on `/einbuergerungstest/` for GitHub Pages; loading it here would
   * 404 every image and match no route.
   */
  webDir: 'dist-native',

  /**
   * Keep the WebView pinned to the bundled files. Capacitor can instead load a
   * dev server over the network, which is convenient and also means a shipped
   * build could be pointed at an origin we do not control — so the live-reload
   * server is configured ad hoc when needed, never committed.
   */
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
  },

  plugins: {
    FirebaseAuthentication: {
      /**
       * The JS SDK owns the session. Everything in `src/lib/sync` reads
       * `firebase/auth`'s `currentUser`, so letting the native SDK hold a second
       * independent session would give "who is signed in" two answers that can
       * disagree — and sign-out through the JS SDK would leave the native one
       * signed in. With this set, the plugin's only job is to fetch a Google ID
       * token, which `src/lib/sync/googleAuth.ts` passes to
       * `signInWithCredential`.
       */
      skipNativeAuth: true,
      /** Google only, matching the one provider enabled in the Firebase console. */
      providers: ['google.com'],
    },
  },

  // No `ios` block yet, on purpose. The two settings worth considering here —
  // `limitsNavigationsToAppBoundDomains` (locks the WebView to a declared domain
  // list) and `contentInset` (how the WebView handles the notch and home
  // indicator) — both change runtime behaviour in ways that cannot be checked
  // without building and running on a device or simulator. App-bound domains in
  // particular is known to interfere with OAuth flows and some cross-origin
  // APIs, and this app talks to Firestore. Decide both once `cap add ios` has
  // run and the app boots, rather than committing a guess.
};

export default config;
