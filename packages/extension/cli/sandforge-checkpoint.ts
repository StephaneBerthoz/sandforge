#!/usr/bin/env tsx
/**
 * sandforge-checkpoint — take a checkpoint of an org's data, list the
 * checkpoints kept, preview what a rewind to one would do, and delete them,
 * without the editor.
 *
 * Every command goes through the extension's own composition (`panelHost.ts`):
 * the Checkpoints page's requests, answered by the handler the page talks to,
 * over the store the page keeps its checkpoints in. A checkpoint taken here is
 * listed in the editor, and the other way round.
 *
 * `list` and `delete` read this machine alone and never contact the org: an
 * org's checkpoints are told by the alias or username each was taken under,
 * and by the Organization Id they are filed under, so a scratch org that has
 * expired, whose alias no longer reaches it, still lists its checkpoints and
 * has them deleted. `take` and `preview` reach the org through the `sf` CLI's
 * session. A production org is refused by the checkpoint's own guard, before
 * any record is read, and no flag lifts it.
 *
 * The host keeps nothing of its own past the command: its config store is a
 * folder of the system's temp directory made for the run, its owner's alone,
 * removed as the command ends. What lasts is the checkpoints, in the store.
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts take --org DEV --name baseline
 *   pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts preview --org DEV --fail-on-change
 *   pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts list
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  checkpointIdSchema,
  type CheckpointEstimate,
  type CheckpointLeftOutObject,
  type CheckpointListEntry,
  type CheckpointObject,
  type CheckpointRefusal,
  type CheckpointScopeMode,
  type CheckpointScopeObject,
  type ForgeTargetAutomation,
  type OrgCheckpoint,
  type RewindDiff,
  type RewindDiffObject,
  type SalesforceOrg,
} from '@sandforge/shared';
import { createPanelHost } from './panelHost.js';
import type { PanelAnswer, PanelHost, PanelHostOptions, PostedMessage } from './panelHost.js';
import { refuseUnreadArguments, type CommandFlags } from './commandLine.js';
import { DONE_EXIT, FAILED_EXIT, PARTIAL_EXIT, endWith } from './exitCodes.js';
import { confirm } from './prompt.js';
import { onStopSignal, stopExitCode, type StopSignal } from './stopSignals.js';
import { checkpointTakePayloadSchema } from '../src/bridge/validatePayload.js';
import type { InfraServices } from '../src/bridge/handlers/HandlerTypes.js';
import { BackgroundOperationRegistry } from '../src/core/engine/BackgroundOperationRegistry.js';
import {
  DEFAULT_KEEP_DAYS,
  defaultCheckpointStoreRoot,
  openCheckpointStore,
  type OrgCheckpointStore,
} from '../src/modules/checkpoint/OrgCheckpointStore.js';
import { DEFAULT_MAX_TOTAL } from '../src/modules/checkpoint/takeCheckpoint.js';
import { formatMB } from '../src/modules/forge/ForgeRunGate.js';

const HELP = `sandforge-checkpoint — take a checkpoint of an org's data, and see what a rewind to it would do, without the editor.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts <command> --org <alias> [options]

Commands:
  take      read the org's records and keep them as a checkpoint on this machine
  list      name the checkpoints kept, newest first, with what a rewind and an undo can still reach
  preview   say what a rewind would delete, give back and bring back, who last changed it, and what
            it and an undo cannot take back; writes nothing
  delete    delete a checkpoint from this machine; the org is not touched

Required:
  --org <alias>                  sf CLI alias of the org (list: every org of the store without it)

take:
  --name <text>                  what it is called (default: the date and time)
  --object <ApiName>             an object to keep; repeat for more (default: every object people
                                 work in, empty ones included, setup and log objects left out)
  --exclude-object <ApiName>     leave an object out; repeat for more
  --ignore-field <Object.Field>  do not compare a field, nor write it back (one your automation sets
                                 on every save); repeat for more
  --max-total <n>                refuse, before reading, more than <n> records (default: ${DEFAULT_MAX_TOTAL})
  --keep-days <n>                when it expires (default: ${DEFAULT_KEEP_DAYS}; 0 keeps it until deleted)
  --estimate                     say the records, API requests, time and disk it would take, then stop
preview, delete:
  --checkpoint <id|name|latest>  which one (default: latest)
preview:
  --fail-on-change               exit 3 when the org differs from the checkpoint
delete:
  --all                          every checkpoint of the org
  --yes                          do not ask
Options:
  --store <dir>                  where checkpoints live (default: ~/.sandforge/checkpoints, or
                                 checkpoints/ in the folder SANDFORGE_JOURNAL_DIR names)
  --json                         the answer alone on stdout, every other line on stderr
  --help                         this text

A production org is refused before anything is read or written, exit 1. No flag lifts it.
The user the alias connects as needs View All Data and Modify All Data.
A checkpoint holds the records' values as the org held them, personal data among them, in clear,
in files only you can read (on Windows: in your user profile). Expired checkpoints are deleted as
any command starts, each named.
list and delete read this machine alone and never contact the org. An org's checkpoints are the
ones taken under its alias or username, and the others kept of the same Organization Id.
Ctrl-C stops a take between two reads, and nothing of it is kept; a second Ctrl-C ends it at once,
and leaves a checkpoint listed as never taken, which delete removes.

What a rewind cannot undo, said by preview: a record deleted since and no longer in the recycle
bin; the values the org computes or keeps itself (formulas, roll-ups, auto-numbers, created and
modified dates); a field added or removed since; a lead converted since; an activated contract;
what left the org (emails, callouts, outbound messages, platform events); metadata; files.

JSON (--json), one value on stdout:
  list               [{id, name, org, organizationId, takenAt, records, bytes, expiresAt,
                       expiresSoon, binReachSince, lastRewind?, valid, why?, refreshedAt?}]
                     (name, org, takenAt, records and bytes are null for a damaged checkpoint;
                     expiresAt is null for one kept until deleted)
  take               {checkpoint}: the checkpoint as kept (its checkpoint.json)
  take --estimate    {mode, objects, leftOut, estimate, refusal?}
  preview            {checkpoint: {id, name, takenAt, org}, toDelete, toGiveBack, toBringBack,
                      differs, diff, estimate, automation?, refusal?}: diff, estimate, automation
                     and refusal as the extension answers them; refusal is the one a rewind would
                     meet now
  delete             {deleted: [id], kept: [id]}
  refused or failed  {refusal: {code, message}}
  A bad command line (exit 2) prints nothing on stdout.

Exit codes: 0 done (take: every record of its objects is kept; preview and list answered; delete:
every checkpoint named is deleted); 1 refused before it read or wrote (a production org, missing
permissions, more than --max-total records, more API requests than the org has left today, a
checkpoint of the org before a refresh or of an expired scratch org, a SandForge run writing to
it), or nothing done; 2 a bad command line, a --checkpoint name several checkpoints have, or a
question with no terminal (give --yes); 3 with --fail-on-change, the org differs (records to
delete, give back or bring back, records the rewind cannot take back or the checkpoint does not
hold although they are dated before it, an object that could not be read); delete: some were
kept, each said with why; 130, 143, 129 Ctrl-C, SIGTERM or SIGHUP stopped it.
`;

// ─── The command line ────────────────────────────────────────────────────────

/** What the tool does, as its first word names it. */
const COMMANDS = ['take', 'list', 'preview', 'delete'] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (word: string): word is Command => (COMMANDS as readonly string[]).includes(word);

/** The flags of every command. */
const COMMON: Pick<CommandFlags, 'switches' | 'values'> = {
  switches: ['--json'],
  values: ['--org', '--store'],
};

/** What each command reads of its line, after its own word. */
const FLAGS: Readonly<Record<Command, CommandFlags>> = {
  take: {
    words: 1,
    switches: [...COMMON.switches, '--estimate'],
    values: [
      ...COMMON.values,
      '--name',
      '--object',
      '--exclude-object',
      '--ignore-field',
      '--max-total',
      '--keep-days',
    ],
  },
  list: { words: 1, ...COMMON },
  preview: {
    words: 1,
    switches: [...COMMON.switches, '--fail-on-change'],
    values: [...COMMON.values, '--checkpoint'],
  },
  delete: {
    words: 1,
    switches: [...COMMON.switches, '--all', '--yes'],
    values: [...COMMON.values, '--checkpoint'],
  },
};

/** The flag that gave each field of a take's request, as a refusal of it names it. */
const FLAG_OF_FIELD: Readonly<Record<string, string>> = {
  name: '--name',
  objects: '--object',
  excluded: '--exclude-object',
  ignoredFields: '--ignore-field',
  maxTotal: '--max-total',
  keepDays: '--keep-days',
};

/** What a take of the org is asked, as the page asks it, but for the org's id. */
export interface TakeAsked {
  name: string;
  mode: CheckpointScopeMode;
  objects?: string[];
  excluded?: string[];
  ignoredFields?: string[];
  maxTotal?: number;
  keepDays: number;
}

interface CommonArgs {
  /** Where the checkpoints live, absolute. */
  storeRoot: string;
  json: boolean;
}

/** Everything the command line settled. */
export type CliArgs =
  | (CommonArgs & { command: 'take'; org: string; take: TakeAsked; estimate: boolean })
  | (CommonArgs & { command: 'list'; org?: string })
  | (CommonArgs & { command: 'preview'; org: string; checkpoint: string; failOnChange: boolean })
  | (CommonArgs & {
      command: 'delete';
      org: string;
      /** Absent with --all. */
      checkpoint?: string;
      all: boolean;
      yes: boolean;
    });

/** Stop the command, exit 2, on a line it cannot read: said on stderr, nothing on stdout. */
function refuseLine(line: string): never {
  process.stderr.write(`${line}\n`);
  process.exit(2);
}

/** A checkpoint not given a name: the date and time, as the page prefills its field. */
export function defaultName(now: Date): string {
  const at = now.toISOString();
  return `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
}

/**
 * Read the command line, or stop, exit 2, on one that cannot be read. A
 * take's request is checked here with the rules its handler checks it by, so
 * a name, an object or a field it would refuse is said before any org is
 * reached.
 */
export function parseArgs(argv: readonly string[], now: Date = new Date()): CliArgs {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const command = args[0];
  if (command === undefined || command.startsWith('-')) {
    return refuseLine('Name the command first: take, list, preview or delete. Run with --help.');
  }
  if (!isCommand(command)) {
    return refuseLine(
      `"${command}" is not a command of sandforge-checkpoint: take, list, preview or delete. ` +
        'Nothing was run. Run with --help.',
    );
  }
  // A misspelt flag, or `--org=ALIAS`, would be dropped without a word.
  refuseUnreadArguments(args, FLAGS[command]);

  const values = (flag: string): string[] => {
    const out: string[] = [];
    for (let at = 1; at < args.length; at++) {
      if (args[at] !== flag) continue;
      const value = args[at + 1];
      if (value === undefined || value.startsWith('--')) {
        return refuseLine(`${flag} wants a value.`);
      }
      out.push(value);
      at++;
    }
    return out;
  };
  // One org, one name: a second one would be taken for the first without a word.
  const single = (flag: string): string | undefined => {
    const given = values(flag);
    if (given.length > 1) refuseLine(`${flag} is given ${given.length} times: give it once.`);
    return given[0];
  };
  const wholeNumber = (flag: string): number | undefined => {
    const value = single(flag);
    if (value === undefined) return undefined;
    if (!/^\d{1,15}$/.test(value)) refuseLine(`${flag} takes a whole number, not "${value}".`);
    return Number(value);
  };
  const store = single('--store');
  const common: CommonArgs = {
    storeRoot: store !== undefined ? resolve(store) : defaultCheckpointStoreRoot(),
    json: args.includes('--json'),
  };
  const org = single('--org');
  const orgNamed = (): string => org ?? refuseLine(`${command} needs --org. Run with --help.`);

  switch (command) {
    case 'list':
      return { ...common, command, ...(org !== undefined ? { org } : {}) };
    case 'take': {
      const named = orgNamed();
      const objects = values('--object');
      const excluded = values('--exclude-object');
      const ignoredFields = values('--ignore-field');
      const maxTotal = wholeNumber('--max-total');
      const take: TakeAsked = {
        name: single('--name') ?? defaultName(now),
        mode: objects.length > 0 ? 'picked' : 'everything',
        ...(objects.length > 0 ? { objects } : {}),
        ...(excluded.length > 0 ? { excluded } : {}),
        ...(ignoredFields.length > 0 ? { ignoredFields } : {}),
        ...(maxTotal !== undefined ? { maxTotal } : {}),
        keepDays: wholeNumber('--keep-days') ?? DEFAULT_KEEP_DAYS,
      };
      const checked = checkpointTakePayloadSchema.safeParse({ ...take, orgId: 'command-line' });
      if (!checked.success) {
        const issue = checked.error.issues[0];
        const field = String(issue?.path[0] ?? '');
        return refuseLine(
          `${FLAG_OF_FIELD[field] ?? field}: ${issue?.message ?? 'not read'}. Nothing was run.`,
        );
      }
      return {
        ...common,
        command,
        org: named,
        // The name as the take keeps it: without the spaces around it.
        take: { ...take, name: checked.data.name },
        estimate: args.includes('--estimate'),
      };
    }
    case 'preview':
      return {
        ...common,
        command,
        org: orgNamed(),
        checkpoint: single('--checkpoint') ?? 'latest',
        failOnChange: args.includes('--fail-on-change'),
      };
    case 'delete': {
      const named = orgNamed();
      const checkpoint = single('--checkpoint');
      const all = args.includes('--all');
      if (all && checkpoint !== undefined) {
        refuseLine('Give --checkpoint or --all, not both.');
      }
      return {
        ...common,
        command,
        org: named,
        ...(all ? {} : { checkpoint: checkpoint ?? 'latest' }),
        all,
        yes: args.includes('--yes'),
      };
    }
  }
}

// ─── Which checkpoints are an org's, and which one is meant ──────────────────

/** Whether two Organization Ids name one org: the 15-character id and its 18-character form alike. */
function sameOrganization(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.length >= 15 && a.slice(0, 15) === b.slice(0, 15);
}

/**
 * The checkpoints of the org `org` names, read from this machine alone: those
 * taken under that alias or username, and every other one filed under the
 * Organization Id of one of them, or under `organizationId` once the org has
 * answered — a checkpoint taken in the editor under another alias, a damaged
 * one whose file no longer says whose it is.
 */
export function checkpointsOf(
  entries: readonly CheckpointListEntry[],
  org: string,
  organizationId?: string,
): CheckpointListEntry[] {
  const orgs = organizationId !== undefined ? [organizationId] : [];
  for (const entry of entries) {
    const of = entry.checkpoint?.org;
    if (of === undefined) continue;
    if (of.alias === org || of.username.toLowerCase() === org.toLowerCase()) {
      orgs.push(entry.organizationId);
    }
  }
  return entries.filter((entry) => orgs.some((id) => sameOrganization(id, entry.organizationId)));
}

/** Which checkpoint `--checkpoint` means, or why none or more than one. */
export type Resolution =
  | { entry: CheckpointListEntry }
  | { none: string }
  /** A name several checkpoints have: the line must say which. */
  | { ambiguous: string };

/**
 * The checkpoint `asked` names: by its id, wherever it is kept; `latest`, the
 * org's newest; else the org's one of that name.
 *
 * @param all - Every checkpoint kept, newest first.
 * @param ofOrg - The org's, newest first.
 */
export function resolveCheckpoint(
  all: readonly CheckpointListEntry[],
  ofOrg: readonly CheckpointListEntry[],
  asked: string,
  orgName: string,
): Resolution {
  if (checkpointIdSchema.safeParse(asked).success) {
    const entry = all.find((candidate) => candidate.checkpointId === asked);
    return entry ? { entry } : { none: `No checkpoint ${asked} is kept on this machine.` };
  }
  if (asked === 'latest') {
    const entry = ofOrg[0];
    return entry ? { entry } : { none: `No checkpoint of ${orgName} is kept on this machine.` };
  }
  const named = ofOrg.filter((entry) => entry.checkpoint?.name === asked);
  if (named.length === 1) return { entry: named[0] };
  if (named.length === 0) {
    return { none: `No checkpoint of ${orgName} named '${asked}' is kept on this machine.` };
  }
  return {
    ambiguous:
      `${named.length} checkpoints of ${orgName} are named '${asked}': give the id of the one ` +
      `you mean with --checkpoint (${named.map((entry) => entry.checkpointId).join(', ')}).`,
  };
}

/** Why a checkpoint listed cannot be previewed, as a refusal says it, with its code. */
export function invalidRefusal(entry: CheckpointListEntry): CheckpointRefusalLike | undefined {
  if (entry.valid) return undefined;
  const name = entry.checkpoint ? `'${entry.checkpoint.name}'` : entry.checkpointId;
  switch (entry.why) {
    case 'damaged':
      return {
        code: 'DAMAGED',
        message: `The file of checkpoint ${entry.checkpointId} cannot be read: it can only be deleted.`,
      };
    case 'taking':
      return {
        code: 'TAKING',
        message: `The checkpoint ${name} is being taken, or its take never ended: it can be previewed once taken, or deleted.`,
      };
    case 'failed':
      return {
        code: 'FAILED',
        message: `The take of checkpoint ${name} failed: it can only be deleted.`,
      };
    case 'refreshed':
      return {
        code: 'OTHER_ORG',
        message:
          `This sandbox was refreshed${entry.refreshedAt ? ` on ${entry.refreshedAt.slice(0, 10)}` : ''}: ` +
          `it is another org now, and the checkpoint ${name} is of the org before it. It can only be deleted.`,
      };
    case 'scratchExpired':
      return {
        code: 'SCRATCH_EXPIRED',
        message: `The scratch org of checkpoint ${name} has expired: its checkpoints can only be deleted.`,
      };
    default:
      return { code: 'INVALID', message: `The checkpoint ${name} cannot be previewed.` };
  }
}

/** A refusal said by the command line, beside the ones the extension answers with. */
export interface CheckpointRefusalLike {
  code: string;
  message: string;
}

// ─── Words ───────────────────────────────────────────────────────────────────

const count = (n: number): string => n.toLocaleString('en-US');

/** An instant as the lines say it: `2026-10-22 14:05 UTC`. */
function when(iso: string): string {
  const at = new Date(Date.parse(iso)).toISOString();
  return `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
}

/** An instant to the second, for the moments a checkpoint is of. */
function whenExactly(iso: string): string {
  const at = new Date(Date.parse(iso)).toISOString();
  return `${at.slice(0, 10)} ${at.slice(11, 19)} UTC`;
}

const megabytes = (bytes: number): string => `${formatMB(bytes / (1024 * 1024))} MB`;

/** Up to `max` names, then how many more. */
function someOf(names: readonly string[], max = 8): string {
  if (names.length === 0) return '—';
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown} … (+${names.length - max})` : shown;
}

/** The records a checkpoint holds, all objects together. */
function recordsOf(checkpoint: Pick<OrgCheckpoint, 'objects'>): number {
  return checkpoint.objects.reduce((total, object) => total + object.records, 0);
}

/** How long a checkpoint is kept, as its line says it. */
function keptWords(expiresAt: string | null): string {
  return expiresAt === null ? 'kept until you delete it' : `kept until ${when(expiresAt)}`;
}

/** The org a checkpoint is of, as the user knows it. */
function orgOf(checkpoint: OrgCheckpoint): string {
  return checkpoint.org.alias ?? checkpoint.org.username;
}

/** The objects a scope left out, one line per reason. */
function leftOutLines(leftOut: readonly CheckpointLeftOutObject[]): string[] {
  const byReason = new Map<string, string[]>();
  for (const { objectApiName, reason } of leftOut) {
    byReason.set(reason, [...(byReason.get(reason) ?? []), objectApiName]);
  }
  return [...byReason].map(([reason, objects]) => `  left out: ${someOf(objects)} — ${reason}`);
}

/** Why a field is not in the snapshot, as a person reads it. */
const FIELD_LEFT_OUT_WORDS: Readonly<Record<string, string>> = {
  fls: 'hidden from the user SandForge connects as by field-level security: Rewind won’t put them back',
  encrypted:
    'encrypted, and the user SandForge connects as can’t view encrypted data: Rewind won’t touch them',
  base64: 'files and binary values, which a checkpoint doesn’t cover',
  compound: 'compound fields, kept through the fields they are made of',
};

/** The fields left out of each object, one line per reason. */
function fieldsLeftOutLines(
  objects: ReadonlyArray<Pick<CheckpointObject, 'objectApiName' | 'leftOutFields'>>,
): string[] {
  const byReason = new Map<string, string[]>();
  for (const object of objects) {
    for (const { field, reason } of object.leftOutFields) {
      byReason.set(reason, [...(byReason.get(reason) ?? []), `${object.objectApiName}.${field}`]);
    }
  }
  return [...byReason].map(
    ([reason, fields]) =>
      `  fields left out (${fields.length}): ${someOf(fields)} — ${FIELD_LEFT_OUT_WORDS[reason] ?? reason}`,
  );
}

/** The objects Salesforce undeletes only with their parent, said before a take. */
function withParentLine(objects: ReadonlyArray<{ objectApiName: string; undeletable: boolean }>) {
  const names = objects.filter((object) => !object.undeletable).map((o) => o.objectApiName);
  return names.length === 0
    ? []
    : [`  deleted ${someOf(names)} records come back from the recycle bin only with their parent`];
}

/** What a take, a preview or a rewind would cost, in one line. */
function estimateLine(estimate: CheckpointEstimate): string {
  return (
    `  about ${count(estimate.seconds)} s · about ${count(estimate.apiRequests)} API requests of ` +
    `the ${count(estimate.apiRequestsLeft)} left today` +
    (estimate.bytes > 0 ? ` · about ${megabytes(estimate.bytes)} on this machine` : '')
  );
}

/** Why a listed checkpoint cannot be previewed, in the list's words. */
const WHY_WORDS: Readonly<Record<string, string>> = {
  damaged: 'its file cannot be read: it can only be deleted',
  taking: 'being taken, or its take never ended: it can only be deleted unless it ends',
  failed: 'its take failed: it can only be deleted',
  refreshed: 'of the org before its refresh: it can only be deleted',
  scratchExpired: 'its scratch org has expired: it can only be deleted',
};

/** The lines `list` prints, newest first. */
export function listLines(entries: readonly CheckpointListEntry[], store: string): string[] {
  if (entries.length === 0) return [`No checkpoint is kept in ${store}.`];
  const lines: string[] = [];
  for (const entry of entries) {
    const c = entry.checkpoint;
    if (!c) {
      lines.push(`${entry.checkpointId}  ${WHY_WORDS.damaged}`);
      continue;
    }
    lines.push(
      `${entry.checkpointId}  '${c.name}'  ${orgOf(c)}  taken ${when(c.takenAt)}  ` +
        `${count(recordsOf(c))} records in ${c.objects.length} objects  ${megabytes(c.bytes)}  ` +
        keptWords(c.expiresAt),
    );
    if (!entry.valid) {
      const refreshed =
        entry.why === 'refreshed' && entry.refreshedAt
          ? `refreshed on ${entry.refreshedAt.slice(0, 10)}: `
          : '';
      lines.push(`  ${refreshed}${WHY_WORDS[entry.why ?? ''] ?? 'it cannot be previewed'}`);
    }
    if (entry.expiresSoon && c.expiresAt !== null) {
      lines.push(
        `  expires on ${when(c.expiresAt)}: take a new one, or keep this one in the editor`,
      );
    }
    if (entry.binReachSince) {
      lines.push(
        `  records deleted before ${entry.binReachSince.slice(0, 10)} can't come back (recycle ` +
          'bin), sooner if the bin fills',
      );
    }
    if (entry.undo) {
      lines.push(`  rewound: the rewind can be undone until ${when(entry.undo.until)}`);
    }
  }
  return lines;
}

/** What `list --json` prints of one checkpoint: see the help. */
export function listEntryJson(entry: CheckpointListEntry): Record<string, unknown> {
  const c = entry.checkpoint;
  return {
    id: entry.checkpointId,
    name: c?.name ?? null,
    org: c ? orgOf(c) : null,
    organizationId: entry.organizationId,
    takenAt: c?.takenAt ?? null,
    records: c ? recordsOf(c) : null,
    bytes: c?.bytes ?? null,
    expiresAt: c ? c.expiresAt : null,
    expiresSoon: entry.expiresSoon === true,
    binReachSince: entry.binReachSince ?? null,
    ...(c?.lastRewind
      ? { lastRewind: { ...c.lastRewind, undoable: entry.undo !== undefined } }
      : {}),
    valid: entry.valid,
    ...(entry.why !== undefined ? { why: entry.why } : {}),
    ...(entry.refreshedAt !== undefined ? { refreshedAt: entry.refreshedAt } : {}),
  };
}

/** What a take's scope answers: what it would hold and cost. */
export interface ScopeAnswer {
  mode: CheckpointScopeMode;
  objects: CheckpointScopeObject[];
  leftOut: CheckpointLeftOutObject[];
  estimate: CheckpointEstimate;
  refusal?: CheckpointRefusal;
}

/** The lines `take --estimate` prints. */
export function scopeLines(orgName: string, scope: ScopeAnswer): string[] {
  const holding = scope.objects.filter((object) => object.records > 0).length;
  const packages = new Map<string, number>();
  for (const { namespace } of scope.objects) {
    if (namespace !== undefined) packages.set(namespace, (packages.get(namespace) ?? 0) + 1);
  }
  return [
    `a checkpoint of ${orgName} would keep ${scope.objects.length} objects (${holding} hold ` +
      `records; ${scope.objects.length - holding} are empty — what is created there later is ` +
      `caught too), about ${count(scope.estimate.records)} records`,
    ...[...packages].map(([namespace, n]) => `  includes ${n} objects of the ${namespace} package`),
    estimateLine(scope.estimate),
    ...leftOutLines(scope.leftOut),
    ...fieldsLeftOutLines(scope.objects),
    ...withParentLine(scope.objects),
    ...(scope.refusal ? [`refused: ${scope.refusal.message}`] : []),
  ];
}

/** The lines a take prints once its checkpoint is kept. */
export function takeLines(checkpoint: OrgCheckpoint, folder: string): string[] {
  const moved = checkpoint.movedWhileTaken;
  const movedTotal = moved.changed + moved.deleted + moved.created;
  return [
    `taken '${checkpoint.name}' (${checkpoint.checkpointId}) of ${orgOf(checkpoint)}: ` +
      `${count(recordsOf(checkpoint))} records in ${checkpoint.objects.length} objects, ` +
      `${megabytes(checkpoint.bytes)} on this machine, ${keptWords(checkpoint.expiresAt)}`,
    `  of ${whenExactly(checkpoint.readFrom)}, read until ${whenExactly(checkpoint.takenAt)} on the org's clock`,
    ...(movedTotal > 0
      ? [
          `  ${count(movedTotal)} records changed while it was taken (${moved.changed} changed, ` +
            `${moved.deleted} deleted, ${moved.created} created): it holds them as they were ` +
            'read, and a rewind treats them as changed since. Take checkpoints when nobody works ' +
            'in the org.',
        ]
      : []),
    ...leftOutLines(checkpoint.scope.leftOut),
    ...fieldsLeftOutLines(checkpoint.objects),
    ...(checkpoint.ignoredFields.length > 0
      ? [`  not compared, nor written back (you chose): ${checkpoint.ignoredFields.join(', ')}`]
      : []),
    ...withParentLine(checkpoint.objects),
    `  it holds the records' values in clear, in files only you can read: ${folder}`,
  ];
}

/** What a rewind to a checkpoint would do, in the three numbers the preview leads with. */
export interface PreviewTotals {
  toDelete: number;
  toGiveBack: number;
  toBringBack: number;
}

const toDeleteOf = (o: RewindDiffObject): number =>
  o.toDelete.createdSince + o.toDelete.broughtBackSince + o.toDelete.comesBackWithParent;
const toBringBackOf = (o: RewindDiffObject): number =>
  o.toBringBack.inBin + o.toBringBack.withParent + o.toBringBack.deletedWhileTaken;
const cannotUndoOf = (o: RewindDiffObject): number =>
  o.cannotUndo.reduce((total, line) => total + line.count, 0);

/**
 * The three numbers: records to delete (created since, brought back from the
 * bin since, and those that come back with a parent and go again), to give
 * their values back, and to bring back from the recycle bin.
 */
export function previewTotals(diff: Pick<RewindDiff, 'objects'>): PreviewTotals {
  return diff.objects.reduce<PreviewTotals>(
    (totals, object) => ({
      toDelete: totals.toDelete + toDeleteOf(object),
      toGiveBack: totals.toGiveBack + object.toGiveBack.records,
      toBringBack: totals.toBringBack + toBringBackOf(object),
    }),
    { toDelete: 0, toGiveBack: 0, toBringBack: 0 },
  );
}

/**
 * Whether the org differs from the checkpoint, among the objects and fields
 * it holds: records a rewind would delete, give back or bring back; records
 * it cannot take back, or that the checkpoint does not hold although they are
 * dated before it; or an object that could not be read, which is never taken
 * for one that did not change.
 */
export function orgDiffers(diff: Pick<RewindDiff, 'objects' | 'unread'>): boolean {
  const totals = previewTotals(diff);
  return (
    totals.toDelete + totals.toGiveBack + totals.toBringBack > 0 ||
    diff.objects.some((object) => cannotUndoOf(object) > 0 || object.unexplained > 0) ||
    diff.unread.length > 0
  );
}

/** What a rewind cannot take back of an object, as the preview says it. */
const CANNOT_UNDO_WORDS: Readonly<Record<string, string>> = {
  goneForGood: 'deleted since and no longer in the recycle bin: they can’t come back with their Id',
  convertedLead: 'leads converted since: Salesforce can’t unconvert a lead',
  activatedContract: 'contracts activated since: Salesforce won’t set them back to Draft',
  deletedWithCreatedParent:
    'deleted with a parent created since: they can’t come back on their own',
};

/** What the preview answers: the diff, what the org runs, the cost, and a rewind's refusal. */
export interface PreviewAnswer {
  diff: RewindDiff;
  automation?: ForgeTargetAutomation;
  estimate: CheckpointEstimate;
  refusal?: CheckpointRefusal;
}

/** One line per object the org runs something on as a rewind writes. */
function automationLines(orgName: string, automation: ForgeTargetAutomation): string[] {
  const lines: string[] = [];
  for (const object of automation.objects) {
    const flows = [
      ...object.flows,
      ...(object.processes ?? []),
      ...(object.workflowRules ?? []),
    ].map((flow) => `'${flow.label}'`);
    const triggers = object.triggers.map((trigger) => trigger.name);
    const parts = [
      ...(flows.length > 0 ? [`${flows.length} flow(s) or rule(s): ${someOf(flows, 4)}`] : []),
      ...(triggers.length > 0
        ? [`${triggers.length} Apex trigger(s): ${someOf(triggers, 4)}`]
        : []),
    ];
    if (parts.length > 0) lines.push(`    ${object.objectApiName}: ${parts.join('; ')}`);
  }
  const head =
    lines.length > 0
      ? [`  what ${orgName} runs as a rewind writes (updates, deletes, records brought back):`]
      : [];
  return [
    ...head,
    ...lines,
    ...automation.unread.map(
      (unread) => `  not read of its automation: ${unread.part} — ${unread.reason}`,
    ),
  ];
}

/** The lines `preview` prints. */
export function previewLines(
  orgName: string,
  checkpoint: Pick<OrgCheckpoint, 'name' | 'takenAt'>,
  answer: PreviewAnswer,
): string[] {
  const { diff } = answer;
  const totals = previewTotals(diff);
  const lines = [
    `Rewind ${orgName} to '${checkpoint.name}' (${when(checkpoint.takenAt)}), read at ${whenExactly(diff.readAt)}:`,
    `  ${count(totals.toDelete)} to delete · ${count(totals.toGiveBack)} to give back · ` +
      `${count(totals.toBringBack)} to bring back`,
  ];
  if (!orgDiffers(diff)) {
    lines.push(
      `  ${orgName} is as it was at '${checkpoint.name}' among the objects and fields it holds: ` +
        'nothing to rewind.',
    );
  }
  const shown = diff.objects.filter(
    (o) => toDeleteOf(o) + o.toGiveBack.records + toBringBackOf(o) + cannotUndoOf(o) > 0,
  );
  if (shown.length > 0) {
    const width = Math.max(6, ...shown.map((o) => o.objectApiName.length));
    lines.push(
      `  ${'Object'.padEnd(width)}  ${'Delete'.padStart(8)}  ${'Give back'.padStart(9)}  ` +
        `${'Bring back'.padStart(10)}  ${"Can't undo".padStart(10)}`,
    );
    for (const o of shown) {
      lines.push(
        `  ${o.objectApiName.padEnd(width)}  ${count(toDeleteOf(o)).padStart(8)}  ` +
          `${count(o.toGiveBack.records).padStart(9)}  ${count(toBringBackOf(o)).padStart(10)}  ` +
          `${count(cannotUndoOf(o)).padStart(10)}`,
      );
    }
  }
  const by = new Map<string, number>();
  for (const object of diff.objects) {
    for (const [userId, n] of Object.entries(object.lastChangedBy)) {
      by.set(userId, (by.get(userId) ?? 0) + n);
    }
  }
  if (by.size > 0) {
    lines.push(
      `  last changed by: ${[...by]
        .sort((a, b) => b[1] - a[1])
        .map(([userId, n]) => `${diff.userNames[userId] ?? userId} ${count(n)}`)
        .join(' · ')}`,
    );
  }
  if (diff.activeLastHour.length > 0) {
    lines.push(
      `  people working in ${orgName} in the last hour: ${diff.activeLastHour
        .map((userId) => diff.userNames[userId] ?? userId)
        .join(', ')}`,
    );
  }
  const touched = diff.objects.filter((o) => o.touched > 0);
  if (touched.length > 0) {
    lines.push(
      `  touched since but holding their checkpoint values: ${someOf(
        touched.map((o) => `${o.objectApiName} ${count(o.touched)}`),
      )}`,
    );
  }
  const cannot = new Map<string, string[]>();
  for (const object of diff.objects) {
    for (const line of object.cannotUndo) {
      if (line.count === 0) continue;
      cannot.set(line.reason, [
        ...(cannot.get(line.reason) ?? []),
        `${object.objectApiName} ${count(line.count)}`,
      ]);
    }
  }
  for (const [reason, objects] of cannot) {
    lines.push(
      `  can't be taken back: ${someOf(objects)} — ${CANNOT_UNDO_WORDS[reason] ?? reason}`,
    );
  }
  const unexplained = diff.objects.filter((o) => o.unexplained > 0);
  if (unexplained.length > 0) {
    lines.push(
      `  left as they are: ${someOf(unexplained.map((o) => `${o.objectApiName} ${count(o.unexplained)}`))} ` +
        "— records the checkpoint doesn't hold although they're dated before it (a load with " +
        'back-dated creation dates?); a rewind deletes nothing it cannot prove was created since',
    );
  }
  if (diff.undoCannot.length > 0) {
    lines.push(
      `  undo couldn't bring back: ${someOf(
        diff.undoCannot.map((u) => `${u.objectApiName} ${count(u.count)}`),
      )} — Salesforce undeletes them only with their parent, and their parent stays`,
    );
  }
  for (const object of diff.objects) {
    for (const outside of object.outside) {
      lines.push(
        `  also deleted with them, outside the checkpoint: ${count(outside.count)} ` +
          `${outside.objectApiName} created under ${count(outside.parents)} ${object.objectApiName}`,
      );
    }
  }
  const notCompared = diff.objects.flatMap((o) =>
    o.notCompared.map((f) => `${o.objectApiName}.${f}`),
  );
  if (notCompared.length > 0) {
    lines.push(`  not compared (you chose): ${someOf(notCompared)}`);
  }
  for (const object of diff.objects) {
    const drift = object.schemaDrift;
    if (!drift) continue;
    const named = (fields: string[]) => fields.map((f) => `${object.objectApiName}.${f}`);
    if (drift.removed.length > 0) {
      lines.push(
        `  fields deleted since: ${someOf(named(drift.removed))} — restore them from Deleted ` +
          'Fields, then rewind',
      );
    }
    if (drift.added.length > 0) {
      lines.push(`  fields added since, their values left alone: ${someOf(named(drift.added))}`);
    }
    if (drift.changed.length > 0) {
      lines.push(`  fields changed since, tried one by one: ${someOf(named(drift.changed))}`);
    }
  }
  for (const unread of diff.unread) {
    lines.push(
      `  could not be read: ${unread.objectApiName} — ${unread.reason} (never taken for unchanged)`,
    );
  }
  if (answer.automation) lines.push(...automationLines(orgName, answer.automation));
  lines.push(estimateLine(answer.estimate));
  if (answer.refusal) lines.push(`  a rewind now would be refused: ${answer.refusal.message}`);
  return lines;
}

/** What `preview --json` prints: see the help. */
export function previewJson(
  orgName: string,
  checkpoint: Pick<OrgCheckpoint, 'checkpointId' | 'name' | 'takenAt'>,
  answer: PreviewAnswer,
): Record<string, unknown> {
  return {
    checkpoint: {
      id: checkpoint.checkpointId,
      name: checkpoint.name,
      takenAt: checkpoint.takenAt,
      org: orgName,
    },
    ...previewTotals(answer.diff),
    differs: orgDiffers(answer.diff),
    diff: answer.diff,
    estimate: answer.estimate,
    ...(answer.automation ? { automation: answer.automation } : {}),
    ...(answer.refusal ? { refusal: answer.refusal } : {}),
  };
}

/**
 * The exit code of a preview: 3 with `--fail-on-change` when the org differs
 * from the checkpoint ({@link orgDiffers}), 0 otherwise — a preview answered
 * is a preview done, whatever it found.
 */
export function previewExitCode(
  diff: Pick<RewindDiff, 'objects' | 'unread'>,
  failOnChange: boolean,
): number {
  return failOnChange && orgDiffers(diff) ? PARTIAL_EXIT : DONE_EXIT;
}

// ─── Running it ──────────────────────────────────────────────────────────────

/** How long the page waits for what a take would hold and cost. */
const SCOPE_TIMEOUT_MS = 10 * 60_000;

/** How long the page waits for a take it started: as long as a write run. */
const TAKE_TIMEOUT_MS = 12 * 60 * 60_000;

/** How long a preview may read the org for. */
const PREVIEW_TIMEOUT_MS = 60 * 60_000;

/** How long a request that reads this machine alone may take. */
const LOCAL_TIMEOUT_MS = 5 * 60_000;

/** The most checkpoints one delete names. */
const DELETE_BATCH = 200;

/** What the command runs with, beside its line; tests give their own. */
export interface CheckpointCliDeps {
  /** Stands the host up: the product's own unless a test gives another. */
  createHost?: (options: PanelHostOptions) => PanelHost;
  /** Where the orgs' locks are; `~/.sandforge/locks` unless a test names another. */
  locksDir?: string;
}

/** A refusal, said on the log and, with --json, as the answer on stdout. */
class Stop extends Error {
  constructor(
    readonly refusal: CheckpointRefusalLike,
    readonly code: number = FAILED_EXIT,
  ) {
    super(refusal.message);
    this.name = 'Stop';
  }
}

/** The payload of an answer, as an object. */
function payloadOf(answer: PanelAnswer): Record<string, unknown> {
  return (answer.message?.payload ?? {}) as Record<string, unknown>;
}

/** An answer that is not the response, as the refusal it stands for. */
function refusalOfAnswer(answer: PanelAnswer, what: string): CheckpointRefusalLike {
  const payload = payloadOf(answer);
  if (answer.outcome === 'unanswered') {
    return { code: 'UNANSWERED', message: `${what}: no answer came in time.` };
  }
  const message = typeof payload.message === 'string' ? payload.message : JSON.stringify(payload);
  const code = typeof payload.code === 'string' ? payload.code : answer.outcome.toUpperCase();
  return { code, message };
}

/** Run the command; exported so it can be run on the memory org. */
export async function main(
  argv: string[] = process.argv,
  deps: CheckpointCliDeps = {},
): Promise<void> {
  const args = parseArgs(argv);
  // On stderr with --json, where stdout carries the JSON alone.
  const say = (line: string): void => {
    process[args.json ? 'stderr' : 'stdout'].write(`${line}\n`);
  };
  const answerJson = (value: unknown): void => {
    if (args.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  };

  const opened = openCheckpointStore({
    root: args.storeRoot,
    ...(deps.locksDir !== undefined ? { locksDir: deps.locksDir } : {}),
  });
  if ('refusal' in opened) {
    const { reason, path } = opened.refusal;
    const message =
      reason === 'otherOwner'
        ? `The checkpoints cannot be kept in ${path}: another user of this machine owns it, and ` +
          'could read and replace the checkpoints in it. Name a folder of your own with --store.'
        : reason === 'notAFolder'
          ? `The checkpoints cannot be kept in ${path}: it is a file, not a folder.`
          : `The checkpoints cannot be kept in ${path}: it could not be made${opened.refusal.detail ? ` (${opened.refusal.detail})` : ''}.`;
    process.stderr.write(`${message}\n`);
    answerJson({ refusal: { code: 'STORE_REFUSED', message } });
    endWith(FAILED_EXIT);
    return;
  }
  const store = opened.store;

  // The host's own state: its config store, made for this run and removed
  // with it. Every org is connected afresh by the command that reaches it.
  const hostDir = mkdtempSync(join(tmpdir(), 'sandforge-checkpoint-'));
  const registry = new BackgroundOperationRegistry();
  let sweeping = false;
  let lastStep: string | undefined;
  let sweep: () => Promise<void> = () => Promise.resolve();
  try {
    const host = (deps.createHost ?? createPanelHost)({
      storeDir: hostDir,
      log: (line) => {
        // What the sweep removed, each named; the extension's warnings. Its
        // failures come back as the answers this command says itself.
        if (sweeping && line.startsWith('[INFO] ')) say(line.slice('[INFO] '.length));
        else if (line.startsWith('[WARN] ')) say(`warning: ${line.slice('[WARN] '.length)}`);
      },
      compose: (wiring) => {
        wiring.handlers.setCheckpointStore(store);
        // The registry alone: the take is listed in it, and Ctrl-C stops it
        // through it as Live Operations' Cancel does. Nothing else the
        // handlers this command sends to reads the rest of these services.
        wiring.handlers.setInfraServices({
          backgroundRegistry: registry,
        } as Partial<InfraServices> as InfraServices);
        sweep = () => wiring.handlers.sweepCheckpoints();
      },
      onPost: (message: PostedMessage) => {
        if (message.type !== 'operation:progress') return;
        const step = (message.payload as { currentStep?: unknown } | undefined)?.currentStep;
        if (typeof step !== 'string' || step === lastStep) return;
        lastStep = step;
        say(`  ${step}`);
      },
    });

    sweeping = true;
    try {
      await sweep();
    } finally {
      sweeping = false;
    }

    const listAll = async (): Promise<CheckpointListEntry[]> => {
      const answer = await host.request({ type: 'checkpoint:list', timeoutMs: LOCAL_TIMEOUT_MS });
      if (answer.outcome !== 'answered') {
        throw new Stop(refusalOfAnswer(answer, 'The list of checkpoints'));
      }
      return (payloadOf(answer).checkpoints ?? []) as CheckpointListEntry[];
    };
    const connect = async (alias: string): Promise<SalesforceOrg> => {
      try {
        return await host.connect(alias);
      } catch (err: unknown) {
        throw new Stop({
          code: 'NOT_CONNECTED',
          message: `${alias} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    };

    switch (args.command) {
      case 'list': {
        const all = await listAll();
        const entries = args.org !== undefined ? checkpointsOf(all, args.org) : all;
        for (const line of listLines(entries, store.root)) say(line);
        answerJson(entries.map(listEntryJson));
        return;
      }
      case 'take':
        await take(args, host, await connect(args.org), store, registry, say, answerJson);
        return;
      case 'preview': {
        const all = await listAll();
        const entry = chosen(
          resolveCheckpoint(all, checkpointsOf(all, args.org), args.checkpoint, args.org),
        );
        const invalid = invalidRefusal(entry);
        if (invalid) throw new Stop(invalid);
        const checkpoint = entry.checkpoint as OrgCheckpoint;
        const org = await connect(args.org);
        if (!sameOrganization(org.orgId, entry.organizationId)) {
          const takenUnder = checkpointsOf([entry], args.org).length > 0;
          throw new Stop({
            code: 'OTHER_ORG',
            message: takenUnder
              ? `${args.org} answers as another org than the one '${checkpoint.name}' was taken ` +
                'of: a sandbox refreshed since is another org, and this checkpoint can only be ' +
                'deleted. No record was read.'
              : `'${checkpoint.name}' is a checkpoint of ${orgOf(checkpoint)}, not of ` +
                `${args.org}: preview it with --org ${orgOf(checkpoint)}. No record was read.`,
          });
        }
        const answer = await host.request({
          type: 'checkpoint:preview',
          payload: { checkpointId: entry.checkpointId },
          timeoutMs: PREVIEW_TIMEOUT_MS,
        });
        if (answer.outcome !== 'answered') {
          throw new Stop(refusalOfAnswer(answer, 'The preview'));
        }
        const preview = payloadOf(answer) as unknown as PreviewAnswer;
        for (const line of previewLines(args.org, checkpoint, preview)) say(line);
        answerJson(previewJson(args.org, checkpoint, preview));
        endWith(previewExitCode(preview.diff, args.failOnChange));
        return;
      }
      case 'delete':
        await remove(args, host, listAll, say, answerJson);
        return;
    }
  } catch (err: unknown) {
    const stop =
      err instanceof Stop
        ? err
        : new Stop({ code: 'FAILED', message: err instanceof Error ? err.message : String(err) });
    process.stderr.write(`${stop.message}\n`);
    // A line refused, as a bad one is, prints nothing on stdout.
    if (stop.code !== 2) answerJson({ refusal: stop.refusal });
    endWith(stop.code);
  } finally {
    registry.dispose();
    rmSync(hostDir, { recursive: true, force: true });
  }
}

/** The checkpoint a resolution names, or the stop it ends the command with. */
function chosen(resolution: Resolution): CheckpointListEntry {
  if ('entry' in resolution) return resolution.entry;
  if ('ambiguous' in resolution) {
    throw new Stop({ code: 'AMBIGUOUS', message: resolution.ambiguous }, 2);
  }
  throw new Stop({ code: 'NOT_FOUND', message: resolution.none });
}

/** `take`, and `take --estimate`. */
async function take(
  args: Extract<CliArgs, { command: 'take' }>,
  host: PanelHost,
  org: SalesforceOrg,
  store: OrgCheckpointStore,
  registry: BackgroundOperationRegistry,
  say: (line: string) => void,
  answerJson: (value: unknown) => void,
): Promise<void> {
  const { take: asked } = args;
  if (args.estimate) {
    const payload = {
      orgId: org.id,
      mode: asked.mode,
      ...(asked.objects ? { objects: asked.objects } : {}),
      ...(asked.excluded ? { excluded: asked.excluded } : {}),
      ...(asked.maxTotal !== undefined ? { maxTotal: asked.maxTotal } : {}),
    };
    const answer = await host.request({
      type: 'checkpoint:scope',
      payload,
      timeoutMs: SCOPE_TIMEOUT_MS,
    });
    if (answer.outcome !== 'answered') {
      throw new Stop(refusalOfAnswer(answer, 'The estimate'));
    }
    const answered = payloadOf(answer) as unknown as ScopeAnswer;
    const scope: ScopeAnswer = {
      mode: answered.mode,
      objects: answered.objects,
      leftOut: answered.leftOut,
      estimate: answered.estimate,
      ...(answered.refusal ? { refusal: answered.refusal } : {}),
    };
    for (const line of scopeLines(args.org, scope)) say(line);
    answerJson(scope);
    endWith(scope.refusal ? FAILED_EXIT : DONE_EXIT);
    return;
  }

  say(
    `taking a checkpoint of ${args.org}: it reads every record of its objects (Ctrl-C stops it, ` +
      'and nothing of it is kept)',
  );
  // Ctrl-C stops the take as Live Operations' Cancel does, between two reads,
  // and nothing of it is kept. One that comes before the take is listed stops
  // it as it is listed. A second one ends the process at once.
  let stopped: StopSignal | undefined;
  const unlisten = registry.onEvent((operationId, type, operation) => {
    if (stopped !== undefined && type === 'started' && operation.module === 'checkpoint') {
      registry.abort(operationId);
    }
  });
  const release = onStopSignal((signal) => {
    stopped = signal;
    process.stderr.write(
      '\ninterrupted: the take stops after the read under way, and keeps nothing (Ctrl-C again ends it at once)\n',
    );
    for (const operation of registry.getRunning()) {
      if (operation.module === 'checkpoint') registry.abort(operation.operationId);
    }
  });
  let answer: PanelAnswer;
  try {
    answer = await host.request({
      type: 'checkpoint:take',
      payload: { orgId: org.id, ...asked },
      timeoutMs: TAKE_TIMEOUT_MS,
    });
  } finally {
    release();
    unlisten();
  }
  if (answer.outcome !== 'answered') {
    const refusal = refusalOfAnswer(answer, 'The take');
    if (stopped !== undefined && refusal.code === 'CANCELLED') {
      throw new Stop(refusal, stopExitCode(stopped));
    }
    throw new Stop(refusal);
  }
  const checkpoint = payloadOf(answer).checkpoint as OrgCheckpoint;
  const folder = store.folderOf(checkpoint.org.organizationId, checkpoint.checkpointId).dir;
  for (const line of takeLines(checkpoint, folder)) say(line);
  answerJson({ checkpoint });
}

/** `delete`: from this machine alone, after the question unless --yes. */
async function remove(
  args: Extract<CliArgs, { command: 'delete' }>,
  host: PanelHost,
  listAll: () => Promise<CheckpointListEntry[]>,
  say: (line: string) => void,
  answerJson: (value: unknown) => void,
): Promise<void> {
  const all = await listAll();
  const ofOrg = checkpointsOf(all, args.org);
  const targets =
    args.checkpoint === undefined
      ? ofOrg
      : [chosen(resolveCheckpoint(all, ofOrg, args.checkpoint, args.org))];
  if (targets.length === 0) {
    throw new Stop({
      code: 'NOT_FOUND',
      message: `No checkpoint of ${args.org} is kept on this machine. Nothing was deleted.`,
    });
  }
  const named = (entry: CheckpointListEntry): string =>
    entry.checkpoint ? `'${entry.checkpoint.name}' (${entry.checkpointId})` : entry.checkpointId;
  if (!args.yes) {
    const undone = targets.filter((entry) => entry.undo !== undefined);
    const what =
      targets.length === 1
        ? `Delete ${named(targets[0])}${targets[0].checkpoint ? `, taken ${when(targets[0].checkpoint.takenAt)},` : ''} from this machine? ${args.org} can no longer be rewound to it`
        : `Delete the ${targets.length} checkpoints of ${args.org} from this machine (${someOf(
            targets.map(named),
            4,
          )})? ${args.org} can no longer be rewound to them`;
    const question =
      `${what}${undone.length > 0 ? ', and its last rewind can no longer be undone' : ''}. ` +
      'The org is not touched.';
    if (!(await confirm(question))) {
      throw new Stop({ code: 'DECLINED', message: 'Nothing was deleted.' });
    }
  }
  const asked = targets.map((entry) => entry.checkpointId);
  for (let at = 0; at < asked.length; at += DELETE_BATCH) {
    const answer = await host.request({
      type: 'checkpoint:delete',
      payload: { checkpointIds: asked.slice(at, at + DELETE_BATCH) },
      timeoutMs: LOCAL_TIMEOUT_MS,
    });
    if (answer.outcome !== 'answered') {
      const refusal = refusalOfAnswer(answer, 'The delete');
      // What the batches before it deleted is said by the list below.
      if (at === 0) throw new Stop(refusal);
      say(`refused: ${refusal.message}`);
      break;
    }
  }
  // What is gone is what the store no longer lists: one deleted meanwhile by
  // another window counts as deleted, one a run's lock kept does not.
  const left = new Set((await listAll()).map((entry) => entry.checkpointId));
  const deleted = targets.filter((entry) => !left.has(entry.checkpointId));
  const kept = targets.filter((entry) => left.has(entry.checkpointId));
  for (const entry of deleted) say(`deleted ${named(entry)}`);
  for (const entry of kept) {
    say(
      `kept ${named(entry)}: a take, a rewind or an undo of its org is running; delete it once ` +
        'it has ended',
    );
  }
  answerJson({
    deleted: deleted.map((entry) => entry.checkpointId),
    kept: kept.map((entry) => entry.checkpointId),
  });
  if (kept.length > 0) endWith(deleted.length > 0 ? PARTIAL_EXIT : FAILED_EXIT);
}

// `tsx` runs this file directly; the check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-checkpoint')) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
