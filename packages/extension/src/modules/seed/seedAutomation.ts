/**
 * What a seed's target runs as the seed creates its records, read before the
 * first is written: the record-triggered flows, Apex triggers, processes and
 * workflow rules that fire on insert, what of them sends emails or creates
 * records, and the custom permissions that keep them quiet — Forge's read of
 * the target's automation (`TargetAutomationReader`), on the objects the
 * template writes. And the seed's email gate: the emails those records make
 * the target send, against what it has left today of its daily limits,
 * refused past them — Autopilot's gate (`emailChecksOf`), on the template's
 * counts.
 *
 * On 2026-10-20 a seed of the CRM starter, 75 contacts, into a Developer
 * Edition left its single emails at −60 of 15: a workflow rule of the org
 * emailed every contact created, and nothing said so before the run. An org
 * whose automation emails each new contact spends its day of emails on a
 * seed, and its own flows that send in the save refuse their records for the
 * rest of the day (`CANNOT_EXECUTE_FLOW_TRIGGER`). Seed read none of it.
 */

import type {
  ForgeEmailLimit,
  ForgeEmailsPerInsert,
  ForgeTargetAutomation,
  ForgeTargetObjectAutomation,
  SeedAutomationEntry,
  SeedAutomationObject,
  SeedAutomationPreview,
  SeedBypassWay,
} from '@sandforge/shared';
import {
  automationByWrite,
  blindedBy,
  bypassAssignmentsOf,
  emailsPerInsertOf,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { emailChecksOf, type EmailCheck, type EmailLimit } from '../forge/ForgeRunGate.js';

/** The single emails a day of a Developer Edition. */
export const DEVELOPER_EDITION_SINGLE_EMAILS = 15;

/** What `/limits` said of an org's daily email limits, or why it said nothing. */
export type EmailLimits = Partial<Record<ForgeEmailLimit, EmailLimit>> | { unread: string };

/** Whether the limits could not be read. */
function isUnread(limits: EmailLimits): limits is { unread: string } {
  return typeof (limits as { unread?: unknown }).unread === 'string';
}

/**
 * Whether the email alerts of an org count against its single emails too: an
 * org held to the fifteen single emails a day of a Developer Edition.
 *
 * Twice the trap Developer Edition counted the email alert of its contact
 * workflow rule against its single emails, its contact flow quiet for the
 * user who wrote: on 2026-10-14, 36 contacts cloned took them from −75 to
 * −117 while its workflow emails did not move; on 2026-10-20, 75 contacts
 * seeded took them from 15 to −60. Counted as workflow emails alone, 8,040 a
 * day there, the 75 contacts fitted.
 */
export function alertsCountAsSingle(limits: Partial<Record<ForgeEmailLimit, EmailLimit>>): boolean {
  const single = limits.SingleEmail;
  return single !== undefined && single.max <= DEVELOPER_EDITION_SINGLE_EMAILS;
}

/**
 * The emails each record of an object makes the org send, per daily limit:
 * what fires on its insert that no bypass of the user the seed writes as keeps
 * quiet (`emailsPerInsertOf`), the email alerts counted against the single
 * emails as well where the org counts them there.
 *
 * @param alertsAsSingle - Whether the org counts its email alerts against its
 *   single emails ({@link alertsCountAsSingle}).
 */
export function seedEmailsPerRecord(
  perInsert: readonly ForgeEmailsPerInsert[],
  alertsAsSingle: boolean,
): ForgeEmailsPerInsert[] {
  const out = perInsert.map((sending) => ({ ...sending, sentBy: [...sending.sentBy] }));
  if (!alertsAsSingle) return out;
  for (const alert of perInsert.filter((sending) => sending.limit === 'DailyWorkflowEmails')) {
    const single = out.find(
      (sending) => sending.objectApiName === alert.objectApiName && sending.limit === 'SingleEmail',
    );
    if (!single) {
      out.push({ ...alert, limit: 'SingleEmail', sentBy: [...alert.sentBy] });
      continue;
    }
    single.perRecord += alert.perRecord;
    for (const name of alert.sentBy) if (!single.sentBy.includes(name)) single.sentBy.push(name);
  }
  return out;
}

/** What fires as the records of `object` are created, as the confirmation says it. */
function entriesOnInsert(object: ForgeTargetObjectAutomation): SeedAutomationEntry[] {
  const fired = automationByWrite(object).find((entry) => entry.write === 'insert')?.fired ?? [];
  return fired.map((entry): SeedAutomationEntry => {
    const flow = entry.flow;
    const messages = flow?.messages ?? [];
    return {
      kind: entry.kind,
      name: entry.name,
      when: entry.when,
      emails: messages.filter((message) => message.kind === 'email').length,
      messages: [
        ...new Set(messages.flatMap((message) => (message.kind === 'email' ? [] : [message.kind]))),
      ],
      creates: [...(flow?.creates ?? [])],
      afterCommit: (flow?.paths?.length ?? 0) > 0,
      bypasses: (flow?.permissions ?? [])
        .filter((permission) => permission.bypass)
        .map(({ name, held }) => (held === undefined ? { name } : { name, held })),
      keptQuiet: entry.keptQuiet === true,
      unread: flow !== undefined && flow.condition !== 'read',
    };
  });
}

/** Names, each once, in name order. */
function sortedOnce(names: readonly string[]): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/**
 * What the target runs as a seed creates the records of the objects read, in
 * the words the confirmation and the command line say it, with the emails
 * each record sends and what the target has left of its daily limits.
 *
 * @param org - The target, as the panel or the command line names it.
 * @param limits - What its `/limits` said; `{}` when they were not read, no
 *   record sending any.
 */
export function seedAutomationPreview(
  automation: ForgeTargetAutomation,
  org: string,
  limits: EmailLimits,
): SeedAutomationPreview {
  const objects = automation.objects.flatMap((object): SeedAutomationObject[] => {
    const entries = entriesOnInsert(object);
    return entries.length > 0 ? [{ objectApiName: object.objectApiName, entries }] : [];
  });
  const read = isUnread(limits) ? undefined : limits;
  const alertsAsSingle = read !== undefined && alertsCountAsSingle(read);
  const emailsPerRecord = seedEmailsPerRecord(emailsPerInsertOf(automation), alertsAsSingle);
  const bypasses = objects.flatMap((object) => object.entries.flatMap((entry) => entry.bypasses));
  const held = sortedOnce(bypasses.filter((b) => b.held === true).map((b) => b.name));
  const toAssign = sortedOnce(bypasses.map((b) => b.name)).filter((name) => !held.includes(name));
  const assignments = bypassAssignmentsOf(automation, toAssign);
  const ways = toAssign.map((permission): SeedBypassWay => {
    const set = assignments.find(
      (a) => a.permission.toLowerCase() === permission.toLowerCase(),
    )?.permissionSet;
    return set ? { permission, permissionSet: set.name } : { permission };
  });
  return {
    org,
    objectsRead: [...automation.objectsRead],
    objects,
    emailsPerRecord,
    ...(read && emailsPerRecord.length > 0 ? { limits: { ...read } } : {}),
    ...(isUnread(limits) ? { limitsUnread: limits.unread } : {}),
    alertsAsSingle,
    bypasses: ways,
    bypassesHeld: held,
    unread: automation.unread.map(({ part, reason }) => ({ part, reason })),
    blinded: blindedBy(automation.unread),
    conditionsNotRead: automation.conditionsNotRead,
  };
}

/** What a read of a seed's target came to: what it runs, or why it could not be read at all. */
export type SeedAutomationRead = { preview: SeedAutomationPreview } | { error: string };

/**
 * Read what the target runs on the objects a seed writes, and the daily
 * email limits it has left when a record sends any, as Autopilot reads them.
 * Never throws: a read that fails says why, and the seed is not held back.
 *
 * @param input.readAutomation - What the target runs on the given objects.
 * @param input.readLimits - The target's daily email limits, as `/limits` say them.
 */
export async function readSeedAutomation(input: {
  org: string;
  objects: readonly string[];
  readAutomation: (objects: readonly string[]) => Promise<ForgeTargetAutomation>;
  readLimits: () => Promise<Partial<Record<ForgeEmailLimit, EmailLimit>>>;
}): Promise<SeedAutomationRead> {
  let automation: ForgeTargetAutomation;
  try {
    automation = await input.readAutomation(input.objects);
  } catch (err: unknown) {
    return { error: extractErrorMessage(err) };
  }
  if (emailsPerInsertOf(automation).length === 0) {
    return { preview: seedAutomationPreview(automation, input.org, {}) };
  }
  const limits: EmailLimits = await input
    .readLimits()
    .catch((err: unknown) => ({ unread: extractErrorMessage(err) }));
  return { preview: seedAutomationPreview(automation, input.org, limits) };
}

/** How each daily limit is said. */
const LIMIT_WORDS: Readonly<Record<ForgeEmailLimit, string>> = {
  SingleEmail: 'single emails',
  DailyWorkflowEmails: 'workflow emails',
};

/** Items joined as a sentence lists them: "a", "a and b", "a, b, and c". */
function listed(items: readonly string[], last = 'and'): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} ${last} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, ${last} ${items[items.length - 1]}`;
}

/** What a refusal for the emails names: the first limit past what is left, and the ways out. */
export interface SeedEmailRefusalFigures {
  org: string;
  limit: ForgeEmailLimit;
  emails: number;
  remaining: number;
  max: number;
  /** The objects whose records send them. */
  objects: string[];
  /** The flows, processes and rules that send them. */
  senders: string[];
  /** The bypasses that keep senders quiet, the permission set that holds each, and the senders it quiets. */
  bypasses: Array<SeedBypassWay & { quiets: string[] }>;
}

/** What a seed's email gate came to. */
export interface SeedEmailGate {
  /** One per daily limit the records send against. */
  checks: EmailCheck[];
  /** Why nothing is written: the records take the org past what it has left today. */
  refusal?: string;
  /** The figures of the refusal, as the panel says them. */
  figures?: SeedEmailRefusalFigures;
  /** Why the emails could not all be counted against what is left: the seed runs, and this is said. */
  unknown?: string[];
}

/**
 * Hold a seed's records to the daily email limits its target has left:
 * refused past one, before anything is written, with the figures and the ways
 * out — lower the counts, leave the object out, turn off what sends or give
 * the user the seed writes as the bypass that keeps it quiet — as a seed past
 * its storage is refused. An estimate that cannot be made — the automation or
 * the limits unread — lets the seed through, and says so.
 *
 * @param objects - The records the seed creates, by object.
 */
export function seedEmailGate(
  read: SeedAutomationRead,
  objects: ReadonlyArray<{ objectApiName: string; recordCount: number }>,
  org: string,
): SeedEmailGate {
  if ('error' in read) {
    return {
      checks: [],
      unknown: [
        `what ${org} runs as these records are created could not be read (${read.error}): the ` +
          'emails they make it send are not known',
      ],
    };
  }
  const { preview } = read;
  const plan = {
    objects: objects.map((o) => ({
      objectApiName: o.objectApiName,
      rows: o.recordCount,
      storageBytes: 0,
    })),
  };
  const limits: EmailLimits =
    preview.limitsUnread !== undefined ? { unread: preview.limitsUnread } : (preview.limits ?? {});
  const checks = emailChecksOf(plan, preview.emailsPerRecord, limits);
  const unknown = [
    ...checks
      .filter((check) => check.verdict === 'unread')
      .map(
        (check) =>
          `about ${check.emails} ${LIMIT_WORDS[check.limit]}, but what ${org} has left today ` +
          `could not be read (${check.unread ?? 'not said'})`,
      ),
    ...(preview.blinded
      ? [`part of what ${org} runs could not be read: emails it sends may not be counted`]
      : []),
    ...(preview.conditionsNotRead > 0
      ? [
          `${preview.conditionsNotRead} start condition(s) of ${org} not read: the emails of ` +
            'those flows are not counted',
        ]
      : []),
  ];
  const over = checks.find((check) => check.verdict === 'exceeds');
  if (!over) return unknown.length > 0 ? { checks, unknown } : { checks };

  const exceeding = checks.filter((check) => check.verdict === 'exceeds');
  const sending = sortedOnce(exceeding.flatMap((c) => c.objects.map((o) => o.objectApiName)));
  const senders = sortedOnce(exceeding.flatMap((c) => c.objects.flatMap((o) => o.sentBy)));
  // What each bypass keeps quiet of what sends: holding it may leave others sending.
  const quieted = new Map<string, Set<string>>();
  for (const entry of preview.objects.flatMap((object) => object.entries)) {
    if (entry.emails === 0 || !senders.includes(entry.name)) continue;
    for (const { name } of entry.bypasses) {
      quieted.set(name, (quieted.get(name) ?? new Set()).add(entry.name));
    }
  }
  const bypasses = preview.bypasses.flatMap((way) => {
    const quiets = quieted.get(way.permission);
    return quiets ? [{ ...way, quiets: sortedOnce([...quiets]) }] : [];
  });
  const said = exceeding
    .map(
      (check) =>
        `about ${check.emails} ${LIMIT_WORDS[check.limit]} (` +
        check.objects.map((o) => `${o.perRecord} per ${o.objectApiName}`).join(', ') +
        `), ${check.remaining ?? 0} of ${check.max ?? 0} left today`,
    )
    .join('; ');
  const ways = [
    'lower the record counts',
    `set ${listed(sending)} to 0`,
    `turn off ${listed(senders.map((name) => `"${name}"`))}`,
    ...bypasses.map(
      (way) =>
        'give the user the seed writes as ' +
        (way.permissionSet
          ? `the permission set ${way.permissionSet}, whose ${way.permission}`
          : `a permission set holding ${way.permission}, which`) +
        ` keeps ${listed(way.quiets.map((name) => `"${name}"`))} quiet`,
    ),
  ];
  const refusal =
    `The seed was refused before it wrote anything: its records would make ${org} send ${said}. ` +
    'Past what is left, a flow that sends in the save refuses its record ' +
    "(CANNOT_EXECUTE_FLOW_TRIGGER), and the org's own emails stop for the rest of the day. " +
    `To seed it, ${listed(ways, 'or')}. Nothing was written.`;
  return {
    checks,
    refusal,
    figures: {
      org,
      limit: over.limit,
      emails: over.emails,
      remaining: over.remaining ?? 0,
      max: over.max ?? 0,
      objects: sending,
      senders,
      bypasses,
    },
    ...(unknown.length > 0 ? { unknown } : {}),
  };
}

/** What runs, by kind, as the command line names it. */
const KIND_WORDS: Readonly<Record<SeedAutomationEntry['kind'], (name: string) => string>> = {
  flow: (name) => `flow "${name}"`,
  trigger: (name) => `Apex trigger ${name}`,
  process: (name) => `process "${name}"`,
  workflowRule: (name) => `workflow rule "${name}"`,
};

const WHEN_WORDS: Readonly<Record<SeedAutomationEntry['when'], string>> = {
  before: 'before save',
  after: 'after save',
  beforeAndAfter: 'before and after save',
};

const MESSAGE_WORDS: Readonly<Record<SeedAutomationEntry['messages'][number], string>> = {
  notification: 'custom notifications',
  outbound: 'outbound messages',
  sms: 'text messages',
};

/** What the command line says of one flow, trigger, process or rule a seed's inserts fire. */
function entryWords(entry: SeedAutomationEntry): string {
  const held = (b: { held?: boolean }): string =>
    b.held === true ? ' (held)' : b.held === false ? ' (not held)' : '';
  const notes = [
    WHEN_WORDS[entry.when],
    ...(entry.emails > 0 ? [`${entry.emails} email(s) a record`] : []),
    ...entry.messages.map((kind) => `sends ${MESSAGE_WORDS[kind]}`),
    ...(entry.creates.length > 0 ? [`creates ${entry.creates.join(', ')}`] : []),
    ...(entry.afterCommit ? ['then after commit'] : []),
    ...(entry.bypasses.length > 0
      ? [`not for a user with ${entry.bypasses.map((b) => b.name + held(b)).join(', ')}`]
      : []),
    ...(entry.keptQuiet ? ['quiet for this seed'] : []),
    ...(entry.unread ? ['what it does was not read'] : []),
  ];
  return `${KIND_WORDS[entry.kind](entry.name)} (${notes.join('; ')})`;
}

/**
 * What the command line says of the target's automation before a seed
 * writes, dry run included: per object, what its inserts fire; the bypasses
 * held and those that would keep it quiet; what could not be read.
 *
 * @param target - The target, as the command names it.
 */
export function seedAutomationLines(read: SeedAutomationRead, target: string): string[] {
  if ('error' in read) {
    return [
      `target automation: what ${target} runs as these records are created could not be read ` +
        `(${read.error}): the emails they make it send are not known`,
    ];
  }
  const { preview } = read;
  const lines = [`target automation: what ${target} runs as these records are created`];
  for (const object of preview.objects) {
    lines.push(`  ${object.objectApiName}: ${object.entries.map(entryWords).join(', ')}`);
  }
  if (preview.objects.length === 0) {
    lines.push(
      preview.blinded
        ? '  nothing found in what could be read'
        : '  nothing runs on them: no flow, Apex trigger, process or workflow rule',
    );
  }
  if (preview.bypassesHeld.length > 0) {
    lines.push(
      `  bypass held: the user the seed writes as holds ${preview.bypassesHeld.join(', ')}, and ` +
        'what names it stays quiet',
    );
  }
  for (const way of preview.bypasses) {
    lines.push(
      way.permissionSet
        ? `  bypass: ${way.permission} keeps quiet what names it; permission set ` +
            `${way.permissionSet} holds it`
        : `  bypass: ${way.permission} keeps quiet what names it; no permission set of ${target} ` +
            'was found to hold it',
    );
  }
  if (
    preview.alertsAsSingle &&
    preview.emailsPerRecord.some((sending) => sending.limit === 'DailyWorkflowEmails')
  ) {
    lines.push(
      `  ${target} counts its email alerts against its single emails too, as a Developer ` +
        'Edition does',
    );
  }
  for (const { part, reason } of preview.unread) {
    lines.push(`  ${part} could not be read: ${reason}`);
  }
  if (preview.conditionsNotRead > 0) {
    lines.push(`  ${preview.conditionsNotRead} start condition(s) not read`);
  }
  return lines;
}
