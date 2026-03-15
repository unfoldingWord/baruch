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
    const servers = await getMcpServers(kv);
    expect(servers).toEqual([]);
  });

  it('returns servers from KV', async () => {
    const kv = mockKV();
    const stored = [
      { id: 's1', name: 'Server 1', url: 'https://mcp.test', enabled: true, priority: 1 },
    ];
    vi.mocked(kv.get).mockResolvedValue(stored);
    const servers = await getMcpServers(kv);
    expect(servers).toEqual(stored);
  });

  it('reads from the correct KV key', async () => {
    const kv = mockKV();
    vi.mocked(kv.get).mockResolvedValue(null);
    await getMcpServers(kv);
    expect(kv.get).toHaveBeenCalledWith('_baruch_mcp_servers', 'json');
  });
});

describe('setMcpServers', () => {
  it('writes servers to KV', async () => {
    const kv = mockKV();
    const servers = [
      { id: 's1', name: 'Server 1', url: 'https://mcp.test', enabled: true, priority: 1 },
    ];
    await setMcpServers(kv, servers as never);
    expect(kv.put).toHaveBeenCalledWith('_baruch_mcp_servers', JSON.stringify(servers));
  });

  it('writes empty array', async () => {
    const kv = mockKV();
    await setMcpServers(kv, []);
    expect(kv.put).toHaveBeenCalledWith('_baruch_mcp_servers', '[]');
  });
});
