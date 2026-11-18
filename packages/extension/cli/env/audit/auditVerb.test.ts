import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envAuditResultSchema, type EnvAudits } from '@sandforge/shared';
import { commandOf } from '../../invocation.js';
import { fakeAuditOrg, sfError, type FakeAuditOrgInit, type FakeAuditRow } from './auditFakeOrg.js';
import { saveInventory } from '../../../src/modules/audit/auditStore.js';
import {
  AUDIT_FLAGS,
  auditPlanLine,
  auditVerb,
  auditsAskedOf,
  type AuditOrgInput,
} from './auditVerb.js';

const HOST = 'acme--uat.sandbox.my.salesforce.com';
const BEFORE = '00Dxx0000001gPLEAY';
const AFTER = '00Dxx0000002AbCEAU';
const ADMIN = '005xx0000001AAAAAA';
const OPS = '005xx0000002AAAAAA';
const AT = new Date('2026-11-20T08:14:49.000Z');

/** The file of the design's example: every audit, a production host and a field beside. */
const AUDITS: EnvAudits = {
  schedules: true,
  endpoints: {
    productionHosts: ['erp.acme.com'],
    fields: ['Integration_Setting__mdt.Endpoint__c'],
  },
  handoff: true,
};

const UAT: AuditOrgInput = { organizationId: AFTER, kind: 'sandbox', alias: 'uat', host: HOST };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function journal(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-audit-verb-'));
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

/** The uat sandbox the morning after its refresh, as the design's example has it. */
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
          trigger('Weekly digest', {
            NextFireTime: '2026-11-21T06:00:00.000+0000',
            OwnerId: OPS,
          }),
          trigger('Data cleanup', { 'CronJobDetail.JobType': '9' }),
          trigger('Kept one'),
          trigger('Kept two'),
          trigger('Kept three'),
        ],
      },
      User: {
        columns: ['Id', 'Username', 'IsActive', 'Email'],
        rows: [
          {
            Id: ADMIN,
            Username: 'admin@acme.com.uat',
            IsActive: true,
            Email: 'admin.person@acme.com',
          },
          {
            Id: OPS,
            Username: 'ops.batch@acme.com.uat',
            IsActive: true,
            Email: 'ops.person@acme.com',
          },
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
        rows: [
          {
            DeveloperName: 'Default',
            Endpoint__c: 'https://login.salesforce.com/services/oauth2/token?client_secret=xyz789',
          },
          {
            DeveloperName: 'ERP',
            Endpoint__c: 'https://svc:s3cret-pass@erp.acme.com/api/v2?key=abc123#frag-token',
          },
        ],
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
          { SiteName: 'ApexDevNet', EndpointUrl: 'http://www.apexdevnet.com', IsActive: true },
          { SiteName: 'SF_Prod', EndpointUrl: 'https://acme.my.salesforce.com/', IsActive: true },
        ],
      },
    },
    ...over,
  };
}

/** What `--save` kept the eve of the refresh, of the sandbox before it. */
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

async function run(
  init: FakeAuditOrgInit,
  dir: string,
  over: Partial<Parameters<typeof auditVerb>[1]> = {},
) {
  const { transport, requests } = fakeAuditOrg(init);
  const outcome = await auditVerb(
    { transport, journalDir: dir, now: () => AT },
    {
      org: UAT,
      audits: AUDITS,
      file: '../uat/sandforge.yaml',
      save: false,
      failOnFindings: false,
      ...over,
    },
  );
  return { outcome, requests };
}

describe('what env audit reads', () => {
  it('reads its own line: --save, --fail-on-findings, --json, the file, the org and the roles', () => {
    expect(AUDIT_FLAGS).toEqual({
      words: 1,
      switches: ['--json', '--save', '--fail-on-findings'],
      values: ['--file', '--org', '--alias'],
    });
  });
});

describe('what the audits cost', () => {
  it('is said by a plan beforehand: what is read, and about how many requests', () => {
    const asked = auditsAskedOf(AUDITS, 'apply');
    if (asked === undefined) throw new Error('the file asks audits');
    expect(auditPlanLine(asked)).toBe(
      'audits after the apply: deliverability, scheduled jobs, endpoints, about 5 to 8 API requests',
    );
    expect(auditPlanLine({ deliverability: true, schedules: false, endpoints: false })).toBe(
      'audits after the apply: deliverability, about 1 to 2 API requests',
    );
  });

  it('is counted as the audits read, every request the org saw, and said in the first line', async () => {
    const { outcome, requests } = await run(uat(), journal());
    if (!('result' in outcome)) throw new Error(outcome.refusal.message);
    expect(outcome.result.apiRequests).toBe(8);
    expect(requests).toHaveLength(8);
    expect(outcome.lines[0]).toBe(
      `audit of uat (sandbox acme--uat, ${AFTER}), 2026-11-20T08:14:49Z, 8 API requests`,
    );
  });
});

describe('env audit the morning after a refresh', () => {
  it('says the deliverability, the jobs against the eve’s inventory and the endpoints that name production', async () => {
    const dir = journal();
    await eve(dir);
    const { outcome } = await run(uat(), dir);
    if (!('result' in outcome)) throw new Error(outcome.refusal.message);
    expect(outcome.lines).toEqual([
      `audit of uat (sandbox acme--uat, ${AFTER}), 2026-11-20T08:14:49Z, 8 API requests`,
      'deliverability: closed — System email only or No access: what runs there emails nobody. ' +
        'Which of the two, no API says.',
      `scheduled jobs: 5 now, against the inventory saved on 2026-11-18 from ${BEFORE}, this ` +
        'sandbox before its refresh',
      '  gone     Nightly ERP sync (Scheduled Apex, 0 0 2 * * ?): scheduled before the refresh, not since',
      '  frozen   Weekly digest (Scheduled Apex) runs as ops.batch@acme.com.uat, who is frozen: its ' +
        'next run, 2026-11-21T06:00:00Z, fails',
      '  new      Data cleanup (Batch Job)',
      '  kept     3',
      'endpoints that still name production (acme.my.salesforce.com, acme.lightning.force.com, ' +
        'acme.my.site.com, login.salesforce.com, erp.acme.com):',
      '  Named Credential  ERP_API                                       https://erp.acme.com/api                            a production host the file lists',
      "  Remote Site       SF_Prod                                       https://acme.my.salesforce.com/                     production's My Domain",
      '  Field             Integration_Setting__mdt.Default.Endpoint__c  https://login.salesforce.com/services/oauth2/token  where production orgs sign in',
      '  Field             Integration_Setting__mdt.ERP.Endpoint__c      https://erp.acme.com/api/v2                         a production host the file lists',
      'SandForge changes none of these: Setup, sf or your deployment put them right.',
    ]);
    expect(outcome.result.findings).toBe(6);
    expect(outcome.exitCode).toBe(0);
  });

  it('answers with --json what its schema holds', async () => {
    const dir = journal();
    await eve(dir);
    const { outcome } = await run(uat(), dir);
    if (!('result' in outcome)) throw new Error(outcome.refusal.message);
    expect(envAuditResultSchema.safeParse(outcome.result).success).toBe(true);
    expect(outcome.result.org).toEqual(UAT);
    expect(outcome.result.at).toBe('2026-11-20T08:14:49.000Z');
  });

  it('never prints nor answers an endpoint’s query, fragment or credentials', async () => {
    const { outcome } = await run(uat(), journal());
    if (!('result' in outcome)) throw new Error(outcome.refusal.message);
    const said = `${outcome.lines.join('\n')}\n${JSON.stringify(outcome.result)}`;
    for (const secret of [
      'abc123',
      'xyz789',
      'frag-token',
      's3cret-pass',
      'svc:',
      'client_secret',
    ]) {
      expect(said).not.toContain(secret);
    }
  });

  it('names a job by its owner’s username, never by the owner’s address', async () => {
    const dir = journal();
    await eve(dir);
    const { outcome } = await run(uat(), dir);
    if (!('result' in outcome)) throw new Error(outcome.refusal.message);
    const said = `${outcome.lines.join('\n')}\n${JSON.stringify(outcome.result)}`;
    expect(said).toContain('ops.batch@acme.com.uat');
    expect(said).not.toContain('ops.person@acme.com');
  });

  it('compares with no inventory of another host, and says it has nothing to compare and the line to run', async () => {
    const dir = journal();
    await eve(dir, 'other--uat.sandbox.my.salesforce.com');
    const { outcome } = await run(uat(), dir);
    if (!('result' in outcome)) throw new Error(outcome.refusal.message);
    expect(outcome.result.schedules?.against).toBeUndefined();
    expect(outcome.lines).toContain(
      `scheduled jobs: 5 now, nothing to compare them with: no inventory of ${HOST} is kept on this machine`,
    );
    expect(outcome.lines).toContain(
      `  before the next refresh, keep one: ${commandOf('env')} audit --file ../uat/sandforge.yaml --org uat --save`,
    );
    expect(outcome.result.schedules?.jobs.map((job) => job.status)).toEqual(['frozen']);
  });

  it('names a sandbox before enhanced domains by its My Domain, and deduces no production host from it', async () => {
    const old = 'acme--uat.cs42.my.salesforce.com';
    const { transport } = fakeAuditOrg(uat());
    const outcome = await auditVerb(
      { transport, journalDir: journal(), now: () => AT },
      {
        org: { ...UAT, host: old },
        audits: { schedules: false, endpoints: { productionHosts: ['erp.acme.com'] } },
        file: 'sandforge.yaml',
        save: false,
        failOnFindings: false,
      },
    );
    if (!('result' in outcome)) throw new Error(outcome.refusal.message);
    expect(outcome.lines[0]).toBe(
      `audit of uat (sandbox acme--uat, ${AFTER}), 2026-11-20T08:14:49Z, 4 API requests`,
    );
    expect(outcome.result.endpoints?.productionHosts).toEqual([
      'login.salesforce.com',
      'erp.acme.com',
    ]);
    expect(outcome.lines).toContain(
      `  ${old} is no sandbox's host of the form <domain>--<sandbox>.sandbox.my.salesforce.com: ` +
        "production's own hosts are not deduced",
    );
  });
});

describe('an audit the org does not answer', () => {
  /** An org that refuses each read the audits make. */
  const refusing = (): FakeAuditOrgInit => ({
    deliverability: sfError('INSUFFICIENT_ACCESS', 'Author Apex is required.'),
    refuse: {
      CronTrigger: sfError('INSUFFICIENT_ACCESS', 'You cannot see the scheduled jobs.'),
      NamedCredential: sfError('INSUFFICIENT_ACCESS', 'Customize Application is required.'),
      RemoteProxy: sfError('INSUFFICIENT_ACCESS', 'Customize Application is required.'),
      Integration_Setting__mdt: sfError(
        'INVALID_TYPE',
        "sObject type 'Integration_Setting__mdt' is not supported.",
      ),
    },
  });

  it('is said not read, with why, never taken for one that found nothing', async () => {
    const { outcome } = await run(refusing(), journal());
    if (!('result' in outcome)) throw new Error(outcome.refusal.message);
    expect(outcome.lines.slice(1, 3)).toEqual([
      'deliverability: not read — the org refused it: INSUFFICIENT_ACCESS: Author Apex is required.',
      'scheduled jobs: not read — the org refused it: INSUFFICIENT_ACCESS: You cannot see the scheduled jobs.',
    ]);
    expect(outcome.lines).toContain(
      'endpoints that still name production (acme.my.salesforce.com, acme.lightning.force.com, ' +
        'acme.my.site.com, login.salesforce.com, erp.acme.com): none among those read',
    );
    expect(outcome.lines.at(-1)).toMatch(/^ {2}not read: Named Credentials: the org refused it/);
    expect(outcome.result.findings).toBe(0);
  });

  it('never fails the command, --fail-on-findings included', async () => {
    const { outcome } = await run(refusing(), journal(), { failOnFindings: true });
    expect(outcome.exitCode).toBe(0);
  });
});

describe('--fail-on-findings', () => {
  it('ends 3 on what was found', async () => {
    const dir = journal();
    await eve(dir);
    const { outcome } = await run(uat(), dir, { failOnFindings: true });
    expect(outcome.exitCode).toBe(3);
  });

  it('ends 0 on an org where nothing is found, a new job being no finding', async () => {
    const clean = uat();
    const { outcome } = await run(
      {
        ...clean,
        data: {
          ...clean.data,
          UserLogin: { columns: ['UserId', 'IsFrozen'], rows: [] },
          Integration_Setting__mdt: { columns: ['DeveloperName', 'Endpoint__c'], rows: [] },
        },
        tooling: {
          NamedCredential: { columns: ['DeveloperName', 'Endpoint'], rows: [] },
          RemoteProxy: { columns: ['SiteName', 'EndpointUrl', 'IsActive'], rows: [] },
        },
      },
      journal(),
      {
        failOnFindings: true,
        audits: { endpoints: { fields: ['Integration_Setting__mdt.Endpoint__c'] } },
      },
    );
    if (!('result' in outcome)) throw new Error(outcome.refusal.message);
    expect(outcome.result.findings).toBe(0);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.lines.at(-1)).not.toMatch(/^SandForge changes none of these/);
  });

  it('counts an open deliverability a finding', async () => {
    const { outcome } = await run(uat({ deliverability: 'open' }), journal(), {
      failOnFindings: true,
      audits: { schedules: false, endpoints: false },
    });
    if (!('result' in outcome)) throw new Error(outcome.refusal.message);
    expect(outcome.result.deliverability).toEqual({ read: 'open' });
    expect(outcome.result.findings).toBe(1);
    expect(outcome.exitCode).toBe(3);
  });
});

describe('--save', () => {
  it('keeps the jobs read, and the audit after the refresh compares with them', async () => {
    const dir = journal();
    const { transport } = fakeAuditOrg(uat());
    const saved = await auditVerb(
      { transport, journalDir: dir, now: () => new Date('2026-11-18T20:00:00.000Z') },
      {
        org: { ...UAT, organizationId: BEFORE },
        audits: AUDITS,
        file: 'sandforge.yaml',
        save: true,
        failOnFindings: false,
      },
    );
    if (!('result' in saved)) throw new Error(saved.refusal.message);
    const path = join(dir, 'audits', HOST, '20261118T200000000Z-00Dxx0000001gPLEAY.json');
    expect(saved.result.schedules?.saved).toBe(path);
    expect(saved.lines).toContain(
      `  inventory saved in ${path}, to compare with after the next refresh`,
    );
    expect(saved.exitCode).toBe(0);

    const after = await run(uat(), dir);
    if (!('result' in after.outcome)) throw new Error(after.outcome.refusal.message);
    expect(after.outcome.result.schedules?.against).toEqual({
      savedAt: '2026-11-18T20:00:00.000Z',
      organizationId: BEFORE,
      refreshed: true,
    });
  });

  it('compared with an inventory of the same org, says no refresh since', async () => {
    const dir = journal();
    await run(uat(), dir, { save: true });
    const again = await run(uat(), dir);
    if (!('result' in again.outcome)) throw new Error(again.outcome.refusal.message);
    expect(again.outcome.lines).toContain(
      `scheduled jobs: 5 now, against the inventory saved on 2026-11-20 from ${AFTER}, this sandbox: no refresh since`,
    );
  });

  it('is refused before any request when the file reads no scheduled jobs', async () => {
    const { outcome, requests } = await run(uat(), journal(), {
      save: true,
      audits: { schedules: false },
    });
    expect(outcome).toEqual({
      refusal: {
        code: 'BAD_LINE',
        message:
          '--save keeps the scheduled jobs, which the file does not read (audits.schedules: ' +
          'false): take --save off the line, or the line off the file. Nothing was read.',
      },
      exitCode: 2,
    });
    expect(requests).toEqual([]);
  });

  it('ends 1 when the inventory cannot be written, and says nothing was saved', async () => {
    const dir = journal();
    const blocked = join(dir, 'not-a-folder');
    writeFileSync(blocked, 'a file where the journal goes');
    const { outcome } = await run(uat(), blocked, { save: true });
    if (!('result' in outcome)) throw new Error(outcome.refusal.message);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.result.schedules?.saved).toBeUndefined();
    expect(
      outcome.lines.some((line) => line.startsWith('  nothing saved: it could not be written:')),
    ).toBe(true);
  });

  it('keeps nothing when the jobs were not read, says so, and ends 0: an audit not read is no failure', async () => {
    const dir = journal();
    const { outcome } = await run(
      uat({ refuse: { CronTrigger: sfError('INSUFFICIENT_ACCESS', 'No.') } }),
      dir,
      { save: true },
    );
    if (!('result' in outcome)) throw new Error(outcome.refusal.message);
    expect(outcome.lines).toContain('  nothing saved: the scheduled jobs were not read');
    expect(outcome.exitCode).toBe(0);
    expect(existsSync(join(dir, 'audits'))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
