// Getting a Google credential, on whichever shell this build runs in.
//
// The web uses `signInWithPopup`. A Capacitor WebView cannot: the popup opens a
// window the native shell never returns from, so the promise hangs forever and
// the user is left looking at a spinner with no way back. The native path asks
// the platform's own Google SDK for an ID token instead and hands that to the
// same `firebase/auth` instance via `signInWithCredential`.
//
// Both paths therefore end with a session on the JS SDK, which is the only
// session the rest of `src/lib/sync` knows about. That is also why
// `capacitor.config.ts` sets `skipNativeAuth: true` — without it the native SDK
// would hold a second, independent session, and "who is signed in" would have
// two answers that can disagree.
//
// Neither branch is imported statically: the Capacitor plugin stays out of the
// web bundle's entry chunk, and `firebase/auth` stays lazy as it is everywhere
// else in this file's callers.

import { isNative } from '@/config/paths';

import type { Auth, User, UserCredential } from 'firebase/auth';

/**
 * The code the web SDK uses when a user dismisses the sign-in UI. The native
 * branch re-labels its own cancellations with this so callers keep one test for
 * "the user changed their mind" rather than one per platform — in particular
 * `isCancelledSignIn` in `./firestore.ts`, which must stay quiet on a
 * cancellation and must not stay quiet on a real failure.
 */
export const CANCELLED_CODE = 'auth/user-cancelled';

/** Shape of the plugin result we depend on, declared locally so this module's
 * tests do not need the native plugin installed. */
type NativeSignInResult = { credential?: { idToken?: string | null } | null };

/**
 * Pull the ID token out of a native sign-in result.
 *
 * The plugin resolves successfully with no `idToken` when the platform project
 * is misconfigured — on iOS, most often a missing or wrong `CLIENT_ID` in
 * `GoogleService-Info.plist`, or a URL scheme that was never added. Passing
 * `undefined` on to `GoogleAuthProvider.credential` would fail much later with
 * an opaque argument error, so it is caught here with the cause named.
 */
export function idTokenFrom(result: NativeSignInResult): string {
  const idToken = result.credential?.idToken;
  if (typeof idToken !== 'string' || idToken === '') {
    throw new Error(
      'Google sign-in returned no ID token. Check that the native project has a ' +
        'GoogleService-Info.plist (iOS) / google-services.json (Android) with a ' +
        'client ID, and that the reversed-client-ID URL scheme is registered.',
    );
  }
  return idToken;
}

/**
 * Re-label a native cancellation so it looks like a dismissed popup.
 *
 * The native SDKs do not use Firebase's `auth/*` codes: iOS raises an error
 * whose message says the flow was cancelled, Android raises status code `12501`.
 * Left alone, both would be reported to the user as "sign-in failed" — an error
 * banner for an action they deliberately abandoned.
 *
 * Anything that does not look like a cancellation is returned untouched, so a
 * genuine failure keeps its own code and message.
 */
export function asCancellation(error: unknown): unknown {
  if (!looksCancelled(error)) return error;
  return Object.assign(new Error('sign-in was cancelled'), {
    code: CANCELLED_CODE,
    cause: error,
  });
}

function looksCancelled(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = 'code' in error ? error.code : undefined;
  // Android's GoogleSignInStatusCodes.SIGN_IN_CANCELLED, as a number or a string.
  if (code === 12501 || code === '12501') return true;
  const message: unknown = 'message' in error ? error.message : undefined;
  // iOS: "The user canceled the sign-in flow." Also covers the British spelling
  // and the plugin's own "canceled" wording.
  return typeof message === 'string' && /cancel/i.test(message);
}

async function nativeIdToken(): Promise<string> {
  const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
  try {
    return idTokenFrom(await FirebaseAuthentication.signInWithGoogle());
  } catch (error) {
    throw asCancellation(error);
  }
}

/**
 * Sign in with Google, by whichever route this build has available.
 *
 * Rejects with a `CANCELLED_CODE` error if the user backs out, and with the
 * underlying error otherwise.
 */
export async function signInWithGoogle(auth: Auth): Promise<UserCredential> {
  const { GoogleAuthProvider, signInWithCredential, signInWithPopup } = await import(
    'firebase/auth'
  );
  if (!isNative) return signInWithPopup(auth, new GoogleAuthProvider());
  return signInWithCredential(auth, GoogleAuthProvider.credential(await nativeIdToken()));
}

/**
 * Prove again that the signed-in user is present, for operations Firebase
 * refuses on a session restored from an earlier visit — account deletion being
 * the one that matters here.
 *
 * On native this runs the Google flow a second time purely to obtain a fresh
 * token; with `skipNativeAuth` set it does not disturb the existing session.
 */
export async function reauthenticateWithGoogle(user: User): Promise<void> {
  const { GoogleAuthProvider, reauthenticateWithCredential, reauthenticateWithPopup } =
    await import('firebase/auth');
  if (!isNative) {
    await reauthenticateWithPopup(user, new GoogleAuthProvider());
    return;
  }
  await reauthenticateWithCredential(
    user,
    GoogleAuthProvider.credential(await nativeIdToken()),
  );
}
