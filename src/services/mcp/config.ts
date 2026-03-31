/**
 * MCP server configuration storage
 *
 * Reads/writes Baruch's own MCP server configs from the PROMPT_OVERRIDES KV namespace
 * under an org-scoped key. This is separate from the admin API tools that manage
 * bt-servant-worker's MCP servers.
 */

import { MCPServerConfig } from './types.js';

/** Build the org-scoped KV key for Baruch's MCP server configuration */
function mcpServersKey(org: string): string {
  return `mcp:${org}`;
}

/**
 * Read Baruch's MCP server configurations from KV for the given org
 */
export async function getMcpServers(kv: KVNamespace, org: string): Promise<MCPServerConfig[]> {
  const servers = await kv.get<MCPServerConfig[]>(mcpServersKey(org), 'json');
  return servers ?? [];
}

/**
 * Write Baruch's MCP server configurations to KV for the given org
 */
export async function setMcpServers(
  kv: KVNamespace,
  org: string,
  servers: MCPServerConfig[]
): Promise<void> {
  await kv.put(mcpServersKey(org), JSON.stringify(servers));
}
