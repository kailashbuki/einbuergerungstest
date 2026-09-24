// Firebase config — PLACEHOLDER until the user supplies their own project.
//
// Firebase *web* config values (apiKey, projectId, etc.) are not secrets —
// they identify a public client the same way a store's street address does;
// Firebase's actual security boundary is Firestore/Auth rules, enforced
// server-side. That's why this file is committed rather than kept in `.env`
// (see the comment in `.gitignore`). It is still a placeholder because the
// real project id/keys are unknown to this workstream.
//
// This module MUST be safe to import from anywhere (in particular from
// src/lib/sync/*, owned by another workstream) without ever crashing the UI
// or blocking on network/config. It is also never imported eagerly from the
// app shell (src/main.tsx / src/App.tsx) — firebase/app + firebase/auth +
// firebase/firestore together are roughly 200KB, and that cost should only
// be paid by users who actually sign in.

import type { SyncAccount, SyncStatus } from '@/types';
// Type-only imports are erased at compile time — they do NOT pull firebase
// into the app shell's bundle. Only the `import()` calls inside
// `getFirebase()` do that, and only when it actually runs.
import type { FirebaseApp } from 'firebase/app';
import type { Auth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';

/** Sentinel written into every placeholder field so `isFirebaseConfigured` can tell a real value from an unfilled one, even for fields where an empty string might otherwise look "unset". */
const PLACEHOLDER = 'TODO(user)';

export interface FirebaseWebConfig {
  readonly apiKey: string;
  readonly authDomain: string;
  readonly projectId: string;
  readonly storageBucket: string;
  readonly messagingSenderId: string;
  readonly appId: string;
}

/**
 * Web config for the `einbuergerungstest-2225f` Firebase project (Firebase
 * console → Project settings → General → Your apps → SDK setup and
 * configuration → Config). Now that these are real, `isFirebaseConfigured()`
 * returns `true` and Google sign-in is available; with placeholders the app
 * runs fully offline on the `noop` sync adapter and nothing here is fetched.
 *
 * To point a fork at a different project, replace all six values. Sync is
 * gated on every field being non-placeholder, so a partial edit disables it
 * rather than half-enabling it.
 */
export const firebaseConfig: FirebaseWebConfig = {
  apiKey: 'AIzaSyDvaLWQ-ZZjFN_FrUy1bUpeLqKvlP4pmgc',
  authDomain: 'einbuergerungstest-2225f.firebaseapp.com',
  projectId: 'einbuergerungstest-2225f',
  storageBucket: 'einbuergerungstest-2225f.firebasestorage.app',
  messagingSenderId: '31173590168',
  appId: '1:31173590168:web:38bfbcc6bd25b6c43de4ed',
};

/** True only when every config field has been replaced with a real value. */
export function isFirebaseConfigured(): boolean {
  return Object.values(firebaseConfig).every((value) => value !== PLACEHOLDER && value.trim() !== '');
}

export interface FirebaseHandle {
  readonly app: FirebaseApp;
  readonly auth: Auth;
  readonly firestore: Firestore;
}

let cached: FirebaseHandle | null = null;
let initPromise: Promise<FirebaseHandle | null> | null = null;

/**
 * Lazily dynamic-imports and initialises Firebase exactly once. Resolves to
 * `null` — never throws, never hangs — when the config is still a
 * placeholder, so callers (the sync adapter) can fall back to `noop`
 * without any special-casing:
 *
 * ```ts
 * const fb = await getFirebase();
 * if (!fb) return noopAdapter;
 * ```
 */
export async function getFirebase(): Promise<FirebaseHandle | null> {
  if (!isFirebaseConfigured()) return null;
  if (cached) return cached;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const [{ initializeApp }, { getAuth }, { getFirestore }] = await Promise.all([
        import('firebase/app'),
        import('firebase/auth'),
        import('firebase/firestore'),
      ]);
      const app = initializeApp(firebaseConfig);
      const handle: FirebaseHandle = { app, auth: getAuth(app), firestore: getFirestore(app) };
      cached = handle;
      return handle;
    } catch (err) {
      console.error('[firebase] initialisation failed; falling back to offline-only mode', err);
      return null;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

/** Convenience re-exports so callers building a `SyncAdapter` don't need to know sync-status/account shapes live in `@/types`. */
export type { SyncAccount, SyncStatus };
