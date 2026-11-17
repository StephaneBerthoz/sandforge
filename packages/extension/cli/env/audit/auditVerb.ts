/**
 * `sandforge env audit`, and the audits an apply reads once it wrote: the
 * org's deliverability, its scheduled jobs against what they were before its
 * refresh, and the endpoints that still name its production. Read, and
 * nothing written to the org.
 *
 * - **An audit not read is said "not read", with why.** It is never taken
 *   for one that found nothing, and never changes how a command ends: an
 *   apply that wrote ends as its steps end, and `env audit` ends 0 whatever
 *   the org refused it, unless `--fail-on-findings` finds something read.
 * - **`--fail-on-findings`** ends 3 on a job gone, a job run as a user who
 *   can no longer run it, an endpoint that names production, or an open
 *   deliverability. A new job is no finding.
 * - **`--save`** keeps the jobs read in an inventory of this machine, filed
 *   by the org's host (`auditStore.ts`), to compare with after the next
 *   refresh. An inventory that could not be written ends the command 1: the
 *   comparison the line asked for would find nothing the morning after.
 * - **What it costs is counted and said**: the requests sent, those the org
 *   refused included, in the first line and in `apiRequests`. A plan says it
 *   beforehand ({@link auditPlanLine}).
 *
 * The verb reads each audit the file does not turn off (`schedules: false`,
 * `endpoints: false`); an apply reads those the file asks for, and the
 * deliverability with them. The note an apply writes is `handoffNote.ts`'s.
 *
 * When it was read is this machine's clock: the org's would cost a request
 * more.
 */

import type { EnvAuditResult, EnvAudits, EnvTargetKind } from '@sandforge/shared';
import { envAuditResultSchema } from '@sandforge/shared';
import { readEmailDeliverability } from '../../../src/modules/forge/targetDeliverability.js';
import type { CommandFlags } from '../../commandLine.js';
import { DONE_EXIT, FAILED_EXIT, PARTIAL_EXIT } from '../../exitCodes.js';
import { commandOf } from '../../invocation.js';
import { AuditOrg, type AuditTransport } from './auditOrg.js';
import {
  inventoryAgainst,
  readInventories,
  saveInventory,
  type AuditAgainst,
} from './auditStore.js';
import {
  ENDPOINT_SOURCE_WORDS,
  ENDPOINT_WHY_WORDS,
  endpointsRequestsOf,
  readEndpoints,
} from './endpointsAudit.js';
import { sandboxMyDomainOf } from '../envTargetHost.js';
import { inventoryOf, readJobs, schedulesOf } from './schedulesAudit.js';

/** What `env audit` reads of its line, after its word. */
export const AUDIT_FLAGS: CommandFlags = {
  words: 1,
  switches: ['--json', '--save', '--fail-on-findings'],
  values: ['--file', '--org', '--alias'],
};

/** The exit code of a line that cannot be run as given. */
const BAD_LINE_EXIT = 2;

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
  /** The connection to the org, as the user the line connects as. */
  transport: AuditTransport;
  /** Where `--save` keeps the inventories: the journal directory. */
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
   * Why `--save` kept nothing it had read: the inventory could not be
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

/** What a plan says of the audits an apply reads once it wrote: what, and about how many requests. */
export function auditPlanLine(asked: AuditsAsked): string {
  const what = [
    asked.deliverability ? 'deliverability' : undefined,
    asked.schedules ? 'scheduled jobs' : undefined,
    asked.endpoints !== false ? 'endpoints' : undefined,
  ].filter((one): one is string => one !== undefined);
  const { fewest, most } = auditRequestsOf(asked);
  const cost = fewest === most ? `${most}` : `${fewest} to ${most}`;
  return `audits after the apply: ${what.join(', ')}, about ${cost} API requests`;
}

/** The findings of an answer: what `--fail-on-findings` ends 3 on. */
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

/** An instant as a line says it: to the second. */
function secondOf(instant: string): string {
  return instant.replace(/\.\d{3}Z$/, 'Z');
}

/** The org as the first line names it: its kind, a sandbox by its My Domain. */
function orgWords(org: EnvAuditResult['org']): string {
  const myDomain = sandboxMyDomainOf(org.host);
  const kind =
    org.kind === 'sandbox'
      ? myDomain !== undefined
        ? `sandbox ${myDomain}`
        : 'sandbox'
      : org.kind === 'scratch'
        ? 'scratch org'
        : 'Developer Edition org';
  return org.alias !== undefined
    ? `${org.alias} (${kind}, ${org.organizationId})`
    : `${org.organizationId} (${kind})`;
}

/** Whether the scheduled jobs were not read at all: nothing counted, nothing compared. */
function schedulesUnread(schedules: NonNullable<EnvAuditResult['schedules']>): boolean {
  return (
    schedules.unread !== undefined &&
    schedules.now === 0 &&
    schedules.jobs.length === 0 &&
    schedules.kept === 0 &&
    schedules.against === undefined
  );
}

/**
 * What the audits say on a terminal, from their answer: the deliverability,
 * the scheduled jobs and the endpoints, each read, or not read and why.
 *
 * @param input.file - The file as the line named it, for the line that saves an inventory.
 * @param input.notes - What the read said beside its answer ({@link AuditsRead}).
 */
export function auditLines(
  result: EnvAuditResult,
  input: { file: string; notes?: readonly string[] },
): string[] {
  const lines: string[] = [];
  const requests = `${result.apiRequests} API request${result.apiRequests === 1 ? '' : 's'}`;
  lines.push(`audit of ${orgWords(result.org)}, ${secondOf(result.at)}, ${requests}`);

  const deliverability = result.deliverability;
  if (deliverability?.read === 'closed') {
    lines.push(
      'deliverability: closed — System email only or No access: what runs there emails nobody. ' +
        'Which of the two, no API says.',
    );
  } else if (deliverability?.read === 'open') {
    lines.push(
      'deliverability: open — All email: what runs there emails whoever its records name, the ' +
        "addresses copied from production's among them.",
    );
  } else if (deliverability?.unread !== undefined) {
    lines.push(`deliverability: not read — ${deliverability.unread}`);
  }

  const schedules = result.schedules;
  if (schedules !== undefined && schedulesUnread(schedules)) {
    lines.push(`scheduled jobs: not read — ${schedules.unread ?? ''}`);
  } else if (schedules !== undefined) {
    const against = schedules.against;
    const sandbox = result.org.kind === 'sandbox' ? 'this sandbox' : 'this org';
    if (against === undefined) {
      const host = result.org.host ?? 'its host';
      lines.push(
        `scheduled jobs: ${schedules.now} now, nothing to compare them with: no inventory of ` +
          `${host} is kept on this machine`,
      );
    } else {
      lines.push(
        `scheduled jobs: ${schedules.now} now, against the inventory saved on ` +
          `${against.savedAt.slice(0, 10)} from ${against.organizationId}, ` +
          (against.refreshed ? `${sandbox} before its refresh` : `${sandbox}: no refresh since`),
      );
    }
    for (const job of schedules.jobs) {
      const label = `  ${job.status.padEnd(8)} `;
      const runs = (who: string): string =>
        `${label}${job.name} (${job.type}) runs as ${job.owner ?? 'a user not read'}, who is ` +
        `${who}: its next run${job.nextFireTime !== undefined ? `, ${secondOf(job.nextFireTime)},` : ''} fails`;
      if (job.status === 'gone') {
        const of =
          job.cronExpression !== undefined ? `${job.type}, ${job.cronExpression}` : job.type;
        lines.push(
          `${label}${job.name} (${of}): ` +
            (against?.refreshed === true
              ? 'scheduled before the refresh, not since'
              : `in the inventory of ${against?.savedAt.slice(0, 10) ?? '?'}, not since`),
        );
      } else if (job.status === 'frozen' || job.status === 'inactive') {
        lines.push(runs(job.status));
      } else {
        lines.push(`${label}${job.name} (${job.type})`);
      }
    }
    if (against !== undefined) lines.push(`  ${'kept'.padEnd(8)} ${schedules.kept}`);
    if (schedules.unread !== undefined) lines.push(`  not read: ${schedules.unread}`);
    if (schedules.saved !== undefined) {
      lines.push(`  inventory saved in ${schedules.saved}, to compare with after the next refresh`);
    } else if (against === undefined) {
      const org = result.org.alias ?? result.org.organizationId;
      lines.push(
        `  before the next refresh, keep one: ${commandOf('env')} audit --file ${input.file} ` +
          `--org ${org} --save`,
      );
    }
  }
  for (const note of input.notes ?? []) lines.push(`  ${note}`);

  const endpoints = result.endpoints;
  if (endpoints !== undefined) {
    const hosts = endpoints.productionHosts.join(', ');
    const none = endpoints.found.length === 0;
    lines.push(
      `endpoints that still name production (${hosts}):` +
        (none ? (endpoints.unread !== undefined ? ' none among those read' : ' none') : ''),
    );
    if (endpoints.notDeduced !== undefined) lines.push(`  ${endpoints.notDeduced}`);
    const width = (values: string[]): number => Math.max(...values.map((one) => one.length)) + 2;
    const sources = endpoints.found.map((one) => ENDPOINT_SOURCE_WORDS[one.source]);
    const names = endpoints.found.map((one) => one.name);
    const urls = endpoints.found.map((one) => one.url);
    endpoints.found.forEach((one, at) => {
      lines.push(
        `  ${(sources[at] ?? '').padEnd(width(sources))}${(names[at] ?? '').padEnd(width(names))}` +
          `${one.url.padEnd(width(urls))}${ENDPOINT_WHY_WORDS[one.why]}`,
      );
    });
    if (endpoints.unread !== undefined) lines.push(`  not read: ${endpoints.unread}`);
  }
  if (result.findings > 0) {
    lines.push('SandForge changes none of these: Setup, sf or your deployment put them right.');
  }
  return lines;
}

/**
 * How `env audit` ends: 1 when `--save` could not keep the jobs it read,
 * 3 on findings with `--fail-on-findings`, 0 otherwise — an audit not read
 * included, and a `--save` it left nothing to keep.
 */
export function auditExitCode(read: AuditsRead, failOnFindings: boolean): number {
  if (read.saveFailed !== undefined) return FAILED_EXIT;
  return failOnFindings && read.result.findings > 0 ? PARTIAL_EXIT : DONE_EXIT;
}

/** What `env audit` ends with: its answer, its lines and its exit code, or the refusal of its line. */
export type AuditVerbOutcome =
  | { result: EnvAuditResult; lines: string[]; exitCode: number }
  | { refusal: { code: string; message: string }; exitCode: number };

/**
 * `sandforge env audit`: the audits the file does not turn off, read from the
 * org the guards typed. A `--save` the file leaves nothing to save for is
 * refused before any request.
 *
 * @param input.audits - The file's `audits`.
 * @param input.file - The file as the line named it.
 */
export async function auditVerb(
  deps: AuditDeps,
  input: {
    org: AuditOrgInput;
    audits: EnvAudits | undefined;
    file: string;
    save: boolean;
    failOnFindings: boolean;
  },
): Promise<AuditVerbOutcome> {
  const asked = auditsAskedOf(input.audits, 'verb');
  if (asked === undefined) throw new Error('env audit reads the deliverability at least');
  if (input.save && !asked.schedules) {
    return {
      refusal: {
        code: 'BAD_LINE',
        message:
          '--save keeps the scheduled jobs, which the file does not read (audits.schedules: ' +
          'false): take --save off the line, or the line off the file. Nothing was read.',
      },
      exitCode: BAD_LINE_EXIT,
    };
  }
  const read = await readAudits(deps, { org: input.org, asked, save: input.save });
  const lines = auditLines(read.result, { file: input.file, notes: read.notes });
  return { result: read.result, lines, exitCode: auditExitCode(read, input.failOnFindings) };
}
