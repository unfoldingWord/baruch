/**
 * Picks the bearer key for bt-servant-worker's admin API.
 */

import { Env } from './types.js';

export type AdminApiKeySource = 'admin' | 'engine_fallback';

export interface AdminApiKey {
  key: string;
  source: AdminApiKeySource;
}

type KeyEnv = Pick<Env, 'ADMIN_API_KEY' | 'ENGINE_API_KEY'>;

// Memoized per env object. Workers hand the same env to every request in an
// isolate (and a Durable Object keeps its constructor env), so this resolves
// once per isolate.
const resolved = new WeakMap<KeyEnv, AdminApiKey>();

/**
 * The trimmed ADMIN_API_KEY when it is set and non-blank (source `admin`);
 * otherwise ENGINE_API_KEY exactly as configured (source `engine_fallback`,
 * untrimmed, because the worker compares it untrimmed), so a deploy without
 * the new secret keeps working. Whitespace-only counts as unset.
 */
export function resolveAdminApiKey(env: KeyEnv): AdminApiKey {
  const cached = resolved.get(env);
  if (cached) return cached;
  const adminKey = env.ADMIN_API_KEY?.trim();
  const result: AdminApiKey = adminKey
    ? { key: adminKey, source: 'admin' }
    : { key: env.ENGINE_API_KEY, source: 'engine_fallback' };
  resolved.set(env, result);
  return result;
}
