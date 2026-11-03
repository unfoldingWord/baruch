/**
 * Generic HTTP client for bt-servant-worker admin API
 *
 * Wraps fetch with admin API key auth (see src/config/admin-api-key.ts) and
 * ENGINE_BASE_URL.
 */

import {
  logAdminApiKeySourceOnce,
  type AdminApiKey,
  type AdminApiKeySource,
} from '../../config/admin-api-key.js';
import { AdminApiError } from '../../utils/errors.js';
import { RequestLogger } from '../../utils/logger.js';

export interface AdminApiClientConfig {
  baseUrl: string;
  /** From resolveAdminApiKey(env) in src/config/admin-api-key.ts. */
  apiKey: AdminApiKey;
  logger: RequestLogger;
}

function extractBodyKeys(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return [];
  return Object.keys(body as Record<string, unknown>);
}

/**
 * Encode a value as a URL path segment, rejecting nullish/non-string values at the
 * call site. Prevents `${undefined}` from being stringified into a request URL
 * (the original demo-incident symptom) without making "null" or "undefined" into
 * reserved slug names at the URL layer.
 */
export function encodePathParam(value: unknown, paramName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AdminApiError(
      `Admin API path parameter "${paramName}" must be a non-empty string (got ${value === undefined ? 'undefined' : value === null ? 'null' : typeof value})`,
      400
    );
  }
  return encodeURIComponent(value);
}

interface RequestContext {
  method: string;
  path: string;
  logger: RequestLogger;
  keySource: AdminApiKeySource;
}

function handleNonOkResponse(
  status: number,
  errorBody: string,
  duration: number,
  ctx: RequestContext
): never {
  const { method, path, logger, keySource } = ctx;
  logger.error('admin_api_error', new Error(errorBody), {
    method,
    path,
    status,
    key_source: keySource,
    duration_ms: duration,
    response_body: errorBody.slice(0, 1024),
  });
  throw new AdminApiError(`Admin API ${method} ${path} returned ${status}: ${errorBody}`, status);
}

/**
 * The key to send, or a clean failure when neither ADMIN_API_KEY nor
 * ENGINE_API_KEY is configured (never send "Bearer undefined"). The 401 is
 * what the worker returns for a missing bearer, so the orchestrator treats
 * it as a deterministic failure and does not retry it.
 */
function requireKey(apiKey: AdminApiKey, method: string, path: string, logger: RequestLogger) {
  if (apiKey.key === null) {
    logger.error(
      'admin_api_key_missing',
      new Error('Neither ADMIN_API_KEY nor ENGINE_API_KEY is set'),
      {
        method,
        path,
      }
    );
    throw new AdminApiError('Admin API key is not configured for Baruch', 401);
  }
  logAdminApiKeySourceOnce(logger, apiKey.source);
  return { key: apiKey.key, source: apiKey.source };
}

export class AdminApiClient {
  constructor(private config: AdminApiClientConfig) {}

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const startTime = Date.now();
    const bodyString = body !== undefined ? JSON.stringify(body) : null;

    this.config.logger.log('admin_api_request', {
      method,
      path,
      body_keys: extractBodyKeys(body),
      body_size_bytes: bodyString?.length ?? 0,
    });

    const { key, source } = requireKey(this.config.apiKey, method, path, this.config.logger);

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: bodyString,
    });

    const duration = Date.now() - startTime;

    if (!response.ok) {
      const errorBody = await response.text();
      return handleNonOkResponse(response.status, errorBody, duration, {
        method,
        path,
        logger: this.config.logger,
        keySource: source,
      });
    }

    this.config.logger.log('admin_api_response', {
      method,
      path,
      status: response.status,
      duration_ms: duration,
    });

    return (await response.json()) as T;
  }
}
