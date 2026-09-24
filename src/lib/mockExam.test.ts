import { describe, expect, it } from 'vitest';
import { federalQuestions, stateQuestions } from './deck';
import {
  MOCK_FEDERAL_COUNT,
  MOCK_PASS_MARK,
  MOCK_STATE_COUNT,
  MOCK_TOTAL_QUESTIONS,
  buildMockPaper,
  buildMockResult,
  scoreMockPaper,
  type MockResponses,
} from './mockExam';
import type { Question, StateCode } from '@/types';

const STATE: StateCode = 'BW';

describe('buildMockPaper', () => {
  it('draws exactly 33 questions: 30 federal + 3 from the requested state, no duplicates', () => {
    const paper = buildMockPaper(STATE, 42);
    expect(paper).toHaveLength(MOCK_TOTAL_QUESTIONS);

    const federal = paper.filter((q) => q.scope === 'federal');
    const state = paper.filter((q) => q.scope === 'state');
    expect(federal).toHaveLength(MOCK_FEDERAL_COUNT);
    expect(state).toHaveLength(MOCK_STATE_COUNT);
    expect(state.every((q) => q.state === STATE)).toBe(true);

    const ids = paper.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('draws every state question from the requested Bundesland only', () => {
    const paper = buildMockPaper('BY', 7);
    const state = paper.filter((q) => q.scope === 'state');
    expect(state.every((q) => q.state === 'BY')).toBe(true);
    expect(state.some((q) => q.state === 'BW')).toBe(false);
  });

  it('is deterministic: the same seed reproduces the same paper', () => {
    const a = buildMockPaper(STATE, 1234);
    const b = buildMockPaper(STATE, 1234);
    expect(a.map((q) => q.id)).toEqual(b.map((q) => q.id));
  });

  it('a different seed produces a different paper', () => {
    const a = buildMockPaper(STATE, 1);
    const b = buildMockPaper(STATE, 2);
    expect(a.map((q) => q.id)).not.toEqual(b.map((q) => q.id));
  });

  it('draws only from the 300 federal questions and this state’s 10', () => {
    const paper = buildMockPaper(STATE, 99);
    const federalIds = new Set(federalQuestions().map((q) => q.id));
    const stateIds = new Set(stateQuestions(STATE).map((q) => q.id));
    for (const q of paper) {
      expect(federalIds.has(q.id) || stateIds.has(q.id)).toBe(true);
    }
  });
});

describe('scoreMockPaper', () => {
  const startedAt = 1_000_000;

  function paperOf(size: number): readonly Question[] {
    return buildMockPaper(STATE, 5).slice(0, size);
  }

  it('scores 17 correct as a pass', () => {
    const paper = buildMockPaper(STATE, 5);
    expect(paper.length).toBeGreaterThanOrEqual(MOCK_PASS_MARK);
    const responses: MockResponses = {};
    paper.slice(0, MOCK_PASS_MARK).forEach((q, i) => {
      (responses as Record<string, { chosen: typeof q.solution; answeredAt: number }>)[q.id] = {
        chosen: q.solution,
        answeredAt: startedAt + i * 1000,
      };
    });
    const score = scoreMockPaper(paper, responses, startedAt);
    expect(score.correct).toBe(MOCK_PASS_MARK);
    expect(score.passed).toBe(true);
  });

  it('scores 16 correct as a fail', () => {
    const paper = buildMockPaper(STATE, 5);
    const responses: MockResponses = {};
    paper.slice(0, MOCK_PASS_MARK - 1).forEach((q, i) => {
      (responses as Record<string, { chosen: typeof q.solution; answeredAt: number }>)[q.id] = {
        chosen: q.solution,
        answeredAt: startedAt + i * 1000,
      };
    });
    const score = scoreMockPaper(paper, responses, startedAt);
    expect(score.correct).toBe(MOCK_PASS_MARK - 1);
    expect(score.passed).toBe(false);
  });

  it('scores an unanswered question as incorrect with ms 0', () => {
    const paper = paperOf(3);
    const score = scoreMockPaper(paper, {}, startedAt);
    expect(score.correct).toBe(0);
    expect(score.total).toBe(3);
    expect(score.answers.every((a) => a.chosen === null && !a.correct && a.ms === 0)).toBe(true);
  });

  it('scores a wrong-option answer as incorrect', () => {
    const paper = paperOf(1);
    const q = paper[0];
    expect(q).toBeDefined();
    if (q === undefined) return;
    const wrongOption = (['a', 'b', 'c', 'd'] as const).find((k) => k !== q.solution);
    expect(wrongOption).toBeDefined();
    if (wrongOption === undefined) return;
    const responses: MockResponses = { [q.id]: { chosen: wrongOption, answeredAt: startedAt + 500 } };
    const score = scoreMockPaper(paper, responses, startedAt);
    expect(score.correct).toBe(0);
    expect(score.answers[0]?.correct).toBe(false);
  });
});

describe('buildMockResult', () => {
  it('produces a MockResult carrying the state it was taken in', () => {
    const paper = buildMockPaper(STATE, 3);
    const startedAt = 2_000_000;
    const finishedAt = startedAt + 45 * 60_000;
    const result = buildMockResult({
      id: 'mock-1',
      state: STATE,
      startedAt,
      finishedAt,
      paper,
      responses: {},
    });
    expect(result.state).toBe(STATE);
    expect(result.total).toBe(MOCK_TOTAL_QUESTIONS);
    expect(result.durationMs).toBe(45 * 60_000);
    expect(result.answers).toHaveLength(MOCK_TOTAL_QUESTIONS);
  });
});
