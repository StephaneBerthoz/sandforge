import { describe, expect, it } from 'vitest';
import type { SalesforceOrg } from '@sandforge/shared';
import { canFill, orgToFill } from './orgToFill';

const org = (
  id: string,
  orgType: SalesforceOrg['orgType'],
  status: SalesforceOrg['status'] = 'connected',
  edition?: string,
) => ({ id, orgType, status, metadata: edition ? { edition } : undefined });

describe('orgToFill', () => {
  it('fills the selected org when it is a sandbox, a scratch org or a Developer Edition', () => {
    const orgs = [org('a', 'Sandbox'), org('b', 'Scratch')];
    expect(orgToFill(orgs, 'b')?.id).toBe('b');
  });

  it('fills the first org to fill when the selected one is a production org', () => {
    const orgs = [org('prod', 'Production'), org('dev', 'Developer')];
    expect(orgToFill(orgs, 'prod')?.id).toBe('dev');
  });

  it('reads a Developer Edition stored as a production org as the development org it is', () => {
    const orgs = [org('de', 'Production', 'connected', 'Developer Edition')];
    expect(orgToFill(orgs, null)?.id).toBe('de');
  });

  it('offers no org when every connected org is a production org, or none is connected', () => {
    expect(orgToFill([org('prod', 'Production')], 'prod')).toBeUndefined();
    expect(orgToFill([org('sbx', 'Sandbox', 'expired')], 'sbx')).toBeUndefined();
    expect(orgToFill([], null)).toBeUndefined();
  });

  it('never fills an org that is not connected', () => {
    expect(canFill(org('sbx', 'Sandbox', 'error'))).toBe(false);
    expect(canFill(org('sbx', 'Sandbox'))).toBe(true);
  });
});
