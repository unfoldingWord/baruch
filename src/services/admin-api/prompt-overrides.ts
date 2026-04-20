/**
 * Admin API client functions for prompt overrides
 */

import { AdminApiClient, encodePathParam } from './client.js';

export async function getPromptOverrides(client: AdminApiClient, org: string): Promise<unknown> {
  return client.get(`/api/v1/admin/orgs/${encodePathParam(org, 'org')}/prompt-overrides`);
}

export async function setPromptOverrides(
  client: AdminApiClient,
  org: string,
  overrides: Record<string, string | null>
): Promise<unknown> {
  return client.put(
    `/api/v1/admin/orgs/${encodePathParam(org, 'org')}/prompt-overrides`,
    overrides
  );
}
