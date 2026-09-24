// German read-aloud via the Web Speech API (synthesis only).
//
// Explicit non-goal: speech *recognition*. We never ask for the microphone.
//
// Everything here is feature-detected and wrapped, because this API is a
// minefield: absent in jsdom, absent in some in-app webviews, `getVoices()`
// returns an empty array until the async `voiceschanged` event fires, and iOS
// throws if you speak without a user gesture. No function in this module is
// allowed to throw — the worst case is "no sound", never a broken screen.

/** BCP-47 tag we ask for. Standard German; regional voices still match via the `de-` prefix. */
export const GERMAN_LANG = 'de-DE';
/** Slightly under natural pace — learners read along with the text. */
export const DEFAULT_RATE = 0.9;

export interface SpeakOptions {
  readonly onEnd?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly rate?: number;
  readonly pitch?: number;
}

/**
 * The two globals we need, both marked optional so the code is forced to check
 * them. `globalThis` is read lazily on every call: the browser can define these
 * late, and tests stub them per-case.
 */
interface SpeechGlobals {
  readonly speechSynthesis?: SpeechSynthesis;
  readonly SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
}

function speechGlobals(): SpeechGlobals {
  return globalThis;
}

function synth(): SpeechSynthesis | null {
  const ss = speechGlobals().speechSynthesis;
  if (ss === undefined || ss === null) return null;
  if (typeof ss.speak !== 'function' || typeof ss.cancel !== 'function') return null;
  return ss;
}

function utteranceCtor(): typeof SpeechSynthesisUtterance | null {
  const ctor = speechGlobals().SpeechSynthesisUtterance;
  return typeof ctor === 'function' ? ctor : null;
}

/** True only when we can actually construct and speak an utterance. */
export function isTtsAvailable(): boolean {
  return synth() !== null && utteranceCtor() !== null;
}

/* ─────────────────────────── the voices quirk ─────────────────────── */

/**
 * Last non-empty voice list we saw. `getVoices()` is famously empty on the first
 * call in Chrome and Safari and only fills in after `voiceschanged`, so we
 * remember the good answer and keep using it.
 */
let cachedVoices: readonly SpeechSynthesisVoice[] = [];
let listening = false;

function readVoices(ss: SpeechSynthesis): readonly SpeechSynthesisVoice[] {
  if (typeof ss.getVoices !== 'function') return [];
  try {
    const voices = ss.getVoices();
    return Array.isArray(voices) ? voices : [];
  } catch {
    return [];
  }
}

/**
 * Start listening for `voiceschanged` so the cache is warm by the time the user
 * taps the speaker button. Safe to call repeatedly and safe when unsupported.
 */
export function primeVoices(): void {
  const ss = synth();
  if (ss === null) return;

  const fresh = readVoices(ss);
  if (fresh.length > 0) cachedVoices = fresh;

  if (listening || typeof ss.addEventListener !== 'function') return;
  try {
    ss.addEventListener('voiceschanged', () => {
      const updated = readVoices(ss);
      if (updated.length > 0) cachedVoices = updated;
    });
    listening = true;
  } catch {
    // Some webviews expose addEventListener but reject unknown event names.
  }
}

/** Drop the remembered voice list. Useful when the platform resets its voices, and in tests. */
export function clearVoiceCache(): void {
  cachedVoices = [];
  listening = false;
}

/** All voices we currently know about, preferring a live read over the cache. */
export function availableVoices(): readonly SpeechSynthesisVoice[] {
  const ss = synth();
  if (ss === null) return [];
  const fresh = readVoices(ss);
  if (fresh.length > 0) {
    cachedVoices = fresh;
    return fresh;
  }
  return cachedVoices;
}

/** `de_DE`, `DE-de` and `de-DE` all normalise to `de-de`. Android reports underscores. */
function normaliseLang(lang: unknown): string {
  return typeof lang === 'string' ? lang.toLowerCase().replace(/_/g, '-') : '';
}

/** 2 = exact `de-DE`, 1 = any other German (`de-AT`, `de-CH`, bare `de`), 0 = not German. */
function germanScore(voice: SpeechSynthesisVoice): 0 | 1 | 2 {
  const lang = normaliseLang(voice.lang);
  if (lang === 'de-de') return 2;
  if (lang === 'de' || lang.startsWith('de-')) return 1;
  return 0;
}

/**
 * Best German voice, or `null` when the platform has none (in which case we let
 * the engine pick by `lang` instead of forcing an English voice on German text).
 *
 * Preference order: exact `de-DE` over other German locales, then the
 * platform-default voice, then a local (offline) voice, then list order — so the
 * choice is deterministic for a given voice list.
 */
export function germanVoice(): SpeechSynthesisVoice | null {
  let best: SpeechSynthesisVoice | null = null;
  let bestScore = 0;

  for (const voice of availableVoices()) {
    const score = germanScore(voice);
    if (score === 0) continue;
    if (best === null || score > bestScore) {
      best = voice;
      bestScore = score;
      continue;
    }
    if (score < bestScore) continue;
    if (voice.default && !best.default) {
      best = voice;
      continue;
    }
    if (voice.default === best.default && voice.localService && !best.localService) {
      best = voice;
    }
  }

  return best;
}

/* ─────────────────────────────── speaking ─────────────────────────── */

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Speak `text` in German. Returns `true` when speech was handed to the platform.
 *
 * Returns `false` without calling either callback when TTS is unavailable or the
 * text is blank — callers get a synchronous answer instead of waiting on an
 * `onEnd` that will never come.
 *
 * Any queued speech is cancelled first: tapping the speaker on question 5 must
 * not queue behind question 4.
 */
export function speakGerman(text: string, options?: SpeakOptions): boolean {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length === 0) return false;

  const ss = synth();
  const Utterance = utteranceCtor();
  if (ss === null || Utterance === null) return false;

  try {
    try {
      ss.cancel();
    } catch {
      // Cancelling an idle engine throws in some webviews; speaking is still fine.
    }

    const utterance = new Utterance(trimmed);
    utterance.lang = GERMAN_LANG;
    utterance.rate = clampNumber(options?.rate, DEFAULT_RATE, 0.5, 2);
    utterance.pitch = clampNumber(options?.pitch, 1, 0, 2);

    const voice = germanVoice();
    if (voice !== null) utterance.voice = voice;
    else primeVoices(); // no voices yet — warm the cache for the next tap

    const onEnd = options?.onEnd;
    const onError = options?.onError;
    if (onEnd !== undefined) utterance.onend = () => onEnd();
    if (onError !== undefined) utterance.onerror = (event) => onError(event);

    ss.speak(utterance);
    return true;
  } catch (error) {
    options?.onError?.(error);
    return false;
  }
}

/** Stop immediately and drop anything queued. No-op when unsupported. */
export function cancelSpeech(): void {
  const ss = synth();
  if (ss === null) return;
  try {
    ss.cancel();
  } catch {
    // Nothing useful to do — the user just keeps hearing the current word.
  }
}

/** True while the platform is speaking or has something queued. */
export function isSpeaking(): boolean {
  const ss = synth();
  if (ss === null) return false;
  return ss.speaking === true || ss.pending === true;
}
