/**
 * What the org runs as a DataOps act writes records it already holds, read
 * before the act's question and again before its first write: a masking
 * updates every record of its objects, a restore of a backup brings back
 * from the recycle bin what was deleted since and writes the backup's values
 * back, a cleanup deletes. Each fires what the org runs on that write — its
 * record-triggered flows, Apex triggers, processes and workflow rules — and
 * DataOps read none of it: a masking of every contact ran the org's "on
 * update" flows, emails among them, with no question and no way to keep them
 * quiet, where Forge, Sync, Seed and Frozen list what fires, ask, and offer
 * the mute.
 *
 * Nothing here is a mechanism of its own. What fires is Forge's read
 * (`TargetAutomationReader`) on the act's steps, as a removal's are read
 * (`firedOnRemovalStepsOf`); the emails are counted as a rewind counts those
 * of its updates and deletes (`checkpointEmails`), against what the org has
 * left today; whether the org delivers them is Forge's gate
 * (`runEmailsOf`), read with one line of anonymous Apex that sends nothing;
 * the mute is the lease every run takes (`muteForRun`). Refused as the other
 * modules refuse: what fires, unless accepted (`AUTOMATION_NOT_ACCEPTED`);
 * past the day's emails, whatever is accepted (`EMAILS_EXCEEDED`); emails the
 * org delivers, unless accepted on their own (`EMAILS_NOT_ACCEPTED`), which
 * the acceptance of the automation never stands for.
 */

import type {
  CheckpointEmails,
  DataOpsAct,
  DataOpsAutomationAnswer,
  DataOpsAutomationObject,
  DataOpsAutomationRefusal,
  DataOpsWriteAccord,
  ForgeEmailLimit,
  ForgeFiredOnRemovalStep,
  ForgeRemovalSteps,
  ForgeTargetAutomation,
} from '@sandforge/shared';
import {
  emailsPerWriteOf,
  firedOnRemovalStepsOf,
  heldBypassPermissionsOf,
  removalStepsBypassesOf,
  removalStepsWrites,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import {
  automationUnreadOf,
  bypassAssistantSentences,
  bypassesToAssign,
  readEmailLimits,
  type EmailLimit,
  type LimitsTransport,
} from '../forge/ForgeRunGate.js';
import {
  NO_APEX_IN_PRODUCTION,
  readEmailDeliverability,
  runEmailsOf,
  type DeliverabilityRead,
  type RunEmails,
} from '../forge/targetDeliverability.js';
import {
  isMuteRefusedError,
  muteForRun,
  muteLines,
  muteOrgOf,
  type HeldMute,
  type MuteLeaseOptions,
  type MuteOrg,
  type RunMute,
} from '../forge/AutomationMuteLease.js';
import {
  checkpointEmails,
  checkpointEmailsUncounted,
  type EmailLimits,
  type WrittenRecords,
} from '../checkpoint/rewindEmails.js';

/** The code an act is refused under when what fires was not accepted. */
export const AUTOMATION_NOT_ACCEPTED = 'AUTOMATION_NOT_ACCEPTED';

/** The code an act is refused under past the emails the org has left today: nothing lifts it. */
export const EMAILS_EXCEEDED = 'EMAILS_EXCEEDED';

/**
 * What each step of an act writes, as a removal's steps are written: a
 * masking updates (`giveBack`), a restore brings back from the recycle bin
 * then updates, a cleanup deletes. What fires, its mute and its emails are
 * read on these, as they are of a removal.
 */
export function dataOpsStepsOf(act: DataOpsAct, objects: readonly string[]): ForgeRemovalSteps {
  if (act === 'cleanup') return { delete: [...objects] };
  if (act === 'restore') return { bringBack: [...objects], giveBack: [...objects] };
  return { giveBack: [...objects] };
}

/**
 * The records an act writes, per object and write, as the emails are counted
 * on them: every record a masking or a restore counts is updated, every one a
 * cleanup counts deleted. What a restore brings back from the recycle bin is
 * not counted apart: an undelete starts no flow, process or rule, and what its
 * Apex triggers send is read nowhere.
 */
export function dataOpsWrittenOf(
  act: DataOpsAct,
  objects: readonly DataOpsAutomationObject[],
): WrittenRecords[] {
  const write = act === 'cleanup' ? 'delete' : 'update';
  return objects
    .filter((object) => object.records > 0)
    .map((object) => ({ objectApiName: object.objectApiName, write, records: object.records }));
}

/** How each act is named, and what lifts its refusals. */
const ACT_WORDS: Readonly<
  Record<
    DataOpsAct,
    {
      heading: string;
      the: string;
      this: string;
      writes: string;
      verb: string;
      nothing: string;
      flag: string;
    }
  >
> = {
  masking: {
    heading: 'masking automation: what {org} runs as the masking writes over the records',
    the: 'the masking',
    this: 'this masking',
    writes: 'writes over',
    verb: 'mask',
    nothing: 'Nothing was written.',
    flag: 'to mask all the same',
  },
  restore: {
    heading: "restore automation: what {org} runs as the restore puts the backup's values back",
    the: 'the restore',
    this: 'this restore',
    writes: 'puts back',
    verb: 'restore',
    nothing: 'Nothing was written.',
    flag: 'to restore all the same',
  },
  cleanup: {
    heading: 'cleanup automation: what {org} runs as the cleanup deletes the records',
    the: 'the cleanup',
    this: 'this cleanup',
    writes: 'deletes',
    verb: 'delete',
    nothing: 'Nothing was deleted.',
    flag: 'to delete all the same',
  },
};

/**
 * Whose words an act's refusals are said in: the page's and the command
 * line's (`flags`), which name `--accept-automation` and its siblings; a
 * pipeline's Anonymize step (`step`), which nobody gives a flag to, and
 * which names its settings; a subject erasure (`erasure`), which writes over
 * or deletes as a masking or a cleanup does and is called by its own name.
 */
export type DataOpsVoice = 'flags' | 'step' | 'erasure';

/** The setting of a pipeline's step each flag stands for. */
const STEP_SETTINGS: Readonly<Record<string, string>> = {
  'accept-automation': 'acceptAutomation',
  'accept-emails': 'acceptEmails',
  'mute-automation': 'muteAutomation',
};

/**
 * A refusal in the voice of what asked for the act. The refusals of what
 * fires, of the emails and of a mute are worded once, for the command line,
 * here and in Forge's gate: a pipeline's step turns a setting on where the
 * command line adds a flag, and an erasure was told what "this cleanup"
 * would fire, an act it never asked for.
 */
export function dataOpsSaid(message: string, voice: DataOpsVoice = 'flags'): string {
  if (voice === 'step') {
    return message
      .replace(
        /--(accept-automation|accept-emails|mute-automation)\b/g,
        (_, flag: string) => `${STEP_SETTINGS[flag] ?? flag} in the step`,
      )
      .replace(
        /\bAdd (acceptAutomation|acceptEmails|muteAutomation) in the step\b/g,
        'Turn on $1 in the step',
      );
  }
  if (voice === 'erasure') {
    return message
      .replace(/\b(this|the|This|The) (masking|cleanup)\b/g, '$1 erasure')
      .replace(/\bto (mask|delete) all the same\b/g, 'to erase all the same');
  }
  return message;
}

/** When what fires on an update runs. */
const SAVE_WHEN: Readonly<Record<ForgeFiredOnRemovalStep['when'], string>> = {
  before: 'before save',
  after: 'after save',
  beforeAndAfter: 'before and after save',
};

/** When what fires on a delete runs. */
const DELETE_WHEN: Readonly<Record<ForgeFiredOnRemovalStep['when'], string>> = {
  before: 'before delete',
  after: 'after delete',
  beforeAndAfter: 'before and after delete',
};

/** How the command line names a part of the automation it could not read. */
const UNREAD_WORDS: Readonly<Record<string, string>> = {
  flows: 'the flows',
  triggers: 'the Apex triggers',
  processes: 'the Process Builder processes',
  workflowRules: 'the workflow rules',
  automation: 'the automation',
};

/** How the command line names what fires. */
function firedWords({ kind, name }: Pick<ForgeFiredOnRemovalStep, 'kind' | 'name'>): string {
  if (kind === 'flow') return `flow "${name}"`;
  if (kind === 'process') return `process "${name}"`;
  if (kind === 'workflowRule') return `workflow rule "${name}"`;
  return `Apex trigger ${name}`;
}

/** What the record a step writes goes through as it fires, and when. */
function stepWords(act: DataOpsAct, entry: ForgeFiredOnRemovalStep): string {
  if (entry.step === 'delete') return DELETE_WHEN[entry.when];
  if (entry.step === 'bringBack') return 'as it comes back from the recycle bin';
  return `${act === 'restore' ? 'as its values are put back' : 'as it is masked'}, ${SAVE_WHEN[entry.when]}`;
}

/** The first letter of a sentence, in capitals. */
function capitalized(words: string): string {
  return `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}`;
}

/**
 * What the command line says, before an act writes, of what the org runs as
 * it does: per object, what each of its writes fires, and when; that nothing
 * does; or what could not be read.
 *
 * @param read - What the org runs, read before any mute; or why it could not be read.
 */
export function dataOpsAutomationLines(
  read: Pick<ForgeTargetAutomation, 'objects' | 'unread'> | { unread: string },
  target: string,
  act: DataOpsAct,
  steps: ForgeRemovalSteps,
): string[] {
  const words = ACT_WORDS[act];
  const lines = [words.heading.replace('{org}', target)];
  if (typeof read.unread === 'string') {
    lines.push(`  what ${target} runs could not be read: ${read.unread}`);
    return lines;
  }
  const automation = read as Pick<ForgeTargetAutomation, 'objects' | 'unread'>;
  for (const entry of firedOnRemovalStepsOf(automation, steps)) {
    lines.push(`  ${entry.objectApiName}: ${stepWords(act, entry)}: ${firedWords(entry)}`);
  }
  const unread = automationUnreadOf(automation);
  if (lines.length === 1 && unread.length === 0) {
    const objects = new Set(Object.values(steps).flat()).size;
    lines.push(`  nothing fires on the ${objects} object(s) it ${words.writes} records of`);
  }
  const held = heldBypassPermissionsOf(automation);
  if (held.length > 0) {
    lines.push(
      `  bypass held: the user ${words.the} writes as holds ${held.join(', ')}, and what ` +
        'names it stays quiet',
    );
  }
  for (const { part, reason } of unread) {
    lines.push(`  ${UNREAD_WORDS[part] ?? part} could not be read: ${reason}`);
  }
  return lines;
}

/**
 * Why an act will not write without its automation accepted: what the org
 * runs as each of its writes goes, named — what the act's mute keeps quiet
 * left out when it mutes —, or what of it could not be read; then the
 * permission sets that would keep it quiet, and the mute that assigns them
 * for the act alone. Nothing when nothing fires and everything was read.
 *
 * @param running - What still runs: the read, its mute's bypasses held when it mutes.
 * @param options.assign - The bypasses to assign (`bypassesToAssign`).
 * @param options.mayMute - Whether the act can mute them itself and was not asked to.
 */
export function dataOpsAutomationRefusal(
  running: Pick<ForgeTargetAutomation, 'objects' | 'unread'> | { unread: string },
  target: string,
  options: {
    act: DataOpsAct;
    steps: ForgeRemovalSteps;
    assign?: Parameters<typeof bypassAssistantSentences>[0];
    mayMute?: boolean;
  },
): string | undefined {
  const words = ACT_WORDS[options.act];
  const lifted =
    `${words.nothing} Add --accept-automation ${words.flag}, or turn that automation off in ` +
    `${target} first.`;
  if (typeof running.unread === 'string') {
    return (
      `What ${target} runs as ${words.this} ${words.writes} its records could not be read ` +
      `(${running.unread}), so what fires is not known. ${lifted}`
    );
  }
  const automation = running as Pick<ForgeTargetAutomation, 'objects' | 'unread'>;
  const fired = firedOnRemovalStepsOf(automation, options.steps);
  const unread = automationUnreadOf(automation);
  if (fired.length === 0 && unread.length === 0) return undefined;
  const parts: string[] = [];
  if (fired.length > 0) {
    const named = fired.map(
      (entry) => `${entry.objectApiName}: ${firedWords(entry)} (${stepWords(options.act, entry)})`,
    );
    parts.push(
      `${target} runs automation as ${words.this} ${words.writes} its records: ${named.join('; ')}.`,
    );
  }
  for (const { part, reason } of unread) {
    parts.push(
      `${capitalized(UNREAD_WORDS[part] ?? part)} of ${target} could not be read (${reason}), ` +
        `so what fires as ${words.the} ${words.writes} its records is not known.`,
    );
  }
  const assign = options.assign ?? [];
  parts.push(...bypassAssistantSentences(assign, target, words.the));
  const sets = [...new Set(assign.flatMap((entry) => entry.permissionSet ?? []))];
  if (options.mayMute === true && sets.length > 0) {
    parts.push(
      `With --mute-automation, ${words.the} assigns ${sets.join(', ')} to the user it writes ` +
        `as for ${words.the} alone, under a lease, and what ` +
        `${sets.length === 1 ? 'it keeps' : 'they keep'} quiet does not fire.`,
    );
  }
  parts.push(lifted);
  return parts.join(' ');
}

/** How each daily email limit is said. */
const LIMIT_WORDS: Readonly<Record<ForgeEmailLimit, string>> = {
  SingleEmail: 'single emails',
  DailyWorkflowEmails: 'workflow emails',
};

/** What one limit's count says: the emails, per record of each object, and what is left. */
function emailsWords(check: CheckpointEmails): string {
  const per = check.objects.map((o) => `${o.perRecord} per ${o.objectApiName}`).join(', ');
  return (
    `about ${check.emails} ${LIMIT_WORDS[check.limit]} (${per}` +
    (check.alertsCounted
      ? '; its email alerts among them, as a Developer Edition counts them'
      : '') +
    ')'
  );
}

/** What the command line says of the emails an act makes the org send, against what it has left. */
export function dataOpsEmailLines(
  emails: readonly CheckpointEmails[],
  target: string,
  uncounted?: string,
): string[] {
  const lines = emails.map((check) => {
    if (check.verdict === 'unread') {
      return (
        `  emails: ${emailsWords(check)}; what ${target} has left today could not be read ` +
        `(${check.unread ?? 'not said'})`
      );
    }
    const left = `${check.remaining ?? 0} of ${check.max ?? 0} left today`;
    return check.verdict === 'exceeds'
      ? `  emails: ${emailsWords(check)}, past the ${left}`
      : `  emails: ${emailsWords(check)}, ${left}`;
  });
  if (uncounted !== undefined) {
    lines.push(`  emails not counted: what sends them was not read (${uncounted})`);
  }
  return lines;
}

/**
 * The refusal of an act whose writes would make the org send more emails of
 * a daily limit than it has left today. Nothing lifts it: past them, the org
 * refuses each record whose flow fails in the save, and its own emails stop
 * for the day.
 */
export function dataOpsEmailsRefusal(
  act: DataOpsAct,
  emails: readonly CheckpointEmails[],
  target: string,
): string | undefined {
  const over = emails.filter((check) => check.verdict === 'exceeds');
  if (over.length === 0) return undefined;
  const words = ACT_WORDS[act];
  const said = over
    .map(
      (check) => `${emailsWords(check)}, ${check.remaining ?? 0} of ${check.max ?? 0} left today`,
    )
    .join('; ');
  return (
    `${capitalized(words.this)} would make ${target} send ${said}: past them, each record whose ` +
    "flow fails in the save is refused (CANNOT_EXECUTE_FLOW_TRIGGER), and the org's own emails " +
    'stop for the rest of the day. Turn off what sends them, give the user it writes as the ' +
    `bypass that keeps it quiet (--mute-automation assigns one a permission set holds), or ` +
    `${words.verb} fewer records. ${words.nothing}`
  );
}

/** What an act's read and its gate are given of the org. */
export interface DataOpsAutomationOrg {
  /** What the org runs on these objects, as Forge reads it (`TargetAutomationReader`). */
  readAutomation: (objects: readonly string[]) => Promise<ForgeTargetAutomation>;
  /** Its daily email limits, as its `/limits` say (`readEmailLimits`). */
  readLimits: () => Promise<Partial<Record<ForgeEmailLimit, EmailLimit>>>;
  /** Whether it delivers its automation's emails (`readEmailDeliverability`), read only when something sends. */
  readDeliverability: () => Promise<DeliverabilityRead>;
  /** The org a mute assigns its sets in (`muteOrgOf`): reached only when the act mutes. */
  muteOrg: () => Promise<MuteOrg>;
}

/**
 * The org as an act's read reaches it through one connection, as the user
 * the act writes as: its limits and the line of Apex through the connection's
 * requests, its permission sets through its records. The line of Apex never
 * runs in a production org, which a DataOps write reaches once Production
 * Guard's question was answered: its emails then ask, as an org that would
 * not say asks.
 *
 * @param readAutomation - What the org runs on the objects, as the handler reads it.
 */
export function dataOpsAutomationOrgOf(
  conn: LimitsTransport & Parameters<typeof muteOrgOf>[0],
  readAutomation: DataOpsAutomationOrg['readAutomation'],
  production: boolean,
): DataOpsAutomationOrg {
  return {
    readAutomation,
    readLimits: () => readEmailLimits(conn),
    readDeliverability: () =>
      production ? Promise.resolve(NO_APEX_IN_PRODUCTION) : readEmailDeliverability(conn),
    muteOrg: async () => muteOrgOf(conn),
  };
}

/**
 * Take the lease of an act's mute before its first write, and hold its
 * emails to what the lease holds once read back: a set it does not hold
 * leaves running what it was to keep quiet, and a sender of it no question
 * named refuses the act, the lease given back and nothing written. An act
 * that does not mute holds nothing.
 *
 * @param accepted - Whether its emails were accepted (`--accept-emails`, the page's box).
 * @param voice - Whose words its refusal is said in (`dataOpsSaid`).
 */
export async function holdDataOpsMute(
  read: Pick<DataOpsActRead, 'mute' | 'emails'> | undefined,
  runId: string,
  accepted: boolean,
  voice?: DataOpsVoice,
): Promise<{ held?: HeldMute } | { refused: DataOpsAutomationRefusal }> {
  const prepared = read?.mute?.prepared;
  if (!read || !prepared) return {};
  let held: HeldMute;
  try {
    held = await prepared.acquire(runId);
  } catch (err: unknown) {
    if (!isMuteRefusedError(err)) throw err;
    return { refused: { code: err.code, message: dataOpsSaid(err.message, voice) } };
  }
  const relit = read.emails.afterLease(held.outcome, accepted);
  if (relit) {
    await held.release();
    return { refused: { code: relit.code, message: dataOpsSaid(relit.message, voice) } };
  }
  return { held };
}

/** What an act asks of its read and its gate. */
export interface DataOpsActInput {
  act: DataOpsAct;
  /** The org, as the refusals name it. */
  target: string;
  /** The records of each object the act writes; an object with none is left out. */
  objects: readonly DataOpsAutomationObject[];
  org: DataOpsAutomationOrg;
  accord: DataOpsWriteAccord;
  /** Whether the act's way of being started can mute: its refusals then name `--mute-automation`. */
  mayMute: boolean;
  /** Where the mute's leases are journaled, when not the home directory's. */
  muteLeases?: MuteLeaseOptions;
  /** The org by its alias and the user the act writes as: the command a bypass's sentence gives. */
  assignTo?: { alias: string; username: string };
  /** Whose words its refusals are said in (`dataOpsSaid`): the command line's when not said. */
  voice?: DataOpsVoice;
}

/** What an act's read came to: what is said and refused, the mute planned, and the emails' gate. */
export interface DataOpsActRead {
  answer: DataOpsAutomationAnswer;
  /** The mute planned, when asked and not refused: held from before the first write to the end. */
  mute?: RunMute;
  /** The emails' gate, with the check made once the mute's lease is read back. */
  emails: RunEmails;
}

/** The read of an act that writes nothing: nothing fires, and nothing is read. */
const NOTHING_READ: ForgeTargetAutomation = {
  objectsRead: [],
  objects: [],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 0,
  requests: 0,
};

/**
 * Read what the org runs as an act writes, plan its mute when asked — nothing
 * assigned —, count its emails and read whether the org delivers them, and
 * say why the act would be refused as it was asked: a mute refused first
 * (`MUTE_*`), then what fires not accepted, past the day's emails, and emails
 * the org delivers not accepted. The act refuses with the first, and its dry
 * run says them all. Never throws on a read that fails: what fires is then
 * unknown, which asks as much as what fires.
 */
export async function readDataOpsAct(input: DataOpsActInput): Promise<DataOpsActRead> {
  const { act, target, accord } = input;
  const objects = input.objects.filter((object) => object.records > 0);
  const names = objects.map((object) => object.objectApiName);
  const steps = dataOpsStepsOf(act, names);
  const writes = removalStepsWrites(steps);
  const read: ForgeTargetAutomation | { unread: string } =
    names.length === 0
      ? NOTHING_READ
      : await input.org
          .readAutomation(names)
          .catch((err: unknown) => ({ unread: extractErrorMessage(err) }));
  const known = typeof read.unread === 'string' ? undefined : (read as ForgeTargetAutomation);

  const refusals: DataOpsAutomationRefusal[] = [];
  let mute: RunMute | undefined;
  if (accord.muteAutomation === true) {
    try {
      mute = await muteForRun(input.org.muteOrg, read, { ...input.muteLeases, writes });
    } catch (err: unknown) {
      if (!isMuteRefusedError(err)) throw err;
      refusals.push({ code: err.code, message: err.message });
    }
  }
  /** What still runs once the mute's plan holds: the read itself when the act does not mute. */
  const running = mute?.automation ?? known;
  const mayMute = input.mayMute && accord.muteAutomation !== true;

  const lines = [
    ...dataOpsAutomationLines(known ?? read, target, act, steps),
    ...(mute ? muteLines(mute.muted, target).map((line) => `  ${line}`) : []),
  ];

  const automationRefusal = dataOpsAutomationRefusal(running ?? read, target, {
    act,
    steps,
    ...(running
      ? {
          assign: bypassesToAssign(running, removalStepsBypassesOf(running, steps), input.assignTo),
        }
      : {}),
    mayMute,
  });
  if (automationRefusal !== undefined && accord.acceptAutomation !== true) {
    refusals.push({ code: AUTOMATION_NOT_ACCEPTED, message: automationRefusal });
  }

  // The emails of what still runs, counted against what the org has left
  // today: its limits are read only when something sends one.
  const written = dataOpsWrittenOf(act, objects);
  let emails: CheckpointEmails[] = [];
  let uncounted: string | undefined;
  if (running) {
    const sends = written.some((each) =>
      emailsPerWriteOf(running, each.write).some((s) => s.objectApiName === each.objectApiName),
    );
    if (sends) {
      const limits: EmailLimits = await input.org
        .readLimits()
        .catch((err: unknown) => ({ unread: extractErrorMessage(err) }));
      emails = checkpointEmails(written, running, limits);
    }
    uncounted = checkpointEmailsUncounted(written, running);
  }
  lines.push(...dataOpsEmailLines(emails, target, uncounted));
  const exceeded = dataOpsEmailsRefusal(act, emails, target);
  if (exceeded !== undefined) refusals.push({ code: EMAILS_EXCEEDED, message: exceeded });

  // Whether the org delivers what still runs sends, read only when something
  // does: an org on All email sends them to the addresses the records hold.
  const runEmails = await runEmailsOf({
    read,
    ...(mute?.plan ? { plan: mute.plan } : {}),
    writes,
    readDeliverability: input.org.readDeliverability,
    accepted: accord.acceptEmails === true,
    target,
    run: act,
    keepsAddresses: true,
    mayMute,
  });
  if (runEmails.gate.line !== undefined) lines.push(`  ${runEmails.gate.line}`);
  if (runEmails.gate.stop) refusals.push({ ...runEmails.gate.stop });

  const answer: DataOpsAutomationAnswer = {
    act,
    objects,
    steps,
    ...(known ? { automation: known } : { automationUnread: String(read.unread) }),
    lines,
    emails,
    ...(uncounted !== undefined ? { emailsUncounted: uncounted } : {}),
    ...(runEmails.gate.deliverability ? { deliverability: runEmails.gate.deliverability } : {}),
    emailsAsk: runEmails.gate.verdict === 'asks',
    refusals: refusals.map((refusal) => ({
      ...refusal,
      message: dataOpsSaid(refusal.message, input.voice),
    })),
    ...(mute ? { mutedAutomation: mute.muted } : {}),
    ...(mute?.plan ? { mutePlan: mute.plan } : {}),
  };
  return { answer, ...(mute ? { mute } : {}), emails: runEmails };
}

/**
 * The refusal an act stops with, as asked: the first of its read's, every
 * other one said after it, so that a run told of one is told of them all.
 * Undefined when the act may write.
 */
export function dataOpsStop(
  answer: Pick<DataOpsAutomationAnswer, 'refusals'>,
): DataOpsAutomationRefusal | undefined {
  const [first, ...rest] = answer.refusals;
  if (!first) return undefined;
  return {
    code: first.code,
    message: [first.message, ...rest.map((refusal) => refusal.message)].join(' '),
  };
}
