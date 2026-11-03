/**
 * Picks the bearer key for bt-servant-worker's admin API.
 */

import { Env } from './types.js';

export type AdminApiKeySource = 'admin' | 'engine_fallback';

export type AdminApiKey =
  | { key: string; source: AdminApiKeySource }
  /** Neither key is configured: admin calls must not be sent. */
  | { key: null; source: 'missing' };

/**
 * Pure. The trimmed ADMIN_API_KEY when it is set and non-blank (source
 * `admin`). Otherwise ENGINE_API_KEY as configured (source
 * `engine_fallback`), the same value Baruch sent before ADMIN_API_KEY
 * existed; fetch normalizes surrounding whitespace in header values either
 * way. Whitespace-only counts as unset. If ENGINE_API_KEY is also missing
 * or blank, the result is `missing` with no key.
 */
export function resolveAdminApiKey(
  env: Pick<Env, 'ADMIN_API_KEY' | 'ENGINE_API_KEY'>
): AdminApiKey {
  const adminKey = env.ADMIN_API_KEY?.trim();
  if (adminKey) return { key: adminKey, source: 'admin' };
  const engineKey = env.ENGINE_API_KEY;
  if (engineKey?.trim()) return { key: engineKey, source: 'engine_fallback' };
  return { key: null, source: 'missing' };
}
