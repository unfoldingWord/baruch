import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

interface EnqueueResponse {
  message_id: string;
  queue_position: number;
  status: string;
}

let stub: DurableObjectStub;

beforeEach(() => {
  const id = env.USER_QUEUE.newUniqueId();
  stub = env.USER_QUEUE.get(id);
});

describe('UserQueue POST /enqueue', () => {
  it('returns 202 with message_id and queue_position', async () => {
    const response = await stub.fetch('http://fake-host/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: 'test-user',
        client_id: 'test-client',
        org: 'test-org',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(response.status).toBe(202);
    const data = (await response.json()) as EnqueueResponse;
    expect(data.message_id).toBeDefined();
    expect(data.queue_position).toBeDefined();
    expect(typeof data.queue_position).toBe('number');
  });

  it('rejects missing user_id', async () => {
    const response = await stub.fetch('http://fake-host/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'test-client',
        org: 'test-org',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects missing messages', async () => {
    const response = await stub.fetch('http://fake-host/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'test-user', client_id: 'test-client', org: 'test-org' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('UserQueue GET /status', () => {
  it('returns queue status', async () => {
    const response = await stub.fetch('http://fake-host/status');
    expect(response.status).toBe(200);
    const data = (await response.json()) as { queue_depth: number };
    expect(data.queue_depth).toBeDefined();
  });
});

describe('UserQueue GET /stream', () => {
  it('requires message_id parameter', async () => {
    const response = await stub.fetch('http://fake-host/stream');
    expect(response.status).toBe(400);
  });

  it('returns 404 for unknown message_id', async () => {
    const response = await stub.fetch('http://fake-host/stream?message_id=nonexistent');
    expect(response.status).toBe(404);
  });
});

describe('UserQueue GET /poll', () => {
  it('requires message_id parameter', async () => {
    const response = await stub.fetch('http://fake-host/poll');
    expect(response.status).toBe(400);
  });

  it('returns 404 for unknown message_id', async () => {
    const response = await stub.fetch('http://fake-host/poll?message_id=nonexistent&cursor=0');
    expect(response.status).toBe(404);
  });
});
