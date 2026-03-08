import { describe, it, expect } from 'vitest';
import {
  buildAllTools,
  isReadMemoryInput,
  isUpdateMemoryInput,
  isAdminToolInput,
} from '../../src/services/claude/tools.js';

describe('buildAllTools', () => {
  it('returns exactly 10 tools', () => {
    expect(buildAllTools()).toHaveLength(10);
  });

  it('all tools have required fields', () => {
    for (const tool of buildAllTools()) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
    }
  });

  it('includes all expected tool names', () => {
    const names = buildAllTools().map((t) => t.name);
    expect(names).toContain('get_prompt_overrides');
    expect(names).toContain('set_prompt_overrides');
    expect(names).toContain('list_modes');
    expect(names).toContain('get_mode');
    expect(names).toContain('create_or_update_mode');
    expect(names).toContain('delete_mode');
    expect(names).toContain('list_mcp_servers');
    expect(names).toContain('set_mcp_servers');
    expect(names).toContain('read_memory');
    expect(names).toContain('update_memory');
  });
});

describe('isReadMemoryInput', () => {
  it('accepts empty object (read all)', () => {
    expect(isReadMemoryInput({})).toBe(true);
  });

  it('accepts object with string array sections', () => {
    expect(isReadMemoryInput({ sections: ['a', 'b'] })).toBe(true);
  });

  it('rejects empty sections array', () => {
    expect(isReadMemoryInput({ sections: [] })).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isReadMemoryInput(null)).toBe(false);
    expect(isReadMemoryInput('string')).toBe(false);
  });

  it('rejects sections with non-string items', () => {
    expect(isReadMemoryInput({ sections: [123] })).toBe(false);
  });

  it('rejects sections with empty strings', () => {
    expect(isReadMemoryInput({ sections: [''] })).toBe(false);
  });

  it('rejects too many sections', () => {
    const sections = Array.from({ length: 51 }, (_, i) => `s${i}`);
    expect(isReadMemoryInput({ sections })).toBe(false);
  });
});

describe('isUpdateMemoryInput', () => {
  it('accepts valid sections object', () => {
    expect(isUpdateMemoryInput({ sections: { topic: 'content' } })).toBe(true);
  });

  it('accepts null values in sections (delete)', () => {
    expect(isUpdateMemoryInput({ sections: { topic: null } })).toBe(true);
  });

  it('accepts pin and unpin arrays', () => {
    expect(
      isUpdateMemoryInput({ sections: { topic: 'val' }, pin: ['topic'], unpin: ['other'] })
    ).toBe(true);
  });

  it('rejects missing sections', () => {
    expect(isUpdateMemoryInput({})).toBe(false);
  });

  it('rejects empty sections', () => {
    expect(isUpdateMemoryInput({ sections: {} })).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isUpdateMemoryInput(null)).toBe(false);
    expect(isUpdateMemoryInput('string')).toBe(false);
  });

  it('rejects sections with non-string/null values', () => {
    expect(isUpdateMemoryInput({ sections: { topic: 123 } })).toBe(false);
  });

  it('rejects empty key in sections', () => {
    expect(isUpdateMemoryInput({ sections: { '': 'value' } })).toBe(false);
  });
});

describe('isAdminToolInput', () => {
  it('accepts plain objects', () => {
    expect(isAdminToolInput({})).toBe(true);
    expect(isAdminToolInput({ org: 'test' })).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(isAdminToolInput(null)).toBe(false);
    expect(isAdminToolInput([])).toBe(false);
    expect(isAdminToolInput('string')).toBe(false);
  });
});
