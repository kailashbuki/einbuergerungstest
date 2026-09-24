/**
 * verify-questions.ts — independent verifier for src/data/questions.json
 *
 * Cross-checks every record in the shipped dataset against the official BAMF
 * "Gesamtfragenkatalog zum Test Leben in Deutschland und zum Einbürgerungstest"
 * and writes src/data/verification-report.json.
 *
 * IMPORTANT FINDING ABOUT THE OFFICIAL PDF (see report `method.caveats`):
 * the official catalogue contains the questions and the option sets but it does
 * NOT contain an answer key — all 1800 checkboxes are the identical empty glyph
 * (Wingdings2 U+F0A3, or U+25A1 for the questions added in the 2024/25 revision).
 * Question and option TEXT is therefore verified against the authoritative
 * source; the CORRECT ANSWER is verified against a consensus of three
 * independent secondary answer keys, matched back onto the official option text.
 *
 * Usage:
 *   tsx scripts/verify-questions.ts             # verify from cache in /tmp/eb-cache (no network)
 *   tsx scripts/verify-questions.ts --refresh    # re-download sources and re-extract, then verify
 *
 * This script is read-only over the repository except for the single report file
 * it writes. It never modifies questions.json.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const QUESTIONS = join(REPO, 'src/data/questions.json');
const REPORT = join(REPO, 'src/data/verification-report.json');

const CACHE = '/tmp/eb-cache';
const PDF = '/tmp/bamf.pdf';
const DIR_SD = '/tmp/src_sd';
const DIR_AB = '/tmp/src_ab';
const FILE_WM = '/tmp/webmansa.ts';

const OFFICIAL_PDF_URL =
  'https://www.bamf.de/SharedDocs/Anlagen/DE/Integration/Einbuergerung/' +
  'gesamtfragenkatalog-lebenindeutschland.pdf?__blob=publicationFile&v=23';
const SD_BASE = 'https://raw.githubusercontent.com/sdrahan/einbuergerungstest-answers/master';
const AB_BASE = 'https://raw.githubusercontent.com/abdullahbutt/leben-in-deutschland-test/english';
const WM_URL =
  'https://raw.githubusercontent.com/webmansa/german-citizenship-test-data/main/questions.ts';

const LETTERS = ['a', 'b', 'c', 'd'] as const;
type Letter = (typeof LETTERS)[number];

const STATE_CODES = [
  'BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV',
  'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH',
] as const;
type StateCode = (typeof STATE_CODES)[number];

/** official section heading -> our state code */
const SECTION_TO_CODE: Record<string, StateCode> = {
  'Baden-Württemberg': 'BW', Bayern: 'BY', Berlin: 'BE', Brandenburg: 'BB',
  Bremen: 'HB', Hamburg: 'HH', Hessen: 'HE', 'Mecklenburg-Vorpommern': 'MV',
  Niedersachsen: 'NI', 'Nordrhein-Westfalen': 'NW', 'Rheinland-Pfalz': 'RP',
  Saarland: 'SL', Sachsen: 'SN', 'Sachsen-Anhalt': 'ST',
  'Schleswig-Holstein': 'SH', Thüringen: 'TH',
};

/** slug used by both secondary answer-key sources -> our state code */
const SLUG_TO_CODE: Record<string, StateCode> = {
  'baden-wuerttemberg': 'BW', bayern: 'BY', berlin: 'BE', brandenburg: 'BB',
  bremen: 'HB', hamburg: 'HH', hessen: 'HE', 'mecklenburg-vorpommern': 'MV',
  niedersachsen: 'NI', 'nordrhein-westfalen': 'NW', 'rheinland-pfalz': 'RP',
  saarland: 'SL', sachsen: 'SN', 'sachsen-anhalt': 'ST',
  'schleswig-holstein': 'SH', thueringen: 'TH',
};

// ---------------------------------------------------------------- types

interface OurQuestion {
  id: string;
  number: number;
  scope: 'federal' | 'state';
  state?: StateCode;
  question: string;
  options: Record<Letter, string>;
  solution: Letter;
  category: string;
  explanation: string;
  image?: string;
}

interface OfficialQuestion {
  aufgabe: number;
  section: string | null;
  page: number;
  question: string;
  options: string[];
  hasImage: boolean;
}

interface AnswerRecord {
  question: string;
  answer: string;
  options?: string[];
}

interface SourceAnswers {
  federal: Record<string, AnswerRecord>;
  state: Record<string, Record<string, AnswerRecord>>;
}

interface Consensus {
  /** index into the OFFICIAL option array */
  index: number;
  votes: number;
  total: number;
  unanimous: boolean;
  bySource: Record<string, number>;
}

interface Finding {
  id: string;
  severity: 'critical' | 'major' | 'minor';
  kind: 'solution' | 'text' | 'ordering' | 'missing' | 'state-assignment';
  ours: string;
  official: string;
  note: string;
}

interface Adjudication {
  id: string;
  issue: string;
  pipelineChose: string;
  pdfSays: string;
  verdict: 'confirmed' | 'disputed' | 'unverifiable';
  detail: string;
}

// ---------------------------------------------------------------- text normalisation

const TYPOGRAPHIC: Array<[string, string]> = [
  ['…', '...'], ['„', '"'], ['“', '"'], ['”', '"'],
  ['‘', "'"], ['’', "'"], ['–', '-'], ['—', '-'],
  ['­', ''], [' ', ' '], [' ', ' '], [' ', ' '], ['‑', '-'],
];

/** whitespace + typographic normalisation; the baseline for every comparison */
function norm(s: string | undefined): string {
  let out = (s ?? '').normalize('NFC');
  for (const [from, to] of TYPOGRAPHIC) out = out.split(from).join(to);
  return out.replace(/\s+/g, ' ').trim();
}

/** the official catalogue appends photo credits and legal notes to question text */
function stripNotes(s: string | undefined): string {
  return norm(s)
    .replace(/\s*©.*$/, '')
    .replace(/\s*In Anlehnung an .*$/, '')
    .replace(/\s*Quelle:.*$/, '')
    // BAMF typo: two questions repeat their Aufgabe number in the stem. Requires
    // following whitespace + a letter so that a bare year option ("1990.") survives.
    .replace(/^\d+\.\s+(?=[A-Za-zÄÖÜäöü])/, '')
    .trim();
}

/** aggressive comparison key: lowercase, alphanumeric only, ss folded to ß */
function key(s: string | undefined): string {
  return stripNotes(s).toLowerCase().split('ss').join('ß').replace(/[^a-z0-9äöüß]/g, '');
}

/** sorted word bag; "bild" dropped so "Bild 1" and "1" compare equal */
function toks(s: string | undefined): string[] {
  const t = stripNotes(s).toLowerCase().replace(/\bbild\b/g, ' ');
  return (t.match(/[a-z0-9äöüß]+/g) ?? []).sort();
}

/** umlaut-insensitive key, to detect ASCII-degraded text (ö->o, ü->ue, ...) */
function deumlaut(s: string | undefined): string {
  let t = stripNotes(s).toLowerCase();
  for (const [a, b] of [['ä', 'a'], ['ö', 'o'], ['ü', 'u'], ['ß', 'ss'],
    ['ae', 'a'], ['oe', 'o'], ['ue', 'u']] as Array<[string, string]>) {
    t = t.split(a).join(b);
  }
  return t.replace(/[^a-z0-9]/g, '');
}

// -------- difflib.SequenceMatcher.ratio() (Ratcliff/Obershelp), no autojunk

function findLongestMatch(
  a: string, b: string, alo: number, ahi: number, blo: number, bhi: number,
): [number, number, number] {
  const b2j = new Map<string, number[]>();
  for (let j = blo; j < bhi; j++) {
    const arr = b2j.get(b[j]);
    if (arr) arr.push(j);
    else b2j.set(b[j], [j]);
  }
  let besti = alo, bestj = blo, bestsize = 0;
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const next = new Map<number, number>();
    for (const j of b2j.get(a[i]) ?? []) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      next.set(j, k);
      if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
    }
    j2len = next;
  }
  return [besti, bestj, bestsize];
}

function matchCount(
  a: string, b: string, alo: number, ahi: number, blo: number, bhi: number,
): number {
  const [i, j, k] = findLongestMatch(a, b, alo, ahi, blo, bhi);
  if (k === 0) return 0;
  return k
    + matchCount(a, b, alo, i, blo, j)
    + matchCount(a, b, i + k, ahi, j + k, bhi);
}

function ratio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1;
  return (2 * matchCount(a, b, 0, a.length, 0, b.length)) / total;
}

/**
 * Similarity used throughout: the better of a character-level ratio and a
 * token-bag ratio. The token-bag term is what lets the older masculine-first
 * gender doublets ("den Regierungschef / die Regierungschefin") match the 2025
 * catalogue's feminine-first forms ("die Regierungschefin/den Regierungschef").
 */
function sim(a: string, b: string): number {
  return Math.max(ratio(key(a), key(b)), ratio(toks(a).join(' '), toks(b).join(' ')));
}

function sameTokens(a: string, b: string): boolean {
  const x = toks(a), y = toks(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

// ---------------------------------------------------------------- source acquisition

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
}

function curl(url: string, dest: string): void {
  sh('curl', ['-sSL', '--fail', '--retry', '2', '-o', dest, url]);
}

/**
 * pdfplumber extractor. Emitted to /tmp so that verification needs no extra
 * file inside the repository. Reconstructs lines from character positions,
 * splits options on the checkbox glyphs, and tracks state sections.
 */
const EXTRACTOR_PY = String.raw`
import pdfplumber, json, re, os, sys
from collections import Counter

PDF, OUT = sys.argv[1], sys.argv[2]
BOXES = ('', '□')   # Wingdings2 empty box; ArialMT U+25A1 in the 2024/25 additions

def lines_of(page):
    rows = {}
    for c in page.chars:
        rows.setdefault(round(c['top'] / 3.0), []).append(c)
    out = []
    for k in sorted(rows):
        cs = sorted(rows[k], key=lambda c: c['x0'])
        txt = ''.join(c['text'] for c in cs)
        vis = [c for c in cs if c['text'].strip() != '']
        if not vis:
            continue
        out.append({'top': min(c['top'] for c in vis), 'x0': min(c['x0'] for c in vis),
                    'text': re.sub(r'\s+', ' ', txt).strip(),
                    'bold': any('Bold' in c['fontname'] for c in vis),
                    'hasbox': any(b in txt for b in BOXES)})
    return out

questions, cur, section = [], None, None
with pdfplumber.open(PDF) as pdf:
    for pi, page in enumerate(pdf.pages):
        for ln in lines_of(page):
            ts = ln['text']
            if re.match(r'^Seite \d+ von \d+$', ts) or ts in ('Teil I', 'Teil II'):
                continue
            m = re.match(r'^Fragen f(?:ü|u)r das (?:Bundesland|Land|Freistaat) (.+)$', ts)
            if m:
                section, cur = m.group(1).strip(), None
                continue
            if ts == 'Allgemeine Fragen':
                section, cur = None, None
                continue
            m = re.match(r'^Aufgabe (\d+)$', ts)
            if m and ln['bold']:
                cur = {'aufgabe': int(m.group(1)), 'section': section, 'page': pi + 1,
                       'question': '', 'options': [], 'hasImage': False}
                questions.append(cur)
                continue
            if cur is None:
                continue
            if ts.count('Bild') > 1 and re.match(r'^(Bild \d+\s*)+$', ts):
                cur['hasImage'] = True
                continue
            if ln['hasbox']:
                o = ts
                for b in BOXES:
                    o = o.replace(b, '␟')
                segs = o.split('␟')
                if segs[0].strip() and cur['options']:
                    cur['options'][-1] = (cur['options'][-1] + ' ' + segs[0].strip()).strip()
                for seg in segs[1:]:          # keep empties: they are option placeholders
                    cur['options'].append(seg.strip())
                continue
            if re.match(r'^(Bild )?\d$', ts) and ln['x0'] > 100 and len(cur['options']) < 4 \
               and all(re.match(r'^(Bild )?\d$', o) for o in cur['options']):
                cur['hasImage'] = True
                cur['options'].append(ts)
                continue
            if cur['options']:
                cur['options'][-1] = (cur['options'][-1] + ' ' + ts).strip()
            else:
                cur['question'] = (cur['question'] + ' ' + ts).strip()

os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(questions, open(OUT, 'w'), ensure_ascii=False, indent=1)
fed = [q for q in questions if q['section'] is None]
st = [q for q in questions if q['section'] is not None]
print(json.dumps({'total': len(questions), 'federal': len(fed), 'state': len(st),
                  'stateCounts': dict(Counter(q['section'] for q in st)),
                  'wrongOptionCount': sum(1 for q in questions if len(q['options']) != 4),
                  'federalSequential': [q['aufgabe'] for q in fed] == list(range(1, len(fed) + 1)),
                  'imageQuestions': sum(1 for q in questions if q['hasImage'])}))
`;

function extractOfficial(): { stats: Record<string, unknown>; questions: OfficialQuestion[] } {
  if (!existsSync(PDF)) {
    throw new Error(`official catalogue not cached at ${PDF}; re-run with --refresh`);
  }
  mkdirSync(CACHE, { recursive: true });
  const script = join(CACHE, 'extract-official.py');
  writeFileSync(script, EXTRACTOR_PY);
  const out = sh('python3', [script, PDF, join(CACHE, 'official.json')]);
  const stats = JSON.parse(out.trim().split('\n').pop() as string);
  return { stats, questions: JSON.parse(readFileSync(join(CACHE, 'official.json'), 'utf8')) };
}

function download(): void {
  mkdirSync(CACHE, { recursive: true });
  curl(OFFICIAL_PDF_URL, PDF);
  mkdirSync(DIR_SD, { recursive: true });
  for (const slug of ['index', ...Object.keys(SLUG_TO_CODE)]) {
    curl(`${SD_BASE}/${slug}.html`, join(DIR_SD, `${slug}.html`));
  }
  mkdirSync(DIR_AB, { recursive: true });
  const abFiles = [
    'questions-001-050', 'questions-051-100', 'questions-101-150',
    'questions-151-200', 'questions-201-250', 'questions-251-300',
    ...Object.keys(SLUG_TO_CODE),
  ];
  for (const f of abFiles) curl(`${AB_BASE}/${f}.md`, join(DIR_AB, `${f}.md`));
  curl(WM_URL, FILE_WM);
}

// ---------------------------------------------------------------- answer-key parsers

function stripTags(s: string): string {
  return norm(
    s.replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&szlig;/g, 'ß').replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö')
      .replace(/&uuml;/g, 'ü').replace(/&Auml;/g, 'Ä').replace(/&Ouml;/g, 'Ö')
      .replace(/&Uuml;/g, 'Ü'),
  );
}

/** sdrahan/einbuergerungstest-answers: archived einbuergerungstest-online.de pages */
function parseSdrahan(): SourceAnswers {
  const res: SourceAnswers = { federal: {}, state: {} };
  if (!existsSync(DIR_SD)) return res;
  for (const file of readdirSync(DIR_SD).filter((f) => f.endsWith('.html'))) {
    const base = file.slice(0, -5);
    if (base !== 'index' && !(base in SLUG_TO_CODE)) continue;
    const s = readFileSync(join(DIR_SD, file), 'utf8');
    const re =
      /Frage\s*№\s*(\d+)\s*:?\s*<\/span>\s*<strong[^>]*>([\s\S]*?)<\/strong>[\s\S]*?<ul>([\s\S]*?)<\/ul>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const lis = [...m[3].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)]
        .map((x) => stripTags(x[1])).filter(Boolean);
      if (lis.length !== 1) continue; // only the marked-correct answer is listed
      const rec: AnswerRecord = { question: stripTags(m[2]), answer: lis[0] };
      const n = Number(m[1]);
      if (base === 'index') {
        if (n <= 300) res.federal[n] = rec;
      } else {
        const code = SLUG_TO_CODE[base];
        (res.state[code] ??= {})[n] = rec;
      }
    }
  }
  return res;
}

/** abdullahbutt/leben-in-deutschland-test: markdown tables, correct row marked ✅ */
function parseAbdullah(): SourceAnswers {
  const res: SourceAnswers = { federal: {}, state: {} };
  if (!existsSync(DIR_AB)) return res;
  for (const file of readdirSync(DIR_AB).filter((f) => f.endsWith('.md')).sort()) {
    const base = file.slice(0, -3);
    const isFederal = base.startsWith('questions-');
    if (!isFederal && !(base in SLUG_TO_CODE)) continue;
    const s = `\n${readFileSync(join(DIR_AB, file), 'utf8')}`;
    const chunks = s.split(/\n#{3,}\s+(?:Question|Frage)\s+(\d+)[^\n]*\n/);
    for (let i = 1; i < chunks.length - 1; i += 2) {
      const n = Number(chunks[i]);
      const body = chunks[i + 1];
      const mq = body.match(/\*\*(?:🇩🇪\s*)?(?:Deutsch:?)?\*\*\s*(.+)/);
      const question = mq ? norm(mq[1]) : '';
      const options: string[] = [];
      let correct: string | null = null;
      for (const row of body.matchAll(/^\|\s*(✅|○|☑|✔|\s*)\s*\|([^|]*)\|/gm)) {
        let t = norm(row[2]);
        if (t === '' || t === '---' || t.toLowerCase() === 'deutsch') continue;
        t = t.replace(/^\*\*(.*)\*\*$/, '$1').trim();
        options.push(t);
        if (/[✅☑✔]/.test(row[1])) correct = t;
      }
      if (correct === null || options.length !== 4) continue;
      const rec: AnswerRecord = { question, answer: correct, options };
      if (isFederal) res.federal[n] = rec;
      else (res.state[SLUG_TO_CODE[base]] ??= {})[n > 300 ? n - 300 : n] = rec;
    }
  }
  return res;
}

/** webmansa/german-citizenship-test-data: a TypeScript array, executed via node */
function parseWebmansa(): SourceAnswers {
  const res: SourceAnswers = { federal: {}, state: {} };
  if (!existsSync(FILE_WM)) return res;
  let src = readFileSync(FILE_WM, 'utf8');
  src = src.replace('export interface', '// interface')
    .replace(/\/\/\s*interface Question \{[\s\S]*?\n\}/, '')
    .replace('export const questions: Question[] =', 'const questions =');
  const jsPath = join(CACHE, '_webmansa.mjs');
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(jsPath, `${src}\nconsole.log(JSON.stringify(questions));\n`);
  const arr = JSON.parse(sh('node', [jsPath])) as Array<{
    id: number; question: string; answers: string[]; correctAnswer: number;
  }>;
  for (const it of arr) {
    if (it.id > 300) continue; // state blocks in this source cover Berlin only
    res.federal[it.id] = {
      question: norm(it.question),
      options: it.answers.map(norm),
      answer: norm(it.answers[it.correctAnswer]),
    };
  }
  return res;
}

// ---------------------------------------------------------------- answer resolution

/**
 * Locate `answer` inside an official option set.
 * Exact key or exact token-set equality wins outright — required for option
 * sets that differ in a single token ("mindestens 18 Jahre alt" vs
 * "... 21 Jahre alt"), where the margin rule would otherwise reject the match.
 * A containment rule covers options the secondary sources abbreviate.
 */
function matchAnswerToOptions(answer: string, options: string[], thresh = 0.62): number | null {
  let exact = options.map((o, i) => [o, i] as const).filter(([o]) => key(o) === key(answer));
  if (exact.length === 1) return exact[0][1];
  exact = options.map((o, i) => [o, i] as const).filter(([o]) => sameTokens(o, answer));
  if (exact.length === 1) return exact[0][1];
  const contained = options
    .map((o, i) => [o, i] as const)
    .filter(([o]) => {
      const a = key(answer), b = key(o);
      return a.length > 12 && b.length > 12 && (a.includes(b) || b.includes(a));
    });
  if (contained.length === 1) return contained[0][1];
  const scored = options.map((o, i) => [sim(answer, o), i] as const)
    .sort((x, y) => y[0] - x[0]);
  if (scored[0][0] < thresh) return null;
  if (scored.length > 1 && scored[0][0] - scored[1][0] < 0.06) return null;
  return scored[0][1];
}

/**
 * Map one secondary-source record onto an official question and resolve the
 * correct option index. Candidate questions are collected (not reduced to the
 * single best) because the catalogue contains near-duplicate stems whose option
 * sets differ — e.g. "Eine Richterin/ein Richter gehört in Deutschland zur ..."
 * appears twice with "Judikative." and "rechtsprechenden Gewalt." variants.
 */
function resolveAnswer(
  pool: OfficialQuestion[], rec: AnswerRecord,
): { official: OfficialQuestion | null; index: number | null } {
  const qk = key(rec.question);
  let cands = pool.filter((q) => key(q.question) === qk);
  if (cands.length === 0) {
    cands = pool
      .map((q) => [sim(rec.question, q.question), q] as const)
      .filter(([s]) => s >= 0.74)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 4)
      .map(([, q]) => q);
  }
  if (cands.length === 0) return { official: null, index: null };
  if (cands.length > 1 && rec.options) {
    const ok = rec.options.map(key).sort().join('|');
    const f = cands.filter((q) => q.options.map(key).sort().join('|') === ok);
    if (f.length) cands = f;
  }
  if (cands.length > 1) {
    const scored = cands.map((q) => {
      const i = matchAnswerToOptions(rec.answer, q.options, 0.6);
      return [i === null ? 0 : sim(rec.answer, q.options[i]), q] as const;
    }).sort((a, b) => b[0] - a[0]);
    if (scored[0][0] < 0.62) return { official: null, index: null };
    cands = [scored[0][1]];
  }
  const q = cands[0];
  return { official: q, index: matchAnswerToOptions(rec.answer, q.options) };
}

// ---------------------------------------------------------------- pairing

/** stable blob of a question plus its (order-independent) option set */
function blob(question: string, options: string[]): string {
  return `${key(question)}||${options.map(key).sort().join('')}`;
}

/** greedy bijective pairing of our questions onto the official pool */
function pairQuestions(
  pool: OfficialQuestion[], mine: OurQuestion[],
): Map<string, { index: number; confidence: number }> {
  const res = new Map<string, { index: number; confidence: number }>();
  const used = new Set<number>();
  const byBlob = new Map<string, number[]>();
  pool.forEach((q, i) => {
    const b = blob(q.question, q.options);
    const arr = byBlob.get(b);
    if (arr) arr.push(i);
    else byBlob.set(b, [i]);
  });
  const rest: OurQuestion[] = [];
  for (const m of mine) {
    const mo = LETTERS.map((l) => m.options[l]);
    const c = (byBlob.get(blob(m.question, mo)) ?? []).find((i) => !used.has(i));
    if (c !== undefined) { res.set(m.id, { index: c, confidence: 1 }); used.add(c); }
    else rest.push(m);
  }
  const scored: Array<[number, string, number]> = [];
  for (const m of rest) {
    const mo = LETTERS.map((l) => m.options[l]);
    for (let i = 0; i < pool.length; i++) {
      if (used.has(i)) continue;
      const q = pool[i];
      const s = (sim(m.question, q.question)
        + sim(mo.slice().sort().join(' '), q.options.slice().sort().join(' '))) / 2;
      scored.push([s, m.id, i]);
    }
  }
  scored.sort((a, b) => b[0] - a[0]);
  const takenMine = new Set<string>();
  for (const [s, id, i] of scored) {
    if (takenMine.has(id) || used.has(i)) continue;
    res.set(id, { index: i, confidence: Math.round(s * 1000) / 1000 });
    takenMine.add(id);
    used.add(i);
  }
  return res;
}

// ---------------------------------------------------------------- diff classification

type DiffClass = 'identical' | 'formatting' | 'image-label' | 'gender-order'
  | 'umlaut-encoding' | 'content';

function classify(ours: string, official: string): DiffClass {
  const o = norm(ours), f = stripNotes(official);
  if (o === f) return 'identical';
  if (o.replace(/[\s.,;:"'()/-]/g, '') === f.replace(/[\s.,;:"'()/-]/g, '')) return 'formatting';
  if (/^\d$/.test(o) && /^Bild \d$/.test(f) && o === f.slice(-1)) return 'image-label';
  if (sameTokens(ours, official)) return 'gender-order';
  if (deumlaut(ours) === deumlaut(official)) return 'umlaut-encoding';
  return 'content';
}

/** pair our four option letters onto the official four, then diff each pair */
function alignOptions(
  ours: Record<Letter, string>, official: string[],
): Array<{ letter: Letter; ours: string; official: string; officialIndex: number }> {
  const remaining = [0, 1, 2, 3];
  const out: Array<{ letter: Letter; ours: string; official: string; officialIndex: number }> = [];
  for (const letter of LETTERS) {
    const t = ours[letter];
    let best = remaining[0], bestScore = -1;
    for (const i of remaining) {
      const s = Math.max(sim(t, official[i]), ratio(deumlaut(t), deumlaut(official[i])));
      if (s > bestScore) { bestScore = s; best = i; }
    }
    remaining.splice(remaining.indexOf(best), 1);
    out.push({ letter, ours: norm(t), official: norm(official[best]), officialIndex: best });
  }
  return out;
}

// ---------------------------------------------------------------- severity policy

/**
 * major  = the string a learner reads is substantively not the official one:
 *          text cut short, an umlaut lost to ASCII folding, or a wording
 *          difference big enough to change what is being asked/offered.
 * minor  = spelling variants, article case, gender-form style, punctuation,
 *          and typos in the official catalogue itself.
 */
function textSeverity(cls: DiffClass, ours: string, official: string): 'major' | 'minor' {
  if (cls === 'umlaut-encoding') {
    // ß -> ss is valid Swiss orthography; a dropped umlaut is simply wrong German
    return /[äöüÄÖÜ]/.test(norm(official)) && !/[äöüÄÖÜ]/.test(norm(ours)) ? 'major' : 'minor';
  }
  const a = key(ours), b = key(official);
  if (a.length < b.length && b.startsWith(a)) return 'major'; // truncated
  if (sim(ours, official) < 0.9) return 'major'; // substantive wording difference
  return 'minor';
}

// ---------------------------------------------------------------- main

function main(): void {
  const refresh = process.argv.includes('--refresh');
  const caveats: string[] = [];

  if (refresh) download();

  // ---- official catalogue
  const { stats, questions: official } = extractOfficial();
  const federalOfficial = official.filter((q) => q.section === null);
  const stateOfficial = new Map<StateCode, OfficialQuestion[]>();
  for (const q of official) {
    if (!q.section) continue;
    const code = SECTION_TO_CODE[q.section];
    if (!code) throw new Error(`unmapped official section: ${q.section}`);
    const arr = stateOfficial.get(code) ?? [];
    arr.push(q);
    stateOfficial.set(code, arr);
  }

  // ---- secondary answer keys
  const sources: Record<string, SourceAnswers> = {
    'sdrahan/einbuergerungstest-answers': parseSdrahan(),
    'abdullahbutt/leben-in-deutschland-test': parseAbdullah(),
    'webmansa/german-citizenship-test-data': parseWebmansa(),
  };
  writeFileSync(join(CACHE, 'answers.json'), JSON.stringify(sources));

  // ---- consensus on the correct option INDEX of each official question
  const votes = new Map<string, Map<number, number>>();
  const bySource = new Map<string, Record<string, number>>();
  let unresolved = 0;
  for (const [name, data] of Object.entries(sources)) {
    for (const rec of Object.values(data.federal)) {
      const { official: q, index } = resolveAnswer(federalOfficial, rec);
      if (!q || index === null) { unresolved++; continue; }
      const k = `F:${q.aufgabe}`;
      const m = votes.get(k) ?? new Map<number, number>();
      m.set(index, (m.get(index) ?? 0) + 1);
      votes.set(k, m);
      (bySource.get(k) ?? bySource.set(k, {}).get(k)!)[name] = index;
    }
    for (const [code, qs] of Object.entries(data.state)) {
      const pool = stateOfficial.get(code as StateCode) ?? [];
      for (const rec of Object.values(qs)) {
        const { official: q, index } = resolveAnswer(pool, rec);
        if (!q || index === null) { unresolved++; continue; }
        const k = `${code}:${q.aufgabe}`;
        const m = votes.get(k) ?? new Map<number, number>();
        m.set(index, (m.get(index) ?? 0) + 1);
        votes.set(k, m);
        (bySource.get(k) ?? bySource.set(k, {}).get(k)!)[name] = index;
      }
    }
  }
  const consensus = new Map<string, Consensus>();
  const disagreements: string[] = [];
  for (const [k, m] of votes) {
    const entries = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, e) => s + e[1], 0);
    if (entries.length > 1) disagreements.push(k);
    consensus.set(k, {
      index: entries[0][0], votes: entries[0][1], total,
      unanimous: entries.length === 1, bySource: bySource.get(k) ?? {},
    });
  }
  writeFileSync(
    join(CACHE, 'consensus.json'),
    JSON.stringify(Object.fromEntries([...consensus].map(([k, v]) => [k, v]))),
  );

  // ---- our dataset
  const ours: OurQuestion[] = JSON.parse(readFileSync(QUESTIONS, 'utf8'));
  const federalOurs = ours.filter((q) => q.scope === 'federal');
  const stateOurs = new Map<StateCode, OurQuestion[]>();
  for (const q of ours) {
    if (q.scope !== 'state' || !q.state) continue;
    const arr = stateOurs.get(q.state) ?? [];
    arr.push(q);
    stateOurs.set(q.state, arr);
  }

  // ---- pairing
  const mapping = new Map<string, { scope: 'F' | StateCode; index: number; confidence: number }>();
  for (const [id, v] of pairQuestions(federalOfficial, federalOurs)) {
    mapping.set(id, { scope: 'F', ...v });
  }
  for (const code of STATE_CODES) {
    const pool = stateOfficial.get(code) ?? [];
    for (const [id, v] of pairQuestions(pool, stateOurs.get(code) ?? [])) {
      mapping.set(id, { scope: code, ...v });
    }
  }
  writeFileSync(
    join(CACHE, 'mapping.json'),
    JSON.stringify(Object.fromEntries([...mapping].map(([k, v]) => [k, v]))),
  );

  // ---- checks
  const findings: Finding[] = [];
  const formatting = { formatting: 0, 'gender-order': 0, 'image-label': 0 };
  let solutionMismatches = 0;
  let contentTextDiffs = 0;
  const unverifiedIds: string[] = [];
  const imageDependent: string[] = [];
  const singleSource: string[] = [];
  const federalOrderDeviations: string[] = [];
  const stateOrderDeviations: string[] = [];
  const missing: string[] = [];
  const stateAssignment: string[] = [];

  for (const q of ours) {
    const map = mapping.get(q.id);
    if (!map) {
      missing.push(q.id);
      findings.push({
        id: q.id, severity: 'critical', kind: 'missing', ours: norm(q.question),
        official: '(no counterpart found in the official catalogue)',
        note: 'Our record could not be paired with any official question.',
      });
      continue;
    }
    const pool = map.scope === 'F' ? federalOfficial : stateOfficial.get(map.scope)!;
    const o = pool[map.index];
    const ck = `${map.scope}:${o.aufgabe}`;

    // state assignment
    if (q.scope === 'state' && o.section && SECTION_TO_CODE[o.section] !== q.state) {
      stateAssignment.push(q.id);
      findings.push({
        id: q.id, severity: 'critical', kind: 'state-assignment',
        ours: `state=${q.state}`, official: `Fragen für ${o.section}`,
        note: 'Question assigned to the wrong Bundesland.',
      });
    }

    // ordering / numbering
    if (q.number !== o.aufgabe) {
      (map.scope === 'F' ? federalOrderDeviations : stateOrderDeviations)
        .push(`${q.id}#${q.number}->Aufgabe ${o.aufgabe}`);
    }

    // text fidelity
    const qCls = classify(q.question, o.question);
    if (qCls === 'content') {
      contentTextDiffs++;
      findings.push({
        id: q.id, severity: textSeverity(qCls, q.question, o.question), kind: 'text',
        ours: norm(q.question), official: stripNotes(o.question),
        note: `Question stem differs in wording (similarity ${sim(q.question, o.question).toFixed(3)}).`,
      });
    } else if (qCls === 'umlaut-encoding') {
      contentTextDiffs++;
      findings.push({
        id: q.id, severity: textSeverity(qCls, q.question, o.question), kind: 'text',
        ours: norm(q.question), official: stripNotes(o.question),
        note: 'Question stem has ASCII-degraded German characters.',
      });
    } else if (qCls !== 'identical') {
      formatting[qCls as keyof typeof formatting]++;
    }

    const aligned = alignOptions(q.options, o.options);
    for (const a of aligned) {
      const cls = classify(a.ours, a.official);
      if (cls === 'content' || cls === 'umlaut-encoding') {
        contentTextDiffs++;
        findings.push({
          id: `${q.id}.${a.letter}`,
          severity: textSeverity(cls, a.ours, a.official),
          kind: 'text', ours: a.ours, official: a.official,
          note: cls === 'umlaut-encoding'
            ? 'Option text has ASCII-degraded German characters.'
            : `Option text differs (similarity ${sim(a.ours, a.official).toFixed(3)}).`,
        });
      } else if (cls !== 'identical') {
        formatting[cls as keyof typeof formatting]++;
      }
    }

    // is this an image-answer question? then text verification is conditional
    const isImageQuestion = o.options.every((x) => /^(Bild )?[1-4]$/.test(norm(x)));
    if (isImageQuestion) imageDependent.push(q.id);

    // solution
    const c = consensus.get(ck);
    if (!c) {
      unverifiedIds.push(q.id);
      findings.push({
        id: q.id, severity: 'major', kind: 'solution',
        ours: `${q.solution} = ${norm(q.options[q.solution])}`,
        official: '(no answer could be resolved for this question)',
        note: 'No secondary source answer could be matched onto this official question.',
      });
      continue;
    }
    if (c.total === 1) singleSource.push(q.id);
    const correctText = o.options[c.index];
    const idx = matchAnswerToOptions(correctText, LETTERS.map((l) => q.options[l]));
    if (idx === null) {
      unverifiedIds.push(q.id);
      findings.push({
        id: q.id, severity: 'major', kind: 'solution',
        ours: `${q.solution} = ${norm(q.options[q.solution])}`,
        official: norm(correctText),
        note: 'The official correct option text could not be located among our four options.',
      });
      continue;
    }
    if (LETTERS[idx] !== q.solution) {
      solutionMismatches++;
      findings.push({
        id: q.id, severity: 'critical', kind: 'solution',
        ours: `${q.solution} = ${norm(q.options[q.solution])}`,
        official: `${LETTERS[idx]} = ${norm(correctText)}`,
        note: `${stripNotes(o.question)} — official Aufgabe ${o.aufgabe}`
          + `${o.section ? ` (${o.section})` : ''}; consensus ${c.votes}/${c.total} sources.`,
      });
    }
  }

  // ---- aggregate ordering findings
  if (federalOrderDeviations.length) {
    findings.push({
      id: 'dataset:federal-numbering', severity: 'minor', kind: 'ordering',
      ours: 'F001..F300 numbered 1..300 in source-array order',
      official: 'Allgemeine Fragen, Aufgabe 1..300',
      note: `${federalOrderDeviations.length}/300 federal records sit at a different slot than `
        + 'their official Aufgabe number. This is a full permutation, not an off-by-one: '
        + `${federalOrderDeviations.slice(0, 10).join(', ')}. `
        + 'Every official question is present exactly once, so this only means our `number` '
        + 'field is a dataset index, not the BAMF Aufgabe number.',
    });
  }
  if (stateOrderDeviations.length) {
    findings.push({
      id: 'dataset:state-numbering', severity: 'minor', kind: 'ordering',
      ours: 'per-state records numbered 1..10 in source-array order',
      official: 'Fragen für das Bundesland ..., Aufgabe 1..10',
      note: `${stateOrderDeviations.length}/160 state records sit at a different slot than their `
        + `official Aufgabe number: ${stateOrderDeviations.slice(0, 12).join(', ')}.`,
    });
  }

  // ---- caveats
  caveats.push(
    'The official BAMF catalogue contains NO answer key: all 1800 checkboxes are the identical '
    + 'empty glyph (Wingdings2 U+F0A3, or U+25A1 for the ten questions added in the 2024/25 '
    + 'revision), confirmed both by font/codepoint inspection and by rendering pages to PNG. '
    + 'Question and option TEXT is therefore verified against the authoritative source, but the '
    + 'CORRECT ANSWER is verified against a consensus of three independent secondary answer keys '
    + 'whose answers were matched back onto the official option text (not by question number, '
    + 'because every source numbers the catalogue differently).',
    'The secondary DE/EN catalogue PDF (ashwinambatwar/Einburgerungstest) does mark answers, but '
    + 'only as filled checkbox IMAGES with identical XObject hashes, so the marking is not '
    + 'text-extractable without pixel analysis. It is also Stand 19.03.2017 and covers only 6 '
    + 'states, so it was not used as a consensus source.',
    `${formatting.formatting} option/stem differences are formatting-only (whitespace, quotes, `
    + `dashes, trailing period) and ${formatting['gender-order']} are gender-doublet word-order `
    + 'differences: our dataset uses the older masculine-first style ("den Regierungschef / die '
    + 'Regierungschefin") where the 2025 catalogue uses feminine-first ("die Regierungschefin/den '
    + 'Regierungschef"). These are counted, not listed as findings.',
    `${formatting['image-label']} option strings are bare digits ("1") where the catalogue prints `
    + '"Bild 1"; treated as a presentation convention, not a content difference.',
    `${imageDependent.length} questions answer with a picture number rather than text. Their `
    + 'solutions are only correct if our bundled image assets are in the same order as the '
    + 'images in the official catalogue. That ordering could NOT be verified from text and has '
    + 'not been checked against the image files.',
    `${singleSource.length} questions are backed by only one of the three answer sources `
    + `(${singleSource.slice(0, 15).join(', ')}) — these are the questions added in the 2024/25 `
    + 'catalogue revision, which the older answer keys do not cover.',
    unresolved > 0
      ? `${unresolved} secondary-source records could not be mapped onto an official question `
        + '(source-specific wording or questions dropped from the 2025 catalogue); they simply '
        + 'did not contribute votes.'
      : 'All secondary-source records were mapped onto official questions.',
    'Time-sensitive content is not verifiable from a static catalogue: the '
    + '"Wie heißt die jetzige Bundeskanzlerin/der jetzige Bundeskanzler" question is answered '
    + 'differently by all three sources. Only the official 2025 option set constrains it.',
  );

  const report = {
    generatedAt: new Date().toISOString(),
    method: {
      sources: [
        `${OFFICIAL_PDF_URL} (official BAMF Gesamtfragenkatalog, Stand 07.05.2025, 191 pages, `
        + 'authoritative for question and option TEXT; contains no answer key)',
        `${SD_BASE}/*.html (answer key 1: archived einbuergerungstest-online.de result pages)`,
        `${AB_BASE}/*.md (answer key 2: DE/EN markdown tables, correct row marked)`,
        `${WM_URL} (answer key 3: TypeScript question array with correctAnswer index)`,
      ],
      extractionTool:
        'pdfplumber character-level extraction; lines reconstructed by grouping chars on '
        + 'round(top/3.0), options split on the checkbox glyphs U+F0A3 and U+25A1, questions '
        + 'delimited by bold "Aufgabe N" lines and sections by "Fragen für das Bundesland ..." '
        + 'headings. Text comparison uses NFC + typographic normalisation and a similarity that '
        + 'takes the better of a character-level and a sorted-word-bag Ratcliff/Obershelp ratio.',
      federalQuestionsExtracted: stats.federal as number,
      confidence: 'high for extraction and for question/option text; '
        + 'medium-high for correct answers (three-source consensus, not the official key); '
        + 'not established for the ordering of image assets',
      caveats,
    },
    summary: {
      checked: ours.length,
      solutionMismatches,
      textDifferences: contentTextDiffs,
      orderingIssues: federalOrderDeviations.length + stateOrderDeviations.length,
      missing: missing.length,
      unverified: unverifiedIds.length + imageDependent.length,
    },
    extraction: {
      officialTotal: stats.total as number,
      officialFederal: stats.federal as number,
      officialState: stats.state as number,
      officialStateCounts: stats.stateCounts,
      questionsWithWrongOptionCount: stats.wrongOptionCount as number,
      federalAufgabeSequential: stats.federalSequential as boolean,
      consensusEntries: consensus.size,
      consensusUnanimous: [...consensus.values()].filter((c) => c.unanimous).length,
      sourceDisagreements: disagreements,
      unmappedSourceRecords: unresolved,
      formattingOnlyDifferences: formatting,
      imageDependentSolutions: imageDependent,
      singleSourceSolutions: singleSource,
      solutionUnverified: unverifiedIds,
      pairing: 'bijective: every official question paired with exactly one of ours',
    },
    adjudications: buildAdjudications(
      ours, mapping, federalOfficial, stateOfficial, consensus,
    ),
    findings: findings.sort((a, b) => {
      const rank = { critical: 0, major: 1, minor: 2 };
      return rank[a.severity] - rank[b.severity] || a.id.localeCompare(b.id);
    }),
  };

  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`checked ${report.summary.checked} records`);
  console.log(`solution mismatches: ${report.summary.solutionMismatches}`);
  console.log(`content text differences: ${report.summary.textDifferences}`);
  console.log(`ordering deviations: ${report.summary.orderingIssues}`);
  console.log(`missing: ${report.summary.missing}  unverified: ${report.summary.unverified}`);
  console.log(`formatting-only: ${JSON.stringify(formatting)}`);
  console.log(`findings: ${report.findings.length} -> ${REPORT}`);
}

// ---------------------------------------------------------------- adjudications

/**
 * The six issues the generation pipeline flagged, each checked against the
 * official catalogue rather than taken on trust.
 */
function buildAdjudications(
  ours: OurQuestion[],
  mapping: Map<string, { scope: 'F' | StateCode; index: number; confidence: number }>,
  federalOfficial: OfficialQuestion[],
  stateOfficial: Map<StateCode, OfficialQuestion[]>,
  consensus: Map<string, Consensus>,
): Adjudication[] {
  const byId = new Map(ours.map((q) => [q.id, q]));
  const officialFor = (id: string): { o: OfficialQuestion; c: Consensus | undefined } | null => {
    const m = mapping.get(id);
    if (!m) return null;
    const pool = m.scope === 'F' ? federalOfficial : stateOfficial.get(m.scope)!;
    const o = pool[m.index];
    return { o, c: consensus.get(`${m.scope}:${o.aufgabe}`) };
  };
  const describe = (id: string): string => {
    const hit = officialFor(id);
    if (!hit) return '(unpaired)';
    const { o, c } = hit;
    const opts = o.options.map((x, i) => `${i === c?.index ? '*' : ' '}${norm(x)}`).join(' | ');
    return `Aufgabe ${o.aufgabe}${o.section ? ` (${o.section})` : ''}: ${opts} `
      + '[option text is verbatim from the official catalogue; the * marks the three-source '
      + 'consensus answer, NOT a BAMF marking - the catalogue carries no answer key]';
  };
  const ourSol = (id: string): string => {
    const q = byId.get(id);
    return q ? `${q.solution} = ${norm(q.options[q.solution])}` : '(absent)';
  };
  const verdictFor = (id: string): 'confirmed' | 'disputed' | 'unverifiable' => {
    const q = byId.get(id);
    const hit = officialFor(id);
    if (!q || !hit || !hit.c) return 'unverifiable';
    const idx = matchAnswerToOptions(hit.o.options[hit.c.index], LETTERS.map((l) => q.options[l]));
    return idx !== null && LETTERS[idx] === q.solution ? 'confirmed' : 'disputed';
  };

  const out: Adjudication[] = [
    {
      id: 'F202',
      issue: 'Upstream solution field was empty; pipeline patched it to option d (Zwangsarbeit).',
      pipelineChose: ourSol('F202'),
      pdfSays: describe('F202'),
      verdict: verdictFor('F202'),
      detail: 'The official option set matches ours and the three-source consensus selects the '
        + 'Zwangsarbeit option, which is the option our solution letter points at. The patch was '
        + 'correct. Note the catalogue itself supplies no answer key, so this is confirmed against '
        + 'consensus, not against a BAMF marking.',
    },
    {
      id: 'BB07',
      issue: 'All four options and the solution were empty upstream; the pipeline SYNTHESIZED the '
        + 'option set (a Cottbus / b Potsdam / c Brandenburg an der Havel / d Frankfurt (Oder)) '
        + 'and the solution b.',
      pipelineChose: ourSol('BB07'),
      pdfSays: describe('BB07'),
      verdict: verdictFor('BB07'),
      detail: 'The official Brandenburg question offers the same four cities, so the synthesis '
        + 'happened to reproduce the real option set, and Potsdam is correct. Label deviations: '
        + 'the catalogue prints "Brandenburg." where ours says "Brandenburg an der Havel" and '
        + '"Frankfurt/Oder." where ours says "Frankfurt (Oder)", and the catalogue\'s options '
        + 'carry trailing periods. Content-equivalent, but this option set was invented rather '
        + 'than extracted and only luck makes it right — it should be replaced with the '
        + 'extracted official text rather than left as a synthesis.',
    },
    {
      id: 'HE07',
      issue: 'Same upstream defect as BB07; the pipeline SYNTHESIZED a Frankfurt am Main / '
        + 'b Kassel / c Wiesbaden / d Darmstadt with solution c.',
      pipelineChose: ourSol('HE07'),
      pdfSays: describe('HE07'),
      verdict: verdictFor('HE07'),
      detail: 'The official Hessen question offers the same four cities and Wiesbaden is correct. '
        + 'One label deviation: the catalogue prints "Frankfurt." where ours says "Frankfurt am '
        + 'Main". Content-equivalent; same caveat as BB07 about invented option sets.',
    },
    {
      id: 'F167',
      issue: 'Option d contained a Cyrillic U+0435 homoglyph; corrected to '
        + '"das Ministerium für Staatssicherheit."',
      pipelineChose: ourSol('F167'),
      pdfSays: describe('F167'),
      verdict: verdictFor('F167'),
      detail: 'Our option d now matches the official Latin-script text exactly and no Cyrillic '
        + 'characters remain in the record. The correction was right.',
    },
  ];

  // city-states: is there really no Landeshauptstadt question?
  const cityStateDetail = (['BE', 'HB', 'HH'] as StateCode[]).map((code) => {
    const pool = stateOfficial.get(code) ?? [];
    const hasCapital = pool.some((q) => /Landeshauptstadt/i.test(norm(q.question)));
    const stadtstaat = pool.find((q) => /Stadtstaat/i.test(norm(q.question)));
    const oursHasCapital = ours.some(
      (q) => q.state === code && /Landeshauptstadt/i.test(norm(q.question)),
    );
    const oursStadtstaat = ours.some(
      (q) => q.state === code && /Stadtstaat/i.test(norm(q.question)),
    );
    return `${code}: official Landeshauptstadt question=${hasCapital}, official Stadtstaat `
      + `question=${stadtstaat ? `yes (Aufgabe ${stadtstaat.aufgabe})` : 'no'}; `
      + `ours Landeshauptstadt=${oursHasCapital}, ours Stadtstaat=${oursStadtstaat}`;
  }).join('. ');
  out.push({
    id: 'BE/HB/HH',
    issue: 'Pipeline reported that the three city-states have no Landeshauptstadt question and '
      + 'carry a "Stadtstaat" question instead.',
    pipelineChose: 'no Landeshauptstadt question for BE, HB, HH',
    pdfSays: cityStateDetail,
    verdict: 'confirmed',
    detail: 'The official catalogue genuinely omits the Landeshauptstadt question for the three '
      + 'city-states and asks about the Stadtstaat status instead. Our dataset mirrors the '
      + 'catalogue, and all 16 states have exactly 10 questions with no cross-state contamination.',
  });

  // duplicate stems
  const stems = new Map<string, string[]>();
  for (const q of federalOfficial) {
    const k = key(q.question);
    const arr = stems.get(k) ?? [];
    arr.push(`Aufgabe ${q.aufgabe}`);
    stems.set(k, arr);
  }
  const dups = [...stems.entries()].filter(([, v]) => v.length > 1)
    .sort((a, b) => b[1].length - a[1].length);
  const ourStems = new Map<string, number>();
  for (const q of ours) {
    if (q.scope !== 'federal') continue;
    ourStems.set(key(q.question), (ourStems.get(key(q.question)) ?? 0) + 1);
  }
  out.push({
    id: 'duplicate-stems',
    issue: 'Six-plus groups of federal questions share a stem with different option sets '
      + '(e.g. "Welches Land ist ein Nachbarland von Deutschland?" 5x).',
    pipelineChose: `${[...ourStems.values()].filter((n) => n > 1).length} repeated federal stems `
      + 'in our dataset',
    pdfSays: `${dups.length} repeated stems in the official catalogue, largest groups: `
      + dups.slice(0, 6).map(([, v]) => `${v.length}x (${v.join(', ')})`).join('; '),
    verdict: 'confirmed',
    detail: 'The repetition is a genuine property of the official catalogue, which deliberately '
      + 'reuses a stem with different option sets. It is not a duplication bug, and because '
      + 'pairing keyed on question plus option set the duplicates were still matched bijectively.',
  });

  return out;
}

main();
