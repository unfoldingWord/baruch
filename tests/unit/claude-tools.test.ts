import { describe, it, expect } from 'vitest';
import {
  buildAllTools,
  buildTools,
  buildSetPromptOverridesTool,
  ADMIN_ONLY_TOOLS,
  isReadMemoryInput,
  isUpdateMemoryInput,
  isAdminToolInput,
  isSetPromptOverridesInput,
} from '../../src/services/claude/tools.js';

describe('buildAllTools', () => {
  it('returns exactly 12 tools', () => {
    expect(buildAllTools()).toHaveLength(12);
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
    expect(names).toContain('get_baruch_mcp_servers');
    expect(names).toContain('set_baruch_mcp_servers');
    expect(names).toContain('read_memory');
    expect(names).toContain('update_memory');
  });
});

describe('buildTools role filtering', () => {
  it('returns all 12 tools for admins', () => {
    const tools = buildTools(true);
    expect(tools).toHaveLength(12);
  });

  it('returns 9 tools for non-admins', () => {
    const tools = buildTools(false);
    expect(tools).toHaveLength(9);
  });

  it('excludes set_prompt_overrides for non-admins', () => {
    const names = buildTools(false).map((t) => t.name);
    expect(names).not.toContain('set_prompt_overrides');
  });

  it('excludes set_mcp_servers for non-admins', () => {
    const names = buildTools(false).map((t) => t.name);
    expect(names).not.toContain('set_mcp_servers');
  });

  it('includes read-only and mode tools for non-admins', () => {
    const names = buildTools(false).map((t) => t.name);
    expect(names).toContain('get_prompt_overrides');
    expect(names).toContain('list_modes');
    expect(names).toContain('get_mode');
    expect(names).toContain('create_or_update_mode');
    expect(names).toContain('delete_mode');
    expect(names).toContain('list_mcp_servers');
    expect(names).toContain('read_memory');
    expect(names).toContain('update_memory');
  });

  it('excludes set_baruch_mcp_servers for non-admins', () => {
    const names = buildTools(false).map((t) => t.name);
    expect(names).not.toContain('set_baruch_mcp_servers');
  });

  it('includes get_baruch_mcp_servers for non-admins', () => {
    const names = buildTools(false).map((t) => t.name);
    expect(names).toContain('get_baruch_mcp_servers');
  });

  it('ADMIN_ONLY_TOOLS contains exactly 3 tools', () => {
    expect(ADMIN_ONLY_TOOLS.size).toBe(3);
    expect(ADMIN_ONLY_TOOLS.has('set_prompt_overrides')).toBe(true);
    expect(ADMIN_ONLY_TOOLS.has('set_mcp_servers')).toBe(true);
    expect(ADMIN_ONLY_TOOLS.has('set_baruch_mcp_servers')).toBe(true);
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

describe('buildSetPromptOverridesTool schema', () => {
  it('has flat slot properties instead of nested overrides', () => {
    const tool = buildSetPromptOverridesTool();
    const props = tool.input_schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('identity');
    expect(props).toHaveProperty('methodology');
    expect(props).toHaveProperty('tool_guidance');
    expect(props).toHaveProperty('mcp_tool_guidance');
    expect(props).toHaveProperty('instructions');
    expect(props).not.toHaveProperty('overrides');
  });

  it('has no required fields', () => {
    const tool = buildSetPromptOverridesTool();
    expect(tool.input_schema.required).toBeUndefined();
  });

  it('description includes examples', () => {
    const tool = buildSetPromptOverridesTool();
    expect(tool.description).toContain('Examples');
    expect(tool.description).toContain('"identity"');
    expect(tool.description).toContain('null');
  });
});

describe('isSetPromptOverridesInput', () => {
  it('accepts a single slot set to a string', () => {
    expect(isSetPromptOverridesInput({ identity: 'Hello' })).toBe(true);
  });

  it('accepts a single slot set to null', () => {
    expect(isSetPromptOverridesInput({ methodology: null })).toBe(true);
  });

  it('accepts multiple valid slots', () => {
    expect(isSetPromptOverridesInput({ identity: 'Hi', instructions: null })).toBe(true);
  });

  it('rejects empty object', () => {
    expect(isSetPromptOverridesInput({})).toBe(false);
  });

  it('rejects non-object types', () => {
    expect(isSetPromptOverridesInput(null)).toBe(false);
    expect(isSetPromptOverridesInput('string')).toBe(false);
    expect(isSetPromptOverridesInput([])).toBe(false);
  });

  it('rejects unknown slot names', () => {
    expect(isSetPromptOverridesInput({ unknown_slot: 'value' })).toBe(false);
  });

  it('rejects non-string non-null values', () => {
    expect(isSetPromptOverridesInput({ identity: 123 })).toBe(false);
    expect(isSetPromptOverridesInput({ identity: true })).toBe(false);
    expect(isSetPromptOverridesInput({ identity: { nested: 'object' } })).toBe(false);
  });

  it('rejects if any key is invalid even with valid keys present', () => {
    expect(isSetPromptOverridesInput({ identity: 'Hello', bad_key: 'value' })).toBe(false);
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
