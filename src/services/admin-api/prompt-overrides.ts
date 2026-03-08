/**
 * Admin API client functions for prompt overrides
 */

import { AdminApiClient } from './client.js';

export async function getPromptOverrides(client: AdminApiClient, org: string): Promise<unknown> {
  return client.get(`/api/v1/admin/orgs/${encodeURIComponent(org)}/prompt-overrides`);
}

export async function setPromptOverrides(
  client: AdminApiClient,
  org: string,
  overrides: Record<string, string | null>
): Promise<unknown> {
  return client.put(`/api/v1/admin/orgs/${encodeURIComponent(org)}/prompt-overrides`, overrides);
}
