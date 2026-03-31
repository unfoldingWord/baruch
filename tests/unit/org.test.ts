import { describe, it, expect } from 'vitest';
import { resolveOrgFromBody, resolveOrgFromParams } from '../../src/utils/org.js';

describe('resolveOrgFromBody', () => {
  const defaultOrg = 'default-org';

  it('returns org when provided', () => {
    expect(resolveOrgFromBody({ org: 'my-org' }, defaultOrg)).toBe('my-org');
  });

  it('falls back to org_id when org is missing', () => {
    expect(resolveOrgFromBody({ org_id: 'id-org' }, defaultOrg)).toBe('id-org');
  });

  it('prefers org over org_id', () => {
    expect(resolveOrgFromBody({ org: 'org', org_id: 'id' }, defaultOrg)).toBe('org');
  });

  it('returns default when neither is provided', () => {
    expect(resolveOrgFromBody({}, defaultOrg)).toBe('default-org');
  });

  it('falls back to default when org is empty string', () => {
    expect(resolveOrgFromBody({ org: '' }, defaultOrg)).toBe('default-org');
  });

  it('falls back to org_id when org is empty string', () => {
    expect(resolveOrgFromBody({ org: '', org_id: 'id-org' }, defaultOrg)).toBe('id-org');
  });

  it('falls back to default when both are empty strings', () => {
    expect(resolveOrgFromBody({ org: '', org_id: '' }, defaultOrg)).toBe('default-org');
  });
});

describe('resolveOrgFromParams', () => {
  const defaultOrg = 'default-org';

  it('returns org param when set', () => {
    const params = new URLSearchParams('org=my-org');
    expect(resolveOrgFromParams(params, defaultOrg)).toBe('my-org');
  });

  it('falls back to org_id param', () => {
    const params = new URLSearchParams('org_id=id-org');
    expect(resolveOrgFromParams(params, defaultOrg)).toBe('id-org');
  });

  it('prefers org over org_id', () => {
    const params = new URLSearchParams('org=org&org_id=id');
    expect(resolveOrgFromParams(params, defaultOrg)).toBe('org');
  });

  it('returns default when no params set', () => {
    const params = new URLSearchParams();
    expect(resolveOrgFromParams(params, defaultOrg)).toBe('default-org');
  });

  it('falls back to default when org param is empty string', () => {
    const params = new URLSearchParams('org=');
    expect(resolveOrgFromParams(params, defaultOrg)).toBe('default-org');
  });
});
