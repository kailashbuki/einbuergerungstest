/**
 * apply-verified-fixes.ts — applies the BAMF-verification text corrections to
 * src/data/questions.json (see src/data/verification-report.json for the source findings).
 *
 * Scope: text fidelity only. No `solution` letter is changed by this script except where a
 * record's full option SET is being replaced (ST05), and even there the script asserts the
 * recomputed solution still points at the same correct-answer text as before.
 *
 * Usage:
 *   npx tsx scripts/apply-verified-fixes.ts            # dry-run: prints the diff table, writes nothing
 *   npx tsx scripts/apply-verified-fixes.ts --write     # applies the corrections to questions.json
 *
 * This script is idempotent-checked: every `before` value is asserted against the current file
 * content before being overwritten, so if it has already run (or upstream has changed under it)
 * it fails loudly instead of silently double-applying or corrupting text.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const QUESTIONS_PATH = join(REPO, 'src/data/questions.json');

type OptionKey = 'a' | 'b' | 'c' | 'd';
type Field = 'question' | OptionKey;

interface Question {
  id: string;
  number: number;
  scope: 'federal' | 'state';
  state?: string;
  question: string;
  options: Record<OptionKey, string>;
  solution: OptionKey;
  category: string;
  explanation: string;
  image?: string;
  sourceId: string;
}

interface Correction {
  id: string;
  field: Field;
  before: string;
  after: string;
  note: string;
}

// ---------------------------------------------------------------------------
// The verified corrections. `before` is asserted against the live file content
// before being replaced by `after`; a mismatch aborts the whole run.
// ---------------------------------------------------------------------------

const CORRECTIONS: readonly Correction[] = [
  // -- Truncations / dropped words -------------------------------------------------
  { id: 'F151', field: 'c', before: 'Gesetze erlasse', after: 'Gesetze erlassen',
    note: 'truncated word' },
  { id: 'F184', field: 'c', before: 'zu den blockfreien Staate', after: 'zu den blockfreien Staaten',
    note: 'truncated word' },
  { id: 'F196', field: 'b', before: 'Regeln für die Benutzung öffentlicher.',
    after: 'Regeln für die Benutzung öffentlicher Verkehrsmittel.', note: 'dropped noun' },
  { id: 'F270', field: 'b', before: 'an die Opfer des Nationalsozialismus',
    after: 'an die Opfer des Nationalsozialismus (Tag der Befreiung des Vernichtungslagers Auschwitz)',
    note: 'dropped parenthetical; this is the solution option, corrected in place' },

  // -- ASCII-degraded German --------------------------------------------------------
  { id: 'F011', field: 'c', before: 'grosse Unternehmen', after: 'große Unternehmen',
    note: 'ss -> ß' },
  { id: 'F057', field: 'question',
    before: 'Der damalige französische Staatspräsident Francois Mitterrand und der damalige deutsche Bundeskanzler Helmut Kohl gedenken in Verdun gemeinsam der Toten beider Weltkriege. Welches Ziel der Europäischen Union wird bei diesem Treffen deutlich?',
    after: 'Der damalige französische Staatspräsident François Mitterrand und der damalige deutsche Bundeskanzler Helmut Kohl gedenken in Verdun gemeinsam der Toten beider Weltkriege. Welches Ziel der Europäischen Union wird bei diesem Treffen deutlich?',
    note: 'Francois -> François' },
  { id: 'F168', field: 'd', before: 'die Bundespraesidentin/der Bundespräsident',
    after: 'die Bundespräsidentin/der Bundespräsident', note: 'ae -> ä' },
  { id: 'F175', field: 'question',
    before: 'Welches Grundrecht gilt in Deutschland nur fur Ausländerinnen/Ausländer? Das Grundrecht auf …',
    after: 'Welches Grundrecht gilt in Deutschland nur für Ausländerinnen/Ausländer? Das Grundrecht auf …',
    note: 'fur -> für' },
  { id: 'F185', field: 'question',
    before: 'Eine Partei im Deutschen Bundestag will die Pressefreiheit abschaffen. Ist das moglich?',
    after: 'Eine Partei im Deutschen Bundestag will die Pressefreiheit abschaffen. Ist das möglich?',
    note: 'moglich -> möglich' },
  { id: 'F185', field: 'd', before: 'Ja, wenn mehr als die Halfte der Abgeordneten im Bundestag dafur sind.',
    after: 'Ja, wenn mehr als die Hälfte der Abgeordneten im Bundestag dafür sind.',
    note: 'Halfte/dafur -> Hälfte/dafür' },
  { id: 'F207', field: 'b', before: 'bei Meinungsäusserungen über die Bundesregierung',
    after: 'bei Meinungsäußerungen über die Bundesregierung', note: 'ss -> ß' },
  { id: 'F222', field: 'a', before: 'Man darf sich in der Offentlichkeit nur leicht bekleidet bewegen.',
    after: 'Man darf sich in der Öffentlichkeit nur leicht bekleidet bewegen.', note: 'O -> Ö' },

  // -- Substituted / wrong wording ---------------------------------------------------
  { id: 'F014', field: 'b', before: 'Damit sind amerikanische Einwanderer in Europa gemeint',
    after: 'Damit sind amerikanische Einwanderinnen und Einwanderer in Europa gemeint.',
    note: 'gender doublet + missing period' },
  { id: 'F014', field: 'c', before: 'Damit sind europäische Auswanderer in den USA gemeint',
    after: 'Damit sind europäische Auswanderinnen und Auswanderer in den USA gemeint.',
    note: 'gender doublet + missing period' },
  { id: 'F030', field: 'c', before: 'der Eltern', after: 'die Eltern',
    note: 'wrong article; this is the solution option, corrected in place' },
  { id: 'F030', field: 'd', before: 'der Schulen', after: 'die Schulen', note: 'wrong article' },
  { id: 'F034', field: 'a', before: 'Verfolgung der Juden', after: 'Verfolgung von Juden',
    note: 'wrong preposition' },
  { id: 'F037', field: 'a', before: 'Renterinnen und Rentner.', after: 'Rentnerinnen und Rentner.',
    note: 'missing "n"' },
  { id: 'F046', field: 'question', before: 'Wo ist der Sitz des Europäischen Parlaments?',
    after: 'Wo ist ein Sitz des Europäischen Parlaments?',
    note: 'der -> ein (the EP has more than one seat)' },
  { id: 'F064', field: 'd',
    before: 'Die amerikanischen Soldaten/Soldatinnen hatten beim Landtransport Angst vor Überfällen.',
    after: 'Die amerikanischen Soldatinnen und Soldaten hatten beim Landtransport Angst vor Überfällen.',
    note: 'gender-doublet form corrected to official wording' },
  { id: 'F081', field: 'c',
    before: 'Der Wähler darf bei der Wahl weder beeinflusst noch zu einer bestimmten Stimmabgabe gezwungen werden und keine Nachteile durch die Wahl haben.',
    after: 'Die Wählerin/der Wähler darf bei der Wahl weder beeinflusst noch zu einer bestimmten Stimmabgabe gezwungen werden und keine Nachteile durch die Wahl haben.',
    note: 'gender doublet added; this is the solution option, corrected in place' },
  { id: 'F107', field: 'question', before: 'In der DDR lebten vor allem Migrantinnen/Migranten aus …',
    after: 'In der DDR lebten vor allem Migrantinnen und Migranten aus …',
    note: 'slash doublet -> "und" doublet' },
  { id: 'F119', field: 'question',
    before: 'Aus welchem Land kamen die ersten Gastarbeiter und Gastarbeiterinnen nach Deutschland?',
    after: 'Aus welchem Land kamen die ersten Gastarbeiterinnen und Gastarbeiter in die Bundesrepublik Deutschland?',
    note: 'gender order + "nach Deutschland" -> "in die Bundesrepublik Deutschland"' },
  { id: 'F195', field: 'c', before: 'Die Bundesrepublik Deutschland hat die DDR besetzt.',
    after: 'Die Bundesrepublik hat die DDR besetzt.', note: 'extra "Deutschland" removed' },
  { id: 'F197', field: 'a', before: 'meine Meinung in Leserbriefen äußern kann.',
    after: 'meine Meinung im Internet äußern kann.',
    note: 'wrong medium substituted; this is the solution option, corrected in place' },
  { id: 'F212', field: 'question', before: 'Bei einer Bundestagswahl in Deutschland darf jeder wählen, die/der …',
    after: 'Bei einer Bundestagswahl in Deutschland darf jede/jeder wählen, die/der …',
    note: 'jeder -> jede/jeder' },
  { id: 'F229', field: 'c', before: 'Kirchensteuern', after: 'Kirchensteuer', note: 'plural -> singular' },
  { id: 'F252', field: 'a', before: 'Hausratversicherung', after: 'Hausratsversicherung',
    note: 'missing "s"' },
  { id: 'F292', field: 'd', before: 'eine Wahlerlaubnis vom Bundespräsidenten/von der Bundespräsidentin',
    after: 'eine Wahlerlaubnis von der Bundespräsidentin/von dem Bundespräsidenten',
    note: 'gender order + preposition case' },
  { id: 'F299', field: 'b', before: 'selbständig mit einer eigenen Firma tätig.',
    after: 'selbstständig mit einer eigenen Firma tätig.', note: 'selbständig -> selbstständig' },
  { id: 'BE08', field: 'b', before: 'Präsident / Präsidentin des Senats',
    after: 'Präsidentin/Präsident des Senates', note: 'gender order + Senats -> Senates' },
  { id: 'HB05', field: 'b', before: 'schwarz-gelb', after: 'schwarz-gold', note: 'wrong color' },
  { id: 'HB08', field: 'a', before: 'Präsident / Präsidentin des Senats',
    after: 'Präsidentin/Präsident des Senates',
    note: 'gender order + Senats -> Senates; this is the solution option, corrected in place' },
  { id: 'MV08', field: 'd', before: 'Erster Bürgermeister / Erste Bürgermeisterin',
    after: 'Erste Ministerin/Erster Minister', note: 'wrong distractor title' },

  // -- MV09: treat with extra care (see report). Removes a second plausible-correct answer
  // (our "Finanzsenator" is a Stadtstaat title MV doesn't have either); official solution
  // stays at option b (Außenminister/Außenministerin), asserted below.
  { id: 'MV09', field: 'a', before: 'Finanzsenator / Finanzsenatorin', after: 'Finanzministerin/Finanzminister',
    note: 'city-state title replaced with the official state-ministry title; solution remains b' },

  // -- ST05: full option-set alignment (see report). Official set is
  // {gelb-schwarz, grün-weiß-rot, blau-weiß-rot, weiß-rot}; ours had a bogus "weiß-blau" at c
  // and was missing "weiß-rot". We keep gelb-schwarz at `a` and grün-weiß-rot at `b` (both
  // already correct) and only replace `c`/`d`, which reproduces the official set exactly while
  // leaving `solution` (already "a") pointing at the same correct text as before.
  { id: 'ST05', field: 'c', before: 'weiß-blau', after: 'blau-weiß-rot',
    note: 'ST05 set-alignment: not in official set at all; replaced with official blau-weiß-rot' },
  { id: 'ST05', field: 'd', before: 'blau-weiß-rot', after: 'weiß-rot',
    note: 'ST05 set-alignment: official weiß-rot was missing from our set' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`\n✗ FATAL: ${message}\n`);
  process.exit(1);
}

function getField(q: Question, field: Field): string {
  return field === 'question' ? q.question : q.options[field];
}

function setField(q: Question, field: Field, value: string): void {
  if (field === 'question') q.question = value;
  else q.options[field] = value;
}

function main(): void {
  const write = process.argv.includes('--write');
  const raw = readFileSync(QUESTIONS_PATH, 'utf8');
  const before: Question[] = JSON.parse(raw);
  // Deep clone so we can diff the untouched snapshot against the mutated array later.
  const originalSnapshot: Question[] = JSON.parse(raw);

  if (before.length !== 460) fail(`expected 460 records before editing, found ${before.length}`);

  const byId = new Map(before.map((q) => [q.id, q]));

  // ---- apply corrections, asserting the `before` fingerprint every time ----
  const touchedIds = new Set<string>();
  for (const c of CORRECTIONS) {
    const q = byId.get(c.id);
    if (!q) fail(`correction targets unknown id ${c.id}`);
    const current = getField(q, c.field);
    if (current !== c.before) {
      fail(
        `fingerprint mismatch for ${c.id}.${c.field}: expected ${JSON.stringify(c.before)}, ` +
          `found ${JSON.stringify(current)}. Refusing to apply blindly — re-audit this correction.`,
      );
    }
    setField(q, c.field, c.after);
    touchedIds.add(c.id);
  }

  // ---- invariant 1: exactly 460 records, byte-identical id set ----
  if (before.length !== 460) fail(`expected 460 records after editing, found ${before.length}`);
  const idsBefore = originalSnapshot.map((q) => q.id);
  const idsAfter = before.map((q) => q.id);
  if (idsBefore.length !== idsAfter.length || idsBefore.some((id, i) => id !== idsAfter[i])) {
    fail('id set (or id order) changed — this must never happen');
  }
  const idSetBefore = new Set(idsBefore);
  const idSetAfter = new Set(idsAfter);
  if (idSetBefore.size !== 460 || idSetAfter.size !== 460) fail('ids are not unique');
  for (const id of idSetBefore) if (!idSetAfter.has(id)) fail(`id ${id} disappeared`);

  // ---- invariant 2: number/scope/state/image unchanged for every record ----
  for (let i = 0; i < before.length; i++) {
    const o = originalSnapshot[i];
    const n = before[i];
    if (o.id !== n.id) fail(`record ${i} id drifted: ${o.id} -> ${n.id}`);
    if (o.number !== n.number) fail(`${o.id}: number changed ${o.number} -> ${n.number}`);
    if (o.scope !== n.scope) fail(`${o.id}: scope changed ${o.scope} -> ${n.scope}`);
    if (o.state !== n.state) fail(`${o.id}: state changed ${o.state} -> ${n.state}`);
    if (o.image !== n.image) fail(`${o.id}: image changed ${o.image} -> ${n.image}`);
    if (o.category !== n.category) fail(`${o.id}: category changed ${o.category} -> ${n.category}`);
    if (o.sourceId !== n.sourceId) fail(`${o.id}: sourceId changed`);
  }

  // ---- invariant 3 & 4: exactly four non-empty options; solution in a|b|c|d ----
  const LETTERS: OptionKey[] = ['a', 'b', 'c', 'd'];
  for (const q of before) {
    const keys = Object.keys(q.options).sort();
    if (keys.join(',') !== 'a,b,c,d') fail(`${q.id}: option keys are ${keys.join(',')}, expected a,b,c,d`);
    for (const k of LETTERS) {
      if (!q.options[k] || !q.options[k].trim()) fail(`${q.id}.${k}: option is empty`);
    }
    if (!LETTERS.includes(q.solution)) fail(`${q.id}: solution ${JSON.stringify(q.solution)} is not a|b|c|d`);
  }

  // ---- invariant 5: 300 federal + 16*10 state ----
  const federal = before.filter((q) => q.scope === 'federal');
  if (federal.length !== 300) fail(`expected 300 federal records, found ${federal.length}`);
  const byState = new Map<string, number>();
  for (const q of before) {
    if (q.scope !== 'state') continue;
    if (!q.state) fail(`${q.id}: scope=state but no state field`);
    byState.set(q.state, (byState.get(q.state) ?? 0) + 1);
  }
  if (byState.size !== 16) fail(`expected 16 states represented, found ${byState.size}`);
  for (const [state, count] of byState) {
    if (count !== 10) fail(`state ${state} has ${count} records, expected 10`);
  }

  // ---- MV09 explicit check: solution must still be b (Außenminister/Außenministerin) ----
  const mv09 = byId.get('MV09')!;
  if (mv09.solution !== 'b') fail(`MV09.solution changed to ${mv09.solution}, expected to remain b`);
  if (mv09.options.b !== 'Außenminister / Außenministerin') {
    fail(`MV09.b text unexpectedly changed to ${JSON.stringify(mv09.options.b)}`);
  }

  // ---- ST05 explicit check: full official set, solution still gelb-schwarz ----
  const st05 = byId.get('ST05')!;
  const st05Set = LETTERS.map((k) => st05.options[k]).slice().sort();
  const officialSet = ['blau-weiß-rot', 'gelb-schwarz', 'grün-weiß-rot', 'weiß-rot'].slice().sort();
  if (JSON.stringify(st05Set) !== JSON.stringify(officialSet)) {
    fail(`ST05 option set is ${JSON.stringify(st05Set)}, expected official set ${JSON.stringify(officialSet)}`);
  }
  if (st05.solution !== 'a' || st05.options.a !== 'gelb-schwarz') {
    fail(`ST05.solution must point at "gelb-schwarz"; found solution=${st05.solution}, a=${st05.options.a}`);
  }

  // ---- solution before/after table for every touched record ----
  console.log('\n=== solution before/after (per touched record) ===');
  for (const id of [...touchedIds].sort()) {
    const o = originalSnapshot.find((q) => q.id === id)!;
    const n = byId.get(id)!;
    const beforeText = o.options[o.solution];
    const afterText = n.options[n.solution];
    console.log(
      `${id}: solution ${o.solution} -> ${n.solution}   ` +
        `before=${JSON.stringify(beforeText)}   after=${JSON.stringify(afterText)}`,
    );
  }

  // ---- full corrections table ----
  console.log('\n=== field corrections applied ===');
  for (const c of CORRECTIONS) {
    console.log(`${c.id}.${c.field}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}  (${c.note})`);
  }

  console.log(`\n${touchedIds.size} record(s) touched, ${CORRECTIONS.length} field correction(s) applied.`);
  console.log('All invariants held.');

  if (!write) {
    console.log('\n(dry run — pass --write to persist to src/data/questions.json)');
    return;
  }

  // ---- serialize, preserving the file's existing 2-space-indent + trailing-newline style ----
  const out = `${JSON.stringify(before, null, 2)}\n`;
  writeFileSync(QUESTIONS_PATH, out);
  console.log(`\nwrote ${QUESTIONS_PATH}`);
}

main();
