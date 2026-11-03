import { describe, it, expect } from 'vitest';
import { resolveAdminApiKey } from '../../src/config/admin-api-key.js';

describe('resolveAdminApiKey', () => {
  it('uses ADMIN_API_KEY when it is set', () => {
    expect(resolveAdminApiKey({ ADMIN_API_KEY: 'admin', ENGINE_API_KEY: 'engine' })).toEqual({
      key: 'admin',
      source: 'admin',
    });
  });

  it('returns the trimmed key when ADMIN_API_KEY is padded', () => {
    expect(resolveAdminApiKey({ ADMIN_API_KEY: '  admin\n', ENGINE_API_KEY: 'engine' }).key).toBe(
      'admin'
    );
  });

  it('falls back to ENGINE_API_KEY when ADMIN_API_KEY is unset', () => {
    expect(resolveAdminApiKey({ ENGINE_API_KEY: 'engine' })).toEqual({
      key: 'engine',
      source: 'engine_fallback',
    });
  });

  it('does not trim ENGINE_API_KEY itself (Baruch passes it on as configured)', () => {
    // fetch then normalizes surrounding whitespace in the header value, as it
    // did before ADMIN_API_KEY existed.
    expect(resolveAdminApiKey({ ENGINE_API_KEY: ' engine\n' }).key).toBe(' engine\n');
  });

  it('treats an empty or whitespace-only ADMIN_API_KEY as unset', () => {
    expect(resolveAdminApiKey({ ADMIN_API_KEY: '', ENGINE_API_KEY: 'engine' }).source).toBe(
      'engine_fallback'
    );
    expect(resolveAdminApiKey({ ADMIN_API_KEY: '  \n', ENGINE_API_KEY: 'engine' }).source).toBe(
      'engine_fallback'
    );
  });

  it('reports missing when ENGINE_API_KEY is also missing or blank', () => {
    expect(resolveAdminApiKey({ ENGINE_API_KEY: '  ' })).toEqual({ key: null, source: 'missing' });
    expect(
      resolveAdminApiKey({ ENGINE_API_KEY: undefined as unknown as string, ADMIN_API_KEY: '' })
    ).toEqual({ key: null, source: 'missing' });
  });

  it('is pure: the same env gives a fresh, current answer', () => {
    const env: { ADMIN_API_KEY?: string; ENGINE_API_KEY: string } = { ENGINE_API_KEY: 'engine' };
    expect(resolveAdminApiKey(env).source).toBe('engine_fallback');
    env.ADMIN_API_KEY = 'admin';
    expect(resolveAdminApiKey(env).source).toBe('admin');
  });
});
