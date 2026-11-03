import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminApiClient, encodePathParam } from '../../src/services/admin-api/client.js';
import { AdminApiError } from '../../src/utils/errors.js';

const mockLogger = {
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

let client: AdminApiClient;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  vi.clearAllMocks();
  client = new AdminApiClient({
    baseUrl: 'https://api.example.com',
    apiKey: 'test-key',
    logger: mockLogger,
  });
});

describe('AdminApiClient GET', () => {
  it('sends GET requests with auth header', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    const result = await client.get('/test');
    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith('https://api.example.com/test', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: null,
    });
  });
});

describe('AdminApiClient PUT', () => {
  it('sends PUT requests with JSON body', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ updated: true })));
    await client.put('/test', { data: 'value' });
    expect(fetch).toHaveBeenCalledWith('https://api.example.com/test', {
      method: 'PUT',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'value' }),
    });
  });
});

describe('AdminApiClient DELETE', () => {
  it('sends DELETE requests', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ deleted: true })));
    await client.delete('/test');
    expect(fetch).toHaveBeenCalledWith('https://api.example.com/test', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: null,
    });
  });
});

describe('AdminApiClient error handling', () => {
  it('throws AdminApiError on non-OK response', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('Not found', { status: 404 }));
    await expect(client.get('/missing')).rejects.toThrow(AdminApiError);
  });

  it('includes status code in AdminApiError', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('Forbidden', { status: 403 }));
    try {
      await client.get('/forbidden');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminApiError);
      expect((error as AdminApiError).apiStatusCode).toBe(403);
    }
  });
});

describe('AdminApiClient logging', () => {
  it('logs request and response', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({})));
    await client.get('/test');
    expect(mockLogger.log).toHaveBeenCalledWith(
      'admin_api_request',
      expect.objectContaining({ method: 'GET', path: '/test' })
    );
    expect(mockLogger.log).toHaveBeenCalledWith(
      'admin_api_response',
      expect.objectContaining({ method: 'GET', path: '/test', status: 200 })
    );
  });

  it('logs errors on failure', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('Server error', { status: 500 }));
    await expect(client.get('/fail')).rejects.toThrow();
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('includes response_body on admin_api_error', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{"error":"bad body"}', { status: 400 }));
    await expect(client.put('/oops', { x: 1 })).rejects.toThrow();
    expect(mockLogger.error).toHaveBeenCalledWith(
      'admin_api_error',
      expect.any(Error),
      expect.objectContaining({ status: 400, response_body: '{"error":"bad body"}' })
    );
  });
});

describe('AdminApiClient body logging', () => {
  it('logs body_keys and body_size_bytes for PUT', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}'));
    await client.put('/thing', { a: 1, b: 'two' });
    expect(mockLogger.log).toHaveBeenCalledWith(
      'admin_api_request',
      expect.objectContaining({
        method: 'PUT',
        body_keys: ['a', 'b'],
        body_size_bytes: JSON.stringify({ a: 1, b: 'two' }).length,
      })
    );
  });

  it('does not reject slugs literally named "null" or "undefined"', async () => {
    // If a caller really wants to address a resource whose slug is "null" or
    // "undefined", the client itself must not reserve those names.
    vi.mocked(fetch).mockImplementation(async () => new Response('{}'));
    await client.get('/api/v1/admin/orgs/acme/modes/null');
    await client.get('/api/v1/admin/orgs/acme/modes/undefined');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('encodePathParam', () => {
  it('URL-encodes a valid non-empty string', () => {
    expect(encodePathParam('acme', 'org')).toBe('acme');
    expect(encodePathParam('slug with space', 'name')).toBe('slug%20with%20space');
  });

  it('accepts the literal strings "null" and "undefined" as valid slugs', () => {
    expect(encodePathParam('null', 'name')).toBe('null');
    expect(encodePathParam('undefined', 'name')).toBe('undefined');
  });

  it('rejects undefined', () => {
    expect(() => encodePathParam(undefined, 'name')).toThrow(AdminApiError);
    expect(() => encodePathParam(undefined, 'name')).toThrow(/name/);
  });

  it('rejects null', () => {
    expect(() => encodePathParam(null, 'name')).toThrow(AdminApiError);
  });

  it('rejects empty string', () => {
    expect(() => encodePathParam('', 'name')).toThrow(AdminApiError);
  });

  it('rejects non-string values', () => {
    expect(() => encodePathParam(42, 'name')).toThrow(AdminApiError);
  });
});
