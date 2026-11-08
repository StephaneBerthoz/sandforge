/**
 * The question a Frozen load asks of what the target runs as it inserts its
 * records and updates them, before its first write: the clone's, on the
 * load's writes.
 *
 * A load read what the target runs only to count its emails, mute it or
 * scope a checkpoint: what sends no email ran unasked. Run on a scratch org,
 * a flow after save on an opportunity product that deletes its record left
 * the load's two products deleted the second they went in; the load asked
 * nothing, and only its verification saw it, ending partial. Forge, Seed and
 * Sync name what fires before they write; the clone's command line writes
 * nothing of it unless told to go on regardless.
 *
 * So a load is refused, nothing written (`AUTOMATION_NOT_ACCEPTED`), while
 * the target runs a flow, an Apex trigger, a process or a workflow rule on
 * what it inserts or updates — what the mute's plan keeps quiet, and what a
 * bypass the user holds keeps quiet, aside — or would not say what it runs,
 * unless it came with the accord: `--accept-automation`, or the box the Load
 * tab offers beside the mute's. `--mute-automation` stays the other way: a
 * refusal names the permission sets it would assign under its lease.
 */

import type {
  ForgeAutomationWrite,
  ForgeTargetAutomation,
  FrozenLoadAutomationEntry,
  FrozenLoadAutomationInfo,
  MutePlan,
} from '@sandforge/shared';
import { stillRunningOf } from '@sandforge/shared';
import {
  automationUnreadOf,
  bypassAssistantSentences,
  bypassesToAssign,
  runBypassesOf,
} from '../forge/ForgeRunGate.js';

/** The code a load is refused under while what the target runs as it writes is not accepted. */
export const AUTOMATION_NOT_ACCEPTED = 'AUTOMATION_NOT_ACCEPTED' as const;

/** What a load's question on the target's automation is judged on, before its first write. */
export interface LoadAutomationInput {
  /** What the target runs on the objects the load writes, or why it could not be read: that asks. */
  read: ForgeTargetAutomation | { unread: string };
  /** The mute's plan, nothing assigned; absent for a load that does not mute. */
  plan?: Pick<MutePlan, 'assign'>;
  /** The objects of the dataset: the load inserts their records, then updates what it inserted. */
  written: readonly string[];
  /** Whether the load came with the accord: `acceptAutomation`, `--accept-automation`. */
  accepted: boolean;
  /** The org, as the refusal names it. */
  target: string;
  /** Whether the load was not asked to mute: a refusal then names `--mute-automation`. */
  mayMute: boolean;
}

/** What a load's question on the target's automation came to. */
export interface LoadAutomation {
  /** What a preview, the report and a refusal say of it; absent when nothing runs and all was read. */
  info?: FrozenLoadAutomationInfo;
  /** Why the load is refused before its first write; absent when it goes on. */
  stop?: { code: typeof AUTOMATION_NOT_ACCEPTED; message: string };
}

/** The writes of a load, on the objects of its dataset: it inserts them, then updates what it inserted. */
function loadWritesOn(
  written: readonly string[],
): (objectApiName: string, write: ForgeAutomationWrite) => boolean {
  const objects = new Set(written);
  return (objectApiName, write) =>
    objects.has(objectApiName) && (write === 'insert' || write === 'update');
}

/** Whether a read of the target's automation failed whole. */
function isUnread(read: ForgeTargetAutomation | { unread: string }): read is { unread: string } {
  return typeof (read as { unread?: unknown }).unread === 'string';
}

/** How the command line names what fires. */
function entryWords({ kind, name }: Pick<FrozenLoadAutomationEntry, 'kind' | 'name'>): string {
  if (kind === 'flow') return `flow "${name}"`;
  if (kind === 'process') return `process "${name}"`;
  if (kind === 'workflowRule') return `workflow rule "${name}"`;
  return `Apex trigger ${name}`;
}

/** How the command line names a part of the automation it could not read. */
const UNREAD_WORDS: Readonly<
  Record<NonNullable<FrozenLoadAutomationInfo['unread']>[number]['part'], string>
> = {
  flows: 'the flows',
  triggers: 'the Apex triggers',
  processes: 'the Process Builder processes',
  workflowRules: 'the workflow rules',
  automation: 'what runs',
};

/** `Object: flow "X" (insert, update)`, as a line and a refusal name an entry. */
function namedEntry(entry: FrozenLoadAutomationEntry): string {
  return `${entry.objectApiName}: ${entryWords(entry)} (${entry.writes.join(', ')})`;
}

/**
 * Why a load will not write without the accord: what the target runs as it
 * writes, named, or what of it could not be read; then the bypasses the user
 * does not hold and what `--mute-automation` would assign.
 */
function refusalOf(
  info: FrozenLoadAutomationInfo,
  target: string,
  sentences: readonly string[],
): string {
  const parts: string[] = [];
  if (info.firing.length > 0) {
    parts.push(
      `${target} runs automation as this load inserts its records and updates them: ` +
        `${info.firing.map(namedEntry).join('; ')}.`,
    );
  }
  for (const { part, reason } of info.unread ?? []) {
    const words = UNREAD_WORDS[part];
    parts.push(
      `${words[0].toUpperCase()}${words.slice(1)} of ${target} could not be read (${reason}), so ` +
        'what fires as the load writes is not known.',
    );
  }
  parts.push(...sentences);
  parts.push(
    `Nothing was written. Add --accept-automation to load all the same, or turn that ` +
      `automation off in ${target} first.`,
  );
  return parts.join(' ');
}

/**
 * A load's question on what the target runs as it writes, from what it read
 * before its first write: what still runs once the mute's plan holds,
 * grouped by object and by automation with the writes it runs on, what could
 * not be read, and the refusal a load without the accord meets.
 */
export function loadAutomationOf(input: LoadAutomationInput): LoadAutomation {
  const { read, target } = input;
  const writes = loadWritesOn(input.written);
  let firing: FrozenLoadAutomationEntry[] = [];
  let unread: NonNullable<FrozenLoadAutomationInfo['unread']> = [];
  let sentences: string[] = [];
  if (isUnread(read)) {
    unread = [{ part: 'automation', reason: read.unread }];
  } else {
    const still = stillRunningOf(read, input.plan, writes);
    const byEntry = new Map<string, FrozenLoadAutomationEntry>();
    for (const fired of still.firing) {
      if (fired.write !== 'insert' && fired.write !== 'update') continue;
      const key = `${fired.objectApiName}\u0000${fired.kind}\u0000${fired.name}`;
      const entry = byEntry.get(key);
      if (entry) {
        if (!entry.writes.includes(fired.write)) entry.writes.push(fired.write);
      } else {
        byEntry.set(key, {
          objectApiName: fired.objectApiName,
          kind: fired.kind,
          name: fired.name,
          writes: [fired.write],
        });
      }
    }
    firing = [...byEntry.values()].map((entry) => ({
      ...entry,
      writes: (['insert', 'update'] as const).filter((write) => entry.writes.includes(write)),
    }));
    unread = automationUnreadOf(read);
    // The sets that keep quiet what still runs, which --mute-automation
    // assigns under a lease: never a command assigning them by hand.
    const assign = bypassesToAssign(
      still.automation,
      runBypassesOf(still.automation, [...input.written]),
    );
    const sets = [...new Set(assign.flatMap((entry) => entry.permissionSet ?? []))];
    sentences = [
      ...bypassAssistantSentences(assign, target, 'the load'),
      ...(input.mayMute && sets.length > 0
        ? [
            `With --mute-automation, the load assigns ${sets.join(', ')} to the user it writes ` +
              `as for the load alone, under a lease, and what ${sets.length === 1 ? 'it keeps' : 'they keep'} ` +
              'quiet does not fire.',
          ]
        : []),
    ];
  }
  if (firing.length === 0 && unread.length === 0) return {};
  const info: FrozenLoadAutomationInfo = {
    firing,
    ...(unread.length > 0 ? { unread } : {}),
    accepted: input.accepted,
  };
  if (input.accepted) return { info };
  const stop = { code: AUTOMATION_NOT_ACCEPTED, message: refusalOf(info, target, sentences) };
  return { info: { ...info, refused: stop }, stop };
}

/**
 * What the command line says of what the target runs as a load writes, from
 * what its preview, its report or its refusal carried.
 */
export function loadAutomationLines(info: FrozenLoadAutomationInfo, target: string): string[] {
  return [
    `target automation: what ${target} runs as the load inserts its records and updates them`,
    ...info.firing.map((entry) => `  ${namedEntry(entry)}`),
    ...(info.unread ?? []).map(
      ({ part, reason }) => `  ${UNREAD_WORDS[part]} could not be read: ${reason}`,
    ),
    ...(info.accepted ? ['  accepted (--accept-automation): the load writes all the same'] : []),
  ];
}
