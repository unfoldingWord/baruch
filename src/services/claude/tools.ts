/**
 * Claude tool definitions for Baruch
 *
 * 14 built-in tools:
 * - 8 bt-servant admin API tools (prompt overrides, modes, MCP servers on bt-servant-worker)
 * - 4 Baruch self-config tools (get/set Baruch's own prompt overrides + MCP servers)
 * - 2 memory tools (read, update)
 */

import Anthropic from '@anthropic-ai/sdk';
import { PROMPT_OVERRIDE_SLOTS } from '../../types/prompt-overrides.js';

export function buildGetPromptOverridesTool(): Anthropic.Tool {
  return {
    name: 'get_prompt_overrides',
    description:
      'Read the current prompt overrides for the organization. Returns both the raw overrides and the resolved values (with defaults applied).',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  };
}

export function buildSetPromptOverridesTool(): Anthropic.Tool {
  const properties: Record<string, object> = {};
  for (const slot of PROMPT_OVERRIDE_SLOTS) {
    // eslint-disable-next-line security/detect-object-injection -- slot is from PROMPT_OVERRIDE_SLOTS constant
    properties[slot] = {
      type: ['string', 'null'],
      description: `${slot.replace(/_/g, ' ')} prompt override, or null to revert to default`,
    };
  }

  return {
    name: 'set_prompt_overrides',
    description: [
      'Update prompt override slots for the organization. Pass slot values directly as top-level properties.',
      'String values set the slot, null reverts to default. Only include slots you want to change.',
      'Examples:',
      '- { "identity": "You are a helpful Bible translation assistant" } — set one slot',
      '- { "methodology": null } — revert a slot to default',
      '- { "identity": "...", "instructions": null } — set one, revert another',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties,
    },
  };
}

export function buildListModesTool(): Anthropic.Tool {
  return {
    name: 'list_modes',
    description:
      'List all prompt modes configured for the organization. Modes are named presets of prompt overrides.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  };
}

export function buildGetModeTool(): Anthropic.Tool {
  return {
    name: 'get_mode',
    description: 'Get the full details of a specific prompt mode, including its overrides.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Mode name (slug, e.g., "mast-methodology").' },
      },
      required: ['name'],
    },
  };
}

export function buildCreateOrUpdateModeTool(): Anthropic.Tool {
  return {
    name: 'create_or_update_mode',
    description:
      'Create a new prompt mode or update an existing one. Modes are named presets of prompt overrides that change how BT Servant behaves.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Mode name (lowercase alphanumeric with hyphens, e.g., "mast-methodology").',
        },
        label: { type: 'string', description: 'Human-readable display name.' },
        description: { type: 'string', description: 'Description of what this mode does.' },
        overrides: {
          type: 'object',
          description: 'Prompt override slots for this mode.',
          additionalProperties: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
      required: ['name', 'overrides'],
    },
  };
}

export function buildDeleteModeTool(): Anthropic.Tool {
  return {
    name: 'delete_mode',
    description: 'Delete a prompt mode from an organization.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Mode name to delete.' },
      },
      required: ['name'],
    },
  };
}

export function buildListMcpServersTool(): Anthropic.Tool {
  return {
    name: 'list_mcp_servers',
    description:
      'List all MCP servers configured for the organization. MCP servers provide external tool integrations to BT Servant.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  };
}

export function buildSetMcpServersTool(): Anthropic.Tool {
  return {
    name: 'set_mcp_servers',
    description:
      'Replace the entire MCP server list for an organization. Pass the full array of server configurations.',
    input_schema: {
      type: 'object',
      properties: {
        servers: {
          type: 'array',
          description: 'Array of MCP server configurations.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique server identifier.' },
              url: { type: 'string', description: 'Server URL.' },
              enabled: { type: 'boolean', description: 'Whether the server is active.' },
              priority: {
                type: 'number',
                description: 'Priority order (lower = higher priority).',
              },
            },
            required: ['id', 'url'],
          },
        },
      },
      required: ['servers'],
    },
  };
}

export function buildReadMemoryTool(): Anthropic.Tool {
  return {
    name: 'read_memory',
    description:
      'Read from persistent user memory. Call with no arguments to get the full memory document, or pass specific section names to read only those sections.',
    input_schema: {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of section names to read. Omit to read full memory.',
        },
      },
      required: [],
    },
  };
}

export function buildUpdateMemoryTool(): Anthropic.Tool {
  return {
    name: 'update_memory',
    description:
      "Create, update, or delete sections in the user's persistent memory. Pass an object where keys are section names and values are either markdown content (to create/update) or null (to delete). Use pin/unpin arrays to control which entries are protected from automatic eviction.",
    input_schema: {
      type: 'object',
      properties: {
        sections: {
          type: 'object',
          additionalProperties: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          description: 'Object of section updates. String values create/replace. Null deletes.',
        },
        pin: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of section names to pin (protect from eviction).',
        },
        unpin: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of section names to unpin.',
        },
      },
      required: ['sections'],
    },
  };
}

export function buildGetBaruchPromptOverridesTool(): Anthropic.Tool {
  return {
    name: 'get_baruch_prompt_overrides',
    description:
      "Read Baruch's own prompt overrides. These control how Baruch itself behaves " +
      '(NOT BT Servant). Returns raw overrides and resolved values with defaults applied.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  };
}

export function buildSetBaruchPromptOverridesTool(): Anthropic.Tool {
  const properties: Record<string, object> = {};
  for (const slot of PROMPT_OVERRIDE_SLOTS) {
    // eslint-disable-next-line security/detect-object-injection -- slot is from PROMPT_OVERRIDE_SLOTS constant
    properties[slot] = {
      type: ['string', 'null'],
      description: `${slot.replace(/_/g, ' ')} override for Baruch, or null to revert to default`,
    };
  }

  return {
    name: 'set_baruch_prompt_overrides',
    description:
      "Update Baruch's own prompt overrides. These control how Baruch itself behaves " +
      '(NOT BT Servant). String values set the slot, null reverts to default. ' +
      'Only include slots you want to change.',
    input_schema: {
      type: 'object',
      properties,
    },
  };
}

export function buildGetBaruchMcpServersTool(): Anthropic.Tool {
  return {
    name: 'get_baruch_mcp_servers',
    description:
      "Read Baruch's own MCP server configuration. These are the external tool servers that Baruch can use directly in conversations.",
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  };
}

export function buildSetBaruchMcpServersTool(): Anthropic.Tool {
  return {
    name: 'set_baruch_mcp_servers',
    description:
      "Replace Baruch's own MCP server configuration. These servers provide external tools that Baruch can use directly in conversations. Changes take effect on the next conversation.",
    input_schema: {
      type: 'object',
      properties: {
        servers: {
          type: 'array',
          description: 'Array of MCP server configurations for Baruch.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique server identifier.' },
              name: { type: 'string', description: 'Human-readable server name.' },
              url: { type: 'string', description: 'MCP server URL.' },
              authToken: { type: 'string', description: 'Optional Bearer token for auth.' },
              enabled: { type: 'boolean', description: 'Whether the server is active.' },
              priority: {
                type: 'number',
                description: 'Priority order (lower = higher priority).',
              },
              allowedTools: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional whitelist of tool names to expose from this server.',
              },
            },
            required: ['id', 'name', 'url'],
          },
        },
      },
      required: ['servers'],
    },
  };
}

/** Tools that require admin privileges (org-level writes) */
export const ADMIN_ONLY_TOOLS = new Set([
  'set_prompt_overrides',
  'set_mcp_servers',
  'set_baruch_prompt_overrides',
  'set_baruch_mcp_servers',
]);

/** Build tools filtered by role. Non-admins get 10 tools (no org-level writes). */
export function buildTools(isAdmin: boolean): Anthropic.Tool[] {
  const all = buildAllTools();
  if (isAdmin) return all;
  return all.filter((t) => !ADMIN_ONLY_TOOLS.has(t.name));
}

/** Build all 14 tool definitions for Baruch */
export function buildAllTools(): Anthropic.Tool[] {
  return [
    buildGetPromptOverridesTool(),
    buildSetPromptOverridesTool(),
    buildListModesTool(),
    buildGetModeTool(),
    buildCreateOrUpdateModeTool(),
    buildDeleteModeTool(),
    buildListMcpServersTool(),
    buildSetMcpServersTool(),
    buildGetBaruchPromptOverridesTool(),
    buildSetBaruchPromptOverridesTool(),
    buildGetBaruchMcpServersTool(),
    buildSetBaruchMcpServersTool(),
    buildReadMemoryTool(),
    buildUpdateMemoryTool(),
  ];
}

/** Set of all built-in tool names (for MCP collision detection) */
export function getBuiltinToolNames(): Set<string> {
  return new Set(buildAllTools().map((t) => t.name));
}

/** Maximum number of sections in a single read_memory request */
const MAX_READ_SECTIONS = 50;

/** Maximum number of sections in a single update_memory request */
const MAX_UPDATE_SECTIONS = 50;

/** Type guard for read_memory input */
export function isReadMemoryInput(input: unknown): input is { sections?: string[] } {
  if (typeof input !== 'object' || input === null) return false;
  if (!('sections' in input)) return true;
  const sections = (input as { sections: unknown }).sections;
  if (!Array.isArray(sections)) return false;
  if (sections.length === 0) return false;
  return (
    sections.length <= MAX_READ_SECTIONS &&
    sections.every((s) => typeof s === 'string' && s.length > 0)
  );
}

/** Validate an optional string array field on input (for pin/unpin) */
function isValidOptionalStringArray(input: object, field: string): boolean {
  if (!(field in input)) return true;
  // eslint-disable-next-line security/detect-object-injection -- field is a hardcoded string
  const value = (input as Record<string, unknown>)[field];
  return Array.isArray(value) && value.every((s) => typeof s === 'string' && s.length > 0);
}

/** Validate that sections is a valid Record<string, string|null> */
function isValidSectionsObject(input: object): boolean {
  const sections = (input as { sections: unknown }).sections;
  if (typeof sections !== 'object' || sections === null || Array.isArray(sections)) return false;
  const entries = Object.entries(sections as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_UPDATE_SECTIONS) return false;
  return entries.every(([key, val]) => key.length > 0 && (typeof val === 'string' || val === null));
}

/** Type guard for update_memory input */
export function isUpdateMemoryInput(
  input: unknown
): input is { sections: Record<string, string | null>; pin?: string[]; unpin?: string[] } {
  if (typeof input !== 'object' || input === null) return false;
  if (!('sections' in input)) return false;
  if (!isValidSectionsObject(input)) return false;
  return isValidOptionalStringArray(input, 'pin') && isValidOptionalStringArray(input, 'unpin');
}

/** Type guard for admin API tool input with optional org */
export function isAdminToolInput(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

const VALID_SLOTS = new Set<string>(PROMPT_OVERRIDE_SLOTS);

/** Type guard for set_prompt_overrides input (flat slot properties) */
export function isSetPromptOverridesInput(input: unknown): input is Record<string, string | null> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(
    ([key, val]) => VALID_SLOTS.has(key) && (typeof val === 'string' || val === null)
  );
}
