import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserSession } from '../../src/durable-objects/user-session.js';
import { Env } from '../../src/config/types.js';
import * as claudeIndex from '../../src/services/claude/index.js';

// Mock orchestrate to avoid real Claude calls
vi.mock('../../src/services/claude/index.js', () => ({
  orchestrate: vi.fn().mockResolvedValue(['Mocked response']),
}));

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
    put: vi.fn((key: string, value: unknown) => {
      storageData.set(key, value);
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
    PROMPT_OVERRIDES: { get: vi.fn().mockResolvedValue(null) } as unknown as KVNamespace,
    USER_SESSION: {} as DurableObjectNamespace,
    USER_QUEUE: {} as DurableObjectNamespace,
  };
}

let session: UserSession;
let env: Env;

beforeEach(() => {
  vi.clearAllMocks();
  storageData.clear();
  env = buildMockEnv();
  session = new UserSession(mockState, env);
});

function makeRequest(path: string, method = 'GET', body?: unknown): Request {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return new Request(`http://fake-host${path}`, opts);
}

describe('UserSession preferences', () => {
  it('returns default preferences', async () => {
    const res = await session.fetch(makeRequest('/preferences'));
    const data = await res.json();
    expect(data).toEqual({ response_language: 'en' });
  });

  it('updates response_language', async () => {
    const res = await session.fetch(
      makeRequest('/preferences', 'PUT', { response_language: 'es' })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.response_language).toBe('es');
  });

  it('rejects invalid language code', async () => {
    const res = await session.fetch(
      makeRequest('/preferences', 'PUT', { response_language: 'invalid' })
    );
    expect(res.status).toBe(400);
  });

  it('rejects numeric language code', async () => {
    const res = await session.fetch(makeRequest('/preferences', 'PUT', { response_language: 42 }));
    expect(res.status).toBe(400);
  });
});

describe('UserSession history', () => {
  it('returns empty history by default', async () => {
    const res = await session.fetch(makeRequest('/history?user_id=u1'));
    const data = await res.json();
    expect(data.entries).toEqual([]);
    expect(data.total_count).toBe(0);
  });

  it('respects limit and offset', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      user_message: `msg${i}`,
      assistant_response: `resp${i}`,
      timestamp: Date.now(),
    }));
    storageData.set('history', entries);

    const res = await session.fetch(makeRequest('/history?user_id=u1&limit=2&offset=1'));
    const data = await res.json();
    expect(data.entries).toHaveLength(2);
    expect(data.total_count).toBe(5);
    expect(data.limit).toBe(2);
    expect(data.offset).toBe(1);
  });

  it('deletes history', async () => {
    storageData.set('history', [{ user_message: 'hi', assistant_response: 'hello', timestamp: 1 }]);
    const res = await session.fetch(makeRequest('/history', 'DELETE'));
    expect(res.status).toBe(200);
    expect(storageData.has('history')).toBe(false);
  });
});

describe('UserSession memory', () => {
  it('returns empty memory', async () => {
    const res = await session.fetch(makeRequest('/memory'));
    expect(res.status).toBe(200);
  });

  it('deletes memory', async () => {
    const res = await session.fetch(makeRequest('/memory', 'DELETE'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toBe('User memory cleared');
  });
});

describe('UserSession chat locking', () => {
  it('rejects concurrent requests with 429', async () => {
    // Simulate an existing lock
    storageData.set('_processing_lock', Date.now());

    const res = await session.fetch(
      makeRequest('/chat', 'POST', { user_id: 'u1', client_id: 'c1', message: 'hi' })
    );
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.code).toBe('CONCURRENT_REQUEST_REJECTED');
  });

  it('allows request when no lock exists', async () => {
    const res = await session.fetch(
      makeRequest('/chat', 'POST', { user_id: 'u1', client_id: 'c1', message: 'hello' })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.responses).toEqual(['Mocked response']);
  });

  it('overwrites stale lock', async () => {
    // Lock from 2 minutes ago (stale threshold is 90s)
    storageData.set('_processing_lock', Date.now() - 120000);

    const res = await session.fetch(
      makeRequest('/chat', 'POST', { user_id: 'u1', client_id: 'c1', message: 'hello' })
    );
    expect(res.status).toBe(200);
  });
});

describe('UserSession chat validation', () => {
  it('rejects empty message', async () => {
    const res = await session.fetch(
      makeRequest('/chat', 'POST', { user_id: 'u1', client_id: 'c1', message: '' })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('VALIDATION_ERROR');
  });

  it('rejects whitespace-only message', async () => {
    const res = await session.fetch(
      makeRequest('/chat', 'POST', { user_id: 'u1', client_id: 'c1', message: '   ' })
    );
    expect(res.status).toBe(400);
  });
});

describe('UserSession 404', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await session.fetch(makeRequest('/nonexistent'));
    expect(res.status).toBe(404);
  });
});

async function collectSSEEvents(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)) as Record<string, unknown>);
}

describe('UserSession initiate', () => {
  const initiateBody = { user_id: 'u1', client_id: 'c1', is_admin: true };

  it('streams SSE and stores AI-initiated entry on empty history', async () => {
    const res = await session.fetch(makeRequest('/initiate', 'POST', initiateBody));
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const events = await collectSSEEvents(res);
    const completeEvent = events.find((e) => e['type'] === 'complete');

    expect(completeEvent).toBeDefined();
    const response = completeEvent!['response'] as { responses: string[] };
    expect(response.responses).toContain('Mocked response');

    const history = storageData.get('history') as { assistant_response: string }[];
    expect(history).toHaveLength(1);
    expect(history[0]!.assistant_response).toBe('Mocked response');
  });

  it('streams cached response without re-calling orchestrate', async () => {
    storageData.set('history', [
      { user_message: '', assistant_response: 'Cached opening', timestamp: Date.now() },
    ]);
    storageData.set('preferences', { response_language: 'es', first_interaction: false });

    const orchestrateSpy = vi.spyOn(claudeIndex, 'orchestrate');
    const events = await collectSSEEvents(
      await session.fetch(makeRequest('/initiate', 'POST', initiateBody))
    );
    const completeEvent = events.find((e) => e['type'] === 'complete');
    expect(completeEvent).toBeDefined();
    const response = completeEvent!['response'] as {
      responses: string[];
      response_language: string;
    };
    expect(response.responses).toContain('Cached opening');
    expect(response.response_language).toBe('es');
    expect(orchestrateSpy).not.toHaveBeenCalled();
  });

  it('marks first_interaction false after generating opening', async () => {
    await (await session.fetch(makeRequest('/initiate', 'POST', initiateBody))).text();
    const prefs = storageData.get('preferences') as { first_interaction: boolean };
    expect(prefs.first_interaction).toBe(false);
  });

  it('sends error SSE event when orchestrate throws', async () => {
    vi.spyOn(claudeIndex, 'orchestrate').mockRejectedValueOnce(new Error('API failure'));
    const events = await collectSSEEvents(
      await session.fetch(makeRequest('/initiate', 'POST', initiateBody))
    );
    const errorEvent = events.find((e) => e['type'] === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent!['error']).toBe('API failure');
  });

  it('acquires lock and rejects concurrent initiate requests', async () => {
    storageData.set('_processing_lock', Date.now());
    const res = await session.fetch(makeRequest('/initiate', 'POST', initiateBody));
    expect(res.status).toBe(429);
  });
});
