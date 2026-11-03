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

  it('trims ENGINE_API_KEY on the fallback too', () => {
    expect(resolveAdminApiKey({ ENGINE_API_KEY: ' engine\n' }).key).toBe('engine');
  });

  it('treats an empty or whitespace-only ADMIN_API_KEY as unset', () => {
    expect(resolveAdminApiKey({ ADMIN_API_KEY: '', ENGINE_API_KEY: 'engine' }).source).toBe(
      'engine_fallback'
    );
    expect(resolveAdminApiKey({ ADMIN_API_KEY: '  \n', ENGINE_API_KEY: 'engine' }).source).toBe(
      'engine_fallback'
    );
  });

  it('resolves once per env object', () => {
    const env: { ADMIN_API_KEY?: string; ENGINE_API_KEY: string } = { ENGINE_API_KEY: 'engine' };
    const first = resolveAdminApiKey(env);
    env.ADMIN_API_KEY = 'admin';
    expect(resolveAdminApiKey(env)).toBe(first);
  });
});
