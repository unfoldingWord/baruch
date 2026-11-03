/**
 * Picks the bearer key for bt-servant-worker's admin API.
 */

import { RequestLogger } from '../utils/logger.js';
import { Env } from './types.js';

export type AdminApiKeySource = 'admin' | 'engine_fallback';

// Log the key source once per isolate: enough to show in the logs which key
// admin calls use, without repeating it on every request.
let sourceLogged = false;

/** Test hook: re-arm the once-per-isolate key-source log. */
export function resetAdminApiKeyLogForTests(): void {
  sourceLogged = false;
}

/**
 * The trimmed ADMIN_API_KEY when it is set and non-blank; otherwise
 * ENGINE_API_KEY, so a deploy without the new secret keeps working.
 * Whitespace-only counts as unset. Logs the key source (`admin` or
 * `engine_fallback`) once per isolate, never the key value.
 */
export function resolveAdminApiKey(
  env: Pick<Env, 'ADMIN_API_KEY' | 'ENGINE_API_KEY'>,
  logger?: RequestLogger
): string {
  const adminKey = env.ADMIN_API_KEY?.trim();
  const source: AdminApiKeySource = adminKey ? 'admin' : 'engine_fallback';
  if (logger && !sourceLogged) {
    sourceLogged = true;
    if (source === 'admin') {
      logger.info('admin_api_key_source', { key_source: source });
    } else {
      logger.warn('admin_api_key_source', { key_source: source });
    }
  }
  return adminKey ? adminKey : env.ENGINE_API_KEY;
}
