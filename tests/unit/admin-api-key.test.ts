import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveAdminApiKey, resetAdminApiKeyLogForTests } from '../../src/config/admin-api-key.js';
import type { RequestLogger } from '../../src/utils/logger.js';

function makeLogger() {
  return { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

beforeEach(() => {
  resetAdminApiKeyLogForTests();
});

describe('resolveAdminApiKey', () => {
  it('uses ADMIN_API_KEY when it is set', () => {
    expect(resolveAdminApiKey({ ADMIN_API_KEY: 'admin', ENGINE_API_KEY: 'engine' })).toBe('admin');
  });

  it('returns the trimmed key when ADMIN_API_KEY is padded', () => {
    expect(resolveAdminApiKey({ ADMIN_API_KEY: '  admin\n', ENGINE_API_KEY: 'engine' })).toBe(
      'admin'
    );
  });

  it('falls back to ENGINE_API_KEY when ADMIN_API_KEY is unset', () => {
    expect(resolveAdminApiKey({ ENGINE_API_KEY: 'engine' })).toBe('engine');
  });

  it('treats an empty or whitespace-only ADMIN_API_KEY as unset', () => {
    expect(resolveAdminApiKey({ ADMIN_API_KEY: '', ENGINE_API_KEY: 'engine' })).toBe('engine');
    expect(resolveAdminApiKey({ ADMIN_API_KEY: '  \n', ENGINE_API_KEY: 'engine' })).toBe('engine');
  });

  it('logs the source once per isolate as admin, never the key value', () => {
    const logger = makeLogger();
    const env = { ADMIN_API_KEY: 'admin-secret-value', ENGINE_API_KEY: 'engine' };
    resolveAdminApiKey(env, logger as unknown as RequestLogger);
    resolveAdminApiKey(env, logger as unknown as RequestLogger);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('admin_api_key_source', { key_source: 'admin' });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('admin-secret-value');
  });

  it('logs engine_fallback as a warning once per isolate, never the key value', () => {
    const logger = makeLogger();
    const env = { ENGINE_API_KEY: 'engine-secret-value' };
    resolveAdminApiKey(env, logger as unknown as RequestLogger);
    resolveAdminApiKey(env, logger as unknown as RequestLogger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('admin_api_key_source', {
      key_source: 'engine_fallback',
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('engine-secret-value');
  });
});
