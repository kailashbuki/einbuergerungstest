#!/usr/bin/env tsx
// Lints both locale-file families for drift against their English source of
// truth:
//   - UI strings:            src/i18n/ui.<locale>.json          (8 files, en included)
//   - Question translations: src/data/i18n/questions.<locale>.json (7 files, no de)
//
// Run via `npm run lint:i18n`. Exits non-zero on any hard failure, after
// printing a full per-locale summary table so a CI log shows everything at
// once rather than stopping at the first problem.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const UI_DIR = path.join(ROOT, 'src', 'i18n');
const QUESTIONS_DIR = path.join(ROOT, 'src', 'data', 'i18n');
const QUESTIONS_MASTER = path.join(ROOT, 'src', 'data', 'questions.json');

const UI_LOCALES = ['de', 'en', 'tr', 'ru', 'fr', 'ar', 'uk', 'hi'] as const;
const TRANSLATION_LOCALES = ['en', 'tr', 'ru', 'fr', 'ar', 'uk', 'hi'] as const;

/** Rate above which "identical to English" stops being cognates and starts being an un-translated copy-paste. */
const IDENTICAL_RATE_FAIL_THRESHOLD = 0.15;

/** Keys where the value is expected to legitimately differ from — or coincidentally equal — English regardless of translation quality. */
const IDENTICAL_ALLOWLIST_KEYS = new Set(['meta.localeCode', 'meta.dir', 'app.name']);
/** Exact values that are fine to leave untranslated (brand terms, universal short tokens). */
const IDENTICAL_ALLOWLIST_VALUES = new Set(['OK', 'XP', 'Einbürgerungstest']);
/** A value that is purely a placeholder (optionally with trailing punctuation like `%`) carries no translatable text. */
const PLACEHOLDER_ONLY_VALUE = /^\{\w+\}[%.,:;]?$/;

let hardFailure = false;
const summaryRows: string[][] = [];

function fail(message: string): void {
  console.error(`✗ ${message}`);
  hardFailure = true;
}

function warn(message: string): void {
  console.warn(`  ⚠ ${message}`);
}

function readJson(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractPlaceholders(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of value.matchAll(/\{(\w+)\}/g)) {
    const name = match[1];
    if (name) tokens.add(name);
  }
  return tokens;
}

function setDiff<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): T[] {
  return [...a].filter((x) => !b.has(x));
}

/* ────────────────────────────── UI strings ────────────────────────────── */

function lintUiLocales(): void {
  console.log('\n=== UI strings (src/i18n/ui.<locale>.json) ===\n');

  const enPath = path.join(UI_DIR, 'ui.en.json');
  if (!fs.existsSync(enPath)) {
    fail(`missing English source of truth: ${path.relative(ROOT, enPath)}`);
    return;
  }
  const enRaw = readJson(enPath);
  if (!isStringRecord(enRaw)) {
    fail(`${path.relative(ROOT, enPath)} is not a flat string map`);
    return;
  }
  const en = enRaw;
  const enKeys = new Set(Object.keys(en));

  for (const locale of UI_LOCALES) {
    const filePath = path.join(UI_DIR, `ui.${locale}.json`);
    const row = [locale, '-', '-', '-', '-', '-'];

    if (!fs.existsSync(filePath)) {
      fail(`src/i18n/ui.${locale}.json does not exist`);
      row[1] = 'MISSING';
      summaryRows.push(row);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = readJson(filePath);
    } catch (err) {
      fail(`src/i18n/ui.${locale}.json is not valid JSON: ${(err as Error).message}`);
      row[1] = 'INVALID JSON';
      summaryRows.push(row);
      continue;
    }
    if (!isStringRecord(parsed)) {
      fail(`src/i18n/ui.${locale}.json is not a flat string map`);
      row[1] = 'INVALID SHAPE';
      summaryRows.push(row);
      continue;
    }
    const messages = parsed;
    const keys = new Set(Object.keys(messages));

    // 1. Key-set parity.
    const missing = setDiff(enKeys, keys);
    const extra = setDiff(keys, enKeys);
    if (missing.length > 0) {
      fail(`ui.${locale}.json is missing ${missing.length} key(s): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}`);
    }
    if (extra.length > 0) {
      fail(`ui.${locale}.json has ${extra.length} unexpected key(s) not in ui.en.json: ${extra.slice(0, 10).join(', ')}${extra.length > 10 ? ', …' : ''}`);
    }

    // 2. Empty / whitespace-only values.
    let emptyCount = 0;
    for (const [key, value] of Object.entries(messages)) {
      if (typeof value !== 'string' || value.trim() === '') {
        fail(`ui.${locale}.json["${key}"] is empty or whitespace-only`);
        emptyCount++;
      }
    }

    // 3. Placeholder parity, only over keys present in both.
    let placeholderIssues = 0;
    for (const key of enKeys) {
      if (!keys.has(key)) continue;
      const enValue = en[key];
      const localeValue = messages[key];
      if (typeof enValue !== 'string' || typeof localeValue !== 'string') continue;
      const enTokens = extractPlaceholders(enValue);
      const localeTokens = extractPlaceholders(localeValue);
      const droppedTokens = setDiff(enTokens, localeTokens);
      const unknownTokens = setDiff(localeTokens, enTokens);
      if (droppedTokens.length > 0) {
        fail(`ui.${locale}.json["${key}"] drops placeholder(s) ${droppedTokens.map((t) => `{${t}}`).join(', ')} present in English`);
        placeholderIssues++;
      }
      if (unknownTokens.length > 0) {
        fail(`ui.${locale}.json["${key}"] introduces unknown placeholder(s) ${unknownTokens.map((t) => `{${t}}`).join(', ')} not present in English`);
        placeholderIssues++;
      }
    }

    // 4. Leftover-English detection (skip the English file itself).
    let identicalCount = 0;
    let comparableCount = 0;
    if (locale !== 'en') {
      for (const key of enKeys) {
        if (!keys.has(key)) continue;
        const enValue = en[key];
        const localeValue = messages[key];
        if (typeof enValue !== 'string' || typeof localeValue !== 'string') continue;
        comparableCount++;
        if (enValue !== localeValue) continue;
        const allowed =
          IDENTICAL_ALLOWLIST_KEYS.has(key) ||
          IDENTICAL_ALLOWLIST_VALUES.has(localeValue) ||
          PLACEHOLDER_ONLY_VALUE.test(localeValue.trim());
        if (!allowed) identicalCount++;
      }
      const rate = comparableCount > 0 ? identicalCount / comparableCount : 0;
      if (identicalCount > 0) {
        const pct = (rate * 100).toFixed(1);
        if (rate > IDENTICAL_RATE_FAIL_THRESHOLD) {
          fail(
            `ui.${locale}.json has ${identicalCount}/${comparableCount} (${pct}%) values byte-identical to English — exceeds the ${(IDENTICAL_RATE_FAIL_THRESHOLD * 100).toFixed(0)}% threshold, looks like an un-translated copy of ui.en.json`,
          );
        } else {
          warn(`ui.${locale}.json: ${identicalCount}/${comparableCount} (${pct}%) values identical to English (within tolerance — likely genuine cognates)`);
        }
      }
    }

    row[1] = String(keys.size);
    row[2] = missing.length === 0 && extra.length === 0 ? 'OK' : `${missing.length}missing/${extra.length}extra`;
    row[3] = emptyCount === 0 ? 'OK' : `${emptyCount} empty`;
    row[4] = placeholderIssues === 0 ? 'OK' : `${placeholderIssues} issues`;
    row[5] = locale === 'en' ? '—' : `${identicalCount}/${comparableCount}`;
    summaryRows.push(row);
  }

  printTable(['locale', 'keys', 'key-parity', 'empty', 'placeholders', 'identical-to-en'], summaryRows);
  summaryRows.length = 0;
}

/* ─────────────────────────── question translations ─────────────────────── */

interface QuestionTranslation {
  readonly question?: unknown;
  readonly options?: { readonly a?: unknown; readonly b?: unknown; readonly c?: unknown; readonly d?: unknown };
  readonly explanation?: unknown;
}

function lintQuestionTranslations(): void {
  console.log('\n=== Question translations (src/data/i18n/questions.<locale>.json) ===\n');

  if (!fs.existsSync(QUESTIONS_MASTER)) {
    fail(`missing master question set: ${path.relative(ROOT, QUESTIONS_MASTER)}`);
    return;
  }
  const master = readJson(QUESTIONS_MASTER);
  if (!Array.isArray(master)) {
    fail(`${path.relative(ROOT, QUESTIONS_MASTER)} is not an array`);
    return;
  }
  const masterIds = new Set<string>();
  for (const q of master) {
    if (typeof q === 'object' && q !== null && 'id' in q && typeof (q as { id: unknown }).id === 'string') {
      masterIds.add((q as { id: string }).id);
    }
  }

  const rows: string[][] = [];

  for (const locale of TRANSLATION_LOCALES) {
    const filePath = path.join(QUESTIONS_DIR, `questions.${locale}.json`);
    const row = [locale, '-', '-', '-'];

    if (!fs.existsSync(filePath)) {
      fail(`src/data/i18n/questions.${locale}.json does not exist`);
      row[1] = 'MISSING';
      rows.push(row);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = readJson(filePath);
    } catch (err) {
      fail(`src/data/i18n/questions.${locale}.json is not valid JSON: ${(err as Error).message}`);
      row[1] = 'INVALID JSON';
      rows.push(row);
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      fail(`src/data/i18n/questions.${locale}.json is not a flat object keyed by question id`);
      row[1] = 'INVALID SHAPE';
      rows.push(row);
      continue;
    }

    const entries = parsed as Record<string, QuestionTranslation>;
    const ids = new Set(Object.keys(entries));

    if (ids.size !== 460) {
      fail(`questions.${locale}.json has ${ids.size} entries, expected 460`);
    }

    const missingFromMaster = setDiff(masterIds, ids);
    const extraVsMaster = setDiff(ids, masterIds);
    if (missingFromMaster.length > 0) {
      fail(`questions.${locale}.json is missing ${missingFromMaster.length} question id(s) present in questions.json: ${missingFromMaster.slice(0, 5).join(', ')}${missingFromMaster.length > 5 ? ', …' : ''}`);
    }
    if (extraVsMaster.length > 0) {
      fail(`questions.${locale}.json has ${extraVsMaster.length} question id(s) not present in questions.json: ${extraVsMaster.slice(0, 5).join(', ')}${extraVsMaster.length > 5 ? ', …' : ''}`);
    }

    let emptyCount = 0;
    for (const [id, entry] of Object.entries(entries)) {
      if (typeof entry.question !== 'string' || entry.question.trim() === '') {
        fail(`questions.${locale}.json["${id}"].question is empty`);
        emptyCount++;
      }
      const options = entry.options;
      for (const letter of ['a', 'b', 'c', 'd'] as const) {
        const value = options?.[letter];
        if (typeof value !== 'string' || value.trim() === '') {
          fail(`questions.${locale}.json["${id}"].options.${letter} is empty`);
          emptyCount++;
        }
      }
    }

    row[1] = String(ids.size);
    row[2] = missingFromMaster.length === 0 && extraVsMaster.length === 0 ? 'OK' : `${missingFromMaster.length}missing/${extraVsMaster.length}extra`;
    row[3] = emptyCount === 0 ? 'OK' : `${emptyCount} empty`;
    rows.push(row);
  }

  printTable(['locale', 'entries', 'id-parity', 'empty'], rows);
}

/* ──────────────────────────────── output ────────────────────────────────── */

function printTable(headers: readonly string[], rows: readonly string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const formatRow = (cells: readonly string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  console.log(formatRow(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(formatRow(row));
}

lintUiLocales();
lintQuestionTranslations();

console.log('');
if (hardFailure) {
  console.error('i18n lint FAILED — see ✗ lines above.');
  process.exit(1);
} else {
  console.log('i18n lint passed.');
}
