/**
 * Admin API client functions for MCP server management
 */

import { AdminApiClient } from './client.js';

export async function listMcpServers(client: AdminApiClient, org: string): Promise<unknown> {
  return client.get(`/api/v1/admin/orgs/${encodeURIComponent(org)}/mcp-servers`);
}

export async function setMcpServers(
  client: AdminApiClient,
  org: string,
  servers: unknown[]
): Promise<unknown> {
  return client.put(`/api/v1/admin/orgs/${encodeURIComponent(org)}/mcp-servers`, servers);
}
