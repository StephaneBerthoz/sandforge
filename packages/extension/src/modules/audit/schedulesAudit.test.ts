import { describe, expect, it } from 'vitest';
import { AuditOrg } from './auditOrg.js';
import { fakeAuditOrg, sfError, type FakeAuditOrgInit, type FakeAuditRow } from './auditFakeOrg.js';
import { auditInventorySchema, type AuditAgainst, type AuditInventoryJob } from './auditStore.js';
import {
  CRON_TRIGGER_SOQL,
  inventoryOf,
  jobTypeOf,
  readJobs,
  schedulesOf,
  type JobsRead,
} from './schedulesAudit.js';

const ADMIN = '005xx0000001AAAAAA';
const OPS = '005xx0000002AAAAAA';
const LEFT = '005xx0000003AAAAAA';

/** A trigger as `CronTrigger` holds it, its detail's fields dotted. */
function trigger(name: string, over: Partial<Record<string, string | null>> = {}): FakeAuditRow {
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

/** The sandbox the morning after its refresh: a job run as a frozen user, one new, three kept. */
function world(over: Partial<FakeAuditOrgInit> = {}, triggers?: FakeAuditRow[]): FakeAuditOrgInit {
  return {
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
        rows: triggers ?? [
          trigger('Weekly digest', {
            CronExpression: '0 0 6 ? * SAT',
            NextFireTime: '2026-11-21T06:00:00.000+0000',
            OwnerId: OPS,
          }),
          trigger('Data cleanup', { 'CronJobDetail.JobType': '9' }),
          trigger('Kept one'),
          trigger('Kept two'),
          trigger('Kept three'),
          trigger('Old export', { 'CronJobDetail.JobType': '0', State: 'COMPLETE' }),
        ],
      },
      User: {
        // The org holds each user's address: the audit never asks for it.
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
          {
            Id: LEFT,
            Username: 'left@acme.com.uat',
            IsActive: false,
            Email: 'left.person@acme.com',
          },
        ],
      },
      UserLogin: {
        columns: ['UserId', 'IsFrozen'],
        rows: [
          { UserId: ADMIN, IsFrozen: false },
          { UserId: OPS, IsFrozen: true },
          { UserId: LEFT, IsFrozen: true },
        ],
      },
    },
    ...over,
  };
}

/** What `--save` kept the eve of the refresh, of the sandbox before it. */
function before(jobs: AuditInventoryJob[], refreshed = true): AuditAgainst {
  return {
    kept: {
      inventory: {
        version: 1,
        savedAt: '2026-11-18T20:00:00.000Z',
        organizationId: refreshed ? '00Dxx0000001gPLEAY' : '00Dxx0000002AbCEAU',
        host: 'acme--uat.sandbox.my.salesforce.com',
        jobs,
      },
      path: '/j/audits/acme--uat.sandbox.my.salesforce.com/x.json',
    },
    refreshed,
  };
}

const kept = (name: string): AuditInventoryJob => ({
  name,
  type: 'Scheduled Apex',
  cronExpression: '0 0 3 * * ?',
  state: 'WAITING',
  owner: 'admin@acme.com.uat',
});

const EVE = [
  { ...kept('Nightly ERP sync'), cronExpression: '0 0 2 * * ?' },
  kept('Weekly digest'),
  kept('Kept one'),
  kept('Kept two'),
  kept('Kept three'),
  { ...kept('Ended before'), state: 'COMPLETE' },
];

async function read(init: FakeAuditOrgInit): Promise<{ jobs: JobsRead; requests: string[] }> {
  const { transport, requests } = fakeAuditOrg(init);
  const jobs = await readJobs(new AuditOrg(transport));
  if ('unread' in jobs) throw new Error(jobs.unread);
  return { jobs, requests: requests.map(decodeURIComponent) };
}

describe('the scheduled jobs an audit reads', () => {
  it('reads each job’s name, type, expression, state and dates, and the user it runs as', async () => {
    const { jobs, requests } = await read(world());
    expect(requests[0]).toBe(`/query?q=${CRON_TRIGGER_SOQL}`);
    expect(jobs.jobs[0]).toEqual({
      name: 'Weekly digest',
      type: 'Scheduled Apex',
      cronExpression: '0 0 6 ? * SAT',
      state: 'WAITING',
      nextFireTime: '2026-11-21T06:00:00.000Z',
      owner: 'ops.batch@acme.com.uat',
      ownerActive: true,
      ownerFrozen: true,
    });
    expect(jobs.jobs[1]?.type).toBe('Batch Job');
    expect(requests).toHaveLength(3);
  });

  it('names a job by its owner’s username, never by the owner’s address, which it never asks', async () => {
    const { jobs, requests } = await read(world());
    const said = JSON.stringify(schedulesOf(jobs, before(EVE)));
    expect(said).toContain('ops.batch@acme.com.uat');
    expect(said).not.toContain('ops.person@acme.com');
    expect(requests.join('\n')).not.toMatch(/Email/);
  });

  it('names a type it does not list by its code, never a guessed one', () => {
    expect(jobTypeOf('7')).toBe('Scheduled Apex');
    expect(jobTypeOf('Z')).toBe('job type Z');
    expect(jobTypeOf(undefined)).toBe('job of no type');
  });

  it('puts into a query no owner that is not shaped as a User Id', async () => {
    const { requests } = await read(
      world({}, [trigger('Odd', { OwnerId: "005') OR Id != ('" }), trigger('Plain')]),
    );
    expect(requests.join('\n')).not.toContain('OR Id');
  });

  it('reads no user for a job that ended: it runs no more', async () => {
    const { requests } = await read(
      world({}, [trigger('Done', { State: 'COMPLETE', OwnerId: OPS })]),
    );
    expect(requests).toHaveLength(1);
  });
});

describe('the scheduled jobs against the inventory of the sandbox before its refresh', () => {
  it('names those gone, those run as a frozen user and those new, and counts the others kept', async () => {
    const { jobs } = await read(world());
    expect(schedulesOf(jobs, before(EVE))).toEqual({
      now: 5,
      against: {
        savedAt: '2026-11-18T20:00:00.000Z',
        organizationId: '00Dxx0000001gPLEAY',
        refreshed: true,
      },
      jobs: [
        {
          status: 'gone',
          name: 'Nightly ERP sync',
          type: 'Scheduled Apex',
          cronExpression: '0 0 2 * * ?',
          owner: 'admin@acme.com.uat',
        },
        {
          status: 'frozen',
          name: 'Weekly digest',
          type: 'Scheduled Apex',
          cronExpression: '0 0 6 ? * SAT',
          owner: 'ops.batch@acme.com.uat',
          nextFireTime: '2026-11-21T06:00:00.000Z',
        },
        {
          status: 'new',
          name: 'Data cleanup',
          type: 'Batch Job',
          cronExpression: '0 0 3 * * ?',
          owner: 'admin@acme.com.uat',
          nextFireTime: '2026-11-21T03:00:00.000Z',
        },
      ],
      kept: 3,
    });
  });

  it('counts a job that ended neither now nor gone', async () => {
    const { jobs } = await read(world());
    const schedules = schedulesOf(jobs, before(EVE));
    expect(schedules.jobs.map((job) => job.name)).not.toContain('Ended before');
    expect(schedules.jobs.map((job) => job.name)).not.toContain('Old export');
  });

  it('names a job run as an inactive user inactive, frozen or not', async () => {
    const { jobs } = await read(world({}, [trigger('Left behind', { OwnerId: LEFT })]));
    expect(schedulesOf(jobs, undefined).jobs).toEqual([
      expect.objectContaining({ status: 'inactive', owner: 'left@acme.com.uat' }),
    ]);
  });

  it('with no inventory, names nothing gone and nothing new: only a stuck job, the others kept', async () => {
    const { jobs } = await read(world());
    const schedules = schedulesOf(jobs, undefined);
    expect(schedules.against).toBeUndefined();
    expect(schedules.jobs.map((job) => `${job.status} ${job.name}`)).toEqual([
      'frozen Weekly digest',
    ]);
    expect(schedules.kept).toBe(4);
  });

  it('against the same org’s inventory, says no refresh', async () => {
    const { jobs } = await read(world());
    expect(schedulesOf(jobs, before(EVE, false)).against?.refreshed).toBe(false);
  });

  it('names no job gone when more jobs were there than were read', async () => {
    const many = Array.from({ length: 6 }, (_, at) => trigger(`Job ${at}`));
    const { jobs } = await read(world({ pageSize: 1 }, many));
    expect(jobs.truncated).toBe(true);
    const schedules = schedulesOf(jobs, before([kept('Job 5'), kept('Nightly ERP sync')]));
    expect(schedules.jobs.filter((job) => job.status === 'gone')).toEqual([]);
    expect(schedules.unread).toMatch(/more jobs than 5 were there/);
  });
});

describe('a read of the scheduled jobs the org refuses', () => {
  it('is not read, with the org’s words, and never throws', async () => {
    const { transport } = fakeAuditOrg(
      world({
        refuse: {
          CronTrigger: sfError('INSUFFICIENT_ACCESS', 'You cannot see the scheduled jobs.'),
        },
      }),
    );
    expect(await readJobs(new AuditOrg(transport))).toEqual({
      unread: 'the org refused it: INSUFFICIENT_ACCESS: You cannot see the scheduled jobs.',
    });
  });

  it('keeps the jobs read when their users are not, and says a stuck job is not told', async () => {
    const { jobs } = await read(
      world({
        refuse: {
          UserLogin: sfError('INVALID_TYPE', "sObject type 'UserLogin' is not supported."),
        },
      }),
    );
    const schedules = schedulesOf(jobs, before(EVE));
    expect(schedules.jobs.map((job) => `${job.status} ${job.name}`)).toEqual([
      'gone Nightly ERP sync',
      'new Data cleanup',
    ]);
    expect(schedules.unread).toMatch(
      /^the users the jobs run as could not be read \(the org refused it: INVALID_TYPE/,
    );
  });
});

describe('the inventory --save keeps of the jobs read', () => {
  it('keeps the name, the type, the expression, the state, the dates and the username alone', async () => {
    const { jobs } = await read(world());
    const kept = inventoryOf(jobs.jobs, {
      savedAt: '2026-11-21T08:00:00.000Z',
      organizationId: '00Dxx0000002AbCEAU',
      host: 'acme--uat.sandbox.my.salesforce.com',
    });
    expect(auditInventorySchema.safeParse(kept).success).toBe(true);
    expect(kept.jobs[0]).toEqual({
      name: 'Weekly digest',
      type: 'Scheduled Apex',
      cronExpression: '0 0 6 ? * SAT',
      state: 'WAITING',
      nextFireTime: '2026-11-21T06:00:00.000Z',
      owner: 'ops.batch@acme.com.uat',
    });
    expect(kept.jobs).toHaveLength(6);
  });
});
