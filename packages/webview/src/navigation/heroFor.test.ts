import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OrgSafetyTier } from '@sandforge/shared';
import type { RecoveryProgress, SalesforceOrg } from '@sandforge/shared';

import { afterRefreshOf, heroFor } from './heroFor';

function org(
  overrides: Partial<SalesforceOrg> & Pick<SalesforceOrg, 'id' | 'alias'>,
): SalesforceOrg {
  return {
    username: `${overrides.alias.toLowerCase()}@acme.test`,
    instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
    orgId: '00Dxx0000001XyZ',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#4a9eff', icon: '', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-11-18T08:00:00.000Z',
    tags: [],
    ...overrides,
  };
}

const uat = org({ id: 'org-uat', alias: 'UAT' });
const qa = org({ id: 'org-qa', alias: 'QA' });
const prod = org({
  id: 'org-prod',
  alias: 'PROD',
  orgType: 'Production',
  safetyTier: OrgSafetyTier.CRITICAL,
  instanceUrl: 'https://acme.my.salesforce.com',
});
const prodEu = org({ ...prod, id: 'org-prod-eu', alias: 'PROD-EU' });

function refreshed(orgId: string, overrides: Partial<RecoveryProgress> = {}): RecoveryProgress {
  return {
    orgId,
    alias: orgId === 'org-uat' ? 'UAT' : 'QA',
    detectedAt: '2026-11-18T08:12:00.000Z',
    done: 3,
    total: 9,
    ...overrides,
  };
}

describe('heroFor', () => {
  it('rule 0: shows no hero until the org list is in, whatever else is known', () => {
    expect(heroFor({ orgs: undefined, selectedOrgId: null })).toEqual({ kind: 'none' });
    expect(
      heroFor({ orgs: undefined, selectedOrgId: 'org-uat', afterRefresh: [refreshed('org-uat')] }),
    ).toEqual({ kind: 'none' });
  });

  it('rule 1: with no org registered, offers to connect the first', () => {
    expect(heroFor({ orgs: [], selectedOrgId: null })).toEqual({ kind: 'firstOrg' });
  });

  describe('rule 2: a sandbox whose refresh was noticed and whose recovery is not over', () => {
    it('leads with its way back into service, n of N steps', () => {
      expect(
        heroFor({
          orgs: [uat, prod],
          selectedOrgId: 'org-prod',
          afterRefresh: [refreshed('org-uat')],
        }),
      ).toEqual({
        kind: 'afterRefresh',
        orgId: 'org-uat',
        alias: 'UAT',
        detectedAt: '2026-11-18T08:12:00.000Z',
        done: 3,
        total: 9,
      });
    });

    it('takes the selected sandbox first, though another was refreshed since', () => {
      const hero = heroFor({
        orgs: [uat, qa],
        selectedOrgId: 'org-qa',
        afterRefresh: [
          refreshed('org-uat', { detectedAt: '2026-11-18T08:12:00.000Z' }),
          refreshed('org-qa', { detectedAt: '2026-11-02T08:00:00.000Z' }),
        ],
      });
      expect(hero).toMatchObject({ kind: 'afterRefresh', orgId: 'org-qa' });
    });

    it('otherwise takes the one refreshed last', () => {
      const hero = heroFor({
        orgs: [uat, qa, prod],
        selectedOrgId: 'org-prod',
        afterRefresh: [
          refreshed('org-qa', { detectedAt: '2026-11-02T08:00:00.000Z' }),
          refreshed('org-uat', { detectedAt: '2026-11-18T08:12:00.000Z' }),
        ],
      });
      expect(hero).toMatchObject({ kind: 'afterRefresh', orgId: 'org-uat' });
    });

    it('comes before reconnecting it: a refresh often ends its session', () => {
      const expired = { ...uat, status: 'expired' as const };
      expect(
        heroFor({
          orgs: [expired],
          selectedOrgId: 'org-uat',
          afterRefresh: [refreshed('org-uat')],
        }),
      ).toMatchObject({ kind: 'afterRefresh', orgId: 'org-uat' });
    });

    it('ends once every step that applies is done, and never for an org gone or a production org', () => {
      expect(
        heroFor({
          orgs: [uat, qa],
          selectedOrgId: 'org-uat',
          afterRefresh: [refreshed('org-uat', { done: 9, total: 9 })],
        }),
      ).toEqual({ kind: 'forge' });
      expect(
        heroFor({
          orgs: [uat, qa],
          selectedOrgId: 'org-uat',
          afterRefresh: [refreshed('org-gone')],
        }),
      ).toEqual({ kind: 'forge' });
      expect(
        heroFor({
          orgs: [prod],
          selectedOrgId: 'org-prod',
          afterRefresh: [refreshed('org-prod', { alias: 'PROD' })],
        }),
      ).toMatchObject({ kind: 'addSandbox' });
    });
  });

  describe('rule 3: an org to reconnect', () => {
    it('names the selected org when its session expired or failed, before filling another', () => {
      const expired = { ...uat, status: 'expired' as const };
      expect(heroFor({ orgs: [expired, qa], selectedOrgId: 'org-uat' })).toEqual({
        kind: 'reconnect',
        orgId: 'org-uat',
        alias: 'UAT',
      });
      const failed = { ...qa, status: 'error' as const };
      expect(heroFor({ orgs: [uat, failed], selectedOrgId: 'org-qa' })).toEqual({
        kind: 'reconnect',
        orgId: 'org-qa',
        alias: 'QA',
      });
    });

    it('names an org whose session ended when every session has, none selected', () => {
      const orgs = [
        { ...prod, status: 'expired' as const },
        { ...uat, status: 'expired' as const },
      ];
      expect(heroFor({ orgs, selectedOrgId: null })).toEqual({
        kind: 'reconnect',
        orgId: 'org-prod',
        alias: 'PROD',
      });
    });
  });

  it('rule 4: with one org connected, one that may be filled, fills it with Seed', () => {
    expect(heroFor({ orgs: [uat], selectedOrgId: null })).toEqual({
      kind: 'seed',
      orgId: 'org-uat',
      alias: 'UAT',
    });
    // An org registered but not connected is not a second org to copy from.
    const expiredQa = { ...qa, status: 'expired' as const };
    expect(heroFor({ orgs: [uat, expiredQa], selectedOrgId: 'org-uat' })).toMatchObject({
      kind: 'seed',
      orgId: 'org-uat',
    });
  });

  it('rule 5: with two orgs connected, one that may be filled, copies with Forge', () => {
    expect(heroFor({ orgs: [prod, uat], selectedOrgId: 'org-prod' })).toEqual({ kind: 'forge' });
    expect(heroFor({ orgs: [uat, qa], selectedOrgId: 'org-uat' })).toEqual({ kind: 'forge' });
  });

  describe('rule 6: production orgs alone', () => {
    it('asks for the sandbox to fill, which Forge copies the production’s records into', () => {
      expect(heroFor({ orgs: [prod], selectedOrgId: 'org-prod' })).toEqual({
        kind: 'addSandbox',
        orgId: 'org-prod',
        alias: 'PROD',
      });
    });

    it('names the selected production, else the first connected', () => {
      expect(heroFor({ orgs: [prod, prodEu], selectedOrgId: 'org-prod-eu' })).toMatchObject({
        orgId: 'org-prod-eu',
      });
      expect(heroFor({ orgs: [prod, prodEu], selectedOrgId: null })).toMatchObject({
        orgId: 'org-prod',
      });
    });
  });
});

describe('afterRefreshOf', () => {
  it('reads the list the extension sends on sidebar:afterRefresh', () => {
    const list = [refreshed('org-uat'), refreshed('org-qa', { done: 0, total: 10 })];
    expect(afterRefreshOf(list)).toEqual(list);
    expect(afterRefreshOf([])).toEqual([]);
  });

  it('refuses anything else whole, so the launcher keeps what it had', () => {
    expect(afterRefreshOf(undefined)).toBeUndefined();
    expect(afterRefreshOf({ orgId: 'org-uat' })).toBeUndefined();
    expect(afterRefreshOf([refreshed('org-uat'), { orgId: 'org-qa' }])).toBeUndefined();
    expect(afterRefreshOf([refreshed('org-uat', { done: -1 })])).toBeUndefined();
    expect(afterRefreshOf([refreshed('org-uat', { total: 2.5 })])).toBeUndefined();
    expect(afterRefreshOf([{ ...refreshed('org-uat'), alias: 3 }])).toBeUndefined();
  });

  it('keeps no more than the fields it reads', () => {
    expect(afterRefreshOf([{ ...refreshed('org-uat'), token: 'x' }])).toEqual([
      refreshed('org-uat'),
    ]);
  });
});

describe('the file the launcher bundles', () => {
  it('reads with neither zod nor a store: the launcher’s bundle carries neither', () => {
    const source = readFileSync(join(__dirname, 'heroFor.ts'), 'utf8');
    const imports = [...source.matchAll(/^import (type )?[^;]*?from '([^']+)';/gm)]
      .filter(([, typeOnly]) => typeOnly === undefined)
      .map(([, , from]) => from);
    expect(imports.filter((from) => from === 'zod' || from.includes('stores/'))).toEqual([]);
  });
});
