// The app's view of where it is mounted. One constant, derived from the build
// target rather than hardcoded, so the same `src/` serves GitHub Pages and a
// native WebView.
//
// `vite.config.ts` deliberately does NOT import from this file: it runs in Node,
// where `import.meta.env` does not exist. It resolves the target from
// `process.env.VITE_TARGET` and calls the same pure helpers in `./target`.

import { basePathFor, joinBase, resolveTarget, type BuildTarget } from './target';

/**
 * Resolved at build time — Vite replaces `import.meta.env.VITE_TARGET` with a
 * literal, so this is a constant in the shipped bundle rather than a lookup.
 * Undefined under Vitest and `npm run dev`, which both mean `'web'`.
 */
export const TARGET: BuildTarget = resolveTarget(import.meta.env.VITE_TARGET);

/**
 * Vite's `base`, the router's `basename`, and the prefix on every asset URL.
 *
 * `/einbuergerungstest/` for the website (GitHub Pages project sites live under
 * the repo name), `/` inside an app shell. See `./target` for both values and why
 * getting this wrong shows up as a blank screen rather than a broken link.
 */
export const BASE_PATH = basePathFor(TARGET);

/**
 * Running inside a native shell rather than a browser tab.
 *
 * Read this instead of sniffing the user agent or probing for Capacitor globals:
 * the target is fixed when the bundle is built, so this answer cannot change at
 * runtime and cannot be wrong about which shell it is in.
 *
 * It is evaluated once at module load, not inlined as a literal, so the branches
 * it guards still exist in both bundles — this is a correctness switch, not a
 * size optimisation.
 */
export const isNative = TARGET === 'native';

/**
 * Prefixes a build-relative asset path (as stored in the question data, e.g.
 * `"img/f085.jpg"`) so it resolves under whichever base this build uses.
 */
export function asset(path: string): string {
  return joinBase(BASE_PATH, path);
}
