import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserDO } from '../../src/durable-objects/user-do.js';
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
    PROMPT_OVERRIDES: { get: vi.fn().mockResolvedValue(null) } as unknown as KVNamespace,
    USER_DO: {} as DurableObjectNamespace,
  };
}

let userDO: UserDO;
let env: Env;

beforeEach(() => {
  vi.clearAllMocks();
  storageData.clear();
  env = buildMockEnv();
  userDO = new UserDO(mockState, env);
});

function makeRequest(path: string, method = 'GET', body?: unknown): Request {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return new Request(`http://fake-host${path}`, opts);
}

describe('UserDO preferences', () => {
  it('returns default preferences', async () => {
    const res = await userDO.fetch(makeRequest('/preferences'));
    const data = await res.json();
    expect(data).toEqual({ response_language: 'en' });
  });

  it('updates response_language', async () => {
    const res = await userDO.fetch(makeRequest('/preferences', 'PUT', { response_language: 'es' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.response_language).toBe('es');
  });

  it('rejects invalid language code', async () => {
    const res = await userDO.fetch(
      makeRequest('/preferences', 'PUT', { response_language: 'invalid' })
    );
    expect(res.status).toBe(400);
  });

  it('rejects numeric language code', async () => {
    const res = await userDO.fetch(makeRequest('/preferences', 'PUT', { response_language: 42 }));
    expect(res.status).toBe(400);
  });
});

describe('UserDO history', () => {
  it('returns empty history by default', async () => {
    const res = await userDO.fetch(makeRequest('/history?user_id=u1'));
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

    const res = await userDO.fetch(makeRequest('/history?user_id=u1&limit=2&offset=1'));
    const data = await res.json();
    expect(data.entries).toHaveLength(2);
    expect(data.total_count).toBe(5);
    expect(data.limit).toBe(2);
    expect(data.offset).toBe(1);
  });

  it('deletes history', async () => {
    storageData.set('history', [{ user_message: 'hi', assistant_response: 'hello', timestamp: 1 }]);
    const res = await userDO.fetch(makeRequest('/history', 'DELETE'));
    expect(res.status).toBe(200);
    expect(storageData.has('history')).toBe(false);
  });
});

describe('UserDO memory', () => {
  it('returns empty memory', async () => {
    const res = await userDO.fetch(makeRequest('/memory'));
    expect(res.status).toBe(200);
  });

  it('deletes memory', async () => {
    const res = await userDO.fetch(makeRequest('/memory', 'DELETE'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toBe('User memory cleared');
  });
});

describe('UserDO chat locking', () => {
  it('rejects concurrent requests with 429', async () => {
    storageData.set('_processing_lock', Date.now());

    const res = await userDO.fetch(
      makeRequest('/chat', 'POST', { user_id: 'u1', client_id: 'c1', message: 'hi' })
    );
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.code).toBe('CONCURRENT_REQUEST_REJECTED');
  });

  it('allows request when no lock exists', async () => {
    const res = await userDO.fetch(
      makeRequest('/chat', 'POST', { user_id: 'u1', client_id: 'c1', message: 'hello' })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.responses).toEqual(['Mocked response']);
  });

  it('overwrites stale lock', async () => {
    storageData.set('_processing_lock', Date.now() - 120000);

    const res = await userDO.fetch(
      makeRequest('/chat', 'POST', { user_id: 'u1', client_id: 'c1', message: 'hello' })
    );
    expect(res.status).toBe(200);
  });
});

describe('UserDO chat validation', () => {
  it('rejects empty message', async () => {
    const res = await userDO.fetch(
      makeRequest('/chat', 'POST', { user_id: 'u1', client_id: 'c1', message: '' })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('VALIDATION_ERROR');
  });

  it('rejects whitespace-only message', async () => {
    const res = await userDO.fetch(
      makeRequest('/chat', 'POST', { user_id: 'u1', client_id: 'c1', message: '   ' })
    );
    expect(res.status).toBe(400);
  });
});

describe('UserDO 404', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await userDO.fetch(makeRequest('/nonexistent'));
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

const initiateBody = { user_id: 'u1', client_id: 'c1', is_admin: true };

describe('UserDO initiate fresh', () => {
  it('streams SSE and stores AI-initiated entry on empty history', async () => {
    const res = await userDO.fetch(makeRequest('/initiate', 'POST', initiateBody));
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

  it('marks first_interaction false after generating opening', async () => {
    await (await userDO.fetch(makeRequest('/initiate', 'POST', initiateBody))).text();
    const prefs = storageData.get('preferences') as { first_interaction: boolean };
    expect(prefs.first_interaction).toBe(false);
  });

  it('sends error SSE event when orchestrate throws', async () => {
    vi.spyOn(claudeIndex, 'orchestrate').mockRejectedValueOnce(new Error('API failure'));
    const events = await collectSSEEvents(
      await userDO.fetch(makeRequest('/initiate', 'POST', initiateBody))
    );
    const errorEvent = events.find((e) => e['type'] === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent!['error']).toBe('API failure');
  });
});

describe('UserDO initiate cached', () => {
  it('streams cached response without re-calling orchestrate', async () => {
    storageData.set('history', [
      { user_message: '', assistant_response: 'Cached opening', timestamp: Date.now() },
    ]);
    storageData.set('preferences', { response_language: 'es', first_interaction: false });

    const orchestrateSpy = vi.spyOn(claudeIndex, 'orchestrate');
    const events = await collectSSEEvents(
      await userDO.fetch(makeRequest('/initiate', 'POST', initiateBody))
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

  it('acquires lock and rejects concurrent initiate requests', async () => {
    storageData.set('_processing_lock', Date.now());
    const res = await userDO.fetch(makeRequest('/initiate', 'POST', initiateBody));
    expect(res.status).toBe(429);
  });
});

describe('UserDO queue enqueue', () => {
  const enqueueBody = {
    user_id: 'u1',
    client_id: 'c1',
    message: 'hello',
    org: 'testOrg',
    delivery: 'callback',
    is_admin: false,
  };

  it('rejects missing user_id', async () => {
    const res = await userDO.fetch(
      makeRequest('/enqueue', 'POST', { message: 'hi', org: 'testOrg' })
    );
    expect(res.status).toBe(400);
  });

  it('rejects missing message', async () => {
    const res = await userDO.fetch(
      makeRequest('/enqueue', 'POST', { user_id: 'u1', org: 'testOrg' })
    );
    expect(res.status).toBe(400);
  });

  it('returns 202 for callback delivery when idle', async () => {
    const res = await userDO.fetch(makeRequest('/enqueue', 'POST', enqueueBody));
    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data.message_id).toBeDefined();
    expect(data.status).toBe('processing');
  });

  it('returns 202 with queue_position when busy (callback)', async () => {
    storageData.set('_processing_lock', Date.now());
    const res = await userDO.fetch(makeRequest('/enqueue', 'POST', enqueueBody));
    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data.queue_position).toBe(1);
  });

  it('returns SSE response for sse delivery when idle', async () => {
    const sseBody = { ...enqueueBody, delivery: 'sse' };
    const res = await userDO.fetch(makeRequest('/enqueue', 'POST', sseBody));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
  });
});

describe('UserDO queue status', () => {
  it('returns empty queue status', async () => {
    const res = await userDO.fetch(makeRequest('/status'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.queue_length).toBe(0);
    expect(data.processing).toBe(false);
  });

  it('reflects queue entries and processing state', async () => {
    storageData.set('queue', [{ message_id: 'msg-1' }]);
    storageData.set('_processing_lock', Date.now());
    const res = await userDO.fetch(makeRequest('/status'));
    const data = await res.json();
    expect(data.queue_length).toBe(1);
    expect(data.processing).toBe(true);
  });
});
