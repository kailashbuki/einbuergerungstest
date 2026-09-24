// The base path is the one piece of configuration that is wrong *silently*.
//
// Get it wrong on the web and every asset 404s under the GitHub Pages subpath.
// Get it wrong in a native build and the WebView opens on a route that does not
// exist — a blank screen, discovered after store review rather than in CI. Both
// failures look like nothing at build time, so the mapping is asserted here.

import { describe, expect, it } from 'vitest';

import {
  basePathFor,
  DEFAULT_TARGET,
  joinBase,
  NATIVE_BASE_PATH,
  resolveTarget,
  WEB_BASE_PATH,
} from './target';

describe('resolveTarget', () => {
  it('defaults to the website when nothing is set', () => {
    // This is the case Vitest and `npm run dev` hit, and the case `npm run build`
    // hits in CI — so the default has to be the deployed target, not the new one.
    expect(resolveTarget(undefined)).toBe('web');
    expect(resolveTarget('')).toBe('web');
    expect(DEFAULT_TARGET).toBe('web');
  });

  it('accepts both targets by name', () => {
    expect(resolveTarget('web')).toBe('web');
    expect(resolveTarget('native')).toBe('native');
  });

  // The important one. A fallback here would turn `VITE_TARGET=nativ` into a web
  // build that copies into the native project without complaint and fails only
  // on launch.
  it('throws on a value it does not recognise rather than guessing', () => {
    expect(() => resolveTarget('nativ')).toThrow(/VITE_TARGET/);
    expect(() => resolveTarget('ios')).toThrow(/native/);
    expect(() => resolveTarget('WEB')).toThrow();
  });
});

describe('basePathFor', () => {
  it('mounts the web build under the repo name', () => {
    // Must match the GitHub repo exactly or Pages serves 404s for everything.
    expect(basePathFor('web')).toBe('/einbuergerungstest/');
  });

  it('mounts the native build at the WebView root', () => {
    expect(basePathFor('native')).toBe('/');
  });

  // Guards the property rather than the two strings: a refactor that collapsed
  // these into one value would pass both assertions above if it picked either.
  it('gives the two targets genuinely different bases', () => {
    expect(basePathFor('web')).not.toBe(basePathFor('native'));
  });

  it('keeps both bases absolute and directory-shaped', () => {
    // A missing trailing slash silently concatenates: `/einbuergerungstestimg/…`.
    for (const base of [WEB_BASE_PATH, NATIVE_BASE_PATH]) {
      expect(base.startsWith('/')).toBe(true);
      expect(base.endsWith('/')).toBe(true);
    }
  });
});

describe('joinBase', () => {
  it('prefixes a data-relative image path for each target', () => {
    // `"img/f085.jpg"` is the exact shape stored in questions.json.
    expect(joinBase(WEB_BASE_PATH, 'img/f085.jpg')).toBe('/einbuergerungstest/img/f085.jpg');
    expect(joinBase(NATIVE_BASE_PATH, 'img/f085.jpg')).toBe('/img/f085.jpg');
  });

  it('does not double the slash when the path already has one', () => {
    expect(joinBase(WEB_BASE_PATH, '/img/f085.jpg')).toBe('/einbuergerungstest/img/f085.jpg');
    expect(joinBase(NATIVE_BASE_PATH, '/img/f085.jpg')).toBe('/img/f085.jpg');
  });
});
