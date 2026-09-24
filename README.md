# Einbürgerungstest

A mobile-first, offline-first study app for the German naturalization test
(Einbürgerungstest). Static PWA — no backend required.

**Live:** https://kailashbuki.github.io/einbuergerungstest/

- All **16 Bundesländer**. The active deck is always **310 questions**: the 300
  federal questions plus the 10 for your selected state.
- **Recall-first** study: you commit to an answer before the options can help
  you, with a three-step hint escalation instead of an instant reveal.
- **Local-first.** IndexedDB is the single source of truth. Everything works
  with no account, no network and no cloud. Sync is strictly an optional
  upgrade (see [Firebase sync](#firebase-sync-optional)).
- **8 interface languages** and **7 question-translation languages**, chosen
  independently — you can read the interface in English while the questions are
  translated into Arabic.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173/einbuergerungstest/
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc -b` then production build into `dist/` |
| `npm run preview` | Serve the built `dist/` locally |
| `npm test` | Full Vitest suite (single run) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint:i18n` | Key parity, empty values, placeholder parity across all locale and translation files |
| `npm run build:questions` | Regenerate `src/data/questions.json` and mirror question images from upstream |
| `npm run build:questions:offline` | Same, from the local cache, with no network access |

Note the base path in the dev URL: the app is served from a sub-path, so
`http://localhost:5173/` alone will 404. See below.

### The translation bundles are a one-time seed, not a build output

`src/data/i18n/questions.<lang>.json` are the only files in this repo that the
generator will **not** rewrite. They were machine-seeded once and then
hand-repaired — several thousand lines of corrections for split sentences,
mistranslated legal terms and inverted negations, none of which the generator
knows how to reproduce. Regenerating them silently reverts all of that.

So `npm run build:questions` **skips** any translation bundle that already exists
and says so. Everything else (`questions.json`, images, the verification report)
is still fully reproducible on every run. To seed a genuinely new language, or to
knowingly discard the repairs:

```bash
npx tsx scripts/build-questions.ts --seed-translations
```

Only pass that flag if you intend to overwrite hand-edited text.

## The base path lives in exactly one place

`src/config/paths.ts`:

```ts
export const BASE_PATH = '/einbuergerungstest/';
```

That single exported constant is imported by **`vite.config.ts`** (as Vite's
`base`, and as the PWA manifest's `id` / `start_url` / `scope`) and by
**`src/App.tsx`** (as the router's `basename`). `asset(path)` in the same module
is the only correct way to build a URL for anything under `public/`.

If you fork this to a differently-named repository or to a custom domain,
change that one constant and nothing else. Do not hardcode the path anywhere.
For a custom domain or a `user.github.io` root repo, set it to `'/'`.

## Architecture

```
src/
  config/paths.ts      BASE_PATH + asset() — the one source of truth for URLs
  data/                Generated dataset: questions.json (460), states.ts (16),
                       curriculum.json, i18n/questions.<lang>.json (7 files)
  i18n/                UI strings ui.<lang>.json (8 files), locale metadata,
                       per-block direction helpers, useT()
  lib/                 Pure engine: scheduler (SM-2-lite), mastery buckets,
                       readiness, deck derivation, mock exam, progress model
  lib/db/              IndexedDB: versioned schema + named migrations, outbox,
                       snapshots, export/import
  lib/sync/            SyncAdapter interface, `noop` and `firestore` adapters,
                       merge.ts (merge-not-overwrite)
  store/               Zustand store — the ONLY write path from UI to storage
  components/          Shared UI
  routes/              Screens (all lazy-loaded)
scripts/               build-questions.ts, verify-questions.ts, lint-i18n.ts
```

Three rules the codebase enforces, each documented at the top of the relevant
module:

1. **No component touches `src/lib/db/*` directly.** Every mutation goes through
   a store action, which writes to IndexedDB, enqueues an outbox mutation for
   sync, and updates the in-memory snapshot — in one place, so disk, memory and
   the sync queue cannot drift apart.
2. **IndexedDB is the source of truth**; the store is a cache of it.
3. **Progress is keyed by question id and is never scoped by the active state.**
   That is precisely why switching Bundesland is lossless: federal progress is
   shared by definition, and the previous state's rows simply stop being in the
   active deck without being touched. Switching Baden-Württemberg → Bayern →
   Baden-Württemberg restores the original progress intact; there is a test for
   exactly that in `src/store/index.test.ts`.

### Localization

Two independent settings: the **interface locale** (8: de, en, tr, ru, fr, ar,
uk, hi) and the **translation locale** (7: the same minus German, plus an
explicit *off — German only*). German is the source language and is never a
translation target.

`dir` is applied **per block, not per document**. `applyDocumentDir()` sets
`<html dir>` from the *interface* locale only; a translation block carries its
own `dir`, `lang` and font class. An English (LTR) interface showing an Arabic
(RTL) translation is the case that breaks naive implementations, and it is
covered by a test. All mirroring uses logical CSS properties
(`margin-inline-start`, `text-start`, …) — never `left`/`right`.

Non-Latin fonts are **self-hosted subsets** in `public/fonts/` (Noto Naskh
Arabic, Noto Sans Devanagari). There is deliberately **no Google Fonts CDN**:
an offline-first app must render Arabic and Devanagari with no network.

The 7 question-translation bundles and the 7 non-English UI bundles are
**lazy-loaded** — one dynamic `import()` per language — and are explicitly
excluded from the service worker's precache manifest, then runtime-cached
`CacheFirst` the first time they are used. Nobody downloads 14 language bundles
to study in one language. See `LAZY_I18N_GLOB_IGNORES` in `vite.config.ts`.

### What the service worker precaches — and what it deliberately does not

A first visit downloads roughly **1.25 MB across 34 precached entries**: the app
shell, the full 460-question German dataset, the English UI strings, the icons and
the two self-hosted webfonts. That is everything needed to open the app cold and
study the 417 text-only questions with no network at all.

Three groups are deliberately **kept out of the precache manifest** and fetched on
demand instead, each with its own `CacheFirst` runtime rule so that whatever a user
actually reaches still works offline afterwards. See `DEFERRED_GLOB_IGNORES` in
`vite.config.ts`.

| Deferred | Size | Why |
|---|---|---|
| 42 question images | ~4.6 MB | They serve 43 of 460 questions. Precaching them made a first visit 6.5 MB. |
| Firebase SDK | ~715 KB | Sync is optional and ships switched off. Nobody should pay for a feature they never enable. |
| 14 lazy i18n bundles | ~1.5 MB | One or two languages get used, not all 14. |

**The honest tradeoff:** a picture question reached for the very first time while
offline shows no image. Once seen on any connection it is cached for a year. This
was chosen over the alternative — a 6.5 MB unprompted download on mobile data,
before the user has answered a single question. The Firebase SDK is additionally
forced into one predictably-named chunk (`manualChunks`) purely so the service
worker has something globbable to exclude.

## Firebase sync (optional)

**The app is fully functional with sync unconfigured.** With placeholder config
it silently uses the `noop` adapter: no network calls, no errors, no blocked UI,
nothing in the interface that nags you to sign in. Sync only ever adds
cross-device continuity on top of a complete local app.

`src/lib/firebase.ts` ships with every config field set to the sentinel
`'TODO(user)'`. To enable sync:

1. Go to https://console.firebase.google.com/ and **Add project** (Google
   Analytics is not needed).
2. In the project, click the **web** icon (`</>`) under *Get started by adding
   Firebase to your app*, register an app (any nickname), and **skip** the
   "Add Firebase SDK" step — the SDK is already a dependency here.
3. Copy the config object shown under **Project settings → General → Your apps
   → SDK setup and configuration → Config**.
4. Paste those six values over the placeholders in `src/lib/firebase.ts`:
   `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`,
   `appId`. `isFirebaseConfigured()` flips to `true` once all six are real.
5. **Authentication → Get started → Sign-in method → Google → Enable.**
6. **Authentication → Settings → Authorized domains → Add domain.** Add
   `https://kailashbuki.github.io`. **Google sign-in will not work in
   production until you do this** — `localhost` is authorized by default, so it
   is easy to miss this and only discover it after deploying.
7. **Firestore Database → Create database.** Pick a region near you. Start in
   *production mode* (locked), then publish the rules from `firestore.rules` in
   this repo — either paste them into **Firestore → Rules** or deploy with the
   Firebase CLI. The rules restrict every document to its own signed-in owner.

### Are those keys secret?

No. Firebase **web** config values are client identifiers, not credentials —
they are visible to anyone who opens the app in a browser, by design. The actual
security boundary is the Firestore/Auth rules, enforced server-side. That is why
this file is committed rather than kept in `.env`. Do not put anything that *is*
a secret (a service-account JSON, an admin key, an API secret) in this
repository.

### Sync semantics

Merge, never overwrite. Two devices that have both been used offline must both
keep everything: counters take the maximum, per-question fields resolve
last-write-wins by `updatedAt` with deliberately conservative tie-breaks,
collections union by id, badges keep the **earliest** earn time, and settings are
taken wholesale from whichever side has the later `settings.updatedAt`. The
merge is commutative and idempotent, with property tests asserting both. See
`src/lib/sync/merge.ts` and its tests, which include two-device divergence cases
proving no progress is ever lost.

## Testing

```bash
npm test
```

Unit tests are mandatory for the scheduler, mastery buckets, readiness scoring,
the IndexedDB migrations, and the merge logic. A few things worth knowing before
you add tests:

- **jsdom has no IndexedDB.** Any test file that touches the store or the
  database must have `import 'fake-indexeddb/auto';` as its **first** import,
  before anything that might open a database. `src/store/index.test.ts` shows
  the canonical `freshStore()` reset pattern (close, delete, reset the Zustand
  singleton, rehydrate) — copy it rather than inventing another one.
- Prove persistence, not memory. Where a test claims something was saved, it
  drops the in-memory copy and calls `reloadFromDb()`.

## Data provenance and known gaps

Be honest with yourself about what this dataset is before you trust it for a
real exam.

`src/data/questions.json` holds 460 records: `F001`–`F300` (federal) and
`BW01`–`BW10` … for each of the 16 states. It is **generated** by
`scripts/build-questions.ts` — do not hand-edit it. Corrections belong in that
script's `PATCHES` table, which is guarded by a content fingerprint so a patch
can never silently mis-apply if upstream text shifts.

`scripts/verify-questions.ts` checks the dataset against the official BAMF
catalogue; its output is `src/data/verification-report.json`. What it found:

- **Question and option text is verified against the official catalogue.**
- **The official catalogue contains no answer key.** All 1800 of its checkboxes
  are the same empty glyph. Correct answers are therefore verified against a
  three-source consensus matched onto the official option *text* — 460/460 got a
  consensus, 458 unanimous. Confidence in the text is high; confidence in the
  answers is medium-high, not certain.
- **Our `number` field is a dataset index, not the official *Aufgabe* number.**
  The federal ordering is a full permutation of the catalogue's. No screen
  claims "question 42 of the official catalogue", and none should.
- **36 picture questions are unverifiable.** Their answer is a panel number
  ("Bild 1"), so they are only correct if the bundled images sit in the same
  order as the catalogue's. `BB01` is the one place two answer sources actively
  disagree and is the most likely image-ordering error.
- **`F072` (the current Bundeskanzler) is time-sensitive** by nature and will
  need revisiting after a federal election.
- Three places keep **our** wording over the catalogue's on purpose:
  `F179.a` (the catalogue itself misspells *Niedersachsen*), and `BB07.c` /
  `HE07.a`, where the catalogue prints a bare "Brandenburg." / "Frankfurt." that
  is ambiguous with the state of the same name and with Frankfurt (Oder).

Other known gaps:

- **No per-state coat of arms.** `src/data/states.ts` has a `wappen` field, but
  it points at the exam's *composite* illustration for that state's "which coat
  of arms belongs to …" question — a 4-up grid of four different states' arms.
  Rendering it per state would show four wrong emblems, so `StatePicker` shows
  the ISO code instead. Fixing this needs 16 properly licensed single-emblem
  assets, which are not in the dataset.
- The 261 gender-doublet word-order differences between our text and the 2025
  catalogue (we are masculine-first, it is feminine-first) are a deliberate
  non-fix: cosmetic, and a bulk rewrite of German text is far likelier to
  introduce a defect than to fix one.

## Deployment

Pushing to `main` triggers `.github/workflows/deploy.yml`, which runs the tests
and the i18n lint, builds, copies `index.html` to `404.html` (GitHub Pages has
no SPA rewrite rule, so deep links need this on a first visit, before the
service worker exists), and publishes to Pages.

Pages must be set to the **GitHub Actions** source once:

```bash
gh api -X POST repos/kailashbuki/einbuergerungstest/pages -f build_type=workflow
```

The repository must be **public** for Pages on a free account.
