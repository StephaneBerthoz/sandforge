import { describe, expect, it } from 'vitest';
import {
  hostIsMyDomain,
  isScratchHost,
  myDomainHostOf,
  refreshedSince,
  sandboxMyDomainOf,
} from './orgHost.js';

/*
 * The host an org answers on, and what it says of the org: the My Domain an
 * environment lists a sandbox by, and the proof that a state kept under
 * another Organization Id is of the same sandbox, refreshed since.
 */

const ORG = '00Dxx0000001234EAA';
const OTHER = '00Dxx0000005678EAA';

const SANDBOX_HOST = 'acme--uat.sandbox.my.salesforce.com';

describe('the host an org answers on', () => {
  it('is its My Domain’s, lower-cased, whatever the URL adds to it', () => {
    expect(myDomainHostOf('https://Acme--UAT.sandbox.my.salesforce.com/')).toBe(SANDBOX_HOST);
    expect(myDomainHostOf('https://acme--uat.sandbox.my.salesforce.com:443/services')).toBe(
      SANDBOX_HOST,
    );
    expect(myDomainHostOf('https://acme.my.salesforce.com')).toBe('acme.my.salesforce.com');
  });

  it('is none for a pod’s host, which many orgs share, nor for what is no URL', () => {
    expect(myDomainHostOf('https://cs42.salesforce.com')).toBeUndefined();
    expect(myDomainHostOf('https://acme--uat.sandbox.lightning.force.com')).toBeUndefined();
    expect(myDomainHostOf('https://my.salesforce.com')).toBeUndefined();
    expect(myDomainHostOf('not a url')).toBeUndefined();
    expect(myDomainHostOf('')).toBeUndefined();
    expect(myDomainHostOf(undefined)).toBeUndefined();
  });
});

describe('the My Domain of a sandbox, as its host says it', () => {
  it('is the host’s first label, with enhanced domains, before them on an instance, and with neither', () => {
    expect(sandboxMyDomainOf(SANDBOX_HOST)).toBe('acme--uat');
    expect(sandboxMyDomainOf('acme--uat.cs42.my.salesforce.com')).toBe('acme--uat');
    expect(sandboxMyDomainOf('acme--uat.my.salesforce.com')).toBe('acme--uat');
    expect(sandboxMyDomainOf('north-acme--qa2.sandbox.my.salesforce.com')).toBe('north-acme--qa2');
  });

  it('is never a scratch org’s, a production org’s or a Developer Edition org’s host', () => {
    expect(sandboxMyDomainOf('acme--uat.scratch.my.salesforce.com')).toBeUndefined();
    expect(sandboxMyDomainOf('example-target.scratch.my.salesforce.com')).toBeUndefined();
    expect(sandboxMyDomainOf('acme.my.salesforce.com')).toBeUndefined();
    expect(sandboxMyDomainOf('acme-dev-ed.develop.my.salesforce.com')).toBeUndefined();
  });

  it('is none for a host of another shape, or none at all', () => {
    expect(sandboxMyDomainOf('acme--uat.a.b.my.salesforce.com')).toBeUndefined();
    expect(sandboxMyDomainOf('acme--uat.sandbox.lightning.force.com')).toBeUndefined();
    expect(sandboxMyDomainOf('cs42.salesforce.com')).toBeUndefined();
    expect(sandboxMyDomainOf(undefined)).toBeUndefined();
  });

  it('tells a scratch org’s host by its scratch label', () => {
    expect(isScratchHost('example-target.scratch.my.salesforce.com')).toBe(true);
    expect(isScratchHost('acme--uat.scratch.my.salesforce.com')).toBe(true);
    expect(isScratchHost(SANDBOX_HOST)).toBe(false);
    expect(isScratchHost(undefined)).toBe(false);
  });
});

describe('an org protected by its My Domain', () => {
  it('is any org on a host of that My Domain, whatever its kind of host', () => {
    expect(hostIsMyDomain(SANDBOX_HOST, 'acme--uat')).toBe(true);
    expect(hostIsMyDomain('acme--uat.cs42.my.salesforce.com', 'acme--uat')).toBe(true);
    expect(hostIsMyDomain('acme--uat.scratch.my.salesforce.com', 'acme--uat')).toBe(true);
  });

  it('is no other My Domain’s, no longer one that starts the same, and no host it cannot read', () => {
    expect(hostIsMyDomain('acme--uat2.sandbox.my.salesforce.com', 'acme--uat')).toBe(false);
    expect(hostIsMyDomain('acme--qa.sandbox.my.salesforce.com', 'acme--uat')).toBe(false);
    expect(hostIsMyDomain('acme--uat.sandbox.lightning.force.com', 'acme--uat')).toBe(false);
    expect(hostIsMyDomain(undefined, 'acme--uat')).toBe(false);
  });
});

describe('a state kept under another Organization Id, as proof of a refresh', () => {
  const kept = {
    organizationId: OTHER,
    kind: 'sandbox' as const,
    username: 'test-user@example.com.uat',
    host: SANDBOX_HOST,
  };
  const target = { organizationId: ORG, kind: 'sandbox' as const, host: SANDBOX_HOST };

  it('proves the sandbox was refreshed when its host is the same and its Id another', () => {
    expect(refreshedSince(kept, target)).toBe(true);
    expect(refreshedSince({ ...kept, host: 'ACME--UAT.sandbox.my.salesforce.com' }, target)).toBe(
      true,
    );
  });

  it('proves nothing of the same Id, in either form, nor of another host', () => {
    expect(refreshedSince({ ...kept, organizationId: ORG.slice(0, 15) }, target)).toBe(false);
    expect(refreshedSince({ ...kept, host: 'acme--qa.sandbox.my.salesforce.com' }, target)).toBe(
      false,
    );
    // Enhanced domains turned on between the two: another host, no proof.
    expect(refreshedSince({ ...kept, host: 'acme--uat.cs42.my.salesforce.com' }, target)).toBe(
      false,
    );
  });

  it('proves nothing from a state written before 1.82, which kept no host', () => {
    const before = { organizationId: OTHER, kind: 'sandbox' as const, username: kept.username };

    expect(refreshedSince(before, target)).toBe(false);
    expect(refreshedSince(kept, { organizationId: ORG, kind: 'sandbox' })).toBe(false);
  });

  it('proves nothing of a scratch org, a Developer Edition org or a host that is no sandbox’s', () => {
    const scratchHost = 'acme--uat.scratch.my.salesforce.com';

    expect(refreshedSince({ ...kept, kind: 'scratch' }, target)).toBe(false);
    expect(refreshedSince(kept, { ...target, kind: 'scratch' })).toBe(false);
    expect(refreshedSince({ ...kept, kind: 'developer' }, { ...target, kind: 'developer' })).toBe(
      false,
    );
    expect(refreshedSince({ ...kept, host: scratchHost }, { ...target, host: scratchHost })).toBe(
      false,
    );
    expect(
      refreshedSince(
        { ...kept, host: 'acme.my.salesforce.com' },
        { ...target, host: 'acme.my.salesforce.com' },
      ),
    ).toBe(false);
  });
});
