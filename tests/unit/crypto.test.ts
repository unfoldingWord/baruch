import { describe, it, expect } from 'vitest';
import { constantTimeCompare } from '../../src/utils/crypto.js';

describe('constantTimeCompare', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeCompare('abc', 'abc')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(constantTimeCompare('abc', 'xyz')).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(constantTimeCompare('short', 'longer-string')).toBe(false);
  });

  it('returns true for empty strings', () => {
    expect(constantTimeCompare('', '')).toBe(true);
  });

  it('returns false when one is empty', () => {
    expect(constantTimeCompare('', 'notempty')).toBe(false);
  });

  it('handles unicode correctly', () => {
    expect(constantTimeCompare('café', 'café')).toBe(true);
    expect(constantTimeCompare('café', 'cafe')).toBe(false);
  });
});
