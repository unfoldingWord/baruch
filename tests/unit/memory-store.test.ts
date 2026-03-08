import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JsonMemoryStore } from '../../src/services/memory/store.js';
import { MEMORY_STORAGE_KEY, MAX_MEMORY_SIZE_BYTES } from '../../src/services/memory/types.js';

function createMockStorage() {
  const data = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => data.delete(key)),
    _data: data,
  } as unknown as DurableObjectStorage;
}

function createMockLogger() {
  return { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function seedMemory(
  storage: DurableObjectStorage,
  entries: Record<string, { content: string; pinned?: boolean }>
) {
  const now = Date.now();

  const memEntries: Record<string, unknown> = {};
  let i = 0;
  for (const [name, entry] of Object.entries(entries)) {
    memEntries[name] = {
      content: entry.content,
      createdAt: now - 1000 * (Object.keys(entries).length - i),
      updatedAt: now - 1000 * (Object.keys(entries).length - i),
      ...(entry.pinned ? { pinned: true } : {}),
    };
    i++;
  }
  await storage.put(MEMORY_STORAGE_KEY, { entries: memEntries });
}

let storage: DurableObjectStorage;
let logger: ReturnType<typeof createMockLogger>;
let store: JsonMemoryStore;

beforeEach(() => {
  storage = createMockStorage();
  logger = createMockLogger();
  store = new JsonMemoryStore(storage, logger);
});

describe('JsonMemoryStore read', () => {
  it('returns empty string for empty memory', async () => {
    expect(await store.read()).toBe('');
  });

  it('returns full markdown for all sections', async () => {
    await seedMemory(storage, { Topic: { content: 'Content here' } });
    const result = await store.read();
    expect(result).toContain('## Topic');
    expect(result).toContain('Content here');
  });

  it('returns specific sections when requested', async () => {
    await seedMemory(storage, { A: { content: 'Alpha' }, B: { content: 'Beta' } });
    const result = (await store.read(['A'])) as Record<string, string>;
    expect(result).toHaveProperty('A', 'Alpha');
    expect(result).not.toHaveProperty('B');
  });

  it('omits missing sections from result', async () => {
    await seedMemory(storage, { A: { content: 'Alpha' } });
    const result = (await store.read(['A', 'Missing'])) as Record<string, string>;
    expect(Object.keys(result)).toHaveLength(1);
  });
});

describe('JsonMemoryStore write', () => {
  it('creates new sections', async () => {
    const result = await store.writeSections({ Topic: 'New content' });
    expect(result.updated).toContain('Topic');
    expect(result.totalSizeBytes).toBeGreaterThan(0);
    expect(await store.read()).toContain('New content');
  });

  it('deletes sections with null', async () => {
    await seedMemory(storage, { Topic: { content: 'Delete me' } });
    const result = await store.writeSections({ Topic: null });
    expect(result.deleted).toContain('Topic');
    expect(await store.read()).toBe('');
  });

  it('returns capacity percentage', async () => {
    const result = await store.writeSections({ Topic: 'Small content' });
    expect(result.capacityPercent).toBeGreaterThanOrEqual(0);
    expect(result.capacityPercent).toBeLessThanOrEqual(100);
  });
});

describe('JsonMemoryStore pin/unpin', () => {
  it('pins a section', async () => {
    await seedMemory(storage, { Topic: { content: 'Content' } });
    await store.writeSections({}, ['Topic']);
    const toc = await store.getTableOfContents();
    expect(toc.entries.find((e) => e.name === 'Topic')?.pinned).toBe(true);
  });

  it('unpins a section', async () => {
    await seedMemory(storage, { Topic: { content: 'Content', pinned: true } });
    await store.writeSections({}, undefined, ['Topic']);
    const toc = await store.getTableOfContents();
    expect(toc.entries.find((e) => e.name === 'Topic')?.pinned).toBe(false);
  });
});

describe('JsonMemoryStore TOC', () => {
  it('returns empty TOC for empty memory', async () => {
    const toc = await store.getTableOfContents();
    expect(toc.entries).toHaveLength(0);
    expect(toc.totalSizeBytes).toBe(0);
    expect(toc.maxSizeBytes).toBe(MAX_MEMORY_SIZE_BYTES);
  });

  it('includes all sections with sizes', async () => {
    await seedMemory(storage, { A: { content: 'Alpha' }, B: { content: 'Beta' } });
    const toc = await store.getTableOfContents();
    expect(toc.entries).toHaveLength(2);
    expect(toc.entries.every((e) => e.sizeBytes > 0)).toBe(true);
  });
});

describe('JsonMemoryStore clear', () => {
  it('removes all memory', async () => {
    await seedMemory(storage, { Topic: { content: 'Content' } });
    await store.clear();
    expect(await store.read()).toBe('');
  });
});

describe('JsonMemoryStore eviction', () => {
  it('evicts oldest non-pinned entries when over capacity', async () => {
    const bigContent = 'x'.repeat(MAX_MEMORY_SIZE_BYTES - 100);
    await seedMemory(storage, { Old: { content: bigContent } });
    const result = await store.writeSections({ New: 'x'.repeat(200) });
    expect(result.evicted).toContain('Old');
  });

  it('preserves pinned entries during eviction', async () => {
    const bigContent = 'x'.repeat(MAX_MEMORY_SIZE_BYTES - 100);
    await seedMemory(storage, { Pinned: { content: bigContent, pinned: true } });
    const result = await store.writeSections({ New: 'x'.repeat(200) });
    expect(result.evicted).not.toContain('Pinned');
  });
});

describe('JsonMemoryStore v1 migration', () => {
  it('migrates v1 markdown to v2 JSON', async () => {
    await storage.put(MEMORY_STORAGE_KEY, '## Topic A\nContent A\n## Topic B\nContent B');
    const result = (await store.read(['Topic A'])) as Record<string, string>;
    expect(result).toHaveProperty('Topic A');
  });
});

describe('JsonMemoryStore section name validation', () => {
  it('skips sections with reserved names', async () => {
    const updates: Record<string, string | null> = {};
    updates['constructor'] = 'bad';
    const result = await store.writeSections(updates);
    expect(result.updated).not.toContain('constructor');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('skips sections with control characters in name', async () => {
    const result = await store.writeSections({ 'bad\x00name': 'content' });
    expect(result.updated).not.toContain('bad\x00name');
  });
});
