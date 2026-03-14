import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  discoverServerTools,
  discoverAllTools,
  callMCPTool,
} from '../../src/services/mcp/discovery.js';
import { MCPServerConfig } from '../../src/services/mcp/types.js';
import { createHealthTracker, getServerMetrics } from '../../src/services/mcp/health.js';

const mockLogger = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeServer(id = 'test-server'): MCPServerConfig {
  return {
    id,
    name: 'Test Server',
    url: 'https://mcp.example.com',
    enabled: true,
    priority: 1,
  };
}

function jsonRpcResponse(result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', result, id: 1 }));
}

function jsonRpcError(code: number, message: string) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: 1 }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
});

describe('discoverServerTools', () => {
  it('discovers tools from a server', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonRpcResponse({
        tools: [
          { name: 'search', description: 'Search', inputSchema: { type: 'object' } },
          { name: 'fetch', description: 'Fetch', inputSchema: { type: 'object' } },
        ],
      })
    );

    const manifest = await discoverServerTools(makeServer(), mockLogger);
    expect(manifest.tools).toHaveLength(2);
    expect(manifest.serverId).toBe('test-server');
    expect(manifest.error).toBeUndefined();
  });

  it('returns empty tools on network error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network error'));
    const manifest = await discoverServerTools(makeServer(), mockLogger);
    expect(manifest.tools).toHaveLength(0);
    expect(manifest.error).toContain('Network error');
  });

  it('returns empty tools on JSON-RPC error', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonRpcError(-32600, 'Invalid Request'));
    const manifest = await discoverServerTools(makeServer(), mockLogger);
    expect(manifest.tools).toHaveLength(0);
    expect(manifest.error).toContain('Invalid Request');
  });
});

describe('discoverServerTools filtering and auth', () => {
  it('filters tools by allowedTools', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonRpcResponse({
        tools: [
          { name: 'search', description: 'Search', inputSchema: { type: 'object' } },
          { name: 'fetch', description: 'Fetch', inputSchema: { type: 'object' } },
          { name: 'delete', description: 'Delete', inputSchema: { type: 'object' } },
        ],
      })
    );

    const server = { ...makeServer(), allowedTools: ['search', 'fetch'] };
    const manifest = await discoverServerTools(server, mockLogger);
    expect(manifest.tools).toHaveLength(2);
    expect(manifest.tools.map((t) => t.name)).toEqual(['search', 'fetch']);
  });

  it('sends auth header when authToken is set', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonRpcResponse({ tools: [] }));
    const server = { ...makeServer(), authToken: 'secret-token' };
    await discoverServerTools(server, mockLogger);

    const fetchCall = vi.mocked(fetch).mock.calls[0]!;
    const init = fetchCall[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer secret-token');
  });

  it('handles SSE-wrapped JSON-RPC responses', async () => {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      result: {
        tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
      },
      id: 1,
    });
    const sseBody = `event: message\ndata: ${payload}\n\n`;
    vi.mocked(fetch).mockResolvedValue(
      new Response(sseBody, { headers: { 'content-type': 'text/event-stream' } })
    );

    const manifest = await discoverServerTools(makeServer(), mockLogger);
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.tools[0]!.name).toBe('search');
  });
});

describe('discoverAllTools', () => {
  it('discovers tools from multiple servers in parallel', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonRpcResponse({
        tools: [{ name: 'tool1', description: 'Tool 1', inputSchema: { type: 'object' } }],
      })
    );

    const servers = [makeServer('s1'), makeServer('s2')];
    const manifests = await discoverAllTools(servers, mockLogger);
    expect(manifests).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('handles partial failures gracefully', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonRpcResponse({
          tools: [{ name: 'tool1', description: 'Tool 1', inputSchema: { type: 'object' } }],
        })
      )
      .mockRejectedValueOnce(new Error('Server down'));

    const manifests = await discoverAllTools([makeServer('s1'), makeServer('s2')], mockLogger);
    expect(manifests).toHaveLength(2);
    expect(manifests[0]!.tools).toHaveLength(1);
    expect(manifests[1]!.tools).toHaveLength(0);
    expect(manifests[1]!.error).toBeDefined();
  });
});

describe('callMCPTool', () => {
  it('calls a tool and returns result', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonRpcResponse({ content: [{ type: 'text', text: 'Hello world' }] })
    );

    const result = await callMCPTool(makeServer(), 'search', { q: 'test' }, mockLogger);
    expect(result.result).toBe('Hello world');
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('records health on success', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonRpcResponse({ content: [{ type: 'text', text: 'ok' }] })
    );

    const tracker = createHealthTracker();
    await callMCPTool(makeServer(), 'tool', {}, mockLogger, { healthTracker: tracker });
    expect(getServerMetrics(tracker, 'test-server')!.totalCalls).toBe(1);
    expect(getServerMetrics(tracker, 'test-server')!.consecutiveFailures).toBe(0);
  });

  it('records health on failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('fail'));
    const tracker = createHealthTracker();

    await expect(
      callMCPTool(makeServer(), 'tool', {}, mockLogger, { healthTracker: tracker })
    ).rejects.toThrow('fail');
    expect(getServerMetrics(tracker, 'test-server')!.failedCalls).toBe(1);
  });

  it('extracts metadata from _meta field', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonRpcResponse({
        content: [{ type: 'text', text: 'result' }],
        _meta: { downstream_api_calls: 2, cache_status: 'miss' },
      })
    );

    const result = await callMCPTool(makeServer(), 'tool', {}, mockLogger);
    expect(result.metadata?.downstream_api_calls).toBe(2);
    expect(result.metadata?.cache_status).toBe('miss');
  });
});
