import { describe, it, expect } from 'vitest';
import {
  buildToolCatalog,
  findTool,
  getToolNames,
  catalogToolsToAnthropicTools,
} from '../../src/services/mcp/catalog.js';
import { MCPServerConfig, MCPServerManifest } from '../../src/services/mcp/types.js';

function makeServer(id: string, url = 'https://mcp.example.com'): MCPServerConfig {
  return { id, name: id, url, enabled: true, priority: 1 };
}

function makeManifest(
  serverId: string,
  tools: Array<{ name: string; description?: string }>
): MCPServerManifest {
  return {
    serverId,
    serverName: serverId,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? `${t.name} tool`,
      inputSchema: { type: 'object', properties: {} },
    })),
  };
}

describe('buildToolCatalog', () => {
  it('builds catalog from manifests', () => {
    const servers = [makeServer('s1')];
    const manifests = [makeManifest('s1', [{ name: 'search' }, { name: 'fetch' }])];

    const catalog = buildToolCatalog(manifests, servers);
    expect(catalog.tools).toHaveLength(2);
    expect(catalog.tools[0]!.name).toBe('search');
    expect(catalog.tools[0]!.serverId).toBe('s1');
    expect(catalog.serverMap.get('s1')).toBeDefined();
  });

  it('handles MCP-to-MCP name collisions by prefixing with server ID', () => {
    const servers = [makeServer('s1'), makeServer('s2', 'https://other.example.com')];
    const manifests = [
      makeManifest('s1', [{ name: 'search' }]),
      makeManifest('s2', [{ name: 'search' }]),
    ];

    const catalog = buildToolCatalog(manifests, servers);
    const names = getToolNames(catalog);
    expect(names).toContain('search');
    expect(names).toContain('s2_search');
  });

  it('handles builtin name collisions by prefixing with mcp_', () => {
    const servers = [makeServer('s1')];
    const manifests = [makeManifest('s1', [{ name: 'list_modes' }])];
    const builtins = new Set(['list_modes', 'get_prompt_overrides']);

    const catalog = buildToolCatalog(manifests, servers, undefined, builtins);
    expect(catalog.tools[0]!.name).toBe('mcp_list_modes');
  });

  it('skips manifests with unknown server IDs', () => {
    const servers = [makeServer('s1')];
    const manifests = [makeManifest('unknown', [{ name: 'tool' }])];

    const catalog = buildToolCatalog(manifests, servers);
    expect(catalog.tools).toHaveLength(0);
  });

  it('returns empty catalog for empty manifests', () => {
    const catalog = buildToolCatalog([], []);
    expect(catalog.tools).toHaveLength(0);
  });
});

describe('findTool', () => {
  it('finds tool by name', () => {
    const servers = [makeServer('s1')];
    const manifests = [makeManifest('s1', [{ name: 'search' }])];
    const catalog = buildToolCatalog(manifests, servers);

    expect(findTool(catalog, 'search')).toBeDefined();
    expect(findTool(catalog, 'nonexistent')).toBeUndefined();
  });
});

describe('catalogToolsToAnthropicTools', () => {
  it('converts catalog tools to Anthropic format', () => {
    const servers = [makeServer('s1')];
    const manifests = [makeManifest('s1', [{ name: 'search', description: 'Search things' }])];
    const catalog = buildToolCatalog(manifests, servers);

    const tools = catalogToolsToAnthropicTools(catalog);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('search');
    expect(tools[0]!.description).toBe('Search things');
    expect(tools[0]!.input_schema.type).toBe('object');
  });

  it('returns empty array for empty catalog', () => {
    const catalog = buildToolCatalog([], []);
    expect(catalogToolsToAnthropicTools(catalog)).toEqual([]);
  });
});
