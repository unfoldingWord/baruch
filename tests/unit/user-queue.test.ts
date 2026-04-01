import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserQueue } from '../../src/durable-objects/user-queue.js';
import { Env } from '../../src/config/types.js';

const storageData = new Map<string, unknown>();

function createMockStorage() {
  return {
    get: vi.fn((key: string | string[]) => {
      if (Array.isArray(key)) {
        const result = new Map();
        for (const k of key) {
          if (storageData.has(k)) result.set(k, storageData.get(k));
        }
        return Promise.resolve(result);
      }
      return Promise.resolve(storageData.get(key) ?? null);
    }),
    put: vi.fn((keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
      if (typeof keyOrEntries === 'string') {
        storageData.set(keyOrEntries, value);
      } else {
        for (const [k, v] of Object.entries(keyOrEntries)) {
          storageData.set(k, v);
        }
      }
      return Promise.resolve();
    }),
    delete: vi.fn((key: string | string[]) => {
      if (Array.isArray(key)) {
        key.forEach((k) => storageData.delete(k));
      } else {
        storageData.delete(key);
      }
      return Promise.resolve();
    }),
    list: vi.fn().mockResolvedValue(new Map()),
    setAlarm: vi.fn().mockResolvedValue(undefined),
  };
}

const mockStorage = createMockStorage();

const mockState = {
  storage: mockStorage,
  blockConcurrencyWhile: vi.fn((fn: () => Promise<unknown>) => fn()),
} as unknown as DurableObjectState;

function buildMockEnv(): Env {
  return {
    ENVIRONMENT: 'test',
    MAX_ORCHESTRATION_ITERATIONS: '10',
    DEFAULT_ORG: 'testOrg',
    ANTHROPIC_API_KEY: 'test-key',
    BARUCH_API_KEY: 'test-baruch-key',
    ENGINE_API_KEY: 'test-engine-key',
    ENGINE_BASE_URL: 'https://api.example.com',
    PROMPT_OVERRIDES: {} as KVNamespace,
    USER_SESSION: { idFromName: vi.fn(), get: vi.fn() } as unknown as DurableObjectNamespace,
    USER_QUEUE: {} as DurableObjectNamespace,
  };
}

let queue: UserQueue;

beforeEach(() => {
  vi.clearAllMocks();
  storageData.clear();
  queue = new UserQueue(mockState, buildMockEnv());
});

function makeRequest(path: string, method = 'GET', body?: unknown): Request {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return new Request(`http://fake-host${path}`, opts);
}

describe('UserQueue enqueue validation', () => {
  it('rejects missing user_id', async () => {
    const res = await queue.fetch(
      makeRequest('/enqueue', 'POST', { message: 'hi', org: 'testOrg' })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('user_id');
  });

  it('rejects missing message', async () => {
    const res = await queue.fetch(
      makeRequest('/enqueue', 'POST', { user_id: 'u1', org: 'testOrg' })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('message');
  });

  it('rejects missing org', async () => {
    const res = await queue.fetch(
      makeRequest('/enqueue', 'POST', { user_id: 'u1', message: 'hi' })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('org');
  });

  it('rejects invalid JSON', async () => {
    const req = new Request('http://fake-host/enqueue', {
      method: 'POST',
      body: 'not-json',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await queue.fetch(req);
    expect(res.status).toBe(400);
  });
});

describe('UserQueue enqueue success', () => {
  it('accepts valid enqueue and returns 202', async () => {
    const res = await queue.fetch(
      makeRequest('/enqueue', 'POST', { user_id: 'u1', message: 'hello', org: 'testOrg' })
    );
    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data.message_id).toBeTruthy();
    expect(data.queue_position).toBe(1);
  });

  it('increments queue position for subsequent enqueues', async () => {
    await queue.fetch(
      makeRequest('/enqueue', 'POST', { user_id: 'u1', message: 'first', org: 'testOrg' })
    );
    const res = await queue.fetch(
      makeRequest('/enqueue', 'POST', { user_id: 'u1', message: 'second', org: 'testOrg' })
    );
    const data = await res.json();
    expect(data.queue_position).toBe(2);
  });

  it('triggers alarm on first enqueue', async () => {
    await queue.fetch(
      makeRequest('/enqueue', 'POST', { user_id: 'u1', message: 'hi', org: 'testOrg' })
    );
    expect(mockStorage.setAlarm).toHaveBeenCalled();
  });
});

describe('UserQueue status', () => {
  it('returns empty status', async () => {
    const res = await queue.fetch(makeRequest('/status'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.queue_length).toBe(0);
    expect(data.processing).toBe(false);
  });

  it('reflects queue length after enqueue', async () => {
    await queue.fetch(
      makeRequest('/enqueue', 'POST', { user_id: 'u1', message: 'hi', org: 'testOrg' })
    );
    const res = await queue.fetch(makeRequest('/status'));
    const data = await res.json();
    expect(data.queue_length).toBe(1);
  });
});

describe('UserQueue poll', () => {
  it('requires message_id', async () => {
    const res = await queue.fetch(makeRequest('/poll'));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('message_id');
  });

  it('returns empty events for unknown message_id', async () => {
    const res = await queue.fetch(makeRequest('/poll?message_id=unknown'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.events).toEqual([]);
    expect(data.done).toBe(false);
  });
});

describe('UserQueue stream', () => {
  it('requires message_id', async () => {
    const res = await queue.fetch(makeRequest('/stream'));
    expect(res.status).toBe(400);
  });
});

describe('UserQueue 404', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await queue.fetch(makeRequest('/nonexistent'));
    expect(res.status).toBe(404);
  });
});

describe('UserQueue is_admin passthrough', () => {
  it('defaults is_admin to false when not provided', async () => {
    const res = await queue.fetch(
      makeRequest('/enqueue', 'POST', { user_id: 'u1', message: 'hi', org: 'testOrg' })
    );
    expect(res.status).toBe(202);
    const queueEntries = storageData.get('queue') as Array<{ is_admin: boolean }>;
    expect(queueEntries[0].is_admin).toBe(false);
  });

  it('preserves is_admin true when provided', async () => {
    const res = await queue.fetch(
      makeRequest('/enqueue', 'POST', {
        user_id: 'u1',
        message: 'hi',
        org: 'testOrg',
        is_admin: true,
      })
    );
    expect(res.status).toBe(202);
    const queueEntries = storageData.get('queue') as Array<{ is_admin: boolean }>;
    expect(queueEntries[0].is_admin).toBe(true);
  });
});

describe('UserQueue _worker_origin passthrough', () => {
  it('stores _worker_origin when provided at enqueue', async () => {
    const res = await queue.fetch(
      makeRequest('/enqueue', 'POST', {
        user_id: 'u1',
        message: 'hi',
        org: 'testOrg',
        _worker_origin: 'https://baruch.example.com',
      })
    );
    expect(res.status).toBe(202);
    const queueEntries = storageData.get('queue') as Array<{ _worker_origin?: string }>;
    expect(queueEntries[0]._worker_origin).toBe('https://baruch.example.com');
  });

  it('leaves _worker_origin undefined when not provided', async () => {
    const res = await queue.fetch(
      makeRequest('/enqueue', 'POST', { user_id: 'u1', message: 'hi', org: 'testOrg' })
    );
    expect(res.status).toBe(202);
    const queueEntries = storageData.get('queue') as Array<{ _worker_origin?: string }>;
    expect(queueEntries[0]._worker_origin).toBeUndefined();
  });
});

function seedQueueEntry(overrides: Record<string, unknown> = {}) {
  storageData.set('queue', [
    {
      message_id: 'msg-1',
      user_id: 'u1',
      client_id: 'c1',
      message: 'hello',
      message_type: 'text',
      org: 'testOrg',
      is_admin: false,
      enqueued_at: Date.now(),
      delivery: 'callback',
      retry_count: 0,
      _worker_origin: 'https://baruch.example.com',
      progress_callback_url: 'https://cb.example.com/hook',
      ...overrides,
    },
  ]);
  storageData.set('processing', true);
}

function makeSseStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));
      controller.close();
    },
  });
}

describe('UserQueue fetchViaWorker callback routing', () => {
  it('calls globalThis.fetch with correct URL, auth, and body', async () => {
    seedQueueEntry();
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    await queue.alarm();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://baruch.example.com/api/v1/chat');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-baruch-key');
    expect(init.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body);
    expect(body.org).toBe('testOrg');
    expect(body.user_id).toBe('u1');
    expect(body.progress_callback_url).toBe('https://cb.example.com/hook');

    vi.unstubAllGlobals();
  });

  it('dead-letters when _worker_origin is missing', async () => {
    seedQueueEntry({ _worker_origin: undefined });
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    await queue.alarm();

    expect(mockFetch).not.toHaveBeenCalled();
    const remaining = storageData.get('queue') as unknown[];
    expect(remaining ?? []).toHaveLength(0);

    vi.unstubAllGlobals();
  });
});

describe('UserQueue fetchViaWorker SSE routing', () => {
  it('calls /api/v1/chat/stream for SSE delivery', async () => {
    seedQueueEntry({ delivery: 'sse', progress_callback_url: undefined });
    const mockFetch = vi.fn().mockResolvedValue(new Response(makeSseStream(), { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    await queue.alarm();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://baruch.example.com/api/v1/chat/stream');

    vi.unstubAllGlobals();
  });

  it('excludes callback fields from SSE body', async () => {
    seedQueueEntry({
      delivery: 'sse',
      progress_callback_url: 'https://cb.example.com/hook',
      progress_mode: 'sentence',
    });
    const mockFetch = vi.fn().mockResolvedValue(new Response(makeSseStream(), { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    await queue.alarm();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.progress_callback_url).toBeUndefined();
    expect(body.progress_mode).toBeUndefined();

    vi.unstubAllGlobals();
  });
});

describe('UserQueue _worker_origin validation', () => {
  it('rejects non-URL _worker_origin values', async () => {
    const res = await queue.fetch(
      makeRequest('/enqueue', 'POST', {
        user_id: 'u1',
        message: 'hi',
        org: 'testOrg',
        _worker_origin: 'not-a-url',
      })
    );
    expect(res.status).toBe(202);
    const queueEntries = storageData.get('queue') as Array<{ _worker_origin?: string }>;
    expect(queueEntries[0]._worker_origin).toBeUndefined();
  });
});

describe('UserQueue queue depth limit', () => {
  it('rejects when queue is full', async () => {
    // Fill the queue to default max (50)
    const entries = Array.from({ length: 50 }, (_, i) => ({
      message_id: `id_${i}`,
      user_id: 'u1',
      client_id: 'c1',
      message: `msg_${i}`,
      message_type: 'text',
      org: 'testOrg',
      enqueued_at: Date.now(),
      delivery: 'sse',
      retry_count: 0,
    }));
    storageData.set('queue', entries);
    storageData.set('processing', true);

    const res = await queue.fetch(
      makeRequest('/enqueue', 'POST', { user_id: 'u1', message: 'overflow', org: 'testOrg' })
    );
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.code).toBe('QUEUE_DEPTH_EXCEEDED');
  });
});
