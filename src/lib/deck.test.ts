import { describe, expect, it } from 'vitest';
import { STATE_CODES } from '@/data/states';
import { OPTION_KEYS } from '@/types';
import {
  ACTIVE_DECK_SIZE,
  activeDeck,
  allQuestions,
  federalQuestions,
  isInActiveDeck,
  questionById,
  stateQuestions,
} from './deck';

describe('deck dataset', () => {
  it('ships 460 records: 300 federal + 160 state', () => {
    expect(allQuestions()).toHaveLength(460);
    expect(federalQuestions()).toHaveLength(300);
    expect(allQuestions().filter((q) => q.scope === 'state')).toHaveLength(160);
  });

  it('has unique ids and a solution that exists in the options', () => {
    const ids = new Set<string>();
    for (const q of allQuestions()) {
      expect(ids.has(q.id)).toBe(false);
      ids.add(q.id);
      expect(OPTION_KEYS).toContain(q.solution);
      expect(q.options[q.solution].length).toBeGreaterThan(0);
    }
    expect(ids.size).toBe(460);
  });

  it('round-trips every one of the 460 ids through questionById', () => {
    for (const q of allQuestions()) {
      expect(questionById(q.id)).toBe(q);
    }
    expect(questionById('NOPE')).toBeUndefined();
    expect(questionById('')).toBeUndefined();
  });

  it('only state-scoped questions carry a state', () => {
    for (const q of allQuestions()) {
      if (q.scope === 'federal') expect(q.state).toBeUndefined();
      else expect(q.state).toBeDefined();
    }
  });
});

describe('activeDeck', () => {
  // Looping all 16 states is the point: a data regression that drops or
  // duplicates one state's questions shows up here and nowhere else.
  it.each(STATE_CODES)('is exactly 310 questions for %s', (state) => {
    const deck = activeDeck(state);
    expect(deck).toHaveLength(ACTIVE_DECK_SIZE);
    expect(deck).toHaveLength(310);

    const federal = deck.filter((q) => q.scope === 'federal');
    const own = deck.filter((q) => q.scope === 'state');
    expect(federal).toHaveLength(300);
    expect(own).toHaveLength(10);
    for (const q of own) expect(q.state).toBe(state);

    expect(new Set(deck.map((q) => q.id)).size).toBe(310);
  });

  it('exposes exactly 10 questions per state', () => {
    for (const state of STATE_CODES) {
      expect(stateQuestions(state)).toHaveLength(10);
    }
  });

  it('gives every state the identical federal subset', () => {
    const reference = federalQuestions().map((q) => q.id);
    for (const state of STATE_CODES) {
      const federalIds = activeDeck(state)
        .filter((q) => q.scope === 'federal')
        .map((q) => q.id);
      expect(federalIds).toEqual(reference);
    }
  });

  it('keeps another state’s questions out of the deck', () => {
    const bwIds = new Set(activeDeck('BW').map((q) => q.id));
    expect(bwIds.has('BW01')).toBe(true);
    expect(bwIds.has('BY01')).toBe(false);
    expect(bwIds.has('TH10')).toBe(false);
  });

  it('memoises per state', () => {
    expect(activeDeck('HH')).toBe(activeDeck('HH'));
    expect(activeDeck('HH')).not.toBe(activeDeck('HB'));
  });

  it('puts the 300 federal questions first, then the state block', () => {
    const deck = activeDeck('SN');
    expect(deck.slice(0, 300).every((q) => q.scope === 'federal')).toBe(true);
    expect(deck.slice(300).map((q) => q.id)).toEqual(stateQuestions('SN').map((q) => q.id));
  });
});

describe('isInActiveDeck', () => {
  it('accepts federal ids for every state', () => {
    for (const state of STATE_CODES) {
      expect(isInActiveDeck('F001', state)).toBe(true);
      expect(isInActiveDeck('F300', state)).toBe(true);
    }
  });

  it('accepts only the matching state block', () => {
    expect(isInActiveDeck('BW01', 'BW')).toBe(true);
    expect(isInActiveDeck('BW01', 'BY')).toBe(false);
    expect(isInActiveDeck('BY10', 'BY')).toBe(true);
  });

  it('rejects unknown ids', () => {
    expect(isInActiveDeck('F999', 'BW')).toBe(false);
    expect(isInActiveDeck('', 'BW')).toBe(false);
  });
});
