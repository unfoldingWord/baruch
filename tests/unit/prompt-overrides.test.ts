import { describe, it, expect } from 'vitest';
import {
  validatePromptOverrides,
  mergePromptOverrides,
  resolvePromptOverrides,
  DEFAULT_PROMPT_VALUES,
  PROMPT_OVERRIDE_SLOTS,
  MAX_OVERRIDE_LENGTH,
  PromptOverrides,
} from '../../src/types/prompt-overrides.js';

describe('validatePromptOverrides', () => {
  it('accepts valid overrides', () => {
    expect(validatePromptOverrides({ identity: 'hello' })).toBeNull();
  });

  it('accepts null values (delete)', () => {
    expect(validatePromptOverrides({ identity: null })).toBeNull();
  });

  it('accepts empty object', () => {
    expect(validatePromptOverrides({})).toBeNull();
  });

  it('rejects non-object', () => {
    expect(validatePromptOverrides('string')).toBe('Prompt overrides must be a JSON object');
    expect(validatePromptOverrides(42)).toBe('Prompt overrides must be a JSON object');
    expect(validatePromptOverrides(null)).toBe('Prompt overrides must be a JSON object');
  });

  it('rejects arrays', () => {
    expect(validatePromptOverrides([])).toBe('Prompt overrides must be a JSON object');
  });

  it('rejects unknown slot names', () => {
    const result = validatePromptOverrides({ unknown_slot: 'value' });
    expect(result).toContain('Unknown prompt slot');
    expect(result).toContain('unknown_slot');
  });

  it('rejects non-string values', () => {
    const result = validatePromptOverrides({ identity: 123 });
    expect(result).toContain('must be a string or null');
  });

  it('rejects values exceeding max length', () => {
    const result = validatePromptOverrides({ identity: 'x'.repeat(MAX_OVERRIDE_LENGTH + 1) });
    expect(result).toContain('exceeds maximum length');
  });

  it('accepts values at exact max length', () => {
    expect(validatePromptOverrides({ identity: 'x'.repeat(MAX_OVERRIDE_LENGTH) })).toBeNull();
  });
});

describe('mergePromptOverrides', () => {
  it('merges string values into existing', () => {
    const existing: PromptOverrides = { identity: 'old' };
    const result = mergePromptOverrides(existing, { identity: 'new' });
    expect(result.identity).toBe('new');
  });

  it('deletes slots set to null', () => {
    const existing: PromptOverrides = { identity: 'value' };
    const result = mergePromptOverrides(existing, { identity: null });
    expect(result.identity).toBeUndefined();
  });

  it('preserves unmodified slots', () => {
    const existing: PromptOverrides = { identity: 'keep', methodology: 'also keep' };
    const result = mergePromptOverrides(existing, { identity: 'changed' });
    expect(result.methodology).toBe('also keep');
  });

  it('strips control characters from values', () => {
    const result = mergePromptOverrides({}, { identity: 'hello\x00world' });
    expect(result.identity).toBe('helloworld');
  });

  it('does not mutate the existing object', () => {
    const existing: PromptOverrides = { identity: 'original' };
    mergePromptOverrides(existing, { identity: 'changed' });
    expect(existing.identity).toBe('original');
  });
});

describe('resolvePromptOverrides', () => {
  it('returns defaults when no overrides are set', () => {
    const result = resolvePromptOverrides({});
    for (const slot of PROMPT_OVERRIDE_SLOTS) {
      expect(result[slot]).toBe(DEFAULT_PROMPT_VALUES[slot]);
    }
  });

  it('overrides specific slots', () => {
    const result = resolvePromptOverrides({ identity: 'Custom identity' });
    expect(result.identity).toBe('Custom identity');
    expect(result.methodology).toBe(DEFAULT_PROMPT_VALUES.methodology);
  });

  it('ignores empty/whitespace-only overrides', () => {
    const result = resolvePromptOverrides({ identity: '   ' });
    expect(result.identity).toBe(DEFAULT_PROMPT_VALUES.identity);
  });

  it('ignores null overrides', () => {
    const result = resolvePromptOverrides({ identity: null });
    expect(result.identity).toBe(DEFAULT_PROMPT_VALUES.identity);
  });

  it('strips control characters from overrides', () => {
    const result = resolvePromptOverrides({ identity: 'hello\x07world' });
    expect(result.identity).toBe('helloworld');
  });
});
