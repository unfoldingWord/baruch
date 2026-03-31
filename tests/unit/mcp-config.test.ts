import { describe, it, expect, vi } from 'vitest';
import { getMcpServers, setMcpServers } from '../../src/services/mcp/config.js';

function mockKV() {
  return {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

describe('getMcpServers', () => {
  it('returns empty array when key does not exist', async () => {
    const kv = mockKV();
    vi.mocked(kv.get).mockResolvedValue(null);
    const servers = await getMcpServers(kv, 'testOrg');
    expect(servers).toEqual([]);
  });

  it('returns servers from KV', async () => {
    const kv = mockKV();
    const stored = [
      { id: 's1', name: 'Server 1', url: 'https://mcp.test', enabled: true, priority: 1 },
    ];
    vi.mocked(kv.get).mockResolvedValue(stored);
    const servers = await getMcpServers(kv, 'testOrg');
    expect(servers).toEqual(stored);
  });

  it('reads from the org-scoped KV key', async () => {
    const kv = mockKV();
    vi.mocked(kv.get).mockResolvedValue(null);
    await getMcpServers(kv, 'testOrg');
    expect(kv.get).toHaveBeenCalledWith('testOrg:mcp_servers', 'json');
  });

  it('uses different keys for different orgs', async () => {
    const kv = mockKV();
    vi.mocked(kv.get).mockResolvedValue(null);
    await getMcpServers(kv, 'orgA');
    await getMcpServers(kv, 'orgB');
    expect(kv.get).toHaveBeenCalledWith('orgA:mcp_servers', 'json');
    expect(kv.get).toHaveBeenCalledWith('orgB:mcp_servers', 'json');
  });
});

describe('setMcpServers', () => {
  it('writes servers to the org-scoped KV key', async () => {
    const kv = mockKV();
    const servers = [
      { id: 's1', name: 'Server 1', url: 'https://mcp.test', enabled: true, priority: 1 },
    ];
    await setMcpServers(kv, 'testOrg', servers as never);
    expect(kv.put).toHaveBeenCalledWith('testOrg:mcp_servers', JSON.stringify(servers));
  });

  it('writes empty array', async () => {
    const kv = mockKV();
    await setMcpServers(kv, 'testOrg', []);
    expect(kv.put).toHaveBeenCalledWith('testOrg:mcp_servers', '[]');
  });

  it('uses different keys for different orgs', async () => {
    const kv = mockKV();
    await setMcpServers(kv, 'orgA', []);
    await setMcpServers(kv, 'orgB', []);
    expect(kv.put).toHaveBeenCalledWith('orgA:mcp_servers', '[]');
    expect(kv.put).toHaveBeenCalledWith('orgB:mcp_servers', '[]');
  });
});
