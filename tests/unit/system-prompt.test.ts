import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, historyToMessages } from '../../src/services/claude/system-prompt.js';
import { DEFAULT_PROMPT_VALUES } from '../../src/types/prompt-overrides.js';

const defaults = { ...DEFAULT_PROMPT_VALUES };
const basePrefs = { response_language: 'en', first_interaction: false };

describe('buildSystemPrompt', () => {
  it('includes all 4 prompt slots', () => {
    const result = buildSystemPrompt(basePrefs, [], defaults);
    expect(result).toContain(defaults.identity);
    expect(result).toContain(defaults.methodology);
    expect(result).toContain(defaults.tool_guidance);
    expect(result).toContain(defaults.instructions);
  });

  it('includes memory instructions', () => {
    const result = buildSystemPrompt(basePrefs, [], defaults);
    expect(result).toContain('User Memory');
    expect(result).toContain('read_memory');
  });

  it('includes memory TOC when provided', () => {
    const result = buildSystemPrompt(basePrefs, [], defaults, {
      memoryTOC: '- **Preferences** (128 B)',
    });
    expect(result).toContain('Preferences');
  });

  it('includes language preference for non-English', () => {
    const prefs = { response_language: 'es', first_interaction: false };
    const result = buildSystemPrompt(prefs, [], defaults);
    expect(result).toContain('Respond in es');
  });

  it('omits language section for English', () => {
    const result = buildSystemPrompt(basePrefs, [], defaults);
    expect(result).not.toContain('User Preferences');
  });

  it('includes conversation context when history is present', () => {
    const history = [{ user_message: 'hi', assistant_response: 'hello', timestamp: Date.now() }];
    const result = buildSystemPrompt(basePrefs, history, defaults);
    expect(result).toContain('Recent Conversation Context');
  });

  it('omits conversation context when history is empty', () => {
    const result = buildSystemPrompt(basePrefs, [], defaults);
    expect(result).not.toContain('Recent Conversation Context');
  });

  it('includes first interaction greeting', () => {
    const prefs = { response_language: 'en', first_interaction: true };
    const result = buildSystemPrompt(prefs, [], defaults);
    expect(result).toContain('first interaction');
  });
});

describe('historyToMessages', () => {
  it('converts history to user/assistant pairs', () => {
    const history = [{ user_message: 'hello', assistant_response: 'hi', timestamp: Date.now() }];
    const messages = historyToMessages(history);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'user', content: 'hello' });
    expect(messages[1]).toEqual({ role: 'assistant', content: 'hi' });
  });

  it('truncates to maxForLLM entries', () => {
    const history = [
      { user_message: 'a', assistant_response: 'b', timestamp: 1 },
      { user_message: 'c', assistant_response: 'd', timestamp: 2 },
      { user_message: 'e', assistant_response: 'f', timestamp: 3 },
    ];
    const messages = historyToMessages(history, 2);
    expect(messages).toHaveLength(4);
    expect(messages[0]!.content).toBe('c');
  });

  it('returns empty array for empty history', () => {
    expect(historyToMessages([])).toHaveLength(0);
  });
});
