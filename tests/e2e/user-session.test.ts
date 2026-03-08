import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

let stub: DurableObjectStub;

beforeEach(() => {
  const id = env.USER_SESSION.newUniqueId();
  stub = env.USER_SESSION.get(id);
});

describe('UserSession POST /chat', () => {
  it('rejects empty message', async () => {
    const response = await stub.fetch('http://fake-host/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'u1', client_id: 'c1', message: '' }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects missing message', async () => {
    const response = await stub.fetch('http://fake-host/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'u1', client_id: 'c1' }),
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
    const data = (await response.json()) as { entries: unknown[]; total_count: number };
    expect(data.entries).toHaveLength(0);
    expect(data.total_count).toBe(0);
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
