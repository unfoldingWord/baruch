export function resolveOrgFromBody(
  body: { org?: string; org_id?: string },
  defaultOrg: string
): string {
  return body.org ?? body.org_id ?? defaultOrg;
}

export function resolveOrgFromParams(params: URLSearchParams, defaultOrg: string): string {
  return params.get('org') ?? params.get('org_id') ?? defaultOrg;
}
