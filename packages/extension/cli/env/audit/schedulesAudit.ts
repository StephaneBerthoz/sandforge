/**
 * The scheduled jobs of an org, against what they were before its refresh:
 * those gone since, those run as a user who can no longer run them, and
 * those new. Read and nothing written.
 *
 * `CronTrigger` answers each job with `CronJobDetail.Name`,
 * `CronJobDetail.JobType` (`7` is Scheduled Apex), `CronExpression`, `State`,
 * `NextFireTime`, `PreviousFireTime` and `OwnerId`: read on a scratch org with
 * a `Schedulable` planned by anonymous Apex, which answered `7`, `WAITING`
 * and the admin who planned it. Whether a sandbox's jobs survive its refresh,
 * and as whom they run after, no scratch org says: a refreshed sandbox has
 * not been read yet.
 *
 * The user a job runs as is read by its id — `User.Username` and
 * `User.IsActive`, then `UserLogin.IsFrozen` —, and a job is named by that
 * username alone: its address is never read, and never said. A job run as a
 * frozen or an inactive user fails at its next run.
 *
 * A job whose trigger ended (`COMPLETE`, `DELETED`) is no longer scheduled:
 * it is kept in an inventory with its state, and counted neither now nor
 * gone.
 *
 * It costs one request a page of 2,000 jobs, then, when there are jobs, one
 * for their users and one for those users' logins, 200 users a request.
 */

import type { EnvAuditJob, EnvAuditResult } from '@sandforge/shared';
import {
  booleanOf,
  instantOf,
  textOf,
  unreadReasonOf,
  type AuditOrg,
  type AuditRows,
} from './auditOrg.js';
import type { AuditAgainst, AuditInventory, AuditInventoryJob } from './auditStore.js';

/** The query of the jobs, the fields the scratch org's read confirmed. */
export const CRON_TRIGGER_SOQL =
  'SELECT CronJobDetail.Name, CronJobDetail.JobType, CronExpression, State, NextFireTime, ' +
  'PreviousFireTime, OwnerId FROM CronTrigger';

/**
 * A job's type as Setup names it, by `CronJobDetail.JobType`. `7` was read on
 * an org; the others are as the object reference lists them. A code it does
 * not list is named by its code, never guessed.
 */
export const JOB_TYPES: Readonly<Record<string, string>> = {
  '0': 'Data Export',
  '3': 'Dashboard Refresh',
  '4': 'Reporting Snapshot',
  '7': 'Scheduled Apex',
  '8': 'Report Run',
  '9': 'Batch Job',
  A: 'Analytics Notification',
};

/** The states of a trigger that will not fire again. */
const ENDED_STATES: ReadonlySet<string> = new Set(['COMPLETE', 'DELETED']);

/** The most users one request reads by id. */
const USERS_A_REQUEST = 200;

/** A User Id, as a trigger names its owner: checked before it goes into a query. */
const USER_ID = /^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

/** A job's type in words. */
export function jobTypeOf(code: string | undefined): string {
  if (code === undefined) return 'job of no type';
  return JOB_TYPES[code] ?? `job type ${code}`;
}

/** A job read now, and the user it runs as when that user was read. */
export interface JobNow extends AuditInventoryJob {
  ownerActive?: boolean;
  ownerFrozen?: boolean;
}

/** The jobs read, and what of them could not be. */
export interface JobsRead {
  jobs: JobNow[];
  /** More jobs than the pages read: the comparison names none gone. */
  truncated: boolean;
  /** Why the users the jobs run as could not be read: a stuck job is not told. */
  ownersUnread?: string;
}

/** The ids of the users the jobs run as, each once, read 200 a request. */
function chunksOf(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let at = 0; at < ids.length; at += USERS_A_REQUEST) {
    out.push(ids.slice(at, at + USERS_A_REQUEST));
  }
  return out;
}

/** A 15-character key of an id, which both of its forms share. */
function keyOf(id: string): string {
  return id.slice(0, 15);
}

/**
 * The org's scheduled jobs, with the user each runs as. Never throws: a
 * query the org refuses is said in `unread`; the users not read leave the
 * jobs read.
 */
export async function readJobs(org: AuditOrg): Promise<JobsRead | { unread: string }> {
  let rows: AuditRows;
  try {
    rows = await org.query(CRON_TRIGGER_SOQL);
  } catch (err: unknown) {
    return { unread: unreadReasonOf(err, org.timeout) };
  }
  const read: Array<{ job: AuditInventoryJob; ownerId?: string }> = [];
  for (const row of rows.records) {
    const detail = row['CronJobDetail'];
    const detailRow =
      typeof detail === 'object' && detail !== null ? (detail as Record<string, unknown>) : {};
    const name = textOf(detailRow, 'Name');
    const state = textOf(row, 'State');
    if (name === undefined || state === undefined) continue;
    const cronExpression = textOf(row, 'CronExpression');
    const nextFireTime = instantOf(row['NextFireTime']);
    const previousFireTime = instantOf(row['PreviousFireTime']);
    const ownerId = textOf(row, 'OwnerId');
    read.push({
      job: {
        name: name.slice(0, 255),
        type: jobTypeOf(textOf(detailRow, 'JobType')),
        ...(cronExpression !== undefined ? { cronExpression: cronExpression.slice(0, 255) } : {}),
        state: state.slice(0, 40),
        ...(nextFireTime !== undefined ? { nextFireTime } : {}),
        ...(previousFireTime !== undefined ? { previousFireTime } : {}),
      },
      ...(ownerId !== undefined && USER_ID.test(ownerId) ? { ownerId } : {}),
    });
  }
  // Only a job still scheduled can fail at its next run: those ended cost no read.
  const ids = [
    ...new Set(
      read.flatMap((one) =>
        one.ownerId !== undefined && isScheduled(one.job) ? [keyOf(one.ownerId)] : [],
      ),
    ),
  ];
  const users = new Map<string, { username?: string; active?: boolean; frozen?: boolean }>();
  let ownersUnread: string | undefined;
  try {
    for (const chunk of chunksOf(ids)) {
      const list = chunk.map((id) => `'${id}'`).join(', ');
      const found = await org.query(
        `SELECT Id, Username, IsActive FROM User WHERE Id IN (${list})`,
      );
      for (const row of found.records) {
        const id = textOf(row, 'Id');
        if (id === undefined) continue;
        users.set(keyOf(id), {
          ...users.get(keyOf(id)),
          username: textOf(row, 'Username'),
          active: booleanOf(row, 'IsActive'),
        });
      }
      const logins = await org.query(
        `SELECT UserId, IsFrozen FROM UserLogin WHERE UserId IN (${list})`,
      );
      for (const row of logins.records) {
        const id = textOf(row, 'UserId');
        if (id === undefined) continue;
        users.set(keyOf(id), { ...users.get(keyOf(id)), frozen: booleanOf(row, 'IsFrozen') });
      }
    }
  } catch (err: unknown) {
    ownersUnread = unreadReasonOf(err, org.timeout);
  }
  const jobs = read.map(({ job, ownerId }): JobNow => {
    const user = ownerId !== undefined ? users.get(keyOf(ownerId)) : undefined;
    return {
      ...job,
      ...(user?.username !== undefined ? { owner: user.username.slice(0, 255) } : {}),
      ...(user?.active !== undefined ? { ownerActive: user.active } : {}),
      ...(user?.frozen !== undefined ? { ownerFrozen: user.frozen } : {}),
    };
  });
  return {
    jobs,
    truncated: rows.truncated,
    ...(ownersUnread !== undefined ? { ownersUnread } : {}),
  };
}

/** Whether a job is still scheduled: its trigger will fire again. */
export function isScheduled(job: Pick<AuditInventoryJob, 'state'>): boolean {
  return !ENDED_STATES.has(job.state.toUpperCase());
}

/** What tells one job from another across two reads: its name and its type. */
function identityOf(job: Pick<AuditInventoryJob, 'name' | 'type'>): string {
  return `${job.type}\u0000${job.name}`;
}

/** The inventory `--save` keeps of the jobs read: no address, no id. */
export function inventoryOf(
  jobs: readonly JobNow[],
  of: { savedAt: string; organizationId: string; host: string },
): AuditInventory {
  return {
    version: 1,
    savedAt: of.savedAt,
    organizationId: of.organizationId,
    host: of.host,
    jobs: jobs.map((job): AuditInventoryJob => ({
      name: job.name,
      type: job.type,
      ...(job.cronExpression !== undefined ? { cronExpression: job.cronExpression } : {}),
      state: job.state,
      ...(job.nextFireTime !== undefined ? { nextFireTime: job.nextFireTime } : {}),
      ...(job.previousFireTime !== undefined ? { previousFireTime: job.previousFireTime } : {}),
      ...(job.owner !== undefined ? { owner: job.owner } : {}),
    })),
  };
}

/** A job as the answer names it. */
function answerJob(status: EnvAuditJob['status'], job: AuditInventoryJob): EnvAuditJob {
  return {
    status,
    name: job.name,
    type: job.type,
    ...(job.cronExpression !== undefined ? { cronExpression: job.cronExpression } : {}),
    ...(job.owner !== undefined ? { owner: job.owner } : {}),
    ...(job.nextFireTime !== undefined ? { nextFireTime: job.nextFireTime } : {}),
  };
}

/** The order the answer lists jobs in: what is lost first, then what fails, then what is new. */
const STATUS_ORDER: readonly EnvAuditJob['status'][] = ['gone', 'inactive', 'frozen', 'new'];

/**
 * The scheduled jobs as the audit answers them: those gone since the
 * inventory compared against, those run as a user who is inactive or frozen,
 * and those new; the others counted kept. With no inventory, nothing is
 * gone and nothing new: only a stuck job is named.
 *
 * @param read - The jobs read now ({@link readJobs}).
 * @param against - The inventory compared against, when one is kept.
 */
export function schedulesOf(
  read: JobsRead,
  against: AuditAgainst | undefined,
): NonNullable<EnvAuditResult['schedules']> {
  const scheduled = read.jobs.filter(isScheduled);
  const before = against?.kept.inventory.jobs.filter(isScheduled) ?? [];
  const left = new Map<string, number>();
  for (const job of before) left.set(identityOf(job), (left.get(identityOf(job)) ?? 0) + 1);
  const named: EnvAuditJob[] = [];
  let kept = 0;
  for (const job of scheduled) {
    const identity = identityOf(job);
    const known = (left.get(identity) ?? 0) > 0;
    if (known) left.set(identity, (left.get(identity) ?? 0) - 1);
    if (job.ownerActive === false) named.push(answerJob('inactive', job));
    else if (job.ownerFrozen === true) named.push(answerJob('frozen', job));
    else if (against !== undefined && !known) named.push(answerJob('new', job));
    else kept++;
  }
  // Past the pages read, a job not seen may be there still: none is said gone.
  if (against !== undefined && !read.truncated) {
    for (const job of before) {
      const identity = identityOf(job);
      if ((left.get(identity) ?? 0) === 0) continue;
      left.set(identity, (left.get(identity) ?? 0) - 1);
      named.push(answerJob('gone', job));
    }
  }
  named.sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      a.name.localeCompare(b.name),
  );
  const unread = [
    read.truncated
      ? `more jobs than ${read.jobs.length} were there: those past them were not read, and ` +
        'none is said gone'
      : undefined,
    read.ownersUnread !== undefined
      ? `the users the jobs run as could not be read (${read.ownersUnread}): a job run as a ` +
        'frozen or inactive user is not told'
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return {
    now: scheduled.length,
    ...(against !== undefined
      ? {
          against: {
            savedAt: against.kept.inventory.savedAt,
            organizationId: against.kept.inventory.organizationId,
            refreshed: against.refreshed,
          },
        }
      : {}),
    jobs: named,
    kept,
    ...(unread.length > 0 ? { unread: unread.join('; ') } : {}),
  };
}
