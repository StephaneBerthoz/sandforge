/**
 * The sections of a handoff note that hold whatever handed the sandbox back,
 * an apply of `sandforge env` or the panel: its title and its org, what is
 * left to do in the order a refresh's checklist does it, and what SandForge
 * leaves to others.
 *
 * They are made from what the audits read (`readAudits.ts`) and read nothing
 * of the org. They name objects, jobs by their names, users by their
 * usernames and endpoints by their hosts — never a value of a record, never
 * a URL, never a word the org said: those may quote what a record holds.
 * What reads an audit that was not read is the caller's to say: a command
 * line, or a page.
 */

import type { EnvAuditResult } from '@sandforge/shared';
import { ENDPOINT_SOURCE_WORDS, ENDPOINT_WHY_WORDS } from './endpointsAudit.js';
import { sandboxMyDomainOf } from './orgHost.js';
import type { AuditOrgInput } from './readAudits.js';

/** The heading of what is left to do. */
export const STILL_TO_DO_HEADING = '## Still to do, in this order';

/** The heading of what SandForge leaves to others. */
export const NOT_TOUCHED_HEADING = '## Not touched by SandForge';

/** A name the note gives, on one line, as code: nothing in it closes the span or breaks the line. */
export function code(name: string): string {
  return `\`${name.replace(/[`\r\n]+/g, ' ').trim()}\``;
}

/** Words on one line: nothing in them breaks the note's structure. */
function plain(words: string): string {
  return words.replace(/[\r\n]+/g, ' ').trim();
}

/** An instant to the second. */
export function secondOf(instant: string): string {
  return instant.replace(/\.\d{3}Z$/, 'Z');
}

/** The note's title: what handed the org back, on which org. */
export function handoffTitleOf(subject: string, org: AuditOrgInput): string {
  return `# Handoff: ${code(subject)} on ${code(org.alias ?? org.organizationId)}`;
}

/** The org, as the note names it: its alias, its kind, a sandbox by its My Domain, and its Id. */
export function orgLineOf(org: AuditOrgInput): string {
  const myDomain = sandboxMyDomainOf(org.host);
  const kind =
    org.kind === 'sandbox'
      ? `sandbox${myDomain !== undefined ? ` ${code(myDomain)}` : ''}`
      : org.kind === 'scratch'
        ? 'scratch org'
        : 'Developer Edition org';
  return `- Org: ${org.alias !== undefined ? `${code(org.alias)}, ` : ''}${kind}, ${code(org.organizationId)}.`;
}

/**
 * What reads an audit that was not read, after "Not audited: ": the line of
 * a command, or the step of a page.
 */
export interface StillToDoReaders {
  endpoints: string;
  schedules: string;
}

/** The audits a note reads what is left from. */
export type HandoffAudits = Pick<EnvAuditResult, 'deliverability' | 'schedules' | 'endpoints'>;

/** The section of what is left, in the order a refresh's checklist takes it. */
export function stillToDoLines(
  audits: HandoffAudits | undefined,
  readers: StillToDoReaders,
): string[] {
  const lines: string[] = [STILL_TO_DO_HEADING, ''];

  lines.push('1. Credentials and technical components: point them away from production.');
  const endpoints = audits?.endpoints;
  if (endpoints === undefined) {
    lines.push(`   - Not audited: ${readers.endpoints}`);
  } else {
    for (const one of endpoints.found) {
      lines.push(
        `   - ${ENDPOINT_SOURCE_WORDS[one.source]} ${code(one.name)} names ${code(one.host)}, ${ENDPOINT_WHY_WORDS[one.why]}.`,
      );
    }
    if (endpoints.found.length === 0 && endpoints.unread === undefined) {
      lines.push('   - None of those read names production.');
    }
    if (endpoints.unread !== undefined) {
      lines.push(
        '   - Not all read: check the Named Credentials, the Remote Site Settings and the ' +
          'Custom Metadata in Setup.',
      );
    }
  }

  lines.push(
    '2. Scheduled jobs: schedule again those gone, and give those stuck a user who can run them.',
  );
  const schedules = audits?.schedules;
  if (schedules === undefined) {
    lines.push(`   - Not audited: ${readers.schedules}`);
  } else {
    for (const job of schedules.jobs) {
      if (job.status === 'gone') {
        lines.push(
          `   - ${code(job.name)} (${plain(job.type)}) was scheduled in the inventory of ` +
            `${schedules.against?.savedAt.slice(0, 10) ?? '?'}, and is not now.`,
        );
      } else if (job.status === 'frozen' || job.status === 'inactive') {
        lines.push(
          `   - ${code(job.name)} (${plain(job.type)}) runs as ${job.owner !== undefined ? code(job.owner) : 'a user not read'}, ` +
            `who is ${job.status}: its next run fails.`,
        );
      }
    }
    if (schedules.against === undefined) {
      lines.push(
        '   - No inventory from before the refresh was kept on this machine: what is gone is not ' +
          'known.',
      );
    }
    if (schedules.unread !== undefined)
      lines.push('   - Not all read: Setup > Scheduled Jobs lists them.');
    if (!schedules.jobs.some((job) => job.status !== 'new') && schedules.unread === undefined) {
      lines.push(
        schedules.against !== undefined ? '   - None gone, none stuck.' : '   - None stuck.',
      );
    }
  }

  lines.push(
    '3. Automations that send emails — flows, workflow rules, Apex —: turn them on last, once the ' +
      'addresses and the masking are as the testers need them.',
  );

  lines.push('4. Deliverability.');
  const deliverability = audits?.deliverability;
  if (deliverability?.read === 'closed') {
    lines.push(
      '   - Read closed, System email only or No access: leave it so until the masking is done.',
    );
  } else if (deliverability?.read === 'open') {
    lines.push(
      '   - Read open, All email: what runs there emails whoever its records name. Set it to ' +
        'System email only in Setup > Deliverability until the masking is done.',
    );
  } else {
    lines.push('   - Not read: Setup > Deliverability shows it.');
  }
  return lines;
}

/** What SandForge leaves to others, each with whose it is. */
const NOT_TOUCHED: readonly string[] = [
  '- Named and External Credentials: Setup, or a deployment of your project by `sf`.',
  '- Metadata: your deployment.',
  '- Single sign-on and DKIM keys: Setup.',
  '- Deliverability: Setup > Deliverability.',
  "- Passwords: each user's own, by Forgot your password? on the sandbox's login page.",
];

/** The section of what SandForge leaves to others: its heading, then each thing and whose it is. */
export function notTouchedLines(): string[] {
  return [NOT_TOUCHED_HEADING, '', ...NOT_TOUCHED];
}
