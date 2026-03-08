import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

let stub: DurableObjectStub;

beforeEach(() => {
  const id = env.USER_SESSION.newUniqueId();
  stub = env.USER_SESSION.get(id);
});

describe('UserSession POST /chat', () => {
  it('rejects missing user_id', async () => {
    const response = await stub.fetch('http://fake-host/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'test-client',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toContain('user_id');
  });

  it('rejects missing messages', async () => {
    const response = await stub.fetch('http://fake-host/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'test-user', client_id: 'test-client' }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects empty messages array', async () => {
    const response = await stub.fetch('http://fake-host/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'test-user', client_id: 'test-client', messages: [] }),
    });
    expect(response.status).toBe(400);
  });
});

describe('UserSession preferences', () => {
  it('returns default preferences', async () => {
    const response = await stub.fetch('http://fake-host/preferences');
    expect(response.status).toBe(200);
    const data = (await response.json()) as { response_language: string };
    expect(data.response_language).toBe('en');
  });

  it('updates and persists preferences', async () => {
    const putResponse = await stub.fetch('http://fake-host/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_language: 'es' }),
    });
    expect(putResponse.status).toBe(200);

    const getResponse = await stub.fetch('http://fake-host/preferences');
    const data = (await getResponse.json()) as { response_language: string };
    expect(data.response_language).toBe('es');
  });
});

describe('UserSession history', () => {
  it('returns empty history initially', async () => {
    const response = await stub.fetch('http://fake-host/history?user_id=test');
    expect(response.status).toBe(200);
    const data = (await response.json()) as { history: unknown[] };
    expect(data.history).toHaveLength(0);
  });

  it('clears history', async () => {
    const response = await stub.fetch('http://fake-host/history?user_id=test', {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
  });
});

describe('UserSession memory', () => {
  it('returns empty memory initially', async () => {
    const response = await stub.fetch('http://fake-host/memory');
    expect(response.status).toBe(200);
  });

  it('clears memory', async () => {
    const response = await stub.fetch('http://fake-host/memory', { method: 'DELETE' });
    expect(response.status).toBe(200);
  });
});
