/**
 * Admin API client functions for mode management
 */

import { AdminApiClient } from './client.js';

export async function listModes(client: AdminApiClient, org: string): Promise<unknown> {
  return client.get(`/api/v1/admin/orgs/${encodeURIComponent(org)}/modes`);
}

export async function getMode(client: AdminApiClient, org: string, name: string): Promise<unknown> {
  return client.get(
    `/api/v1/admin/orgs/${encodeURIComponent(org)}/modes/${encodeURIComponent(name)}`
  );
}

export async function createOrUpdateMode(
  client: AdminApiClient,
  org: string,
  name: string,
  body: unknown
): Promise<unknown> {
  return client.put(
    `/api/v1/admin/orgs/${encodeURIComponent(org)}/modes/${encodeURIComponent(name)}`,
    body
  );
}

export async function deleteMode(
  client: AdminApiClient,
  org: string,
  name: string
): Promise<unknown> {
  return client.delete(
    `/api/v1/admin/orgs/${encodeURIComponent(org)}/modes/${encodeURIComponent(name)}`
  );
}
