/**
 * Admin API client functions for mode management
 */

import { AdminApiClient, encodePathParam } from './client.js';

export async function listModes(client: AdminApiClient, org: string): Promise<unknown> {
  return client.get(`/api/v1/admin/orgs/${encodePathParam(org, 'org')}/modes`);
}

export async function getMode(client: AdminApiClient, org: string, name: string): Promise<unknown> {
  return client.get(
    `/api/v1/admin/orgs/${encodePathParam(org, 'org')}/modes/${encodePathParam(name, 'name')}`
  );
}

export async function createOrUpdateMode(
  client: AdminApiClient,
  org: string,
  name: string,
  body: unknown
): Promise<unknown> {
  return client.put(
    `/api/v1/admin/orgs/${encodePathParam(org, 'org')}/modes/${encodePathParam(name, 'name')}`,
    body
  );
}

export async function deleteMode(
  client: AdminApiClient,
  org: string,
  name: string
): Promise<unknown> {
  return client.delete(
    `/api/v1/admin/orgs/${encodePathParam(org, 'org')}/modes/${encodePathParam(name, 'name')}`
  );
}
