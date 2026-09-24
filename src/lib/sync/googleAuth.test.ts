// The two translation steps between the native Google SDK and `firebase/auth`.
//
// `signInWithGoogle` and `reauthenticateWithGoogle` themselves are a branch plus
// two SDK calls, and neither SDK exists under Vitest — so what is tested here is
// the part that carries the logic: turning a plugin result into a token, and
// deciding whether a native error means "the user changed their mind".
//
// Both matter because getting them wrong is invisible on the web, where this code
// never runs, and only shows up on a device.

import { describe, expect, it } from 'vitest';

import { asCancellation, CANCELLED_CODE, idTokenFrom } from './googleAuth';

describe('idTokenFrom', () => {
  it('returns the token from a successful sign-in', () => {
    expect(idTokenFrom({ credential: { idToken: 'header.payload.signature' } })).toBe(
      'header.payload.signature',
    );
  });

  // The plugin resolves *successfully* with no token when the native project is
  // misconfigured. Passing that on would fail later inside
  // `GoogleAuthProvider.credential` with nothing pointing at the real cause.
  it('throws with the likely cause when the plugin returns no token', () => {
    for (const result of [
      {},
      { credential: null },
      { credential: {} },
      { credential: { idToken: null } },
      { credential: { idToken: '' } },
    ]) {
      expect(() => idTokenFrom(result)).toThrow(/no ID token/i);
    }
    // The message has to name the file the user must fix, or it is just a restatement.
    expect(() => idTokenFrom({})).toThrow(/GoogleService-Info\.plist/);
  });
});

describe('asCancellation', () => {
  it('re-labels an iOS cancellation with the web SDK code', () => {
    const native = new Error('The user canceled the sign-in flow.');
    const translated = asCancellation(native);

    // The whole point: `isCancelledSignIn` in ./firestore.ts tests `.code`, so a
    // native cancellation has to arrive wearing that code or the user gets an
    // error banner for deliberately backing out.
    expect(translated).toHaveProperty('code', CANCELLED_CODE);
    expect(CANCELLED_CODE).toBe('auth/user-cancelled');
    // The original is kept, so a console warning still shows what really happened.
    expect(translated).toHaveProperty('cause', native);
  });

  it('re-labels Android status code 12501, as a number or a string', () => {
    expect(asCancellation(Object.assign(new Error('failed'), { code: 12501 }))).toHaveProperty(
      'code',
      CANCELLED_CODE,
    );
    expect(asCancellation(Object.assign(new Error('failed'), { code: '12501' }))).toHaveProperty(
      'code',
      CANCELLED_CODE,
    );
  });

  // The other half of the contract, and the one a sloppy `catch` would break: a
  // real failure must keep its identity, or every misconfiguration is silently
  // reported as a cancellation and the user is told nothing at all.
  it('passes a genuine failure through untouched', () => {
    const network = Object.assign(new Error('The network connection was lost.'), {
      code: 'auth/network-request-failed',
    });
    expect(asCancellation(network)).toBe(network);

    const misconfigured = new Error('no ID token');
    expect(asCancellation(misconfigured)).toBe(misconfigured);

    // Adjacent status codes are not cancellations (12500 is "sign-in failed").
    const other = Object.assign(new Error('failed'), { code: 12500 });
    expect(asCancellation(other)).toBe(other);
  });

  it('does not crash on values that are not errors', () => {
    expect(asCancellation(undefined)).toBeUndefined();
    expect(asCancellation(null)).toBeNull();
    expect(asCancellation('cancelled')).toBe('cancelled');
  });
});
