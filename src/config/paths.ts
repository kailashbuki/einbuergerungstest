// Deploy-target configuration — THE single source of truth for the app's base path.
//
// This is the ONLY place `BASE_PATH` is defined. It MUST match the GitHub repo
// name exactly, because GitHub Pages serves a project site at
// `https://<user>.github.io/<repo>/`. If the repo is ever renamed, this is the
// only line that needs to change — `vite.config.ts` (the `base` option) and
// the router (`basename`) both import it from here rather than hardcoding the
// string a second time.
//
// Confirmed live target: https://kailashbuki.github.io/einbuergerungstest/
// (repo: kailashbuki/einbuergerungstest).
export const BASE_PATH = '/einbuergerungstest/';

/**
 * Prefixes a repo-relative asset path (as stored in data, e.g. `"img/f085.jpg"`)
 * with `BASE_PATH` so it resolves correctly both in local dev (base `/`) and
 * once deployed under a GitHub Pages subpath.
 */
export function asset(path: string): string {
  const clean = path.startsWith('/') ? path.slice(1) : path;
  return `${BASE_PATH}${clean}`;
}
