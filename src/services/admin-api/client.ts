/**
 * Generic HTTP client for bt-servant-worker admin API
 *
 * Wraps fetch with admin API key auth (see src/config/admin-api-key.ts) and
 * ENGINE_BASE_URL.
 */

import type { AdminApiKey, AdminApiKeySource } from '../../config/admin-api-key.js';
import { AdminApiError } from '../../utils/errors.js';
import { RequestLogger } from '../../utils/logger.js';

export interface AdminApiClientConfig {
  baseUrl: string;
  /** From resolveAdminApiKey(env) in src/config/admin-api-key.ts. */
  apiKey: AdminApiKey;
  logger: RequestLogger;
}

// The key source is logged on the first admin API call in each isolate:
// enough to show which key admin calls use without repeating it per call.
let keySourceLogged = false;

function logKeySourceOnce(logger: RequestLogger, source: AdminApiKeySource): void {
  if (keySourceLogged) return;
  keySourceLogged = true;
  if (source === 'admin') {
    logger.info('admin_api_key_source', { key_source: source });
  } else {
    logger.warn('admin_api_key_source', { key_source: source });
  }
}

/** 401/403 from the worker: log which key was rejected (source only, never the value). */
function logKeyRejected(
  logger: RequestLogger,
  source: AdminApiKeySource,
  response: Response,
  method: string,
  path: string
): void {
  if (response.status !== 401 && response.status !== 403) return;
  logger.warn('admin_api_key_rejected', {
    key_source: source,
    status: response.status,
    method,
    path,
  });
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

async function handleNonOkResponse(
  response: Response,
  method: string,
  path: string,
  duration: number,
  logger: RequestLogger
): Promise<never> {
  const errorBody = await response.text();
  logger.error('admin_api_error', new Error(errorBody), {
    method,
    path,
    status: response.status,
    duration_ms: duration,
    response_body: errorBody.slice(0, 1024),
  });
  throw new AdminApiError(
    `Admin API ${method} ${path} returned ${response.status}: ${errorBody}`,
    response.status
  );
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

    const { key, source } = this.config.apiKey;
    logKeySourceOnce(this.config.logger, source);

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
      logKeyRejected(this.config.logger, source, response, method, path);
      return handleNonOkResponse(response, method, path, duration, this.config.logger);
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
