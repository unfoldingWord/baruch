/**
 * MCP (Model Context Protocol) types for tool discovery and execution
 */

// Import and re-export MCPServerConfig from shared types to avoid circular imports
import { MCPServerConfig } from '../../types/mcp.js';
export type { MCPServerConfig } from '../../types/mcp.js';

/**
 * JSON Schema for tool parameters
 */
export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  description?: string;
  enum?: string[];
  default?: unknown;
  additionalProperties?: boolean | JSONSchema;
}

/**
 * MCP tool definition from server discovery
 */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

/**
 * MCP server manifest returned from discovery
 */
export interface MCPServerManifest {
  serverId: string;
  serverName: string;
  tools: MCPToolDefinition[];
  /** Error message if discovery failed (helps distinguish failed vs no-tools) */
  error?: string;
}

/**
 * Unified tool catalog combining tools from all MCP servers
 */
export interface ToolCatalog {
  tools: CatalogTool[];
  serverMap: Map<string, MCPServerConfig>;
}

/**
 * Tool in the unified catalog with server attribution
 */
export interface CatalogTool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  serverId: string;
  serverUrl: string;
}

/**
 * Result of calling an MCP tool
 */
export interface MCPToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Metadata returned by MCP servers about downstream API activity.
 */
export interface MCPResponseMetadata {
  /** Number of downstream API calls made by the MCP server */
  downstream_api_calls?: number;
  /** Cache status for the response */
  cache_status?: 'hit' | 'miss' | 'partial';
  /** Size of the response payload in bytes */
  response_size_bytes?: number;
}
