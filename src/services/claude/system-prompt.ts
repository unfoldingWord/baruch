/**
 * System prompt builder for Baruch
 *
 * Assembly: [identity] → [methodology] → [tool_guidance] → [mcp_tool_guidance + catalog] →
 *           [instructions] → [memory_instructions + TOC] → [user preferences] →
 *           [conversation context] → [first interaction]
 */

import { ChatHistoryEntry } from '../../types/engine.js';
import { PromptSlot } from '../../types/prompt-overrides.js';
import { ToolCatalog } from '../mcp/types.js';

/** Synthetic trigger injected as the user turn for AI-initiated history entries. */
export const SYNTHETIC_CONVERSATION_TRIGGER = 'Begin the conversation.';

export interface OrchestrationPreferences {
  response_language: string;
  first_interaction: boolean;
}

interface SystemPromptOptions {
  memoryTOC?: string | undefined;
  isAdmin?: boolean | undefined;
  mcpCatalog?: ToolCatalog | undefined;
}

const MEMORY_INSTRUCTIONS = `## User Memory

Below is a table of contents of this user's persistent memory. Use the read_memory tool to retrieve specific sections when needed for context. Use the update_memory tool to save important information that should persist across conversations — such as configuration preferences and key decisions.

Keep memory organized with clear section names. Remove outdated information when updating.`;

/**
 * Build the full system prompt for Baruch.
 */
export function buildSystemPrompt(
  preferences: OrchestrationPreferences,
  history: ChatHistoryEntry[],
  resolvedPromptValues: Required<Record<PromptSlot, string>>,
  options?: SystemPromptOptions
): string {
  const { memoryTOC, isAdmin, mcpCatalog } = options ?? {};
  const sections: string[] = [];

  sections.push(resolvedPromptValues.identity);
  sections.push(resolvedPromptValues.methodology);
  sections.push(resolvedPromptValues.tool_guidance);

  if (mcpCatalog && mcpCatalog.tools.length > 0) {
    let mcpSection = resolvedPromptValues.mcp_tool_guidance;
    const toolList = mcpCatalog.tools.map((t) => `- **${t.name}**: ${t.description}`).join('\n');
    mcpSection += `\n\n### Available MCP Tools\n\n${toolList}`;
    sections.push(mcpSection);
  }

  sections.push(resolvedPromptValues.instructions);

  if (isAdmin === false) {
    sections.push(
      '## Access Level\n\nThe current user is not an org admin. If they ask to change org-level prompt overrides or MCP server configuration, explain that those actions require admin privileges. Suggest alternatives like creating or updating modes instead.'
    );
  }

  // Memory instructions (always present so Claude knows tools exist)
  sections.push(MEMORY_INSTRUCTIONS);

  if (memoryTOC) {
    sections.push(memoryTOC);
  }

  if (preferences.response_language !== 'en') {
    sections.push(
      `## User Preferences\n\nRespond in ${preferences.response_language} when possible.`
    );
  }

  if (history.length > 0) {
    sections.push(
      '## Recent Conversation Context\nThe user has been in conversation. Consider this context when responding.'
    );
  }

  if (preferences.first_interaction) {
    sections.push("This is the user's first interaction. Briefly welcome them.");
  }

  return sections.join('\n\n');
}

/**
 * Convert chat history to Anthropic message format
 */
export function historyToMessages(
  history: ChatHistoryEntry[],
  maxForLLM?: number
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const truncated = maxForLLM !== undefined ? history.slice(-maxForLLM) : history;

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const entry of truncated) {
    const userContent = entry.user_message || SYNTHETIC_CONVERSATION_TRIGGER;
    messages.push({ role: 'user', content: userContent });
    messages.push({ role: 'assistant', content: entry.assistant_response });
  }

  return messages;
}
