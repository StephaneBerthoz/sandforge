/**
 * The audits of an org once it is handed back after a refresh: its
 * deliverability, its scheduled jobs against what they were before the
 * refresh, and the endpoints that still name its production. Read, and
 * nothing written to the org.
 *
 * - **An audit not read is said "not read", with why.** It is never taken
 *   for one that found nothing.
 * - **Saving** keeps the jobs read in an inventory of this machine, filed by
 *   the org's host (`auditStore.ts`), to compare with after the next
 *   refresh. An inventory that could not be written is said apart
 *   (`saveFailed`): the comparison it was kept for would find nothing the
 *   morning after.
 * - **What it costs is counted**: the requests sent, those the org refused
 *   included, in `apiRequests`.
 *
 * `sandforge env audit` and an apply read them through here, and say them on
 * a terminal (`cli/env/audit/auditVerb.ts`): the reading lives in the
 * extension, where the panel can reach it.
 *
 * When it was read is this machine's clock: the org's would cost a request
 * more.
 */

import type { EnvAuditResult, EnvAudits, EnvTargetKind } from '@sandforge/shared';
import { envAuditResultSchema } from '@sandforge/shared';
import { readEmailDeliverability } from '../forge/targetDeliverability.js';
import { AuditOrg, type AuditTransport } from './auditOrg.js';
import {
  inventoryAgainst,
  readInventories,
  saveInventory,
  type AuditAgainst,
} from './auditStore.js';
import { endpointsRequestsOf, readEndpoints } from './endpointsAudit.js';
import { inventoryOf, readJobs, schedulesOf } from './schedulesAudit.js';

/** The audits read, as the file and the reader ask them. */
export interface AuditsAsked {
  deliverability: boolean;
  schedules: boolean;
  /** False, or the production hosts and the fields read beside those deduced. */
  endpoints: false | { productionHosts: string[]; fields: string[] };
}

/** The org the audits read, as the guards typed it. */
export interface AuditOrgInput {
  organizationId: string;
  kind: EnvTargetKind;
  alias?: string;
  /** The host the org answered on: its My Domain's. */
  host?: string;
}

/** What the audits read with. */
export interface AuditDeps {
  /** The connection to the org, as the user the reader connects as. */
  transport: AuditTransport;
  /** Where a save keeps the inventories: the journal directory. */
  journalDir: string;
  now?: () => Date;
  /** How long each answer is waited for. */
  timeoutMs?: number;
}

/** The audits read, and what is said beside the answer. */
export interface AuditsRead {
  result: EnvAuditResult;
  /** Inventories set aside, an inventory not saved and why. */
  notes: string[];
  /**
   * Why a save kept nothing it had read: the inventory could not be
   * written. Jobs not read leave nothing to keep, and are no failure.
   */
  saveFailed?: string;
}

/**
 * The audits the file asks of a reader: `env audit` reads every audit the
 * file does not turn off; an apply reads none unless the file names one, and
 * the deliverability with any it names. Undefined when an apply reads none.
 */
export function auditsAskedOf(
  audits: EnvAudits | undefined,
  by: 'verb' | 'apply',
): AuditsAsked | undefined {
  const extra = (endpoints: EnvAudits['endpoints']): AuditsAsked['endpoints'] =>
    typeof endpoints === 'object'
      ? { productionHosts: endpoints.productionHosts ?? [], fields: endpoints.fields ?? [] }
      : { productionHosts: [], fields: [] };
  if (by === 'verb') {
    return {
      deliverability: true,
      schedules: audits?.schedules !== false,
      endpoints: audits?.endpoints === false ? false : extra(audits?.endpoints),
    };
  }
  const schedules = audits?.schedules === true;
  const endpoints =
    audits?.endpoints !== undefined && audits.endpoints !== false ? extra(audits.endpoints) : false;
  if (!schedules && endpoints === false) return undefined;
  return { deliverability: true, schedules, endpoints };
}

/**
 * The requests the audits send, at fewest and at most: the deliverability one
 * or two, the scheduled jobs one to three (a page, then the users they run as
 * and their logins), the endpoints two and one an object of the file's
 * fields. A page past the first of 2,000 rows costs one more.
 */
export function auditRequestsOf(asked: AuditsAsked): { fewest: number; most: number } {
  let fewest = 0;
  let most = 0;
  if (asked.deliverability) {
    fewest += 1;
    most += 2;
  }
  if (asked.schedules) {
    fewest += 1;
    most += 3;
  }
  if (asked.endpoints !== false) {
    const endpoints = endpointsRequestsOf(asked.endpoints.fields);
    fewest += endpoints;
    most += endpoints;
  }
  return { fewest, most };
}

/**
 * The findings of an answer: a job gone, a job run as a user who can no
 * longer run it, an endpoint that names production, or an open
 * deliverability. A new job is no finding.
 */
export function findingsOf(
  result: Pick<EnvAuditResult, 'deliverability' | 'schedules' | 'endpoints'>,
): number {
  const jobs = (result.schedules?.jobs ?? []).filter((job) => job.status !== 'new').length;
  const endpoints = result.endpoints?.found.length ?? 0;
  const open = result.deliverability?.read === 'open' ? 1 : 0;
  return jobs + endpoints + open;
}

/**
 * Read the audits asked of the org. Never throws for what the org answers:
 * a part not read says why. `save` keeps the scheduled jobs read in an
 * inventory, once the inventory they are compared against was found.
 */
export async function readAudits(
  deps: AuditDeps,
  input: { org: AuditOrgInput; asked: AuditsAsked; save?: boolean },
): Promise<AuditsRead> {
  const now = (deps.now ?? (() => new Date()))();
  const org = new AuditOrg(deps.transport, {
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  });
  const notes: string[] = [];
  let notSaved: string | undefined;
  let saveFailed = false;
  const answer: Omit<EnvAuditResult, 'findings' | 'apiRequests'> = {
    org: {
      organizationId: input.org.organizationId,
      kind: input.org.kind,
      ...(input.org.alias !== undefined ? { alias: input.org.alias } : {}),
      ...(input.org.host !== undefined ? { host: input.org.host } : {}),
    },
    at: now.toISOString(),
  };

  if (input.asked.deliverability) {
    const read = await readEmailDeliverability(org.asTransport(), { timeoutMs: org.timeout }).catch(
      (err: unknown) => ({
        reading: { unread: err instanceof Error ? err.message : String(err) },
        requests: 0,
      }),
    );
    answer.deliverability =
      'unread' in read.reading
        ? { unread: read.reading.unread.slice(0, 2_000) }
        : { read: read.reading.level === 'all' ? 'open' : 'closed' };
  }

  if (input.asked.schedules) {
    const jobs = await readJobs(org);
    if ('unread' in jobs) {
      answer.schedules = { now: 0, jobs: [], kept: 0, unread: jobs.unread.slice(0, 2_000) };
      if (input.save === true) notSaved = 'the scheduled jobs were not read';
    } else {
      let against: AuditAgainst | undefined;
      if (input.org.host !== undefined) {
        const kept = await readInventories(deps.journalDir, input.org.host);
        for (const aside of kept.setAside)
          notes.push(`inventory set aside: ${aside.path}: ${aside.why}`);
        if (kept.unread !== undefined) notes.push(`no inventory read: ${kept.unread}`);
        against = inventoryAgainst(kept.kept, input.org.organizationId);
      }
      answer.schedules = schedulesOf(jobs, against);
      if (input.save === true) {
        if (input.org.host === undefined) {
          saveFailed = true;
          notSaved = "the org's host is not known, and an inventory is kept by its host";
        } else if (jobs.truncated) {
          notSaved =
            'more jobs were there than were read: an inventory of part of them would ' +
            'have the next comparison call the others new';
        } else {
          try {
            const saved = await saveInventory(
              deps.journalDir,
              inventoryOf(jobs.jobs, {
                savedAt: now.toISOString(),
                organizationId: input.org.organizationId,
                host: input.org.host,
              }),
            );
            answer.schedules = { ...answer.schedules, saved };
          } catch (err: unknown) {
            saveFailed = true;
            notSaved = `it could not be written: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }
    }
  } else if (input.save === true) {
    notSaved = 'the file reads no scheduled jobs (audits.schedules: false)';
  }

  if (input.asked.endpoints !== false) {
    answer.endpoints = await readEndpoints(org, {
      ...(input.org.host !== undefined ? { host: input.org.host } : {}),
      productionHosts: input.asked.endpoints.productionHosts,
      fields: input.asked.endpoints.fields,
    });
  }

  if (notSaved !== undefined) notes.push(`nothing saved: ${notSaved}`);
  const result = envAuditResultSchema.parse({
    ...answer,
    apiRequests: org.requests,
    findings: findingsOf(answer),
  });
  return {
    result,
    notes,
    ...(saveFailed && notSaved !== undefined ? { saveFailed: notSaved } : {}),
  };
}
