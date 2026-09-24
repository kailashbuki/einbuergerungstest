# Shipping the same app to the App Store

There is one codebase. The store build is the *same* `src/` compiled with a
different base path and loaded by a native shell instead of a browser tab. No
second UI, no port, no parallel branch.

The shell is [Capacitor](https://capacitorjs.com) 8. It gives the web build a
native project (Xcode / Gradle), a `WKWebView` / Android `WebView` to run in, and
a plugin bridge for the few things a WebView cannot do itself.

## Why Capacitor and not the alternatives

| | why not |
|---|---|
| React Native / Expo | Rewrites every component. `div`/Tailwind do not exist there. Months of work to arrive at the same app. |
| Tauri 2 mobile | Promising, but far less proven through store review than Capacitor. |
| Bubblewrap / Trusted Web Activity | Play Store only. Apple rejects thin web wrappers under guideline 4.2. |

Capacitor keeps the entire existing app and adds a shell around it, so the
maintenance cost of "also a mobile app" stays close to zero.

## The two builds

| | web | native |
|---|---|---|
| Command | `npm run build` | `npm run build:native` |
| `VITE_TARGET` | unset (or `web`) | `native` |
| Output | `dist/` | `dist-native/` (gitignored) |
| Base path | `/einbuergerungstest/` | `/` |
| Service worker | registered | not registered |
| Google sign-in | `signInWithPopup` | native SDK + `signInWithCredential` |

`src/config/target.ts` is the **only** module that knows a mobile build exists.
Everything else asks for a capability (`BASE_PATH`, `isNative`) and never for the
platform. An unrecognised `VITE_TARGET` fails the build rather than falling back,
because a typo would otherwise produce a web build that copies into the native
project without complaint and fails only on launch.

## Workflow

```bash
npm run cap:sync        # build:native, then copy assets + plugins into the native projects
npm run cap:ios         # the same, then open Xcode
```

`cap sync` must be re-run after any change to `dist-native/`, `capacitor.config.ts`,
or the installed plugin set. The native projects are committed once created, so
`sync` is an update, not a scaffold.

## What the WebView changes, and what this repo already does about it

**Google sign-in.** `signInWithPopup` opens a window the native shell never
returns from: the promise never settles and the user is stuck on a spinner with no
way back. `src/lib/sync/googleAuth.ts` branches — popup on the web, the platform's
own Google SDK on native via `@capacitor-firebase/authentication`, whose ID token
is handed to the same `firebase/auth` instance with `signInWithCredential`. Both
paths end with a session on the JS SDK, which is the only session the rest of
`src/lib/sync` knows about. `capacitor.config.ts` sets `skipNativeAuth: true` for
exactly that reason.

**No service worker.** `WKWebView` does not run service workers for pages served
from the `capacitor://` scheme, so `src/main.tsx` skips registration on native.
Nothing is lost — every asset is already on the device inside the app bundle. One
consequence worth knowing: the update path differs. The web picks up a new build
on the next visit; a store build only updates when the user installs a new version.

**The base path.** A Capacitor WebView serves the bundle as its own document root,
so the Pages subpath would 404 every image and match no route — a blank screen,
found after review rather than in CI.

## Not done yet

Deliberately left, in rough priority order:

- **`npx cap add ios` has not been run.** It needs CocoaPods installed, and the
  Xcode in this checkout's environment (15.0.1) is too old to submit to the App
  Store — Apple has required the iOS 18 SDK / Xcode 16+ since April 2025.
- **Safe-area insets.** The notch and home indicator will overlap the layout until
  the header and footer respect `env(safe-area-inset-*)`.
- **`vite-plugin-pwa` still runs for the native build,** so `dist-native/` ships an
  `sw.js` nobody registers. Harmless, just dead weight.
- **The web bundle carries an unused Capacitor chunk** (~16 KB, lazily loaded and
  never reached, because `isNative` is resolved at module load rather than folded
  into a constant). Costs a precache entry, nothing else.
- **Android text-to-speech.** `speechSynthesis` is broken in the Android WebView
  and would need `@capacitor-community/text-to-speech`. Not an iOS problem —
  `WKWebView` supports it.

## Things only the account holder can do

- Enrol in the Apple Developer Program ($99/yr).
- Upgrade Xcode to 16 or newer and install CocoaPods.
- Add the iOS app to the Firebase project and download `GoogleService-Info.plist`
  into `ios/App/App/`, then register the reversed client ID as a URL scheme.
  Without this, sign-in fails with "returned no ID token".
- Write the store listing, privacy questionnaire, and screenshots.

Guideline 5.1.1(v) requires in-app account deletion; **Settings → Delete your
account** satisfies it, provided the published `firestore.rules` grant `delete`
(see the Firebase section of the README).
