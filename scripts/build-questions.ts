/**
 * build-questions.ts — BLOCKING data pipeline for the Einbürgerungstest study app.
 *
 * Reads the upstream `leben-in-deutschland-scrapper` catalogue (460 records) and emits the
 * full national data set: 300 federal questions plus 10 questions for each of the 16
 * Bundesländer (160), i.e. 460 records. The *active deck* for a given user is 310 (the 300
 * federal plus their chosen state's 10); that selection happens at runtime, not here.
 *
 * Also normalises the text, mirrors every referenced image locally, seeds the 7 translation
 * bundles plus a suspected-untranslated report, and hard-asserts a long list of invariants.
 *
 * This is a build tool, not shipped code.
 *
 *   npm run build:questions            # uses /tmp cache when present, else fetches
 *   npm run build:questions:offline    # refuses to touch the network
 *
 * Determinism: same input bytes -> byte-identical output. Object maps are emitted with
 * sorted keys, arrays in a documented stable order, 2-space indent, trailing newline.
 *
 * ONE EXCEPTION to that reproducibility, and it matters: the translation bundles in
 * `src/data/i18n/` are SEEDED here, not owned here. Upstream's machine translations had
 * defects severe enough to change which answer reads as correct, and those were repaired
 * by hand in the emitted files. Re-running this script therefore does not "rebuild" them,
 * it reverts them. Existing bundles are left alone unless you pass --seed-translations.
 * `questions.json` has no such caveat: every correction to it lives in PATCHES below and
 * is reapplied on every run.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access, readdir, unlink } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

const SOURCE_URL =
  'https://raw.githubusercontent.com/leben-in-deutschland/leben-in-deutschland-scrapper/main/data/question.json';
const SOURCE_CACHE = '/tmp/source-question.json';
const IMAGE_CACHE_DIR = '/tmp/eb-img-cache';

const DATA_DIR = path.join(REPO_ROOT, 'src', 'data');
const I18N_DIR = path.join(DATA_DIR, 'i18n');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const IMG_DIR = path.join(PUBLIC_DIR, 'img');

/** Upstream record count we were built against. A change here means re-verify everything. */
const EXPECTED_SOURCE_COUNT = 460;
/** Source indices [0, FEDERAL_BLOCK_END) are the federal catalogue; [300, 460) are per-state. */
const FEDERAL_BLOCK_END = 300;
const EXPECTED_FEDERAL = 300;
const QUESTIONS_PER_STATE = 10;

const LANGUAGES = ['en', 'tr', 'ru', 'fr', 'ar', 'uk', 'hi'] as const;
type Language = (typeof LANGUAGES)[number];

/** Scripts that normally transliterate proper nouns, so an identical string is more suspicious. */
const NON_LATIN_LANGUAGES: ReadonlySet<Language> = new Set<Language>(['ru', 'uk', 'ar', 'hi']);

const OFFLINE = process.argv.includes('--offline');

/**
 * Opt in to overwriting `src/data/i18n/questions.<lang>.json`.
 *
 * Off by default because those seven files hold hand repairs that this script
 * cannot reproduce — see the long comment at the write step. Only pass this when
 * seeding a language for the first time, and only with a clean git tree.
 */
const SEED_TRANSLATIONS = process.argv.includes('--seed-translations');

// ---------------------------------------------------------------------------
// Bundesländer
// ---------------------------------------------------------------------------

/**
 * The 16 Bundesländer in conventional German alphabetical order by name.
 * `isCityState` marks the three Stadtstaaten, whose question templates legitimately differ
 * (Senator/Senatorin instead of Minister/in, Bürgermeister instead of Ministerpräsident/in,
 * Bezirk instead of Landkreis). The extraction rule keys off the state *name*, so it is
 * robust to those template differences without having to model them.
 */
const STATES = [
  { code: 'BW', name: 'Baden-Württemberg', isCityState: false },
  { code: 'BY', name: 'Bayern', isCityState: false },
  { code: 'BE', name: 'Berlin', isCityState: true },
  { code: 'BB', name: 'Brandenburg', isCityState: false },
  { code: 'HB', name: 'Bremen', isCityState: true },
  { code: 'HH', name: 'Hamburg', isCityState: true },
  { code: 'HE', name: 'Hessen', isCityState: false },
  { code: 'MV', name: 'Mecklenburg-Vorpommern', isCityState: false },
  { code: 'NI', name: 'Niedersachsen', isCityState: false },
  { code: 'NW', name: 'Nordrhein-Westfalen', isCityState: false },
  { code: 'RP', name: 'Rheinland-Pfalz', isCityState: false },
  { code: 'SL', name: 'Saarland', isCityState: false },
  { code: 'SN', name: 'Sachsen', isCityState: false },
  { code: 'ST', name: 'Sachsen-Anhalt', isCityState: false },
  { code: 'SH', name: 'Schleswig-Holstein', isCityState: false },
  { code: 'TH', name: 'Thüringen', isCityState: false },
] as const satisfies readonly { code: string; name: string; isCityState: boolean }[];

type StateCode = (typeof STATES)[number]['code'];

const STATE_CODES: readonly StateCode[] = STATES.map((s) => s.code);
const STATE_BY_CODE = new Map<StateCode, (typeof STATES)[number]>(STATES.map((s) => [s.code, s]));

/**
 * Longest name first. This ordering is load-bearing, not cosmetic: "Sachsen" is a substring
 * of both "Sachsen-Anhalt" and "Niedersachsen", so a shortest-first or declaration-order
 * scan mis-assigns 11 records to SN.
 */
const STATES_BY_NAME_LENGTH_DESC: readonly (typeof STATES)[number][] = [...STATES].sort(
  (x, y) => y.name.length - x.name.length || (x.code < y.code ? -1 : 1),
);

function matchStateByText(text: string): StateCode | null {
  for (const state of STATES_BY_NAME_LENGTH_DESC) {
    if (text.includes(state.name)) return state.code;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OptionKey = 'a' | 'b' | 'c' | 'd';
const OPTION_KEYS: readonly OptionKey[] = ['a', 'b', 'c', 'd'];

interface SourceTranslation {
  readonly question: string;
  readonly a: string;
  readonly b: string;
  readonly c: string;
  readonly d: string;
  /** NOTE: upstream calls this `context`, NOT `explanation`. */
  readonly context: string;
}

interface SourceRecord {
  /** Corrupted upstream: 460 rows but only 301 distinct values. Never read this. */
  readonly num: string;
  readonly question: string;
  readonly a: string;
  readonly b: string;
  readonly c: string;
  readonly d: string;
  /** Sometimes the empty string — see PATCHES. */
  readonly solution: string;
  /** Absolute URL, or "-" when the question has no figure. */
  readonly image: string;
  readonly category: string;
  readonly context: string;
  /** sha256 hex, unique across all 460 rows. Our only stable upstream handle. */
  readonly id: string;
  readonly translation: Readonly<Record<Language, SourceTranslation>>;
}

type Scope = 'federal' | 'state';

interface QuestionOptions {
  readonly a: string;
  readonly b: string;
  readonly c: string;
  readonly d: string;
}

interface Question {
  readonly id: string;
  readonly number: number;
  readonly scope: Scope;
  readonly state?: StateCode;
  readonly question: string;
  readonly options: QuestionOptions;
  readonly solution: OptionKey;
  readonly category: CategorySlug;
  readonly explanation: string;
  readonly image?: string;
  readonly sourceId: string;
}

interface TranslatedQuestion {
  readonly question: string;
  readonly options: QuestionOptions;
  readonly explanation: string;
}

// ---------------------------------------------------------------------------
// Categories — stable slug ids for the 10 upstream category labels
// ---------------------------------------------------------------------------

const CATEGORY_SLUGS = {
  General: 'general',
  'History & Geography': 'history-geography',
  'Law & Governance': 'law-governance',
  Elections: 'elections',
  Constitution: 'constitution',
  'Federal System': 'federal-system',
  'Economy & Employment': 'economy-employment',
  'Education & Religion': 'education-religion',
  'Democracy & Politics': 'democracy-politics',
  'Rights & Freedoms': 'rights-freedoms',
} as const satisfies Record<string, string>;

type CategoryLabel = keyof typeof CATEGORY_SLUGS;
type CategorySlug = (typeof CATEGORY_SLUGS)[CategoryLabel];

function categorySlug(label: string): CategorySlug {
  if (!(label in CATEGORY_SLUGS)) {
    fail(
      `Unknown upstream category label ${JSON.stringify(label)}. ` +
        `Add it to CATEGORY_SLUGS (and re-generate src/data/categories.ts).`,
    );
  }
  return CATEGORY_SLUGS[label as CategoryLabel];
}

// ---------------------------------------------------------------------------
// Patch table
// ---------------------------------------------------------------------------
//
// Narrowly scoped, auditable corrections for verified upstream data defects.
//
// Keyed by the upstream stable sha256 `id` AND guarded by an exact question/option
// fingerprint, so a patch can never silently mis-apply if upstream content shifts.
// Every entry MUST match exactly one selected record or the build fails (see asserts),
// which stops the table from rotting unnoticed.
//
// SYNTHESIZED CONTENT WARNING: two entries below reconstruct option sets that upstream
// ships as four empty strings. Those four strings per record are the only content in the
// whole data set that does not come from upstream. They are listed explicitly in the build
// summary and in `src/data/untranslated-report.json` -> `synthesizedContent` so a reviewer
// can find and double-check them without reading this file.

interface PatchMatch {
  /** Exact (post-normalisation) question text the target record must have. */
  readonly question: string;
  /** Exact (post-normalisation) option texts the target record must have. */
  readonly options: QuestionOptions;
}

interface Patch {
  readonly sourceId: string;
  readonly match: PatchMatch;
  /** Correct answer letter, when upstream shipped `solution: ""`. */
  readonly solution?: OptionKey;
  /** Verbatim replacement for the question stem. Same fingerprint guard as `optionText`. */
  readonly questionText?: string;
  /** Verbatim replacements for individual option strings. */
  readonly optionText?: Partial<Record<OptionKey, string>>;
  /** True when `optionText` invents content rather than repairing a scraper artefact. */
  readonly synthesized?: boolean;
  readonly reason: string;
}

const PATCHES: readonly Patch[] = [
  {
    // DEFECT: upstream ships `solution: ""` for this federal question.
    // Grundgesetz Art. 12 Abs. 3 forbids forced labour ("Zwangsarbeit"). Free choice of
    // profession is *protected* by Art. 12 Abs. 1, working abroad is not prohibited, and
    // military service is expressly contemplated by Art. 12a. Therefore the answer is `d`.
    sourceId: 'b3e49f6f15bb7fa5aada8694c00e4a33eaf93736ac957fbfbb63ce7aab939e2e',
    match: {
      question: 'Was verbietet das deutsche Grundgesetz?',
      options: {
        a: 'freie Berufswahl',
        b: 'Arbeit im Ausland',
        c: 'Militärdienst',
        d: 'Zwangsarbeit',
      },
    },
    solution: 'd',
    reason: 'upstream solution is empty; GG Art. 12 Abs. 3 forbids Zwangsarbeit',
  },
  {
    // DEFECT: option `d` contains a Cyrillic homoglyph (U+0435 CYRILLIC SMALL LETTER IE)
    // in "fuеr" and spells the umlaut out as a digraph. Both are scraper artefacts; the
    // official wording is "das Ministerium für Staatssicherheit.". Left unfixed this string
    // is unsearchable and renders inconsistently next to option `a`, which uses "für".
    sourceId: '97a6768d36348d3bcf736b7f3bf274cf79192dc85bba8b5578ecc591b474010c',
    match: {
      question: 'Mit der Abkürzung "Stasi" meinte man in der DDR …',
      options: {
        a: 'das Ministerium für Volksbildung.',
        b: 'eine regierende Partei.',
        c: 'das Parlament.',
        d: 'das Ministerium fuеr Staatssicherheit.',
      },
    },
    optionText: { d: 'das Ministerium für Staatssicherheit.' },
    reason: 'Cyrillic U+0435 homoglyph + "fuer" digraph in option d',
  },
  {
    // DEFECT (SYNTHESIZED REPAIR): upstream ships all four options AND the solution as empty
    // strings, in every language. The question cannot be answered as shipped, and no letter
    // can be picked because there is nothing to pick.
    //
    // Brandenburg's capital is Potsdam. The option set is reconstructed to follow the exact
    // shape the other 15 states use for their own "Die Landeshauptstadt von X heißt ..."
    // question: four real, prominent cities of that same state, exactly one of which is the
    // capital (cf. Bayern -> Nürnberg/München/Regensburg/Ingolstadt, Sachsen ->
    // Dresden/Zwickau/Leipzig/Chemnitz). The distractors here are Brandenburg's next-largest
    // cities; "Brandenburg an der Havel" is a deliberate distractor in the spirit of the
    // official catalogue, since learners routinely confuse the city with the state.
    sourceId: '769dfc2a692eccaccf0129d572d1c3eb125ab7652f965c0ad58c78d880817f74',
    match: {
      question: 'Die Landeshauptstadt von Brandenburg heißt ...',
      options: { a: '', b: '', c: '', d: '' },
    },
    optionText: {
      a: 'Cottbus',
      b: 'Potsdam',
      c: 'Brandenburg an der Havel',
      d: 'Frankfurt (Oder)',
    },
    solution: 'b',
    synthesized: true,
    reason: 'upstream ships empty options AND empty solution; Brandenburg capital is Potsdam',
  },
  {
    // DEFECT (SYNTHESIZED REPAIR): identical breakage to the Brandenburg record above.
    // Hessen's capital is Wiesbaden. Distractors are Hessen's other major cities; Frankfurt
    // am Main is the canonical distractor because it is the state's largest city but not its
    // capital — exactly the confusion this question exists to test.
    sourceId: 'f86c042d95154309a2c94a06010f117e0dbbc472193acb5141dfd5f6dbfff338',
    match: {
      question: 'Die Landeshauptstadt von Hessen heißt ...',
      options: { a: '', b: '', c: '', d: '' },
    },
    optionText: {
      a: 'Frankfurt am Main',
      b: 'Kassel',
      c: 'Wiesbaden',
      d: 'Darmstadt',
    },
    solution: 'c',
    synthesized: true,
    reason: 'upstream ships empty options AND empty solution; Hessen capital is Wiesbaden',
  },

  // ---------------------------------------------------------------------------------------
  // BAMF verification pass (see src/data/verification-report.json, generated by
  // scripts/verify-questions.ts against the official BAMF Gesamtfragenkatalog, Stand
  // 07.05.2025). Every entry below repairs an `optionText`/`questionText`/`solution` finding
  // from that report; none of them change which letter is correct except where noted.
  //
  // Seven entries use `questionText` to repair a question-STEM finding (F046, F057, F107,
  // F119, F175, F185, F212 — e.g. F057 "Francois" -> "François"). F185 also has an
  // `optionText.d` finding on the SAME record; both corrections live in one `Patch` object so
  // the fingerprint guard is evaluated exactly once, against the fully pre-correction draft,
  // never against a half-patched one.
  // ---------------------------------------------------------------------------------------
  {
    // BAMF verification: option c is truncated ("erlasse" for "erlassen").
    sourceId: 'a916a355781eb80916ae1a7f64d1e1ee3764869c9a42354afad3c4f1262a7a48',
    match: {
      question: 'Was ist die Arbeit eines Richters/einer Richterin in Deutschland?',
      options: {
        a: 'Recht sprechen',
        b: 'Pläne erstellen',
        c: 'Gesetze erlasse',
        d: 'Deutschland regieren',
      },
    },
    optionText: { c: 'Gesetze erlassen' },
    reason: 'BAMF verification report finding F151.c: option truncated ("erlasse" -> "erlassen")',
  },
  {
    // BAMF verification: option c is truncated ("Staate" for "Staaten").
    sourceId: '8ea0c0c2b4990de8d612808d45a09981be2cad2d65342c01e975af7e985e83c5',
    match: {
      question: 'Zu wem gehörte die DDR im "Kalten Krieg"?',
      options: {
        a: 'zur NATO',
        b: 'zu den Westmächten',
        c: 'zu den blockfreien Staate',
        d: 'zum Warschauer Pakt',
      },
    },
    optionText: { c: 'zu den blockfreien Staaten' },
    reason: 'BAMF verification report finding F184.c: option truncated ("Staate" -> "Staaten")',
  },
  {
    // BAMF verification: option b drops "Verkehrsmittel" entirely.
    sourceId: '59522ea036d05f0dd5e05e8e9d291763692f80c714ee46cec1330f45d49ed435',
    match: {
      question:
        'In den meisten Mietshäusern in Deutschland gibt es eine "Hausordnung". Was steht in ' +
        'einer solchen "Hausordnung"? Sie nennt',
      options: {
        a: 'die Adresse des nächsten Ordnungsamtes.',
        b: 'Regeln für die Benutzung öffentlicher.',
        c: 'alle Mieter und Mieterinnen im Haus.',
        d: 'Regeln, an die sich alle Bewohner und Bewohnerinnen halten müssen.',
      },
    },
    optionText: { b: 'Regeln für die Benutzung öffentlicher Verkehrsmittel.' },
    reason: 'BAMF verification report finding F196.b: option dropped "Verkehrsmittel"',
  },
  {
    // BAMF verification: option b (the solution) drops the clarifying parenthetical.
    sourceId: '0d7b373519152df7e5b7ca8a18536a1297bc9ad646516a622ccb2ff2d3dfba7b',
    match: {
      question: 'Der 27. Januar ist in Deutschland ein offizieller Gedenktag. Woran erinnert dieser Tag?',
      options: {
        a: 'an die Verabschiedung des Grundgesetzes',
        b: 'an die Opfer des Nationalsozialismus',
        c: 'an das Ende des Zweiten Weltkrieges',
        d: 'an die Wiedervereinigung Deutschlands',
      },
    },
    optionText: { b: 'an die Opfer des Nationalsozialismus (Tag der Befreiung des Vernichtungslagers Auschwitz)' },
    reason: 'BAMF verification report finding F270.b: option dropped the Auschwitz parenthetical',
  },
  {
    // BAMF verification: option c is ASCII-degraded ("grosse" for "große").
    sourceId: '178f31e2c2d1e5793a74e3f539cd4aea3cfa9b24dfd91591ede5176368142249',
    match: {
      question: 'Wen vertreten die Gewerkschaften in Deutschland?',
      options: {
        a: 'kleine Unternehmen',
        b: 'Arbeitnehmerinnen und Arbeitnehmer',
        c: 'grosse Unternehmen',
        d: 'Selbstständige',
      },
    },
    optionText: { c: 'große Unternehmen' },
    reason: 'BAMF verification report finding F011.c: ASCII-degraded "grosse" -> "große"',
  },
  {
    // BAMF verification: option d is ASCII-degraded ("Bundespraesidentin" for "Bundespräsidentin").
    sourceId: '3e04b1e2ccec649fece15bea99e7f524caca7264e468f0e1076e230a92935680',
    match: {
      question: 'Welches Organ gehört nicht zu den Verfassungsorganen Deutschlands?',
      options: {
        a: 'die Regierung',
        b: 'die Bürgerversammlung',
        c: 'der Bundesrat',
        d: 'die Bundespraesidentin/der Bundespräsident',
      },
    },
    optionText: { d: 'die Bundespräsidentin/der Bundespräsident' },
    reason: 'BAMF verification report finding F168.d: ASCII-degraded "Bundespraesidentin" -> "Bundespräsidentin"',
  },
  {
    // BAMF verification: TWO findings on this one record — the question stem is
    // ASCII-degraded ("moglich" for "möglich", finding F185) AND option d is ASCII-degraded
    // ("Halfte"/"dafur" for "Hälfte"/"dafür", finding F185.d). Both live in this single Patch
    // object so the fingerprint is checked once, against the fully pre-correction draft.
    sourceId: 'eee60a4791f5150bea2fdd90d1364b5db92d6a8943fd8afde0c682f7c6b12e18',
    match: {
      question: 'Eine Partei im Deutschen Bundestag will die Pressefreiheit abschaffen. Ist das moglich?',
      options: {
        a: 'Nein, denn die Pressefreiheit ist ein Grundrecht. Sie kann nicht abgeschafft werden',
        b: 'Nein, denn nur der Bundesrat kann die Pressefreiheit abschaffen.',
        c: 'Ja, aber dazu müssen zwei Drittel der Abgeordneten im Bundestag dafür sein',
        d: 'Ja, wenn mehr als die Halfte der Abgeordneten im Bundestag dafur sind.',
      },
    },
    questionText: 'Eine Partei im Deutschen Bundestag will die Pressefreiheit abschaffen. Ist das möglich?',
    optionText: { d: 'Ja, wenn mehr als die Hälfte der Abgeordneten im Bundestag dafür sind.' },
    reason:
      'BAMF verification report findings F185 (stem, "moglich" -> "möglich") and F185.d ' +
      '(ASCII-degraded "Halfte"/"dafur" -> "Hälfte"/"dafür")',
  },
  {
    // BAMF verification: question stem says "der Sitz" (the seat), but the European
    // Parliament has more than one official seat, so the official text says "ein Sitz".
    sourceId: '15157c42e426e7b534ee1730a424c593cdc23b5d7b6b887e3a096da357fc86bc',
    match: {
      question: 'Wo ist der Sitz des Europäischen Parlaments?',
      options: { a: 'Berlin', b: 'Straßburg', c: 'Paris', d: 'London' },
    },
    questionText: 'Wo ist ein Sitz des Europäischen Parlaments?',
    reason: 'BAMF verification report finding F046: "der Sitz" -> "ein Sitz" (EP has more than one seat)',
  },
  {
    // BAMF verification: question stem is ASCII-degraded ("Francois" for "François").
    sourceId: 'ade768fd8382d2aae4a5bc2cd2f14590727db01774eeb6790c78b5640a396fb6',
    match: {
      question:
        'Der damalige französische Staatspräsident Francois Mitterrand und der damalige deutsche ' +
        'Bundeskanzler Helmut Kohl gedenken in Verdun gemeinsam der Toten beider Weltkriege. ' +
        'Welches Ziel der Europäischen Union wird bei diesem Treffen deutlich?',
      options: {
        a: 'Frieden und Sicherheit in den Ländern der EU',
        b: 'einheitliche Feiertage in den Ländern der EU',
        c: 'Reisefreiheit in alle Länder der EU',
        d: 'Freundschaft zwischen England und Deutschland',
      },
    },
    questionText:
      'Der damalige französische Staatspräsident François Mitterrand und der damalige deutsche ' +
      'Bundeskanzler Helmut Kohl gedenken in Verdun gemeinsam der Toten beider Weltkriege. ' +
      'Welches Ziel der Europäischen Union wird bei diesem Treffen deutlich?',
    reason: 'BAMF verification report finding F057: ASCII-degraded "Francois" -> "François"',
  },
  {
    // BAMF verification: question stem uses a slash doublet where the official text uses "und".
    sourceId: 'd69662f14ccef7fbcb6563957fabcae217a850abd44535375e3fc28329b29d3a',
    match: {
      question: 'In der DDR lebten vor allem Migrantinnen/Migranten aus …',
      options: {
        a: 'Chile, Ungarn, Simbabwe.',
        b: 'Nordkorea, Mexiko, Ägypten.',
        c: 'Frankreich, Rumänien, Somalia.',
        d: 'Vietnam, Polen, Mosambik',
      },
    },
    questionText: 'In der DDR lebten vor allem Migrantinnen und Migranten aus …',
    reason: 'BAMF verification report finding F107: slash doublet "Migrantinnen/Migranten" -> "und" doublet',
  },
  {
    // BAMF verification: question stem has wrong gender order and wrong closing phrase.
    sourceId: '5b1e8d91a69c60e9f1b9fa5e7ff22d598f1963661c697b1b18878914d12e4d5c',
    match: {
      question: 'Aus welchem Land kamen die ersten Gastarbeiter und Gastarbeiterinnen nach Deutschland?',
      options: { a: 'Italien', b: 'Portugal', c: 'Türkei', d: 'Spanien' },
    },
    questionText:
      'Aus welchem Land kamen die ersten Gastarbeiterinnen und Gastarbeiter in die Bundesrepublik ' +
      'Deutschland?',
    reason:
      'BAMF verification report finding F119: gender order + "nach Deutschland" -> ' +
      '"in die Bundesrepublik Deutschland"',
  },
  {
    // BAMF verification: question stem is ASCII-degraded ("fur" for "für").
    sourceId: '137c97d971b0b503ba60a8159c12d8e45696c2d383827bc3ffeb2eccad25174f',
    match: {
      question: 'Welches Grundrecht gilt in Deutschland nur fur Ausländerinnen/Ausländer? Das Grundrecht auf …',
      options: { a: 'Menschenwürde', b: 'Meinungsfreiheit', c: 'Schutz der Familie', d: 'Asyl' },
    },
    questionText: 'Welches Grundrecht gilt in Deutschland nur für Ausländerinnen/Ausländer? Das Grundrecht auf …',
    reason: 'BAMF verification report finding F175: ASCII-degraded "fur" -> "für"',
  },
  {
    // BAMF verification: question stem uses "jeder" where the official text uses "jede/jeder".
    sourceId: '61961be19be5d25145903afea7383029076880284394fbdb6468879b22a98d73',
    match: {
      question: 'Bei einer Bundestagswahl in Deutschland darf jeder wählen, die/der …',
      options: {
        a: 'seit mindestens 3 Jahren in der Bundesrepublik Deutschland lebt.',
        b: 'Bürger/Bürgerin der Bundesrepublik Deutschland ist und mindestens 21 Jahre alt ist.',
        c: 'in der Bundesrepublik Deutschland wohnt und wählen möchte.',
        d: 'Bürger/Bürgerin der Bundesrepublik Deutschland ist und mindestens 18 Jahre alt ist.',
      },
    },
    questionText: 'Bei einer Bundestagswahl in Deutschland darf jede/jeder wählen, die/der …',
    reason: 'BAMF verification report finding F212: "jeder" -> "jede/jeder"',
  },
  {
    // BAMF verification: option b is ASCII-degraded ("Meinungsäusserungen" for "Meinungsäußerungen").
    sourceId: '630313c18960a186288cf732b346efe590bf68c744a4b23102c4605cc615c171',
    match: {
      question: 'Wann ist die Meinungsfreiheit in Deutschland eingeschränkt?',
      options: {
        a: 'bei Kritik am Staat',
        b: 'bei Meinungsäusserungen über die Bundesregierung',
        c: 'bei der öffentlichen Verbreitung falscher Behauptungen über einzelne Personen',
        d: 'bei Diskussionen über Religionen',
      },
    },
    optionText: { b: 'bei Meinungsäußerungen über die Bundesregierung' },
    reason: 'BAMF verification report finding F207.b: ASCII-degraded "Meinungsäusserungen" -> "Meinungsäußerungen"',
  },
  {
    // BAMF verification: option a is ASCII-degraded ("Offentlichkeit" for "Öffentlichkeit").
    sourceId: 'e2af84b57db7b1a59707283b8a747831b2a07a251e46d4bcd93dae583b36c0b1',
    match: {
      question: 'Was versteht man unter dem Recht der "Freizügigkeit" in Deutschland?',
      options: {
        a: 'Man darf sich in der Offentlichkeit nur leicht bekleidet bewegen.',
        b: 'Man darf sich seinen Wohnort selbst aussuchen.',
        c: 'Man kann seinen Beruf wechseln.',
        d: 'Man darf sich für eine andere Religion entscheiden.',
      },
    },
    optionText: { a: 'Man darf sich in der Öffentlichkeit nur leicht bekleidet bewegen.' },
    reason: 'BAMF verification report finding F222.a: ASCII-degraded "Offentlichkeit" -> "Öffentlichkeit"',
  },
  {
    // BAMF verification: options b/c drop the gender doublet and trailing period.
    sourceId: 'f749164b14ce558d6325d8fa3e3666b7e719403893e484dbc976b7c62611be69',
    match: {
      question: 'Was bedeutet der Begriff "europäische Integration"?',
      options: {
        a: 'Der Begriff meint den Zusammenschluss europäischer Staaten zur EU',
        b: 'Damit sind amerikanische Einwanderer in Europa gemeint',
        c: 'Damit sind europäische Auswanderer in den USA gemeint',
        d: 'Der Begriff meint den Einwanderungsstopp nach Europa',
      },
    },
    optionText: {
      b: 'Damit sind amerikanische Einwanderinnen und Einwanderer in Europa gemeint.',
      c: 'Damit sind europäische Auswanderinnen und Auswanderer in den USA gemeint.',
    },
    reason: 'BAMF verification report findings F014.b/F014.c: missing gender doublet + trailing period',
  },
  {
    // BAMF verification: options c/d use the wrong article ("der" instead of "die").
    sourceId: '1da01e705b8bbf4b747baa68335800d69a3cf2e1798aaef994963b7711f8cbd2',
    match: {
      question: 'Wer ist in Deutschland hauptsächlich verantwortlich für die Kindererziehung?',
      options: {
        a: 'der Staat',
        b: 'die Verwandten',
        c: 'der Eltern',
        d: 'der Schulen',
      },
    },
    optionText: { c: 'die Eltern', d: 'die Schulen' },
    reason: 'BAMF verification report findings F030.c/F030.d: wrong article "der" -> "die"',
  },
  {
    // BAMF verification: option a uses the wrong preposition ("der" instead of "von").
    sourceId: '4cc85a161eb92955800fe711873f4d6ea2d09a15a582c5d37721789dbd7604de',
    match: {
      question: 'Was gab es in Deutschland nicht während der Zeit des Nationalsozialismus?',
      options: {
        a: 'Verfolgung der Juden',
        b: 'freie Wahlen',
        c: 'Pressezensur',
        d: 'willkürliche Verhaftungen',
      },
    },
    optionText: { a: 'Verfolgung von Juden' },
    reason: 'BAMF verification report finding F034.a: wrong preposition "der" -> "von"',
  },
  {
    // BAMF verification: option a is missing an "n" ("Renterinnen" for "Rentnerinnen").
    sourceId: 'd55f636181cffcaf169e453aded9c0318eca7ec23d728e1304da6f372bbd5f3e',
    match: {
      question: 'Gewerkschaften sind Interessenverbände der …',
      options: {
        a: 'Renterinnen und Rentner.',
        b: 'Arbeitgeberinnen und Arbeitgeber.',
        c: 'Arbeitnehmerinnen und Arbeitnehmer.',
        d: 'Jugendlichen.',
      },
    },
    optionText: { a: 'Rentnerinnen und Rentner.' },
    reason: 'BAMF verification report finding F037.a: missing "n" ("Renterinnen" -> "Rentnerinnen")',
  },
  {
    // BAMF verification: option d used the old masculine-only wording; official adds the doublet.
    sourceId: 'c9af3895964cdc25edb2b71a301fabda75709fb20d69c0a43d7061ca222c0488',
    match: {
      question:
        'Vom Juni 1948 bis zum Mai 1949 wurden die Bürgerinnen und Bürger von West-Berlin durch ' +
        'eine Luftbrücke versorgt. Welcher Umstand war dafür verantwortlich?',
      options: {
        a: 'Für Großbritannien war die Versorgung über die Luftbrücke schneller.',
        b: 'Für Frankreich war eine Versorgung der West-Berliner Bevölkerung mit dem Flugzeug kostengünstiger.',
        c: 'Die Sowjetunion unterbrach den gesamten Verkehr auf dem Landwege.',
        d: 'Die amerikanischen Soldaten/Soldatinnen hatten beim Landtransport Angst vor Überfällen.',
      },
    },
    optionText: { d: 'Die amerikanischen Soldatinnen und Soldaten hatten beim Landtransport Angst vor Überfällen.' },
    reason: 'BAMF verification report finding F064.d: wording differs from official text',
  },
  {
    // BAMF verification: option c (the solution) is missing the gender doublet.
    sourceId: '32a046eb52f23c1aacef2b8426360355bd646aeb12b2dc1da847935f551ba24f',
    match: {
      question: 'Wahlen in Deutschland sind frei. Was bedeutet das?',
      options: {
        a: 'Alle wahlberechtigten Personen müssen wählen.',
        b: 'Man darf Geld annehmen, wenn man dafür einen bestimmten Kandidaten/eine bestimmte Kandidatin wählt.',
        c: 'Der Wähler darf bei der Wahl weder beeinflusst noch zu einer bestimmten Stimmabgabe gezwungen werden und keine Nachteile durch die Wahl haben.',
        d: 'Nur Personen, die noch nie im Gefängnis waren, dürfen wählen.',
      },
    },
    optionText: {
      c:
        'Die Wählerin/der Wähler darf bei der Wahl weder beeinflusst noch zu einer bestimmten ' +
        'Stimmabgabe gezwungen werden und keine Nachteile durch die Wahl haben.',
    },
    reason: 'BAMF verification report finding F081.c: solution option missing gender doublet',
  },
  {
    // BAMF verification: option c has an extraneous "Deutschland" not in the official text.
    sourceId: '82896aaf01afda28a3d4b1cc8e3e81a945137aea5ae528aa8cda25dadb39dab0',
    match: {
      question: 'Wie wurden die Bundesrepublik Deutschland und die DDR zu einem Staat?',
      options: {
        a: 'Die DDR hat die Bundesrepublik Deutschland besetzt.',
        b: 'Die westlichen Bundesländer sind der DDR beigetreten.',
        c: 'Die Bundesrepublik Deutschland hat die DDR besetzt.',
        d: 'Die heutigen fünf östlichen Bundesländer sind der Bundesrepublik Deutschland beigetreten.',
      },
    },
    optionText: { c: 'Die Bundesrepublik hat die DDR besetzt.' },
    reason: 'BAMF verification report finding F195.c: extraneous "Deutschland" not in official text',
  },
  {
    // BAMF verification: option a (the solution) names the wrong medium ("Leserbriefen" vs "Internet").
    sourceId: 'e2db45135b48074f3ee975cdf9dc410496cc690694fda81943da19bfc410c229',
    match: {
      question: 'Meinungsfreiheit in Deutschland heißt, dass ich …',
      options: {
        a: 'meine Meinung in Leserbriefen äußern kann.',
        b: 'Passanten auf der Straße beschimpfen darf.',
        c: 'meine Meinung nur dann äußern darf, solange ich der Regierung nicht widerspreche.',
        d: 'Nazi-, Hamas- oder Islamischer Staat-Symbole öffentlich tragen darf.',
      },
    },
    optionText: { a: 'meine Meinung im Internet äußern kann.' },
    reason: 'BAMF verification report finding F197.a: solution option names the wrong medium',
  },
  {
    // BAMF verification: option c is plural where the official text is singular.
    sourceId: '4824b551535ccfc6ee3d950e4446a220207858e35195230ed79cf399d34a24b5',
    match: {
      question: 'Womit finanziert der deutsche Staat die Sozialversicherung?',
      options: {
        a: 'Spendengeldern',
        b: 'Sozialabgaben',
        c: 'Kirchensteuern',
        d: 'Vereinsbeiträgen',
      },
    },
    optionText: { c: 'Kirchensteuer' },
    reason: 'BAMF verification report finding F229.c: "Kirchensteuern" -> singular "Kirchensteuer"',
  },
  {
    // BAMF verification: option a is missing an "s" ("Hausratversicherung" for "Hausratsversicherung").
    sourceId: 'f51a19adcc1be293bcd98d3a2d50657ca1b45a6e930505d1f56a5dfdb5484ccb',
    match: {
      question: 'Zu welcher Versicherung gehört die Pflegeversicherung?',
      options: {
        a: 'Hausratversicherung',
        b: 'Haftpflicht- und Feuerversicherung',
        c: 'Sozialversicherung',
        d: 'Unfallversicherung',
      },
    },
    optionText: { a: 'Hausratsversicherung' },
    reason: 'BAMF verification report finding F252.a: missing "s" ("Hausratversicherung" -> "Hausratsversicherung")',
  },
  {
    // BAMF verification: option d has the wrong gender order and preposition case.
    sourceId: '6f7c6dd15465fb7f9f2af37195eb500d2072e50482bb85cc3221597002fc556c',
    match: {
      question: 'Was bekommen wahlberechtigte Bürgerinnen und Bürger in Deutschland vor einer Wahl?',
      options: {
        a: 'eine Benachrichtigung von der Bundesversammlung',
        b: 'eine Benachrichtigung vom Pfarramt',
        c: 'eine Wahlbenachrichtigung von der Gemeinde',
        d: 'eine Wahlerlaubnis vom Bundespräsidenten/von der Bundespräsidentin',
      },
    },
    optionText: { d: 'eine Wahlerlaubnis von der Bundespräsidentin/von dem Bundespräsidenten' },
    reason: 'BAMF verification report finding F292.d: wrong gender order and preposition case',
  },
  {
    // BAMF verification: option b is missing an "st" ("selbständig" for "selbstständig").
    sourceId: '013e889f16b8a5ab1de64d2191a8dfc9118cc7e45075305f1d39935a979fbe1a',
    match: {
      question: 'In Deutschland sind die meisten Erwerbstätigen …',
      options: {
        a: 'bei einer Firma oder Behörde beschäftigt.',
        b: 'selbständig mit einer eigenen Firma tätig.',
        c: 'in kleinen Familienunternehmen beschäftigt.',
        d: 'ehrenamtlich für ein Bundesland tätig.',
      },
    },
    optionText: { b: 'selbstständig mit einer eigenen Firma tätig.' },
    reason: 'BAMF verification report finding F299.b: "selbständig" -> "selbstständig"',
  },
  {
    // BAMF verification: option b has the wrong gender order and "Senats" instead of "Senates".
    sourceId: '784341e62278f642c3bf11bfd5728f7adc2cff5388922923ccc7134b13193a6c',
    match: {
      question: 'Wie nennt man den Regierungschef / die Regierungschefin des Stadtstaates Berlin?',
      options: {
        a: 'Regierender Bürgermeister / Regierende Bürgermeisterin',
        b: 'Präsident / Präsidentin des Senats',
        c: 'Ministerpräsident / Ministerpräsidentin',
        d: 'Oberbürgermeister / Oberbürgermeisterin',
      },
    },
    optionText: { b: 'Präsidentin/Präsident des Senates' },
    reason: 'BAMF verification report finding BE08.b: wrong gender order and "Senats" -> "Senates"',
  },
  {
    // BAMF verification: option b names the wrong color ("schwarz-gelb" for "schwarz-gold").
    sourceId: 'ff8b4e2fffa7dc7865c5ccd585510942347955b2136a416f8976f5cd3806067c',
    match: {
      question: 'Welche Farben hat die Landesflagge von Bremen?',
      options: {
        a: 'grün-weiß-rot',
        b: 'schwarz-gelb',
        c: 'rot-weiß',
        d: 'blau-weiß-rot',
      },
    },
    optionText: { b: 'schwarz-gold' },
    reason: 'BAMF verification report finding HB05.b: wrong color "schwarz-gelb" -> "schwarz-gold"',
  },
  {
    // BAMF verification: option a (the solution) has the wrong gender order and "Senats" instead
    // of "Senates".
    sourceId: '322fef1a1f7ac44625be2ea593398e2001fe64eeaabbf324efcf9314aaad329d',
    match: {
      question: 'Wie nennt man den Regierungschef / die Regierungschefin des Stadtstaates Bremen?',
      options: {
        a: 'Präsident / Präsidentin des Senats',
        b: 'Ministerpräsident / Ministerpräsidentin',
        c: 'Regierender Bürgermeister / Regierende Bürgermeisterin',
        d: 'Erster Bürgermeister / Erste Bürgermeisterin',
      },
    },
    optionText: { a: 'Präsidentin/Präsident des Senates' },
    reason: 'BAMF verification report finding HB08.a: solution option wrong gender order and "Senats" -> "Senates"',
  },
  {
    // BAMF verification: option d names the wrong distractor title.
    sourceId: '7c622689440bccb1385e4e56166e7efeca8d763c199850b79f1b3498f5237947',
    match: {
      question: 'Wie nennt man den Regierungschef / die Regierungschefin in Mecklenburg-Vorpommern?',
      options: {
        a: 'Bürgermeister / Bürgermeisterin',
        b: 'Ministerpräsident / Ministerpräsidentin',
        c: 'Premierminister / Premierministerin',
        d: 'Erster Bürgermeister / Erste Bürgermeisterin',
      },
    },
    optionText: { d: 'Erste Ministerin/Erster Minister' },
    reason: 'BAMF verification report finding MV08.d: wrong distractor title',
  },
  {
    // BAMF verification, handled with extra care per the report: our option a
    // ("Finanzsenator / Finanzsenatorin") is a Stadtstaat title Mecklenburg-Vorpommern doesn't
    // have either, so as shipped the question arguably had two correct answers. The official
    // text ("Finanzministerin/Finanzminister") removes that ambiguity. Solution stays `b`
    // (Außenminister/Außenministerin) — unaffected, since only option `a`'s text changes.
    sourceId: '2e04936ed9c832c1367868a4cdb150793379f4b65e7f4f87695f133dad07e81b',
    match: {
      question: 'Welchen Minister / welche Ministerin hat Mecklenburg-Vorpommern nicht?',
      options: {
        a: 'Finanzsenator / Finanzsenatorin',
        b: 'Außenminister / Außenministerin',
        c: 'Innenminister / Innenministerin',
        d: 'Justizminister / Justizministerin',
      },
    },
    optionText: { a: 'Finanzministerin/Finanzminister' },
    reason:
      'BAMF verification report finding MV09.a: city-state title ("Finanzsenator") replaced with ' +
      'official state-ministry title; removes a second arguably-correct answer. Solution remains b.',
  },
  {
    // BAMF verification, set-level alignment: the official option set for this question is
    // {gelb-schwarz, grün-weiß-rot, blau-weiß-rot, weiß-rot}. Ours had a bogus "weiß-blau" at c
    // (not in the official set at all) and was missing "weiß-rot". `a` (gelb-schwarz, the
    // solution) and `b` (grün-weiß-rot) were already correct and are left in place; only `c`
    // and `d` are replaced, which reproduces the official set exactly while `solution` (already
    // "a") keeps pointing at the same correct text as before.
    sourceId: '7a050fac70c57dbb4754ee354f906a95a54218762835409cdff1fd99cc6dbb9b',
    match: {
      question: 'Welche Farben hat die Landesflagge von Sachsen-Anhalt?',
      options: {
        a: 'gelb-schwarz',
        b: 'grün-weiß-rot',
        c: 'weiß-blau',
        d: 'blau-weiß-rot',
      },
    },
    optionText: { c: 'blau-weiß-rot', d: 'weiß-rot' },
    reason:
      'BAMF verification report findings ST05.c/ST05.d: option set realigned to the official ' +
      'four {gelb-schwarz, grün-weiß-rot, blau-weiß-rot, weiß-rot}; solution unchanged at a',
  },
];

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

const problems: string[] = [];

function fail(message: string): never {
  console.error(`\n✗ FATAL: ${message}\n`);
  process.exit(1);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) problems.push(message);
}

function flushAsserts(): void {
  if (problems.length > 0) {
    console.error(`\n✗ ${problems.length} assertion(s) failed:\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

/**
 * Minimal, lossless-in-meaning cleanup. Never paraphrases or truncates.
 *  - NFC (source mixes precomposed umlauts with base letter + U+0308)
 *  - strips HTML tags and decodes the handful of named/numeric entities
 *  - collapses all whitespace runs (the scraper leaves raw newlines + HTML indentation)
 *  - normalises non-breaking hyphen / curly quotes to their plain equivalents
 */
function cleanText(raw: string): string {
  let s = raw.normalize('NFC');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  s = s
    .replace(/ /g, ' ') // no-break space
    .replace(/‑/g, '-') // non-breaking hyphen
    .replace(/[“”„‟«»]/g, '"')
    .replace(/[‘’‚‛]/g, "'");
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
  hellip: '…',
  ndash: '–',
  mdash: '—',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

// ---------------------------------------------------------------------------
// Deterministic JSON emitters
// ---------------------------------------------------------------------------

/** JSON.stringify with recursively sorted object keys, so diffs stay readable. */
function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * JSON.stringify preserving the author-declared key order. Used for questions.json, where
 * schema order (id, number, scope, state, question, …) reads far better than alphabetical.
 * Still deterministic: insertion order is fixed by the builder.
 */
function orderedStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Source loading
// ---------------------------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, FS.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadSource(): Promise<{ records: readonly SourceRecord[]; origin: string }> {
  if (await exists(SOURCE_CACHE)) {
    const text = await readFile(SOURCE_CACHE, 'utf8');
    return { records: parseSource(text), origin: `cache ${SOURCE_CACHE}` };
  }
  if (OFFLINE) {
    fail(`--offline requested but no cache at ${SOURCE_CACHE}. Run once online first.`);
  }
  console.log(`  fetching ${SOURCE_URL} …`);
  const text = await fetchText(SOURCE_URL);
  const records = parseSource(text);
  await writeFile(SOURCE_CACHE, text, 'utf8');
  return { records, origin: `network (cached to ${SOURCE_CACHE})` };
}

function parseSource(text: string): readonly SourceRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    fail(`source JSON is not parseable: ${String(err)}`);
  }
  if (!Array.isArray(parsed)) fail('source JSON is not an array');
  return parsed as readonly SourceRecord[];
}

async function fetchText(url: string, attempts = 4): Promise<string> {
  let lastError = '';
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } catch (err) {
      lastError = String(err);
      if (i < attempts) await sleep(400 * i);
    }
  }
  return fail(`could not fetch ${url} after ${attempts} attempts: ${lastError}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Record selection
// ---------------------------------------------------------------------------

/**
 * Federal block = source indices [0, 300). Verified upstream; re-asserted with anchors so a
 * reordered upstream file trips the build instead of silently shipping the wrong 300.
 */
function selectFederalIndices(records: readonly SourceRecord[]): readonly number[] {
  const first = records[0];
  const last = records[FEDERAL_BLOCK_END - 1];
  const afterBlock = records[FEDERAL_BLOCK_END];
  assert(
    cleanText(first?.question ?? '') === 'Was war am 8. Mai 1945?',
    `federal-block anchor idx 0 changed: got ${JSON.stringify(cleanText(first?.question ?? ''))}`,
  );
  assert(
    cleanText(last?.question ?? '') ===
      'Deutschland ist Mitglied des Schengener Abkommens. Was bedeutet das?',
    `federal-block anchor idx 299 changed: got ${JSON.stringify(cleanText(last?.question ?? ''))}`,
  );
  assert(
    cleanText(afterBlock?.question ?? '') === 'Welches Wappen gehört zum Bundesland Brandenburg?',
    `state-block anchor idx 300 changed: got ${JSON.stringify(cleanText(afterBlock?.question ?? ''))}`,
  );
  return Array.from({ length: FEDERAL_BLOCK_END }, (_unused, i) => i);
}

interface StateAssignment {
  readonly sourceIndex: number;
  readonly state: StateCode;
  /** Which pass claimed the record — reported so the fallback stays visible. */
  readonly via: 'question-text' | 'correct-answer-text';
}

/**
 * Assigns every record in the state block [300, 460) to one of the 16 Bundesländer.
 *
 * Pass 1 — match the QUESTION TEXT ONLY against the 16 state names, longest name first.
 *   Deliberately does NOT look at the options: option lists cross-reference other states
 *   ("Welches ist ein Landkreis in X?" lists districts, "Welches Bundesland …" lists sibling
 *   states), which over-collects to 176 hits instead of 160.
 *   This assigns 157 records: 10 for each of the 13 area states, 9 each for BE/HB/HH.
 *
 * Pass 2 — the 3 leftovers are the Stadtstaat questions, which name no state in the question
 *   text ("Welches Bundesland ist ein Stadtstaat?"). Fall back to the text of the record's
 *   CORRECT ANSWER, matched the same longest-first way. That resolves Berlin, Bremen and
 *   Hamburg respectively, bringing each city state to 10.
 *
 * Expressed as one general rule: a record belongs to the state its question names, or — if
 * the question names no state — to the state its correct answer names.
 */
function assignStates(records: readonly SourceRecord[]): {
  assignments: readonly StateAssignment[];
  unresolved: readonly number[];
} {
  const assignments: StateAssignment[] = [];
  const unresolved: number[] = [];

  for (let i = FEDERAL_BLOCK_END; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;

    // Pass 1: the question text.
    const fromQuestion = matchStateByText(cleanText(record.question));
    if (fromQuestion) {
      assignments.push({ sourceIndex: i, state: fromQuestion, via: 'question-text' });
      continue;
    }

    // Pass 2: the correct answer's text.
    const solution = record.solution.trim().toLowerCase();
    const answer = OPTION_KEYS.includes(solution as OptionKey)
      ? cleanText(record[solution as OptionKey])
      : '';
    const fromAnswer = answer === '' ? null : matchStateByText(answer);
    if (fromAnswer) {
      assignments.push({ sourceIndex: i, state: fromAnswer, via: 'correct-answer-text' });
      continue;
    }

    unresolved.push(i);
  }

  return { assignments, unresolved };
}

// ---------------------------------------------------------------------------
// Image mirroring
// ---------------------------------------------------------------------------

interface SniffedFormat {
  readonly ext: 'jpg' | 'png' | 'gif' | 'webp';
  readonly label: string;
}

/** Trust bytes, never the URL's extension — every upstream `.png` here is really a JPEG. */
function sniffFormat(bytes: Uint8Array): SniffedFormat {
  const b = (i: number): number => bytes[i] ?? -1;
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return { ext: 'jpg', label: 'JPEG' };
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) {
    return { ext: 'png', label: 'PNG' };
  }
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) {
    return { ext: 'gif', label: 'GIF' };
  }
  if (
    b(0) === 0x52 &&
    b(1) === 0x49 &&
    b(2) === 0x46 &&
    b(3) === 0x46 &&
    b(8) === 0x57 &&
    b(9) === 0x45 &&
    b(10) === 0x42 &&
    b(11) === 0x50
  ) {
    return { ext: 'webp', label: 'WebP' };
  }
  return fail(
    `unrecognised image magic bytes: ${Array.from(bytes.slice(0, 12))
      .map((x) => x.toString(16).padStart(2, '0'))
      .join(' ')}`,
  );
}

/** Content-addressed /tmp cache so re-runs never re-hit the origin. */
function imageCachePath(url: string): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 32);
  return path.join(IMAGE_CACHE_DIR, `${hash}.bin`);
}

async function loadImageBytes(url: string): Promise<{ bytes: Uint8Array; cached: boolean }> {
  const cachePath = imageCachePath(url);
  if (await exists(cachePath)) {
    return { bytes: new Uint8Array(await readFile(cachePath)), cached: true };
  }
  if (OFFLINE) fail(`--offline requested but image not cached: ${url}`);

  let lastError = '';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength === 0) throw new Error('empty body');
      await mkdir(IMAGE_CACHE_DIR, { recursive: true });
      await writeFile(cachePath, bytes);
      return { bytes, cached: false };
    } catch (err) {
      lastError = String(err);
      if (attempt < 4) await sleep(500 * attempt);
    }
  }
  return fail(`could not download image ${url}: ${lastError}`);
}

interface MirroredImage {
  readonly repoPath: string;
  readonly format: string;
  readonly bytes: number;
  readonly usedBy: readonly string[];
  readonly urlExtLied: boolean;
}

/**
 * Mirrors every image referenced by any of the 460 records. Downloads are deduped per URL
 * (one URL is shared by two federal questions), but multiple records may point at the same
 * local file. Output names derive from the *first* referencing question id, in record order.
 */
async function mirrorImages(
  refs: readonly { readonly questionId: string; readonly url: string }[],
): Promise<Map<string, MirroredImage>> {
  const byUrl = new Map<string, string[]>();
  for (const ref of refs) {
    const list = byUrl.get(ref.url);
    if (list) list.push(ref.questionId);
    else byUrl.set(ref.url, [ref.questionId]);
  }

  await mkdir(IMG_DIR, { recursive: true });

  const jobs = [...byUrl.entries()].map(([url, questionIds]) => ({ url, questionIds }));
  const results = new Map<string, MirroredImage>();
  const CONCURRENCY = 3; // be polite to the origin
  let cursor = 0;
  let freshDownloads = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const job = jobs[index];
      if (!job) return;
      const { bytes, cached } = await loadImageBytes(job.url);
      if (!cached) {
        freshDownloads += 1;
        await sleep(250);
      }
      const format = sniffFormat(bytes);
      const owner = job.questionIds[0];
      if (!owner) fail(`image ${job.url} has no owning question`);
      const fileName = `${owner.toLowerCase()}.${format.ext}`;
      await writeFile(path.join(IMG_DIR, fileName), bytes);
      const urlExt = path.extname(new URL(job.url).pathname).replace('.', '').toLowerCase();
      const lied = urlExt !== '' && urlExt !== format.ext && !(urlExt === 'jpeg' && format.ext === 'jpg');
      results.set(job.url, {
        repoPath: `img/${fileName}`,
        format: format.label,
        bytes: bytes.byteLength,
        usedBy: job.questionIds,
        urlExtLied: lied,
      });
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`    ${freshDownloads} fresh download(s), ${jobs.length - freshDownloads} from cache`);
  const lies = [...results.values()].filter((m) => m.urlExtLied).length;
  if (lies > 0) {
    console.log(`    ${lies} URL(s) lied about their format; real format taken from magic bytes`);
  }
  return results;
}

/** Removes stale files so public/img/ is exactly the current image set (idempotent re-runs). */
async function pruneImageDir(keep: ReadonlySet<string>): Promise<readonly string[]> {
  const removed: string[] = [];
  for (const entry of await readdir(IMG_DIR)) {
    if (entry.startsWith('.')) continue;
    if (!keep.has(entry)) {
      await unlink(path.join(IMG_DIR, entry));
      removed.push(entry);
    }
  }
  return removed.sort();
}

// ---------------------------------------------------------------------------
// Suspected-untranslated classification
// ---------------------------------------------------------------------------

type Classification = 'likely_proper_noun' | 'genuine_gap';

interface UntranslatedEntry {
  readonly questionId: string;
  readonly language: Language;
  readonly field: string;
  readonly german: string;
  readonly translated: string;
  readonly classification: Classification;
  readonly reason: string;
  /** True when we substituted the German string because upstream shipped an empty value. */
  readonly germanFallback: boolean;
}

/** Multi-token names/places that would otherwise trip the German heuristics below. */
const PROPER_NOUN_PHRASES: ReadonlySet<string> = new Set([
  'Angela Merkel',
  'Bodo Ramelow',
  'Brandenburg an der Havel',
  'Bärbel Bas',
  'Euro Union',
  'Frank-Walter Steinmeier',
  'Frankfurt (Oder)',
  'Frankfurt am Main',
  'Frankfurt/Oder',
  'Friedrich Merz',
  'Gerhard Schröder',
  'Helmut Kohl',
  'Helmut Schmidt',
  'Joachim Gauck',
  'Konrad Adenauer',
  'Kurt Georg Kiesinger',
  'Ludwig Erhard',
  'Ursula von der Leyen',
  'Willy Brandt',
]);

/** Suffixes that mark a German common noun (as opposed to a name that happens to be capitalised). */
const GERMAN_NOUN_SUFFIXES: readonly string[] = [
  'pflicht',
  'verfassung',
  'freiheit',
  'gesetz',
  'recht',
  'rechte',
  'ordnung',
  'schaft',
  'heit',
  'keit',
  'ung',
  'tum',
  'amt',
  'wahl',
  'wahlen',
  'macht',
  'kunft',
  'zeit',
];

/** Closed-class German words. Their presence means the string is German prose, not a name. */
const GERMAN_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des',
  'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'kein', 'keine', 'und', 'oder', 'aber', 'nicht', 'nur', 'auch',
  'mit', 'ohne', 'für', 'von', 'vom', 'zum', 'zur', 'nach', 'bei', 'aus',
  'auf', 'über', 'unter', 'durch', 'gegen',
  'man', 'sich', 'ist', 'sind', 'war', 'waren', 'hat', 'haben',
  'wird', 'werden', 'kann', 'können', 'muss', 'müssen', 'darf', 'dürfen',
  'soll', 'sollen', 'wie', 'was', 'wer', 'wo',
  'welche', 'welcher', 'welches', 'alle', 'allen',
  'ihre', 'ihrer', 'seine', 'im', 'in', 'an', 'am', 'zu',
]);

const GERMAN_MONTHS =
  'Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember';

function stripTrailingPunctuation(s: string): string {
  return s.replace(/[.,;:!?…]+$/u, '').trim();
}

function tokenize(s: string): readonly string[] {
  return s.split(/[\s/]+/u).filter((t) => t.length > 0);
}

function isCapitalized(token: string): boolean {
  const first = token[0];
  return first !== undefined && first === first.toLocaleUpperCase('de-DE') && /\p{L}/u.test(first);
}

/**
 * Classifies a translated-string-equals-German-string hit.
 *
 * Precision over recall by design: downstream agents hand-fix only `genuine_gap`, so a
 * false positive costs human time while a false negative costs nothing but a slightly
 * rougher translation. Non-Latin target scripts normally transliterate, so ambiguous
 * single tokens are treated as gaps there and as identical-by-design in en/tr/fr.
 */
function classify(
  german: string,
  language: Language,
  germanFallback: boolean,
): { classification: Classification; reason: string } {
  const nonLatin = NON_LATIN_LANGUAGES.has(language);
  const core = stripTrailingPunctuation(german);

  // A fallback field has NO upstream translation at all. In a non-Latin script that is
  // always a gap (the reader needs a transliteration), whichever proper noun it is. In a
  // Latin script a city name is legitimately identical, so fall through to the normal rules.
  if (germanFallback && nonLatin) {
    return {
      classification: 'genuine_gap',
      reason: 'no upstream translation existed; Latin-script German fallback needs transliteration',
    };
  }

  // Pure figures / punctuation: years, ages, counts. Identical in every language.
  if (/^[\d\s.,:;%()\-–—/…]+$/u.test(german)) {
    return {
      classification: 'likely_proper_noun',
      reason: 'numeric/punctuation-only string; identical by design in all languages',
    };
  }

  if (PROPER_NOUN_PHRASES.has(core)) {
    return {
      classification: 'likely_proper_noun',
      reason: 'known multi-token proper noun (person/place/institution)',
    };
  }

  // The 16 Bundesland names are kept verbatim in every target language in this data set.
  if (STATES.some((s) => s.name === core)) {
    return { classification: 'likely_proper_noun', reason: 'Bundesland name, kept verbatim' };
  }

  // Acronyms: DDR, USA, CDU, EU, NATO …
  if (/^[\p{Lu}]{2,6}$/u.test(core)) {
    return {
      classification: 'likely_proper_noun',
      reason: 'all-caps abbreviation, conventionally kept as-is',
    };
  }

  // German date format ("9. November", "1. Mai") — target languages reorder these.
  if (new RegExp(`^\\d{1,2}\\.\\s*(?:${GERMAN_MONTHS})$`, 'u').test(core)) {
    return {
      classification: 'genuine_gap',
      reason: 'German day-month date format left untranslated',
    };
  }

  // German gendered pair, e.g. "Senator/Senatorin", "Bürgermeister/Bürgermeisterin".
  if (/^(\p{Lu}[\p{L}]*?)\s*\/\s*\1(?:in|innen)$/u.test(core)) {
    return {
      classification: 'genuine_gap',
      reason: 'German masculine/feminine word pair left untranslated',
    };
  }

  // German common-noun morphology on a capitalised token.
  for (const token of tokenize(core)) {
    if (!isCapitalized(token)) continue;
    const lower = token.toLocaleLowerCase('de-DE');
    const suffix = GERMAN_NOUN_SUFFIXES.find((s) => lower.length > s.length + 2 && lower.endsWith(s));
    if (suffix) {
      return {
        classification: 'genuine_gap',
        reason: `German common noun (-${suffix}) left untranslated: "${token}"`,
      };
    }
  }

  const tokens = tokenize(core);
  const head = tokens[0];
  const tail = tokens[tokens.length - 1];

  // German genitive phrase: "<common noun> <Name>s", e.g. "Tod Adolf Hitlers".
  if (
    tokens.length >= 2 &&
    head !== undefined &&
    tail !== undefined &&
    isCapitalized(head) &&
    isCapitalized(tail) &&
    /s$/u.test(tail)
  ) {
    return {
      classification: 'genuine_gap',
      reason: `German genitive noun phrase left untranslated (head "${head}", genitive "${tail}")`,
    };
  }

  // German prose markers.
  for (const token of tokens) {
    if (GERMAN_FUNCTION_WORDS.has(token.toLocaleLowerCase('de-DE'))) {
      return { classification: 'genuine_gap', reason: `contains German function word "${token}"` };
    }
  }
  if (/ß/u.test(core)) {
    return { classification: 'genuine_gap', reason: 'contains ß, a German-only grapheme' };
  }

  // Single capitalised token: either a name (Berlin, Bundestag, Saarland) or a shared
  // Latin-root cognate (Legislative, Opposition, Monarchie, Presse). Latin scripts keep
  // these legitimately; a non-Latin script would normally transliterate.
  if (tokens.length === 1 && head !== undefined && isCapitalized(head)) {
    return nonLatin
      ? {
          classification: 'genuine_gap',
          reason: 'single Latin-script token left untransliterated in a non-Latin script',
        }
      : {
          classification: 'likely_proper_noun',
          reason: 'single capitalised token: proper noun or shared Latin-root cognate',
        };
  }

  return nonLatin
    ? {
        classification: 'genuine_gap',
        reason: 'Latin-script string left untransliterated in a non-Latin script',
      }
    : {
        classification: 'likely_proper_noun',
        reason: 'no German-specific marker found; plausibly identical by design',
      };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n=== build-questions ===');
  console.log(`  mode: ${OFFLINE ? 'offline (cache only)' : 'online allowed'}`);
  console.log(
    `  translations: ${SEED_TRANSLATIONS ? 'WILL OVERWRITE existing bundles (--seed-translations)' : 'existing bundles preserved'}`,
  );

  const { records, origin } = await loadSource();
  console.log(`  source: ${origin} — ${records.length} records`);

  const expectedTotal = EXPECTED_FEDERAL + STATES.length * QUESTIONS_PER_STATE;
  assert(STATES.length === 16, `expected 16 Bundesländer in STATES, got ${STATES.length}`);
  assert(
    records.length === EXPECTED_SOURCE_COUNT,
    `expected ${EXPECTED_SOURCE_COUNT} source records, got ${records.length}`,
  );
  const distinctNum = new Set(records.map((r) => r.num)).size;
  assert(
    new Set(records.map((r) => r.id)).size === records.length,
    'upstream sha256 ids are not unique',
  );
  flushAsserts();
  console.log(
    `  upstream \`num\` is corrupted (${distinctNum} distinct / ${records.length} rows) — discarded, numbering re-derived`,
  );

  // ---- selection ----------------------------------------------------------
  const federalIndices = selectFederalIndices(records);
  flushAsserts();

  const { assignments, unresolved } = assignStates(records);
  assert(
    unresolved.length === 0,
    `${unresolved.length} state-block record(s) could not be assigned to a Bundesland ` +
      `(source indices ${unresolved.join(', ')}). Neither the question text nor the correct ` +
      `answer names one of the 16 states.`,
  );
  flushAsserts();

  const viaAnswer = assignments.filter((a) => a.via === 'correct-answer-text');
  console.log(
    `  state assignment: ${assignments.length} record(s) — ` +
      `${assignments.length - viaAnswer.length} by question text, ${viaAnswer.length} by correct-answer fallback`,
  );
  for (const a of viaAnswer) {
    console.log(
      `    fallback: idx ${a.sourceIndex} -> ${a.state}  ${JSON.stringify(
        cleanText(records[a.sourceIndex]?.question ?? ''),
      )}`,
    );
  }

  // Group by state, preserving ascending source-index order for `number`.
  const byState = new Map<StateCode, number[]>(STATE_CODES.map((c) => [c, []]));
  for (const a of [...assignments].sort((x, y) => x.sourceIndex - y.sourceIndex)) {
    byState.get(a.state)?.push(a.sourceIndex);
  }

  // ---- patch table --------------------------------------------------------
  const patchHits = new Map<string, number>(PATCHES.map((p) => [p.sourceId, 0]));
  const patchesApplied: string[] = [];
  const synthesized: { questionId: string; field: string; value: string; reason: string }[] = [];
  const synthesizedSourceIds = new Set<string>();

  function applyPatches(
    record: SourceRecord,
    questionId: string,
    draft: { question: string; options: Record<OptionKey, string>; solution: string },
  ): void {
    for (const patch of PATCHES) {
      if (patch.sourceId !== record.id) continue;
      // Fingerprint guard: upstream content must still be exactly what we audited.
      const fingerprintOk =
        patch.match.question === draft.question &&
        OPTION_KEYS.every((k) => patch.match.options[k] === draft.options[k]);
      if (!fingerprintOk) {
        problems.push(
          `patch ${patch.sourceId.slice(0, 12)} matched by id but its content fingerprint no longer ` +
            `matches upstream (reason: ${patch.reason}). Re-audit before shipping. ` +
            `Expected question ${JSON.stringify(patch.match.question)} / options ` +
            `${JSON.stringify(patch.match.options)}; got ${JSON.stringify(draft.question)} / ` +
            `${JSON.stringify(draft.options)}`,
        );
        continue;
      }
      patchHits.set(patch.sourceId, (patchHits.get(patch.sourceId) ?? 0) + 1);
      if (patch.synthesized) synthesizedSourceIds.add(patch.sourceId);

      if (patch.questionText !== undefined) {
        const before = draft.question;
        draft.question = patch.questionText;
        patchesApplied.push(
          `${questionId} question: ${JSON.stringify(before)} -> ${JSON.stringify(patch.questionText)}` +
            ` (${patch.reason})`,
        );
      }
      if (patch.optionText) {
        for (const key of OPTION_KEYS) {
          const replacement = patch.optionText[key];
          if (replacement === undefined) continue;
          const before = draft.options[key];
          draft.options[key] = replacement;
          patchesApplied.push(
            `${questionId} option ${key}: ${JSON.stringify(before)} -> ${JSON.stringify(replacement)}` +
              `${patch.synthesized ? ' [SYNTHESIZED]' : ''} (${patch.reason})`,
          );
          if (patch.synthesized) {
            synthesized.push({
              questionId,
              field: `options.${key}`,
              value: replacement,
              reason: patch.reason,
            });
          }
        }
      }
      if (patch.solution) {
        const before = draft.solution === '' ? '""' : `"${draft.solution}"`;
        draft.solution = patch.solution;
        patchesApplied.push(
          `${questionId} solution: ${before} -> "${patch.solution}" (${patch.reason})`,
        );
      }
    }
  }

  // ---- build records ------------------------------------------------------
  interface Built {
    readonly question: Question;
    readonly source: SourceRecord;
    readonly imageUrl: string | null;
  }

  const built: Built[] = [];

  function build(sourceIndex: number, scope: Scope, number: number, state?: StateCode): void {
    const record = records[sourceIndex];
    if (!record) fail(`no source record at index ${sourceIndex}`);

    const id =
      scope === 'federal'
        ? `F${String(number).padStart(3, '0')}`
        : `${state ?? ''}${String(number).padStart(2, '0')}`;

    const draft = {
      question: cleanText(record.question),
      options: {
        a: cleanText(record.a),
        b: cleanText(record.b),
        c: cleanText(record.c),
        d: cleanText(record.d),
      } as Record<OptionKey, string>,
      solution: record.solution.trim().toLowerCase(),
    };
    applyPatches(record, id, draft);

    if (!OPTION_KEYS.includes(draft.solution as OptionKey)) {
      problems.push(
        `${id} (source idx ${sourceIndex}, id ${record.id.slice(0, 12)}) has invalid solution ` +
          `${JSON.stringify(draft.solution)} — add a PATCHES entry if upstream is broken.`,
      );
    }

    built.push({
      source: record,
      imageUrl: record.image && record.image !== '-' ? record.image : null,
      question: {
        id,
        number,
        scope,
        ...(state === undefined ? {} : { state }),
        question: draft.question,
        options: { a: draft.options.a, b: draft.options.b, c: draft.options.c, d: draft.options.d },
        solution: draft.solution as OptionKey,
        category: categorySlug(record.category),
        explanation: cleanText(record.context ?? ''),
        sourceId: record.id,
      },
    });
  }

  federalIndices.forEach((sourceIndex, i) => build(sourceIndex, 'federal', i + 1));
  for (const code of STATE_CODES) {
    const indices = byState.get(code) ?? [];
    indices.forEach((sourceIndex, i) => build(sourceIndex, 'state', i + 1, code));
  }

  // Checked BEFORE flushing the per-record problems, so a rotted patch is always reported
  // alongside (not masked by) the downstream breakage it causes.
  for (const patch of PATCHES) {
    const hits = patchHits.get(patch.sourceId) ?? 0;
    assert(
      hits === 1,
      `patch ${patch.sourceId.slice(0, 12)} (${patch.reason}) matched ${hits} record(s), expected exactly 1. ` +
        `The patch table has rotted — remove or re-target the entry.`,
    );
  }
  flushAsserts();

  if (patchesApplied.length > 0) {
    console.log(`\n  !! ${patchesApplied.length} PATCH(ES) APPLIED:`);
    for (const p of patchesApplied) console.log(`     ${p}`);
    console.log('');
  }

  // ---- full-tuple duplicate detection ------------------------------------
  // Duplicate *question stems* are legitimate: the official catalogue reuses a stem with
  // different option sets. Only a full (question + all four options) collision is a real
  // duplicate.
  const tupleGroups = new Map<string, Built[]>();
  for (const b of built) {
    const key = [b.question.question, ...OPTION_KEYS.map((k) => b.question.options[k])].join('\u0000');
    const group = tupleGroups.get(key);
    if (group) group.push(b);
    else tupleGroups.set(key, [b]);
  }
  for (const group of [...tupleGroups.values()].filter((g) => g.length > 1)) {
    problems.push(
      `real duplicate (question + all 4 options identical): ${group
        .map((b) => `${b.question.id}/${b.question.sourceId.slice(0, 12)}`)
        .join(', ')} — ${JSON.stringify(group[0]?.question.question ?? '')}. Reporting rather than ` +
        `dropping silently: a drop would break the "exactly 10 per state" invariant.`,
    );
  }
  flushAsserts();

  // Informational, non-fatal: shared stems with distinct option sets.
  const stemGroups = new Map<string, string[]>();
  for (const b of built) {
    const list = stemGroups.get(b.question.question);
    if (list) list.push(b.question.id);
    else stemGroups.set(b.question.question, [b.question.id]);
  }
  const sharedStems = [...stemGroups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .sort((x, y) => y[1].length - x[1].length || (x[0] < y[0] ? -1 : 1));

  // ---- images -------------------------------------------------------------
  const imageRefs = built
    .filter((b) => b.imageUrl !== null)
    .map((b) => ({ questionId: b.question.id, url: b.imageUrl as string }));
  console.log(
    `  image references across all ${built.length} records: ${imageRefs.length} ` +
      `(${new Set(imageRefs.map((r) => r.url)).size} unique URL(s))`,
  );
  const mirrored = await mirrorImages(imageRefs);
  const pruned = await pruneImageDir(new Set([...mirrored.values()].map((m) => path.basename(m.repoPath))));
  if (pruned.length > 0) console.log(`    pruned ${pruned.length} stale file(s): ${pruned.join(', ')}`);

  // Re-emit in a single fixed key order (schema order, optional fields in position, omitted
  // when absent) so questions.json diffs stay stable and readable.
  const questions: Question[] = built.map((b) => {
    let image: string | undefined;
    if (b.imageUrl !== null) {
      const mirror = mirrored.get(b.imageUrl);
      if (!mirror) fail(`image not mirrored for ${b.question.id}: ${b.imageUrl}`);
      image = mirror.repoPath;
    }
    const q = b.question;
    return {
      id: q.id,
      number: q.number,
      scope: q.scope,
      ...(q.state === undefined ? {} : { state: q.state }),
      question: q.question,
      options: { a: q.options.a, b: q.options.b, c: q.options.c, d: q.options.d },
      solution: q.solution,
      category: q.category,
      explanation: q.explanation,
      ...(image === undefined ? {} : { image }),
      sourceId: q.sourceId,
    };
  });

  // ---- translations -------------------------------------------------------
  // Upstream ships all four translated options as empty strings for the two broken
  // Landeshauptstadt records. Rather than emit empty values (which would render as blank
  // buttons), fall back to the German string and log every substitution.
  const bundles = new Map<Language, Record<string, TranslatedQuestion>>();
  const fallbackFields = new Set<string>(); // `${id}|${lang}|${field}`
  const fallbackLog: string[] = [];
  const emptyExplanations: string[] = [];

  for (const lang of LANGUAGES) {
    const bundle: Record<string, TranslatedQuestion> = {};
    for (const b of built) {
      const q = b.question;
      const t = b.source.translation?.[lang];
      if (!t) {
        problems.push(`${q.id}: missing translation object for "${lang}"`);
        continue;
      }
      const take = (translated: string, german: string, field: string): string => {
        const value = cleanText(translated ?? '');
        if (value !== '') return value;
        if (german === '') return '';
        fallbackFields.add(`${q.id}|${lang}|${field}`);
        fallbackLog.push(`${q.id}/${lang}:${field}`);
        return german;
      };

      const entry: TranslatedQuestion = {
        question: take(t.question, q.question, 'question'),
        options: {
          a: take(t.a, q.options.a, 'options.a'),
          b: take(t.b, q.options.b, 'options.b'),
          c: take(t.c, q.options.c, 'options.c'),
          d: take(t.d, q.options.d, 'options.d'),
        },
        explanation: cleanText(t.context ?? ''),
      };
      if (entry.question === '') problems.push(`${q.id}/${lang}: empty translated question`);
      for (const k of OPTION_KEYS) {
        if (entry.options[k] === '') problems.push(`${q.id}/${lang}: empty translated option ${k}`);
      }
      if (entry.explanation === '') emptyExplanations.push(`${q.id}/${lang}`);
      bundle[q.id] = entry;
    }
    bundles.set(lang, bundle);
  }
  flushAsserts();

  // ---- untranslated report -----------------------------------------------
  const entries: UntranslatedEntry[] = [];
  const summary: Record<string, unknown> = {};

  for (const lang of LANGUAGES) {
    const bundle = bundles.get(lang);
    if (!bundle) fail(`missing bundle for ${lang}`);
    let identical = 0;
    let comparable = 0;
    let gaps = 0;
    let properNouns = 0;

    for (const q of questions) {
      const t = bundle[q.id];
      if (!t) fail(`missing ${lang} entry for ${q.id}`);
      const pairs = [
        { field: 'question', de: q.question, tr: t.question },
        ...OPTION_KEYS.map((k) => ({ field: `options.${k}`, de: q.options[k], tr: t.options[k] })),
        { field: 'explanation', de: q.explanation, tr: t.explanation },
      ];
      for (const { field, de, tr } of pairs) {
        if (de === '') continue;
        comparable += 1;
        if (de !== tr) continue;
        identical += 1;
        const germanFallback = fallbackFields.has(`${q.id}|${lang}|${field}`);
        const { classification, reason } = classify(de, lang, germanFallback);
        if (classification === 'genuine_gap') gaps += 1;
        else properNouns += 1;
        entries.push({
          questionId: q.id,
          language: lang,
          field,
          german: de,
          translated: tr,
          classification,
          reason: germanFallback ? `upstream translation was empty; German fallback emitted — ${reason}` : reason,
          germanFallback,
        });
      }
    }

    summary[lang] = {
      comparableFields: comparable,
      identicalToGerman: identical,
      identicalPct: Number(((identical / comparable) * 100).toFixed(2)),
      genuineGap: gaps,
      likelyProperNoun: properNouns,
      script: NON_LATIN_LANGUAGES.has(lang) ? 'non-latin' : 'latin',
    };
  }

  const langOrder = new Map<Language, number>(LANGUAGES.map((l, i) => [l, i]));
  entries.sort(
    (x, y) =>
      (langOrder.get(x.language) ?? 0) - (langOrder.get(y.language) ?? 0) ||
      (x.questionId < y.questionId ? -1 : x.questionId > y.questionId ? 1 : 0) ||
      (x.field < y.field ? -1 : x.field > y.field ? 1 : 0),
  );

  // ---- write outputs ------------------------------------------------------
  await mkdir(I18N_DIR, { recursive: true });
  await writeFile(path.join(DATA_DIR, 'questions.json'), orderedStringify(questions), 'utf8');

  // The translation bundles are a ONE-TIME seed, not a reproducible output.
  //
  // Upstream's machine translations shipped with real defects — lost negations
  // ("Was ist *nicht* erlaubt?" rendered as "What is allowed?"), sentences welded
  // together mid-clause, German common nouns transliterated as if they were proper
  // names ("Tod Adolf Hitlers" -> "Tod" as a first name), and protected terms
  // dropped. Those were repaired by hand across all seven languages: several
  // thousand edits that exist ONLY in these files, because there is no upstream
  // source to regenerate them from and no patch table that could express them.
  //
  // So unlike `questions.json` — whose every correction lives in the fingerprinted
  // PATCHES table above and is reproduced byte-for-byte on every build — rewriting
  // these files is pure data loss. An unguarded overwrite here has already
  // destroyed in-progress repair work once. A comment was not enough to prevent
  // it, so the default is now refusal: you must opt in per run, in the command
  // line, where it cannot be missed.
  const bundlePaths = LANGUAGES.map((lang) => ({
    lang,
    file: path.join(I18N_DIR, `questions.${lang}.json`),
  }));
  const existing: string[] = [];
  for (const { file } of bundlePaths) {
    if (await exists(file)) existing.push(path.relative(process.cwd(), file));
  }

  if (existing.length > 0 && !SEED_TRANSLATIONS) {
    console.log(
      `\n  translation bundles: SKIPPED — ${existing.length} already exist and hold hand-repaired text.\n` +
        `    These files are NOT regenerable: upstream's translations contain defects that were\n` +
        `    fixed by hand, and those fixes have no representation in this script. Overwriting them\n` +
        `    loses that work permanently — git is the only copy, so uncommitted repairs are gone.\n` +
        `    To overwrite anyway (e.g. re-seeding from scratch, or adding a new language), pass\n` +
        `    --seed-translations. Commit or stash the existing files first.`,
    );
  } else {
    for (const { lang, file } of bundlePaths) {
      const bundle = bundles.get(lang);
      if (!bundle) fail(`missing bundle for ${lang}`);
      await writeFile(file, stableStringify(bundle), 'utf8');
    }
    if (existing.length > 0) {
      console.log(
        `\n  translation bundles: OVERWRITTEN (--seed-translations) — ${existing.length} file(s) replaced with upstream text.\n` +
          `    Every hand repair in them is gone. Check \`git diff\` before committing.`,
      );
    }
  }

  await writeFile(
    path.join(DATA_DIR, 'untranslated-report.json'),
    stableStringify({
      generatedBy: 'scripts/build-questions.ts',
      description:
        'Fields whose translated string is byte-identical to the cleaned German source. ' +
        'Only `genuine_gap` entries need a human fix; `likely_proper_noun` entries are ' +
        'identical by design (names, places, acronyms, numerals, shared Latin-root cognates). ' +
        'Entries with `germanFallback: true` had NO upstream translation at all — the German ' +
        'string was substituted so the UI never renders a blank option.',
      questionCount: questions.length,
      summary,
      totals: {
        entries: entries.length,
        genuineGap: entries.filter((e) => e.classification === 'genuine_gap').length,
        likelyProperNoun: entries.filter((e) => e.classification === 'likely_proper_noun').length,
        germanFallback: entries.filter((e) => e.germanFallback).length,
      },
      synthesizedContent: {
        note:
          'These option strings are NOT from upstream — upstream shipped empty strings and an ' +
          'empty solution for these records, so the option sets were reconstructed. Verify them.',
        fields: synthesized,
      },
      emptyTranslatedExplanations: emptyExplanations,
      germanFallbackFields: fallbackLog.slice().sort(),
      entries,
    }),
    'utf8',
  );

  await writeFile(path.join(DATA_DIR, 'categories.ts'), renderCategoriesModule(questions), 'utf8');

  // `wappen` is derived from the data, not guessed: each state's "Welches Wappen gehört zu …"
  // question, when it carries an image, supplies that state's coat-of-arms figure.
  const wappenByState = new Map<StateCode, string | null>(STATE_CODES.map((c) => [c, null]));
  for (const q of questions) {
    if (q.scope !== 'state' || q.state === undefined) continue;
    if (!/\bWappen\b/.test(q.question)) continue;
    if (q.image === undefined) continue;
    if (wappenByState.get(q.state) === null) wappenByState.set(q.state, q.image);
  }
  await writeFile(path.join(DATA_DIR, 'states.ts'), renderStatesModule(wappenByState), 'utf8');

  // ---- hard asserts -------------------------------------------------------
  console.log('  asserting invariants …');

  // 1 total count
  assert(questions.length === expectedTotal, `expected ${expectedTotal} records, got ${questions.length}`);
  // 2 scope split
  const federalCount = questions.filter((q) => q.scope === 'federal').length;
  const stateCount = questions.filter((q) => q.scope === 'state').length;
  assert(federalCount === EXPECTED_FEDERAL, `expected ${EXPECTED_FEDERAL} federal, got ${federalCount}`);
  assert(
    stateCount === STATES.length * QUESTIONS_PER_STATE,
    `expected ${STATES.length * QUESTIONS_PER_STATE} state records, got ${stateCount}`,
  );
  // 3 exactly 10 per state — the single most important invariant: a state silently short one
  // question ships a broken deck to every user who picks it.
  const perState = new Map<StateCode, number>(STATE_CODES.map((c) => [c, 0]));
  for (const q of questions) {
    if (q.scope === 'state' && q.state !== undefined) {
      perState.set(q.state, (perState.get(q.state) ?? 0) + 1);
    }
  }
  for (const code of STATE_CODES) {
    const n = perState.get(code) ?? 0;
    assert(
      n === QUESTIONS_PER_STATE,
      `state ${code} (${STATE_BY_CODE.get(code)?.name}) has ${n} question(s), expected exactly ${QUESTIONS_PER_STATE}`,
    );
  }
  // 4 state field presence/validity
  const validCodes = new Set<string>(STATE_CODES);
  for (const q of questions) {
    if (q.scope === 'state') {
      if (q.state === undefined) problems.push(`${q.id}: scope 'state' but no state field`);
      else if (!validCodes.has(q.state)) problems.push(`${q.id}: invalid state code "${q.state}"`);
      else if (!q.id.startsWith(q.state)) problems.push(`${q.id}: id prefix does not match state ${q.state}`);
    } else if (q.state !== undefined) {
      problems.push(`${q.id}: federal record must not carry a state field (got "${q.state}")`);
    }
  }
  // 5 ids + per-record validity
  const idPattern = new RegExp(`^(F\\d{3}|(?:${STATE_CODES.join('|')})\\d{2})$`);
  const seenIds = new Set<string>();
  for (const q of questions) {
    if (!OPTION_KEYS.includes(q.solution)) problems.push(`${q.id}: solution "${q.solution}" not in a..d`);
    if (q.question === '') problems.push(`${q.id}: empty question`);
    for (const k of OPTION_KEYS) {
      if (q.options[k] === '') problems.push(`${q.id}: empty option ${k}`);
    }
    if (!idPattern.test(q.id)) problems.push(`${q.id}: id does not match ${idPattern}`);
    if (seenIds.has(q.id)) problems.push(`duplicate id ${q.id}`);
    seenIds.add(q.id);
  }
  // 6 tuple uniqueness (collisions already reported above; re-stated as a count check)
  assert(
    tupleGroups.size === questions.length,
    `(question + 4 options) tuples are not unique: ${tupleGroups.size} distinct for ${questions.length} records`,
  );
  // 7 images resolve on disk
  for (const q of questions) {
    if (q.image === undefined) continue;
    if (!(await exists(path.join(PUBLIC_DIR, q.image)))) {
      problems.push(`${q.id}: image "${q.image}" missing on disk`);
    }
  }
  // 8 no origin host leaks
  const emitted: readonly string[] = [
    path.join(DATA_DIR, 'questions.json'),
    path.join(DATA_DIR, 'untranslated-report.json'),
    path.join(DATA_DIR, 'categories.ts'),
    path.join(DATA_DIR, 'states.ts'),
    ...LANGUAGES.map((l) => path.join(I18N_DIR, `questions.${l}.json`)),
  ];
  for (const file of emitted) {
    if ((await readFile(file, 'utf8')).includes('foreignvasi')) {
      problems.push(`${path.relative(REPO_ROOT, file)} still contains "foreignvasi"`);
    }
  }
  // 9 translation bundles 1:1
  for (const lang of LANGUAGES) {
    const bundle = bundles.get(lang);
    if (!bundle) {
      problems.push(`missing bundle for ${lang}`);
      continue;
    }
    const keys = Object.keys(bundle);
    if (keys.length !== expectedTotal) {
      problems.push(`questions.${lang}.json has ${keys.length} keys, expected ${expectedTotal}`);
    }
    const missing = questions.filter((q) => !(q.id in bundle)).map((q) => q.id);
    const extra = keys.filter((k) => !seenIds.has(k));
    if (missing.length > 0) problems.push(`questions.${lang}.json missing ids: ${missing.join(', ')}`);
    if (extra.length > 0) problems.push(`questions.${lang}.json has unknown ids: ${extra.join(', ')}`);
  }
  // 10 patch table freshness (asserted earlier; re-stated for completeness)
  assert(
    PATCHES.every((p) => (patchHits.get(p.sourceId) ?? 0) === 1),
    'patch table did not apply exactly once per entry',
  );

  flushAsserts();
  console.log('  all invariants hold.');

  // ---- summary ------------------------------------------------------------
  const categoryCounts = new Map<CategorySlug, number>();
  for (const q of questions) categoryCounts.set(q.category, (categoryCounts.get(q.category) ?? 0) + 1);

  console.log('\n=== SUMMARY ===');
  console.log(`  records:            ${questions.length} (federal ${federalCount}, state ${stateCount})`);
  console.log(`  patches applied:    ${patchesApplied.length} (${synthesized.length} synthesized field(s))`);
  console.log('\n  per-state counts (must all be 10):');
  for (const state of STATES) {
    const n = perState.get(state.code) ?? 0;
    const wappen = wappenByState.get(state.code);
    console.log(
      `      ${state.code}  ${state.name.padEnd(23)} ${String(n).padStart(2)}  ` +
        `${state.isCityState ? 'Stadtstaat' : '          '}  wappen: ${wappen ?? '(none)'}`,
    );
  }
  console.log(
    `\n  images mirrored:    ${mirrored.size} unique file(s) for ${imageRefs.length} reference(s) -> public/img/`,
  );
  const formats = new Map<string, number>();
  for (const m of mirrored.values()) formats.set(m.format, (formats.get(m.format) ?? 0) + 1);
  console.log(
    `      real formats: ${[...formats.entries()].sort().map(([f, n]) => `${f} x${n}`).join(', ')}` +
      `  |  URLs whose extension lied: ${[...mirrored.values()].filter((m) => m.urlExtLied).length}`,
  );
  const shared = [...mirrored.values()].filter((m) => m.usedBy.length > 1);
  for (const m of shared) console.log(`      shared file ${m.repoPath} used by ${m.usedBy.join(', ')}`);
  console.log('  categories:');
  for (const [label, slug] of Object.entries(CATEGORY_SLUGS).sort((x, y) => (x[1] < y[1] ? -1 : 1))) {
    console.log(`      ${slug.padEnd(20)} ${String(categoryCounts.get(slug) ?? 0).padStart(3)}  "${label}"`);
  }
  console.log('  untranslated report:');
  for (const lang of LANGUAGES) {
    const s = summary[lang] as {
      identicalToGerman: number;
      identicalPct: number;
      genuineGap: number;
      likelyProperNoun: number;
    };
    console.log(
      `      ${lang}  identical ${String(s.identicalToGerman).padStart(3)} (${String(s.identicalPct).padStart(5)}%)  ` +
        `genuine_gap ${String(s.genuineGap).padStart(3)}  likely_proper_noun ${String(s.likelyProperNoun).padStart(3)}`,
    );
  }
  console.log(`      German fallbacks (upstream translation empty): ${fallbackLog.length}`);
  console.log(`      empty translated explanations: ${emptyExplanations.length}`);
  console.log(`  shared question stems (legitimate, distinct option sets): ${sharedStems.length} group(s)`);
  for (const [stem, ids] of sharedStems) {
    console.log(`      x${ids.length}  ${ids.join(', ')}  ${stem.slice(0, 62)}${stem.length > 62 ? '…' : ''}`);
  }
  if (synthesized.length > 0) {
    console.log(`\n  !! SYNTHESIZED CONTENT — needs human verification (${synthesized.length} field(s)):`);
    for (const s of synthesized) console.log(`      ${s.questionId} ${s.field} = ${JSON.stringify(s.value)}`);
  }
  console.log('\n  wrote:');
  console.log('      src/data/questions.json');
  console.log('      src/data/categories.ts');
  console.log('      src/data/states.ts');
  console.log('      src/data/untranslated-report.json');
  console.log(`      src/data/i18n/questions.{${LANGUAGES.join(',')}}.json`);
  console.log(`      public/img/ (${mirrored.size} file(s))`);
  console.log('\n✓ build:questions OK\n');
}

// ---------------------------------------------------------------------------
// Generated TS modules
// ---------------------------------------------------------------------------

function renderCategoriesModule(questions: readonly Question[]): string {
  const counts = new Map<CategorySlug, number>();
  for (const q of questions) counts.set(q.category, (counts.get(q.category) ?? 0) + 1);
  const rows = Object.entries(CATEGORY_SLUGS)
    .map(([label, slug]) => ({ label, slug }))
    .sort((x, y) => (x.slug < y.slug ? -1 : 1));

  return [
    '// GENERATED FILE — do not edit by hand.',
    '// Source: scripts/build-questions.ts (npm run build:questions)',
    '',
    '/** Stable slug ids for the 10 upstream question categories. */',
    'export const CATEGORY_IDS = [',
    ...rows.map((r) => `  '${r.slug}',`),
    '] as const;',
    '',
    'export type CategoryId = (typeof CATEGORY_IDS)[number];',
    '',
    '/** Slug -> original upstream English category label. */',
    'export const CATEGORY_LABELS: Record<CategoryId, string> = {',
    ...rows.map((r) => `  '${r.slug}': '${escapeSingle(r.label)}',`),
    '};',
    '',
    '/**',
    ' * Number of shipped questions per category (informational).',
    ` * Total: ${questions.length} records.`,
    ' */',
    'export const CATEGORY_COUNTS: Record<CategoryId, number> = {',
    ...rows.map((r) => `  '${r.slug}': ${counts.get(r.slug) ?? 0},`),
    '};',
    '',
    'export function isCategoryId(value: string): value is CategoryId {',
    '  return (CATEGORY_IDS as readonly string[]).includes(value);',
    '}',
    '',
  ].join('\n');
}

function renderStatesModule(wappen: ReadonlyMap<StateCode, string | null>): string {
  return [
    '// GENERATED FILE — do not edit by hand.',
    '// Source: scripts/build-questions.ts (npm run build:questions)',
    '',
    '/** ISO 3166-2:DE subdivision codes for the 16 Bundesländer. */',
    'export const STATE_CODES = [',
    ...STATES.map((s) => `  '${s.code}',`),
    '] as const;',
    '',
    'export type StateCode = (typeof STATE_CODES)[number];',
    '',
    'export interface State {',
    '  /** ISO 3166-2:DE subdivision code, e.g. "BW". */',
    '  readonly code: StateCode;',
    '  /** Official German name. */',
    '  readonly name: string;',
    '  /** True for the three Stadtstaaten (Berlin, Bremen, Hamburg). */',
    '  readonly isCityState: boolean;',
    "  /** Repo-relative path to this state's coat of arms, or null when none is available. */",
    '  readonly wappen: string | null;',
    '}',
    '',
    '/** All 16 Bundesländer in conventional German alphabetical order by name. */',
    'export const STATES: readonly State[] = [',
    ...STATES.map((s) => {
      const w = wappen.get(s.code);
      return (
        `  { code: '${s.code}', name: '${escapeSingle(s.name)}', ` +
        `isCityState: ${s.isCityState}, wappen: ${w === null || w === undefined ? 'null' : `'${w}'`} },`
      );
    }),
    '];',
    '',
    'export const STATES_BY_CODE: Record<StateCode, State> = Object.fromEntries(',
    '  STATES.map((s) => [s.code, s]),',
    ') as Record<StateCode, State>;',
    '',
    'export function isStateCode(value: string): value is StateCode {',
    '  return (STATE_CODES as readonly string[]).includes(value);',
    '}',
    '',
  ].join('\n');
}

function escapeSingle(s: string): string {
  return s.replace(/['\\]/g, '\\$&');
}

await main();
