/**
 * MCP Tool Catalog - builds unified tool catalog from multiple MCP servers
 * and converts catalog tools to Anthropic tool format for direct exposure.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { RequestLogger } from '../../utils/logger.js';
import { CatalogTool, MCPServerConfig, MCPServerManifest, ToolCatalog } from './types.js';

function resolveToolName(
  name: string,
  serverId: string,
  toolNames: Set<string>,
  builtinToolNames: Set<string> | undefined,
  logger: RequestLogger | undefined
): string {
  // Handle collisions with built-in tools by prefixing with mcp_
  if (builtinToolNames?.has(name)) {
    const prefixedName = `mcp_${name}`;
    logger?.log('mcp_tool_builtin_collision', {
      original_name: name,
      renamed_to: prefixedName,
      server_id: serverId,
    });
    name = prefixedName;
  }

  // Handle collisions between MCP tools by prefixing with server ID
  if (toolNames.has(name)) {
    const prefixedName = `${serverId}_${name}`;
    logger?.log('mcp_tool_name_collision', {
      original_name: name,
      renamed_to: prefixedName,
      server_id: serverId,
    });
    name = prefixedName;
  }
  return name;
}

/**
 * Build a unified tool catalog from multiple MCP server manifests
 */
export function buildToolCatalog(
  manifests: MCPServerManifest[],
  servers: MCPServerConfig[],
  logger?: RequestLogger,
  builtinToolNames?: Set<string>
): ToolCatalog {
  const serverMap = new Map<string, MCPServerConfig>();
  for (const server of servers) {
    serverMap.set(server.id, server);
  }

  const tools: CatalogTool[] = [];
  const toolNames = new Set<string>();

  for (const manifest of manifests) {
    const server = serverMap.get(manifest.serverId);
    if (!server) continue;

    for (const tool of manifest.tools) {
      const name = resolveToolName(
        tool.name,
        manifest.serverId,
        toolNames,
        builtinToolNames,
        logger
      );
      toolNames.add(name);

      tools.push({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        serverId: manifest.serverId,
        serverUrl: server.url,
      });
    }
  }

  return { tools, serverMap };
}

/**
 * Find a tool in the catalog by name
 */
export function findTool(catalog: ToolCatalog, toolName: string): CatalogTool | undefined {
  return catalog.tools.find((t) => t.name === toolName);
}

/**
 * Get all tool names from the catalog
 */
export function getToolNames(catalog: ToolCatalog): string[] {
  return catalog.tools.map((t) => t.name);
}

/**
 * Convert catalog tools to Anthropic tool definitions for direct exposure.
 * Each MCP tool becomes a first-class Claude tool.
 */
export function catalogToolsToAnthropicTools(catalog: ToolCatalog): Anthropic.Tool[] {
  return catalog.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: tool.inputSchema.type as 'object',
      properties: tool.inputSchema.properties ?? {},
      ...(tool.inputSchema.required && { required: tool.inputSchema.required }),
    },
  }));
}
