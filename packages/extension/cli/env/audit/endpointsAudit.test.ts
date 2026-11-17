import { describe, expect, it } from 'vitest';
import { envAuditResultSchema } from '@sandforge/shared';
import { AuditOrg } from './auditOrg.js';
import { fakeAuditOrg, sfError, type FakeAuditOrgInit } from './auditFakeOrg.js';
import {
  auditUrlOf,
  endpointsRequestsOf,
  fieldsByObject,
  productionHostsOf,
  readEndpoints,
} from './endpointsAudit.js';

const SANDBOX = 'acme--uat.sandbox.my.salesforce.com';

/** A copy of production: its endpoints point where production's did. */
function world(over: Partial<FakeAuditOrgInit> = {}): FakeAuditOrgInit {
  return {
    tooling: {
      NamedCredential: {
        columns: ['DeveloperName', 'Endpoint', 'PrincipalType'],
        rows: [
          {
            DeveloperName: 'ERP_API',
            Endpoint: 'https://erp.acme.com/api',
            PrincipalType: 'NamedUser',
          },
          {
            DeveloperName: 'Prod_Login',
            Endpoint: 'https://login.salesforce.com',
            PrincipalType: 'Anonymous',
          },
          {
            DeveloperName: 'Mock',
            Endpoint: 'https://mock.example.org/v1',
            PrincipalType: 'Anonymous',
          },
          { DeveloperName: 'No_Endpoint', Endpoint: null, PrincipalType: 'Anonymous' },
        ],
      },
      RemoteProxy: {
        columns: ['SiteName', 'EndpointUrl', 'IsActive'],
        rows: [
          { SiteName: 'ApexDevNet', EndpointUrl: 'http://www.apexdevnet.com', IsActive: true },
          { SiteName: 'SF_Prod', EndpointUrl: 'https://acme.my.salesforce.com', IsActive: true },
          {
            SiteName: 'Old_Prod',
            EndpointUrl: 'https://acme.lightning.force.com',
            IsActive: false,
          },
        ],
      },
    },
    data: {
      Integration_Setting__mdt: {
        columns: ['DeveloperName', 'Endpoint__c', 'Token_Url__c'],
        rows: [
          {
            DeveloperName: 'ERP',
            Endpoint__c: 'https://svc:s3cret-pass@erp.acme.com:8443/api/v2?key=abc123#frag-token',
            Token_Url__c: 'https://login.salesforce.com/services/oauth2/token?client_secret=xyz789',
          },
          {
            DeveloperName: 'Sandbox',
            Endpoint__c: 'https://erp-test.acme.com/api',
            Token_Url__c: null,
          },
          {
            DeveloperName: 'Bare',
            Endpoint__c: 'erp.acme.com/api?key=bare456',
            Token_Url__c: null,
          },
        ],
      },
    },
    ...over,
  };
}

async function audit(
  init: FakeAuditOrgInit,
  input: Parameters<typeof readEndpoints>[1],
): Promise<{ endpoints: Awaited<ReturnType<typeof readEndpoints>>; requests: number }> {
  const { transport } = fakeAuditOrg(init);
  const org = new AuditOrg(transport);
  const endpoints = await readEndpoints(org, input);
  return { endpoints, requests: org.requests };
}

describe("production's hosts", () => {
  it('are deduced from a sandbox’s host of the form <domain>--<sandbox>.sandbox.my.salesforce.com, then login and the file’s', () => {
    expect(productionHostsOf(SANDBOX, ['erp.acme.com'])).toEqual({
      hosts: [
        { host: 'acme.my.salesforce.com', why: 'myDomain' },
        { host: 'acme.lightning.force.com', why: 'lightning' },
        { host: 'acme.my.site.com', why: 'site' },
        { host: 'login.salesforce.com', why: 'login' },
        { host: 'erp.acme.com', why: 'listed' },
      ],
    });
    expect(productionHostsOf('acme-corp--qa1.sandbox.my.salesforce.com').hosts[0]?.host).toBe(
      'acme-corp.my.salesforce.com',
    );
  });

  it('are not deduced from any other host, and the answer says so', () => {
    for (const host of [
      'power-ruby-1234-dev-ed.scratch.my.salesforce.com',
      'acme-dev-ed.develop.my.salesforce.com',
      'acme--uat.cs42.my.salesforce.com',
      'acme.my.salesforce.com',
      'acme--uat.sandbox.my.salesforce.com.evil.example',
    ]) {
      const deduced = productionHostsOf(host, ['erp.acme.com']);
      expect(deduced.hosts.map((one) => one.why)).toEqual(['login', 'listed']);
      expect(deduced.notDeduced).toBe(
        `${host} is no sandbox's host of the form <domain>--<sandbox>.sandbox.my.salesforce.com: ` +
          "production's own hosts are not deduced",
      );
    }
    expect(productionHostsOf(undefined).notDeduced).toMatch(/^the org's host is not known/);
  });
});

describe('a URL as an audit names it', () => {
  it('is its scheme, its host, its port and its path: never its query, its fragment nor its credentials', () => {
    expect(
      auditUrlOf('https://svc:s3cret-pass@erp.acme.com:8443/api/v2?key=abc123#frag-token'),
    ).toEqual({
      url: 'https://erp.acme.com:8443/api/v2',
      host: 'erp.acme.com',
    });
    expect(auditUrlOf('https://LOGIN.salesforce.com.')).toEqual({
      url: 'https://login.salesforce.com/',
      host: 'login.salesforce.com',
    });
  });

  it('is nothing for a value that does not read as a URL with a host, which is never named', () => {
    expect(auditUrlOf('erp.acme.com/api?key=bare456')).toBeUndefined();
    expect(auditUrlOf('callout:ERP_API/orders')).toBeUndefined();
    expect(auditUrlOf('https://[::1]/x')).toBeUndefined();
  });
});

describe('the endpoints audit', () => {
  it('finds the Named Credentials, Remote Sites and fields that name production, and why', async () => {
    const { endpoints } = await audit(world(), {
      host: SANDBOX,
      productionHosts: ['erp.acme.com'],
      fields: ['Integration_Setting__mdt.Endpoint__c', 'integration_setting__mdt.token_url__c'],
    });
    expect(endpoints.found).toEqual([
      {
        source: 'namedCredential',
        name: 'ERP_API',
        url: 'https://erp.acme.com/api',
        host: 'erp.acme.com',
        why: 'listed',
      },
      {
        source: 'namedCredential',
        name: 'Prod_Login',
        url: 'https://login.salesforce.com/',
        host: 'login.salesforce.com',
        why: 'login',
      },
      {
        source: 'remoteSite',
        name: 'SF_Prod',
        url: 'https://acme.my.salesforce.com/',
        host: 'acme.my.salesforce.com',
        why: 'myDomain',
      },
      {
        source: 'field',
        name: 'Integration_Setting__mdt.ERP.Endpoint__c',
        url: 'https://erp.acme.com:8443/api/v2',
        host: 'erp.acme.com',
        why: 'listed',
      },
      {
        source: 'field',
        name: 'Integration_Setting__mdt.ERP.token_url__c',
        url: 'https://login.salesforce.com/services/oauth2/token',
        host: 'login.salesforce.com',
        why: 'login',
      },
    ]);
    expect(endpoints.unread).toBeUndefined();
    expect(endpoints.notDeduced).toBeUndefined();
  });

  it('never answers a query, a fragment or a credential an endpoint holds', async () => {
    const { endpoints } = await audit(world(), {
      host: SANDBOX,
      productionHosts: ['erp.acme.com'],
      fields: ['Integration_Setting__mdt.Endpoint__c', 'Integration_Setting__mdt.Token_Url__c'],
    });
    const said = JSON.stringify(endpoints);
    for (const secret of [
      'abc123',
      'frag-token',
      's3cret-pass',
      'svc:',
      'xyz789',
      'bare456',
      '?',
      '#',
    ]) {
      expect(said).not.toContain(secret);
    }
  });

  it('names no Remote Site that is not active, nor a host production does not have', async () => {
    const { endpoints } = await audit(world(), { host: SANDBOX });
    expect(endpoints.found.map((one) => one.name)).toEqual(['Prod_Login', 'SF_Prod']);
  });

  it('costs two requests, and one for each object the file’s fields are of', async () => {
    const fields = [
      'Integration_Setting__mdt.Endpoint__c',
      'INTEGRATION_SETTING__MDT.Token_Url__c',
    ];
    expect(endpointsRequestsOf(fields)).toBe(3);
    expect(fieldsByObject(fields)).toEqual([
      { object: 'Integration_Setting__mdt', fields: ['Endpoint__c', 'Token_Url__c'] },
    ]);
    const { requests } = await audit(world(), { host: SANDBOX, fields });
    expect(requests).toBe(3);
  });

  it('reads the other parts when the org refuses one, and says which and why', async () => {
    const { endpoints } = await audit(
      world({
        refuse: {
          NamedCredential: sfError('INSUFFICIENT_ACCESS', 'Customize Application is required.'),
        },
      }),
      { host: SANDBOX, fields: ['Missing__mdt.Url__c', 'Integration_Setting__mdt.Endpoint__c'] },
    );
    expect(endpoints.found.map((one) => one.name)).toEqual(['SF_Prod']);
    expect(endpoints.unread).toBe(
      'Named Credentials: the org refused it: INSUFFICIENT_ACCESS: Customize Application is ' +
        "required.; Missing__mdt: the org refused it: INVALID_TYPE: sObject type 'Missing__mdt' " +
        'is not supported.',
    );
  });

  it('is not read at all when the org refuses everything, and never throws', async () => {
    const { endpoints } = await audit(
      {},
      { host: SANDBOX, fields: ['Integration_Setting__mdt.Endpoint__c'] },
    );
    expect(endpoints.found).toEqual([]);
    expect(endpoints.unread).toMatch(
      /^Named Credentials: .*; Remote Sites: .*; Integration_Setting__mdt: /,
    );
  });

  it('answers what the audit’s answer holds, deduced or not', async () => {
    for (const host of [SANDBOX, 'x-dev-ed.scratch.my.salesforce.com']) {
      const { endpoints } = await audit(world(), { host, productionHosts: ['erp.acme.com'] });
      const result = {
        org: { organizationId: '00Dxx0000002AbCEAU', kind: 'sandbox', host },
        at: '2026-11-20T08:14:49.000Z',
        apiRequests: 2,
        endpoints,
        findings: endpoints.found.length,
      };
      expect(envAuditResultSchema.safeParse(result).success).toBe(true);
    }
  });
});
