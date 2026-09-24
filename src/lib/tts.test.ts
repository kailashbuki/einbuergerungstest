import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RATE,
  GERMAN_LANG,
  availableVoices,
  cancelSpeech,
  clearVoiceCache,
  germanVoice,
  isSpeaking,
  isTtsAvailable,
  primeVoices,
  speakGerman,
} from './tts';

/** Minimal utterance stand-in: jsdom implements none of the Web Speech API. */
class FakeUtterance {
  public lang = '';
  public rate = 1;
  public pitch = 1;
  public voice: SpeechSynthesisVoice | null = null;
  public onend: (() => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public constructor(public readonly text: string) {}
}

interface FakeSynth {
  speaking: boolean;
  pending: boolean;
  voices: readonly SpeechSynthesisVoice[];
  spoken: FakeUtterance[];
  cancelCount: number;
  listeners: Map<string, (() => void)[]>;
  speak(utterance: FakeUtterance): void;
  cancel(): void;
  getVoices(): readonly SpeechSynthesisVoice[];
  addEventListener(type: string, listener: () => void): void;
  emit(type: string): void;
}

function voice(
  lang: string,
  name: string,
  flags: { readonly isDefault?: boolean; readonly local?: boolean } = {},
): SpeechSynthesisVoice {
  return {
    default: flags.isDefault ?? false,
    lang,
    localService: flags.local ?? false,
    name,
    voiceURI: `urn:voice:${name}`,
  };
}

function fakeSynth(voices: readonly SpeechSynthesisVoice[]): FakeSynth {
  const synth: FakeSynth = {
    speaking: false,
    pending: false,
    voices,
    spoken: [],
    cancelCount: 0,
    listeners: new Map<string, (() => void)[]>(),
    speak(utterance: FakeUtterance) {
      synth.spoken.push(utterance);
      synth.speaking = true;
    },
    cancel() {
      synth.cancelCount += 1;
      synth.speaking = false;
      synth.pending = false;
    },
    getVoices() {
      return synth.voices;
    },
    addEventListener(type: string, listener: () => void) {
      const existing = synth.listeners.get(type) ?? [];
      existing.push(listener);
      synth.listeners.set(type, existing);
    },
    emit(type: string) {
      for (const listener of synth.listeners.get(type) ?? []) listener();
    },
  };
  return synth;
}

const MIXED_VOICES: readonly SpeechSynthesisVoice[] = [
  voice('en-US', 'Samantha', { isDefault: true, local: true }),
  voice('fr-FR', 'Amelie'),
  voice('de-AT', 'Österreich-Stimme', { local: true }),
  voice('de-DE', 'Anna-Remote'),
  voice('de-DE', 'Anna-Lokal', { local: true }),
  voice('en-GB', 'Daniel'),
];

function install(voices: readonly SpeechSynthesisVoice[]): FakeSynth {
  const synth = fakeSynth(voices);
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  return synth;
}

beforeEach(() => {
  clearVoiceCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearVoiceCache();
});

describe('without speechSynthesis (jsdom, locked-down webviews)', () => {
  beforeEach(() => {
    vi.stubGlobal('speechSynthesis', undefined);
    vi.stubGlobal('SpeechSynthesisUtterance', undefined);
  });

  it('reports TTS as unavailable', () => {
    expect(isTtsAvailable()).toBe(false);
  });

  it('makes every entry point a safe no-op', () => {
    expect(() => speakGerman('Was war am 8. Mai 1945?')).not.toThrow();
    expect(speakGerman('Was war am 8. Mai 1945?')).toBe(false);
    expect(() => cancelSpeech()).not.toThrow();
    expect(() => primeVoices()).not.toThrow();
    expect(isSpeaking()).toBe(false);
    expect(germanVoice()).toBeNull();
    expect(availableVoices()).toEqual([]);
  });

  it('never invokes the callbacks it cannot honour', () => {
    const onEnd = vi.fn();
    const onError = vi.fn();
    expect(speakGerman('Hallo', { onEnd, onError })).toBe(false);
    expect(onEnd).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('with speechSynthesis but no utterance constructor', () => {
  it('still reports unavailable rather than half-working', () => {
    vi.stubGlobal('speechSynthesis', fakeSynth(MIXED_VOICES));
    vi.stubGlobal('SpeechSynthesisUtterance', undefined);
    expect(isTtsAvailable()).toBe(false);
    expect(speakGerman('Hallo')).toBe(false);
  });
});

describe('germanVoice', () => {
  it('picks a de-DE voice out of a mixed list', () => {
    install(MIXED_VOICES);
    expect(isTtsAvailable()).toBe(true);
    const chosen = germanVoice();
    expect(chosen?.lang).toBe('de-DE');
    // Neither de-DE voice is the platform default, so the local one wins.
    expect(chosen?.name).toBe('Anna-Lokal');
  });

  it('prefers the platform-default German voice', () => {
    install([
      voice('de-DE', 'Anna-Lokal', { local: true }),
      voice('de-DE', 'Anna-Default', { isDefault: true }),
    ]);
    expect(germanVoice()?.name).toBe('Anna-Default');
  });

  it('falls back to another German locale when there is no de-DE', () => {
    install([voice('en-US', 'Samantha', { isDefault: true }), voice('de-CH', 'Schweiz')]);
    expect(germanVoice()?.name).toBe('Schweiz');
  });

  it('accepts the underscore lang tags some Android builds report', () => {
    install([voice('en_US', 'Samantha'), voice('DE_de', 'Android-Deutsch')]);
    expect(germanVoice()?.name).toBe('Android-Deutsch');
  });

  it('returns null when the platform has no German voice', () => {
    install([voice('en-US', 'Samantha', { isDefault: true }), voice('fr-FR', 'Amelie')]);
    expect(germanVoice()).toBeNull();
  });

  it('is deterministic for a given voice list', () => {
    install(MIXED_VOICES);
    expect(germanVoice()).toBe(germanVoice());
  });
});

describe('the empty-getVoices quirk', () => {
  it('uses the voices that arrive with the voiceschanged event', () => {
    const synth = install([]);
    expect(germanVoice()).toBeNull();

    primeVoices();
    synth.voices = MIXED_VOICES;
    synth.emit('voiceschanged');
    expect(germanVoice()?.lang).toBe('de-DE');

    // Chrome sometimes goes back to returning an empty list; the cache holds.
    synth.voices = [];
    expect(germanVoice()?.name).toBe('Anna-Lokal');
    expect(availableVoices()).toHaveLength(MIXED_VOICES.length);
  });

  it('primes the cache on the first speak attempt even with no voices yet', () => {
    const synth = install([]);
    expect(speakGerman('Hallo')).toBe(true);
    expect(synth.listeners.get('voiceschanged')).toHaveLength(1);
    // Spoken with the right language even though no voice object was available.
    expect(synth.spoken[0]?.lang).toBe(GERMAN_LANG);
    expect(synth.spoken[0]?.voice).toBeNull();
  });
});

describe('speakGerman', () => {
  it('speaks German with the chosen voice and a learner-friendly rate', () => {
    const synth = install(MIXED_VOICES);
    expect(speakGerman('Was steht im Grundgesetz?')).toBe(true);

    const utterance = synth.spoken[0];
    expect(utterance).toBeDefined();
    expect(utterance?.text).toBe('Was steht im Grundgesetz?');
    expect(utterance?.lang).toBe(GERMAN_LANG);
    expect(utterance?.rate).toBe(DEFAULT_RATE);
    expect(utterance?.voice?.name).toBe('Anna-Lokal');
  });

  it('cancels whatever was queued before speaking', () => {
    const synth = install(MIXED_VOICES);
    speakGerman('Erste Frage');
    speakGerman('Zweite Frage');
    expect(synth.cancelCount).toBe(2);
    expect(synth.spoken).toHaveLength(2);
  });

  it('ignores blank text', () => {
    const synth = install(MIXED_VOICES);
    expect(speakGerman('')).toBe(false);
    expect(speakGerman('   \n ')).toBe(false);
    expect(synth.spoken).toHaveLength(0);
  });

  it('trims the text it speaks', () => {
    const synth = install(MIXED_VOICES);
    speakGerman('  Hallo Welt  ');
    expect(synth.spoken[0]?.text).toBe('Hallo Welt');
  });

  it('clamps an absurd rate and pitch', () => {
    const synth = install(MIXED_VOICES);
    speakGerman('Test', { rate: 99, pitch: -4 });
    expect(synth.spoken[0]?.rate).toBe(2);
    expect(synth.spoken[0]?.pitch).toBe(0);

    speakGerman('Test', { rate: Number.NaN });
    expect(synth.spoken[1]?.rate).toBe(DEFAULT_RATE);
  });

  it('wires onEnd', () => {
    const synth = install(MIXED_VOICES);
    const onEnd = vi.fn();
    speakGerman('Fertig', { onEnd });
    synth.spoken[0]?.onend?.();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('wires onError', () => {
    const synth = install(MIXED_VOICES);
    const onError = vi.fn();
    speakGerman('Kaputt', { onError });
    synth.spoken[0]?.onerror?.({ error: 'interrupted' });
    expect(onError).toHaveBeenCalledWith({ error: 'interrupted' });
  });

  it('reports failure through onError when the platform throws', () => {
    const synth = install(MIXED_VOICES);
    synth.speak = () => {
      throw new Error('not-allowed');
    };
    const onError = vi.fn();
    expect(speakGerman('Hallo', { onError })).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('survives a platform whose cancel throws', () => {
    const synth = install(MIXED_VOICES);
    synth.cancel = () => {
      throw new Error('nothing to cancel');
    };
    expect(speakGerman('Hallo')).toBe(true);
    expect(() => cancelSpeech()).not.toThrow();
  });
});

describe('cancelSpeech / isSpeaking', () => {
  it('calls the platform cancel', () => {
    const synth = install(MIXED_VOICES);
    cancelSpeech();
    expect(synth.cancelCount).toBe(1);
  });

  it('tracks speaking and pending', () => {
    const synth = install(MIXED_VOICES);
    expect(isSpeaking()).toBe(false);
    speakGerman('Hallo');
    expect(isSpeaking()).toBe(true);
    cancelSpeech();
    expect(isSpeaking()).toBe(false);
    synth.pending = true;
    expect(isSpeaking()).toBe(true);
  });
});
