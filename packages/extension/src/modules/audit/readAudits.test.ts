import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envAuditResultSchema, type EnvAudits } from '@sandforge/shared';
import { fakeAuditOrg, sfError, type FakeAuditOrgInit, type FakeAuditRow } from './auditFakeOrg.js';
import { saveInventory } from './auditStore.js';
import {
  auditRequestsOf,
  auditsAskedOf,
  findingsOf,
  readAudits,
  type AuditOrgInput,
  type AuditsAsked,
} from './readAudits.js';

/*
 * The audits of an org as the command line and the panel both read them: the
 * deliverability, the scheduled jobs against the inventory kept before a
 * refresh, and the endpoints that still name production. Read through the
 * org in miniature, which answers as the org does.
 */

const HOST = 'acme--uat.sandbox.my.salesforce.com';
const BEFORE = '00Dxx0000001gPLEAY';
const AFTER = '00Dxx0000002AbCEAU';
const ADMIN = '005xx0000001AAAAAA';
const OPS = '005xx0000002AAAAAA';
const AT = new Date('2026-11-20T08:14:49.000Z');

/** Every audit, a production host and a field beside. */
const AUDITS: EnvAudits = {
  schedules: true,
  endpoints: {
    productionHosts: ['erp.acme.com'],
    fields: ['Integration_Setting__mdt.Endpoint__c'],
  },
  handoff: true,
};

const EVERY: AuditsAsked = {
  deliverability: true,
  schedules: true,
  endpoints: {
    productionHosts: ['erp.acme.com'],
    fields: ['Integration_Setting__mdt.Endpoint__c'],
  },
};

const UAT: AuditOrgInput = { organizationId: AFTER, kind: 'sandbox', alias: 'uat', host: HOST };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function journal(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-read-audits-'));
  made.push(dir);
  return dir;
}

function trigger(name: string, over: Partial<FakeAuditRow> = {}): FakeAuditRow {
  return {
    'CronJobDetail.Name': name,
    'CronJobDetail.JobType': '7',
    CronExpression: '0 0 3 * * ?',
    State: 'WAITING',
    NextFireTime: '2026-11-21T03:00:00.000+0000',
    PreviousFireTime: null,
    OwnerId: ADMIN,
    ...over,
  };
}

/** The uat sandbox the morning after its refresh. */
function uat(over: Partial<FakeAuditOrgInit> = {}): FakeAuditOrgInit {
  return {
    deliverability: 'closed',
    data: {
      CronTrigger: {
        columns: [
          'CronJobDetail.Name',
          'CronJobDetail.JobType',
          'CronExpression',
          'State',
          'NextFireTime',
          'PreviousFireTime',
          'OwnerId',
        ],
        rows: [
          trigger('Weekly digest', { NextFireTime: '2026-11-21T06:00:00.000+0000', OwnerId: OPS }),
          trigger('Data cleanup', { 'CronJobDetail.JobType': '9' }),
          trigger('Kept one'),
          trigger('Kept two'),
          trigger('Kept three'),
        ],
      },
      User: {
        columns: ['Id', 'Username', 'IsActive', 'Email'],
        rows: [
          { Id: ADMIN, Username: 'admin@acme.com.uat', IsActive: true, Email: 'a@acme.com' },
          { Id: OPS, Username: 'ops.batch@acme.com.uat', IsActive: true, Email: 'o@acme.com' },
        ],
      },
      UserLogin: {
        columns: ['UserId', 'IsFrozen'],
        rows: [
          { UserId: ADMIN, IsFrozen: false },
          { UserId: OPS, IsFrozen: true },
        ],
      },
      Integration_Setting__mdt: {
        columns: ['DeveloperName', 'Endpoint__c'],
        rows: [{ DeveloperName: 'ERP', Endpoint__c: 'https://erp.acme.com/api/v2?key=abc123' }],
      },
    },
    tooling: {
      NamedCredential: {
        columns: ['DeveloperName', 'Endpoint', 'PrincipalType'],
        rows: [
          {
            DeveloperName: 'ERP_API',
            Endpoint: 'https://erp.acme.com/api',
            PrincipalType: 'NamedUser',
          },
        ],
      },
      RemoteProxy: {
        columns: ['SiteName', 'EndpointUrl', 'IsActive'],
        rows: [
          { SiteName: 'SF_Prod', EndpointUrl: 'https://acme.my.salesforce.com/', IsActive: true },
        ],
      },
    },
    ...over,
  };
}

/** What the eve of the refresh kept, of the sandbox before it. */
async function eve(dir: string, host = HOST): Promise<void> {
  const job = (name: string, cronExpression = '0 0 3 * * ?') => ({
    name,
    type: 'Scheduled Apex',
    cronExpression,
    state: 'WAITING',
    owner: 'admin@acme.com.uat',
  });
  await saveInventory(dir, {
    version: 1,
    savedAt: '2026-11-18T20:00:00.000Z',
    organizationId: BEFORE,
    host,
    jobs: [
      job('Nightly ERP sync', '0 0 2 * * ?'),
      job('Weekly digest'),
      job('Kept one'),
      job('Kept two'),
      job('Kept three'),
    ],
  });
}

describe('the audits asked', () => {
  it('by the verb, are every audit the file does not turn off, the deliverability always', () => {
    expect(auditsAskedOf(undefined, 'verb')).toEqual({
      deliverability: true,
      schedules: true,
      endpoints: { productionHosts: [], fields: [] },
    });
    expect(auditsAskedOf({ schedules: false, endpoints: false }, 'verb')).toEqual({
      deliverability: true,
      schedules: false,
      endpoints: false,
    });
  });

  it('once applied, are only those the file asks, and the deliverability with them', () => {
    expect(auditsAskedOf(undefined, 'apply')).toBeUndefined();
    expect(auditsAskedOf({ handoff: true }, 'apply')).toBeUndefined();
    expect(auditsAskedOf({ endpoints: true }, 'apply')).toEqual({
      deliverability: true,
      schedules: false,
      endpoints: { productionHosts: [], fields: [] },
    });
    expect(auditsAskedOf(AUDITS, 'apply')).toEqual(EVERY);
  });

  it('cost, at fewest and at most, the requests each audit sends', () => {
    expect(auditRequestsOf(EVERY)).toEqual({ fewest: 5, most: 8 });
    expect(auditRequestsOf({ deliverability: true, schedules: false, endpoints: false })).toEqual({
      fewest: 1,
      most: 2,
    });
  });
});

describe('the audits of a sandbox the morning after its refresh', () => {
  it('read the deliverability, the jobs against the eve’s inventory and the endpoints that name production', async () => {
    const dir = journal();
    await eve(dir);
    const { transport, requests } = fakeAuditOrg(uat());
    const read = await readAudits(
      { transport, journalDir: dir, now: () => AT },
      { org: UAT, asked: EVERY },
    );
    expect(envAuditResultSchema.safeParse(read.result).success).toBe(true);
    expect(read.result.org).toEqual(UAT);
    expect(read.result.at).toBe('2026-11-20T08:14:49.000Z');
    expect(read.result.deliverability).toEqual({ read: 'closed' });
    expect(read.result.schedules?.against).toEqual({
      savedAt: '2026-11-18T20:00:00.000Z',
      organizationId: BEFORE,
      refreshed: true,
    });
    expect(read.result.schedules?.jobs.map((job) => [job.name, job.status])).toEqual([
      ['Nightly ERP sync', 'gone'],
      ['Weekly digest', 'frozen'],
      ['Data cleanup', 'new'],
    ]);
    expect(read.result.schedules?.kept).toBe(3);
    expect(read.result.endpoints?.found.map((one) => one.name)).toEqual([
      'ERP_API',
      'SF_Prod',
      'Integration_Setting__mdt.ERP.Endpoint__c',
    ]);
    // A job gone, a job frozen and three endpoints: a new job is no finding.
    expect(read.result.findings).toBe(5);
    expect(findingsOf(read.result)).toBe(5);
    expect(read.result.apiRequests).toBe(requests.length);
    expect(read.notes).toEqual([]);
    expect(read.saveFailed).toBeUndefined();
  });

  it('never answer an endpoint’s query', async () => {
    const { transport } = fakeAuditOrg(uat());
    const read = await readAudits(
      { transport, journalDir: journal(), now: () => AT },
      { org: UAT, asked: EVERY },
    );
    expect(JSON.stringify(read.result)).not.toContain('abc123');
  });

  it('never throw when no request is answered at all, each audit said not read with why', async () => {
    const outcome = await readAudits(
      {
        transport: { request: () => Promise.reject(new Error('socket hang up')) },
        journalDir: journal(),
        now: () => AT,
      },
      {
        org: UAT,
        asked: {
          deliverability: true,
          schedules: true,
          endpoints: { productionHosts: [], fields: [] },
        },
      },
    );
    expect(outcome.result.deliverability?.unread).toMatch(/socket hang up/);
    expect(outcome.result.schedules?.unread).toMatch(/socket hang up/);
    expect(outcome.result.endpoints?.unread).toMatch(/socket hang up/);
    expect(outcome.result.findings).toBe(0);
    expect(outcome.result.apiRequests).toBe(4);
  });

  it('read an open deliverability as a finding', async () => {
    const { transport } = fakeAuditOrg(uat({ deliverability: 'open' }));
    const read = await readAudits(
      { transport, journalDir: journal(), now: () => AT },
      { org: UAT, asked: { deliverability: true, schedules: false, endpoints: false } },
    );
    expect(read.result.deliverability).toEqual({ read: 'open' });
    expect(read.result.findings).toBe(1);
  });
});

describe('the jobs kept for the next refresh', () => {
  it('are saved by the org’s host, for the read after the refresh to compare with', async () => {
    const dir = journal();
    const { transport } = fakeAuditOrg(uat());
    const saved = await readAudits(
      { transport, journalDir: dir, now: () => new Date('2026-11-18T20:00:00.000Z') },
      { org: { ...UAT, organizationId: BEFORE }, asked: EVERY, save: true },
    );
    const path = join(dir, 'audits', HOST, '20261118T200000000Z-00Dxx0000001gPLEAY.json');
    expect(saved.result.schedules?.saved).toBe(path);
    expect(saved.saveFailed).toBeUndefined();

    const after = await readAudits(
      { transport: fakeAuditOrg(uat()).transport, journalDir: dir, now: () => AT },
      { org: UAT, asked: EVERY },
    );
    expect(after.result.schedules?.against).toEqual({
      savedAt: '2026-11-18T20:00:00.000Z',
      organizationId: BEFORE,
      refreshed: true,
    });
  });

  it('are kept by no other host: an inventory of another sandbox is never compared', async () => {
    const dir = journal();
    await eve(dir, 'other--uat.sandbox.my.salesforce.com');
    const read = await readAudits(
      { transport: fakeAuditOrg(uat()).transport, journalDir: dir, now: () => AT },
      { org: UAT, asked: EVERY },
    );
    expect(read.result.schedules?.against).toBeUndefined();
    expect(read.result.schedules?.jobs.map((job) => job.status)).toEqual(['frozen']);
  });

  it('fail the save when the org’s host is not known, an inventory being kept by its host', async () => {
    const noHost: AuditOrgInput = { organizationId: AFTER, kind: 'sandbox', alias: 'uat' };
    const read = await readAudits(
      { transport: fakeAuditOrg(uat()).transport, journalDir: journal(), now: () => AT },
      { org: noHost, asked: EVERY, save: true },
    );
    expect(read.saveFailed).toBe(
      "the org's host is not known, and an inventory is kept by its host",
    );
    expect(read.notes).toContain(
      "nothing saved: the org's host is not known, and an inventory is kept by its host",
    );
  });

  it('fail the save when the inventory cannot be written', async () => {
    const blocked = join(journal(), 'not-a-folder');
    writeFileSync(blocked, 'a file where the journal goes');
    const read = await readAudits(
      { transport: fakeAuditOrg(uat()).transport, journalDir: blocked, now: () => AT },
      { org: UAT, asked: EVERY, save: true },
    );
    expect(read.saveFailed).toMatch(/^it could not be written: /);
    expect(read.result.schedules?.saved).toBeUndefined();
  });

  it('keep nothing, and fail nothing, when the jobs were not read', async () => {
    const dir = journal();
    const read = await readAudits(
      {
        transport: fakeAuditOrg(
          uat({ refuse: { CronTrigger: sfError('INSUFFICIENT_ACCESS', 'No.') } }),
        ).transport,
        journalDir: dir,
        now: () => AT,
      },
      { org: UAT, asked: EVERY, save: true },
    );
    expect(read.notes).toContain('nothing saved: the scheduled jobs were not read');
    expect(read.saveFailed).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });
});
