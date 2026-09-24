// Guards one non-obvious rule about `vite.config.ts` that has already been
// broken once, in a way nothing else in the suite can see.
//
// Workbox does not *call* the `urlPattern` functions in `runtimeCaching` at build
// time — it serialises their **source text** into `dist/sw.js`. The service
// worker is a separate module scope, so any build-time constant a matcher closes
// over simply does not exist there. `new RegExp(\`/${FIREBASE_CHUNK}-...\`)`
// therefore shipped a matcher that threw `ReferenceError: FIREBASE_CHUNK is not
// defined` on every request that reached it, silently disabling the route. The
// build succeeded, `npm test` passed, and the only symptom was in production.
//
// So: every matcher must be self-contained. This reads the config as text rather
// than importing it, because the defect is in the source *text* that gets copied
// into the worker — evaluating the function here would not reproduce it.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// `process.cwd()`, not `import.meta.url`: these tests run in the jsdom
// environment, where `import.meta.url` is an `http://` URL that `readFileSync`
// rejects. Vitest always runs with the project root as the cwd.
const CONFIG = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');

/** The body of every `urlPattern:` entry, up to the line that follows it. */
function urlPatterns(): string[] {
  return CONFIG.split('\n')
    .filter((line) => line.includes('urlPattern:'))
    .map((line) => line.trim());
}

describe('the service worker runtime-caching matchers', () => {
  it('has one matcher per runtime rule', () => {
    // Question images, the Firebase SDK, the lazy i18n chunks.
    expect(urlPatterns()).toHaveLength(3);
  });

  it('closes over nothing: no matcher interpolates a build-time constant', () => {
    for (const pattern of urlPatterns()) {
      // `${...}` is the tell — it can only be resolved in this module's scope,
      // never in the worker's.
      expect(pattern, `matcher must not interpolate: ${pattern}`).not.toContain('${');
      expect(pattern, `matcher must not build a RegExp from a variable: ${pattern}`).not.toContain(
        'new RegExp(',
      );
    }
  });

  it('keeps the Firebase SDK matcher in step with the chunk name it targets', () => {
    // The chunk name appears in three places that must agree: `manualChunks`
    // names the chunk, `globIgnores` keeps it out of the precache manifest, and
    // the matcher gives it a runtime cache instead. The literal below is the one
    // the matcher hard-codes, so if someone renames the chunk without updating
    // the matcher, this fails.
    expect(CONFIG).toContain("const FIREBASE_CHUNK = 'firebase-sdk'");
    expect(CONFIG).toContain('/\\/firebase-sdk-[\\w-]+\\.js$/.test(url.pathname)');

    // And the name must be specific enough not to swallow `src/lib/firebase.ts`,
    // which emits `firebase-<hash>.js` and IS part of the statically-imported app
    // shell, so it belongs in the precache manifest.
    const sdkChunk = /\/firebase-sdk-[\w-]+\.js$/;
    expect(sdkChunk.test('/assets/firebase-sdk-lJyrj1sS.js')).toBe(true);
    expect(sdkChunk.test('/assets/firebase-ClGnYQi8.js')).toBe(false);
  });
});
