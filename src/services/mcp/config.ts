/**
 * MCP server configuration storage
 *
 * Reads/writes Baruch's own MCP server configs from the PROMPT_OVERRIDES KV namespace
 * under a static key. This is separate from the admin API tools that manage
 * bt-servant-worker's MCP servers.
 */

import { MCPServerConfig } from './types.js';

/** Static KV key for Baruch's MCP server configuration */
const MCP_SERVERS_KV_KEY = '_baruch_mcp_servers';

/**
 * Read Baruch's MCP server configurations from KV
 */
export async function getMcpServers(kv: KVNamespace): Promise<MCPServerConfig[]> {
  const servers = await kv.get<MCPServerConfig[]>(MCP_SERVERS_KV_KEY, 'json');
  return servers ?? [];
}

/**
 * Write Baruch's MCP server configurations to KV
 */
export async function setMcpServers(kv: KVNamespace, servers: MCPServerConfig[]): Promise<void> {
  await kv.put(MCP_SERVERS_KV_KEY, JSON.stringify(servers));
}
