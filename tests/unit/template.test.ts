import { describe, it, expect } from 'vitest';
import { replaceTemplateVariables, applyTemplateVariables } from '../../src/utils/template.js';

describe('replaceTemplateVariables', () => {
  it('replaces known variables', () => {
    expect(replaceTemplateVariables('v{{version}}', { version: '1.0.0' })).toBe('v1.0.0');
  });

  it('leaves unknown variables intact', () => {
    expect(replaceTemplateVariables('{{unknown}}', { version: '1.0.0' })).toBe('{{unknown}}');
  });

  it('replaces multiple occurrences', () => {
    const result = replaceTemplateVariables('{{a}} and {{b}}', { a: 'X', b: 'Y' });
    expect(result).toBe('X and Y');
  });

  it('handles text with no variables', () => {
    expect(replaceTemplateVariables('no vars here', {})).toBe('no vars here');
  });
});

describe('applyTemplateVariables', () => {
  it('applies template variables to all slots', () => {
    const resolved = {
      identity: 'Baruch v{{version}}',
      methodology: 'method',
      tool_guidance: 'tools',
      mcp_tool_guidance: 'mcp tools',
      instructions: 'rules',
    };
    const result = applyTemplateVariables(resolved);
    // version comes from APP_VERSION in generated/version.ts
    expect(result.identity).toContain('Baruch v');
    expect(result.identity).not.toContain('{{version}}');
  });

  it('does not mutate the input', () => {
    const resolved = {
      identity: '{{version}}',
      methodology: 'method',
      tool_guidance: 'tools',
      mcp_tool_guidance: 'mcp tools',
      instructions: 'rules',
    };
    const original = { ...resolved };
    applyTemplateVariables(resolved);
    expect(resolved).toEqual(original);
  });
});
