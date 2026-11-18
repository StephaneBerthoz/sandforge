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
 * How the audits are read lives in the extension
 * (`src/modules/audit/readAudits.ts`), where the panel can reach it: this
 * file says what they read on a terminal, and how the command ends.
 */

import type { EnvAuditResult, EnvAudits } from '@sandforge/shared';
import {
  ENDPOINT_SOURCE_WORDS,
  ENDPOINT_WHY_WORDS,
} from '../../../src/modules/audit/endpointsAudit.js';
import { sandboxMyDomainOf } from '../../../src/modules/audit/orgHost.js';
import {
  auditRequestsOf,
  auditsAskedOf,
  readAudits,
  type AuditDeps,
  type AuditOrgInput,
  type AuditsAsked,
  type AuditsRead,
} from '../../../src/modules/audit/readAudits.js';
import type { CommandFlags } from '../../commandLine.js';
import { DONE_EXIT, FAILED_EXIT, PARTIAL_EXIT } from '../../exitCodes.js';
import { commandOf } from '../../invocation.js';

export { auditsAskedOf, readAudits, type AuditOrgInput };

/** What `env audit` reads of its line, after its word. */
export const AUDIT_FLAGS: CommandFlags = {
  words: 1,
  switches: ['--json', '--save', '--fail-on-findings'],
  values: ['--file', '--org', '--alias'],
};

/** The exit code of a line that cannot be run as given. */
const BAD_LINE_EXIT = 2;

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
