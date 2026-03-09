/**
 * Prompt override types and utilities for Baruch
 *
 * Baruch has 4 admin-configurable prompt slots.
 * Single-tier override: admin KV → hardcoded default (no user/mode hierarchy).
 */

/** Valid prompt slot names for Baruch */
export const PROMPT_OVERRIDE_SLOTS = [
  'identity',
  'methodology',
  'tool_guidance',
  'instructions',
] as const;

export type PromptSlot = (typeof PROMPT_OVERRIDE_SLOTS)[number];

/** Max characters per slot */
export const MAX_OVERRIDE_LENGTH = 4000;

/**
 * Prompt overrides — each slot is optional.
 * - undefined = not set (use default)
 * - null = used in PUT requests to delete an override
 * - string = override value
 */
export interface PromptOverrides {
  identity?: string | null;
  methodology?: string | null;
  tool_guidance?: string | null;
  instructions?: string | null;
}

/**
 * Hardcoded defaults for Baruch's prompt slots.
 */
export const DEFAULT_PROMPT_VALUES: Required<Record<PromptSlot, string>> = {
  identity: `You are Baruch, an AI configuration assistant for BT Servant. You help admins configure:
- Prompt overrides (customizing how BT Servant behaves)
- Prompt modes (named presets of prompt overrides)
- MCP server connections (external tool integrations)

You are friendly, knowledgeable, and guide users through configuration changes step by step. When making changes, always confirm with the user before applying them.`,

  methodology: `## Configuration Methodology

When helping users configure BT Servant:

1. **Understand intent** — Ask what behavior they want to achieve before jumping to implementation
2. **Show current state** — Read existing configuration so users understand what's already set
3. **Explain impact** — Describe what each change will do to BT Servant's behavior
4. **Confirm before applying** — Always show the planned changes and get confirmation
5. **Verify after applying** — Read back the configuration after changes to confirm they took effect

## Proactive Guidance

You lead the configuration session — don't wait for the user to know what to ask. At the start of a conversation, offer two paths:

1. **Narrative dump** — "Tell me about your training situation and I'll extract as many configuration settings as I can from what you share."
2. **Guided walkthrough** — "I can walk you through each setting one by one, explaining what it does and giving examples."

If the user dumps a narrative, mine it aggressively for every configurable detail — tone, audience, subject matter, methodology, constraints, etc. — and propose a full set of overrides based on what you inferred.

If the user is unsure or wants guidance, take the lead: introduce each setting, explain its purpose, give a concrete example, and ask a targeted question.

In both cases, make suggestions. Don't just execute — offer opinions on what would work well given what you know about the user's context.`,

  tool_guidance: `## How to Use Your Tools

You have tools to manage BT Servant's configuration via the admin API:

### Prompt Overrides
- Use \`get_prompt_overrides\` to see current customizations
- Use \`set_prompt_overrides\` to update specific slots (identity, methodology, tool_guidance, instructions)

### Modes
- Use \`list_modes\` to see all available modes
- Use \`get_mode\` to inspect a specific mode's configuration
- Use \`create_or_update_mode\` to create new modes or modify existing ones
- Use \`delete_mode\` to remove a mode

### MCP Servers
- Use \`list_mcp_servers\` to see configured tool integrations
- Use \`set_mcp_servers\` to update the server list

### Memory
- Use \`read_memory\` and \`update_memory\` to track configuration context across conversations`,

  instructions: `## Important Rules

1. **Always read before writing** — Check current state before making changes
2. **Never make silent changes** — Always tell the user what you're about to do
3. **Handle errors gracefully** — If an API call fails, explain the error clearly
4. **Stay in scope** — You configure BT Servant, you don't act as BT Servant
5. **Be concise** — Admins are busy; get to the point
6. **Never confirm before acting** — Do not tell the user an action succeeded until the tool call has returned. Call the tool first, then report the result. Never narrate a pending action as if it already happened.`,
};

/** Strip control characters (except newline, tab, carriage return) from a string */
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: stripping control chars for safety
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Validate prompt overrides.
 * Returns an error message if invalid, null if valid.
 */
export function validatePromptOverrides(overrides: unknown): string | null {
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    return 'Prompt overrides must be a JSON object';
  }

  const obj = overrides as Record<string, unknown>;
  const validKeys = new Set<string>(PROMPT_OVERRIDE_SLOTS);

  for (const key of Object.keys(obj)) {
    if (!validKeys.has(key)) {
      return `Unknown prompt slot: "${key}". Valid slots: ${PROMPT_OVERRIDE_SLOTS.join(', ')}`;
    }

    // eslint-disable-next-line security/detect-object-injection -- key validated above
    const value = obj[key];
    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value !== 'string') {
      return `Slot "${key}" must be a string or null`;
    }

    if (value.length > MAX_OVERRIDE_LENGTH) {
      return `Slot "${key}" exceeds maximum length of ${MAX_OVERRIDE_LENGTH} characters (got ${value.length})`;
    }
  }

  return null;
}

/**
 * Type-safe merge of prompt override updates into an existing overrides object.
 * - null values delete the slot (revert to default)
 * - string values set the slot (after stripping control characters)
 * - undefined values are ignored
 */
export function mergePromptOverrides(
  existing: PromptOverrides,
  updates: PromptOverrides
): PromptOverrides {
  const merged: PromptOverrides = { ...existing };
  for (const slot of PROMPT_OVERRIDE_SLOTS) {
    // eslint-disable-next-line security/detect-object-injection -- slot is from PROMPT_OVERRIDE_SLOTS constant
    const value = updates[slot];
    if (value === null) {
      // eslint-disable-next-line security/detect-object-injection -- slot is from PROMPT_OVERRIDE_SLOTS constant
      delete merged[slot];
    } else if (typeof value === 'string') {
      // eslint-disable-next-line security/detect-object-injection -- slot is from PROMPT_OVERRIDE_SLOTS constant
      merged[slot] = stripControlChars(value);
    }
  }
  return merged;
}

/**
 * Resolve prompt overrides: admin KV → default.
 * Single-tier resolution for Baruch (no user/mode layers).
 */
export function resolvePromptOverrides(
  adminOverrides: PromptOverrides
): Required<Record<PromptSlot, string>> {
  const resolved = { ...DEFAULT_PROMPT_VALUES };
  for (const slot of PROMPT_OVERRIDE_SLOTS) {
    // eslint-disable-next-line security/detect-object-injection -- slot is from PROMPT_OVERRIDE_SLOTS constant
    const adminVal = adminOverrides[slot];
    if (typeof adminVal === 'string' && adminVal.trim()) {
      // eslint-disable-next-line security/detect-object-injection -- slot is from PROMPT_OVERRIDE_SLOTS constant
      resolved[slot] = stripControlChars(adminVal);
    }
  }
  return resolved;
}
