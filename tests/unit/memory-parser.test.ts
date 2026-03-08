import { describe, it, expect } from 'vitest';
import {
  formatSize,
  formatTOCForPrompt,
  parseV1Sections,
  calculateTotalSize,
} from '../../src/services/memory/parser.js';

describe('formatSize', () => {
  it('formats bytes', () => {
    expect(formatSize(512)).toBe('512 B');
  });

  it('formats kilobytes', () => {
    expect(formatSize(2048)).toBe('2.0 KB');
  });

  it('formats zero', () => {
    expect(formatSize(0)).toBe('0 B');
  });
});

describe('formatTOCForPrompt', () => {
  it('returns empty string for no entries', () => {
    expect(formatTOCForPrompt({ entries: [], totalSizeBytes: 0, maxSizeBytes: 131072 })).toBe('');
  });

  it('formats entries with sizes', () => {
    const result = formatTOCForPrompt({
      entries: [{ name: 'Preferences', sizeBytes: 128, pinned: false }],
      totalSizeBytes: 128,
      maxSizeBytes: 131072,
    });
    expect(result).toContain('**Preferences**');
    expect(result).toContain('128 B');
    expect(result).toContain('Total:');
  });

  it('shows pinned tag for pinned entries', () => {
    const result = formatTOCForPrompt({
      entries: [{ name: 'Important', sizeBytes: 64, pinned: true }],
      totalSizeBytes: 64,
      maxSizeBytes: 131072,
    });
    expect(result).toContain('[pinned]');
  });
});

describe('parseV1Sections', () => {
  it('parses level-2 headings into sections', () => {
    const markdown = '## Topic A\nContent A\n## Topic B\nContent B';
    const sections = parseV1Sections(markdown);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.name).toBe('Topic A');
    expect(sections[1]!.name).toBe('Topic B');
  });

  it('returns empty for empty string', () => {
    expect(parseV1Sections('')).toHaveLength(0);
  });

  it('drops preamble before first heading', () => {
    const sections = parseV1Sections('preamble\n## Heading\nContent');
    expect(sections).toHaveLength(1);
    expect(sections[0]!.name).toBe('Heading');
  });
});

describe('calculateTotalSize', () => {
  it('sums byte lengths of all entries', () => {
    const entries = {
      a: { content: 'hello' },
      b: { content: 'world' },
    };
    expect(calculateTotalSize(entries)).toBe(10);
  });

  it('returns 0 for empty entries', () => {
    expect(calculateTotalSize({})).toBe(0);
  });

  it('handles multi-byte characters', () => {
    const entries = { emoji: { content: '😀' } };
    expect(calculateTotalSize(entries)).toBe(4); // UTF-8 encoded
  });
});
