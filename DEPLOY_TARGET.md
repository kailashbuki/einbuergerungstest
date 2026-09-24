# Deploy target (resolved)

Orchestrator note — these values are confirmed, not placeholders.

- GitHub user: `kailashbuki`
- Repo: `einbuergerungstest` (public, required for Pages on a free account)
- Vite `base`: `/einbuergerungstest/`
- Live URL: `https://kailashbuki.github.io/einbuergerungstest/`

Base path lives in exactly one exported constant: `src/config/paths.ts` (`BASE_PATH`),
consumed by `vite.config.ts` and the router. Do not hardcode it anywhere else.

## Two targets, one `src/`

`src/config/target.ts` is the only module that knows a mobile build exists.
Everything else asks for a capability (`BASE_PATH`, `isNative`) and never for the
platform.

| | web | native |
|---|---|---|
| Build | `npm run build` | `npm run build:native` |
| `VITE_TARGET` | unset (or `web`) | `native` |
| Output | `dist/` | `dist-native/` |
| Base path | `/einbuergerungstest/` | `/` |
| Service worker | registered | not registered |

The native base is `/` because a Capacitor WebView serves the bundle as its own
document root (`capacitor://localhost/` on iOS, `https://localhost/` on Android).
Shipping the web build into an app unchanged would 404 every image and match no
route — a blank screen, found after store review rather than in CI.

An unrecognised `VITE_TARGET` fails the build instead of falling back, because a
typo would otherwise produce a web build that copies into the native project
without complaint.

The native shell, what the WebView changes, and what is still outstanding before
a store submission: see [MOBILE.md](MOBILE.md).

Firebase remains an unresolved placeholder and still needs the user.
Before Google sign-in works in production, `https://kailashbuki.github.io`
must be added to Firebase Authentication -> Settings -> Authorized domains.
