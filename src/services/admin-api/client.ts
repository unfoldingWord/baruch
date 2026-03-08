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

    this.config.logger.log('admin_api_request', { method, path });

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : null,
    });

    const duration = Date.now() - startTime;

    if (!response.ok) {
      const errorBody = await response.text();
      this.config.logger.error('admin_api_error', new Error(errorBody), {
        method,
        path,
        status: response.status,
        duration_ms: duration,
      });
      throw new AdminApiError(
        `Admin API ${method} ${path} returned ${response.status}: ${errorBody}`,
        response.status
      );
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
