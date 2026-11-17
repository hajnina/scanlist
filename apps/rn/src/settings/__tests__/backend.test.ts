/**
 * Card A6 — the backend picker's pure decisions (RN twin of B6's `BackendChoice.kt`): the four
 * options and their ladders, tolerant parsing of the persisted id, and the honest summary line.
 */
import {
  BACKEND_OPTIONS,
  DEFAULT_BACKEND,
  backendCandidates,
  backendOption,
  backendSummary,
  isBackendChoice,
  isNativeBackend,
  ladderLabel,
  matchesChoice,
  parseBackendChoice,
  parseNativeBackend,
} from '../backend';

describe('BACKEND_OPTIONS', () => {
  test('is the cross-track order auto, gpu, cpu, npu with lowercase ids', () => {
    expect(BACKEND_OPTIONS.map(option => option.id)).toEqual([
      'auto',
      'gpu',
      'cpu',
      'npu',
    ]);
  });

  test('auto is the shipped GPU→CPU ladder, never NPU', () => {
    expect(backendCandidates(DEFAULT_BACKEND)).toEqual(['gpu', 'cpu']);
    expect(ladderLabel(DEFAULT_BACKEND)).toBe('GPU → CPU fallback');
  });

  test('gpu and cpu are strict single-rung ladders', () => {
    expect(backendCandidates('gpu')).toEqual(['gpu']);
    expect(backendCandidates('cpu')).toEqual(['cpu']);
    expect(ladderLabel('gpu')).toBe('GPU only');
    expect(ladderLabel('cpu')).toBe('CPU only');
  });

  test('npu is strict and marked experimental', () => {
    const npu = backendOption('npu');
    expect(npu.candidates).toEqual(['npu']);
    expect(npu.experimental).toBe(true);
    expect(npu.ladderLabel).toBe('NPU only · experimental');
  });

  test('only npu is experimental', () => {
    expect(
      BACKEND_OPTIONS.filter(option => option.experimental).map(o => o.id),
    ).toEqual(['npu']);
  });
});

describe('parseBackendChoice', () => {
  test('accepts the four ids, trimmed and case-insensitively (B6 fromId)', () => {
    expect(parseBackendChoice('auto')).toBe('auto');
    expect(parseBackendChoice(' GPU ')).toBe('gpu');
    expect(parseBackendChoice('Cpu')).toBe('cpu');
    expect(parseBackendChoice('npu')).toBe('npu');
  });

  test('falls back to auto for anything else, never throws', () => {
    expect(parseBackendChoice('wasm')).toBe('auto');
    expect(parseBackendChoice('')).toBe('auto');
    expect(parseBackendChoice(null)).toBe('auto');
    expect(parseBackendChoice(undefined)).toBe('auto');
    expect(parseBackendChoice(3)).toBe('auto');
    expect(parseBackendChoice({id: 'gpu'})).toBe('auto');
  });

  test('every accepted value round-trips through the guard', () => {
    for (const option of BACKEND_OPTIONS) {
      expect(isBackendChoice(option.id)).toBe(true);
      expect(parseBackendChoice(option.id)).toBe(option.id);
    }
    expect(isBackendChoice('none')).toBe(false);
  });
});

describe('native values', () => {
  test('parseNativeBackend keeps the four runtime values and maps junk to none', () => {
    for (const value of ['npu', 'gpu', 'cpu', 'none']) {
      expect(isNativeBackend(value)).toBe(true);
      expect(parseNativeBackend(value)).toBe(value);
    }
    expect(parseNativeBackend('auto')).toBe('none');
    expect(parseNativeBackend(null)).toBe('none');
    expect(parseNativeBackend(0)).toBe('none');
  });
});

describe('backendSummary', () => {
  test('before a run: the choice and its ladder only', () => {
    expect(backendSummary('auto')).toBe('Auto — GPU → CPU fallback');
    expect(backendSummary('npu', 'none')).toBe('NPU — NPU only · experimental');
  });

  test('after a run: appends the backend the ladder actually settled on', () => {
    expect(backendSummary('auto', 'cpu')).toBe(
      'Auto — GPU → CPU fallback · active CPU',
    );
    expect(backendSummary('gpu', 'gpu')).toBe('GPU — GPU only · active GPU');
    expect(backendSummary('npu', 'npu')).toBe(
      'NPU — NPU only · experimental · active NPU',
    );
  });

  test('a corrupt choice still renders the auto row instead of crashing', () => {
    expect(backendSummary('bogus' as never, 'cpu')).toContain('Auto');
  });
});

describe('matchesChoice', () => {
  test('auto accepts either rung of its ladder', () => {
    expect(matchesChoice('gpu', 'auto')).toBe(true);
    expect(matchesChoice('cpu', 'auto')).toBe(true);
    expect(matchesChoice('npu', 'auto')).toBe(false);
  });

  test('strict choices accept only their own backend', () => {
    expect(matchesChoice('gpu', 'gpu')).toBe(true);
    expect(matchesChoice('cpu', 'gpu')).toBe(false);
    expect(matchesChoice('cpu', 'cpu')).toBe(true);
    expect(matchesChoice('npu', 'npu')).toBe(true);
  });

  test('none never matches (the engine has not opened)', () => {
    for (const option of BACKEND_OPTIONS) {
      expect(matchesChoice('none', option.id)).toBe(false);
    }
  });
});
