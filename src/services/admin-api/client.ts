/**
 * Generic HTTP client for bt-servant-worker admin API
 *
 * Wraps fetch with ENGINE_API_KEY auth and ENGINE_BASE_URL.
 */

import { AdminApiError } from '../../utils/errors.js';
import { RequestLogger } from '../../utils/logger.js';

export interface AdminApiClientConfig {
  baseUrl: string;
  apiKey: string;
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

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: bodyString,
    });

    const duration = Date.now() - startTime;

    if (!response.ok) {
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
