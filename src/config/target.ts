// Which shell this bundle is built for. **This is the only module in `src/` that
// knows a mobile build exists.**
//
// The rule that lets one codebase serve a website and two app stores: every
// other file asks for a *capability* — `BASE_PATH`, `isNative` — and never for
// the platform. Branching on the platform spreads; branching on a capability
// stays in one place. When a third target appears, it is added here and nowhere
// else.
//
// Nothing in this file reads the environment, on purpose. `vite.config.ts` runs
// in Node, where `import.meta.env` does not exist; the app runs in a browser,
// where `process` does not. Each side passes in what it can see and calls the
// same pure functions, so the mapping from env value to base path is defined
// once and is directly testable — rather than being two `??` chains that agree
// until someone edits one of them.

export type BuildTarget = 'web' | 'native';

/**
 * GitHub Pages serves a *project* site under the repo name, so the web build is
 * mounted on a subpath that every asset URL and every router route must carry.
 *
 * MUST match the GitHub repo name exactly. Confirmed live target:
 * `https://kailashbuki.github.io/einbuergerungstest/`.
 */
export const WEB_BASE_PATH = '/einbuergerungstest/';

/**
 * A Capacitor WebView serves the bundled build as its own document root
 * (`capacitor://localhost/` on iOS, `https://localhost/` on Android), so there
 * is no subpath to carry.
 *
 * Shipping the web build into an app unchanged is not a cosmetic mistake: every
 * image would resolve to `/einbuergerungstest/img/…`, which does not exist in
 * the bundle, and the router would find no route matching `/`. A blank screen on
 * first launch, after review.
 */
export const NATIVE_BASE_PATH = '/';

/** Absent `VITE_TARGET` means the website, which is what `npm run build` builds. */
export const DEFAULT_TARGET: BuildTarget = 'web';

/**
 * Turn a raw `VITE_TARGET` value into a target.
 *
 * Unset falls back to `web`, which is what tests and `npm run dev` get. An
 * unrecognised value **throws** rather than falling back, because the failure it
 * prevents is silent and expensive: `VITE_TARGET=nativ` would otherwise produce
 * a *web* build, which copies into the native project without complaint and
 * fails only when someone launches the app. Better to break the build.
 */
export function resolveTarget(raw: string | undefined): BuildTarget {
  if (raw === undefined || raw === '') return DEFAULT_TARGET;
  if (raw === 'web' || raw === 'native') return raw;
  throw new Error(
    `VITE_TARGET must be 'web' or 'native' (or unset, meaning '${DEFAULT_TARGET}'); got '${raw}'`,
  );
}

export function basePathFor(target: BuildTarget): string {
  return target === 'native' ? NATIVE_BASE_PATH : WEB_BASE_PATH;
}

/**
 * Prefix a build-relative asset path (as stored in the question data, e.g.
 * `"img/f085.jpg"`) with a base path.
 *
 * Pure and base-agnostic so both targets can be asserted in one test; the app
 * reaches it through {@link module:config/paths.asset}, which supplies the base.
 */
export function joinBase(base: string, path: string): string {
  const clean = path.startsWith('/') ? path.slice(1) : path;
  return `${base}${clean}`;
}
