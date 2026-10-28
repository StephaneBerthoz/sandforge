#!/usr/bin/env tsx
/**
 * sandforge-checkpoint — take a checkpoint of an org's data, list the
 * checkpoints kept, preview what a rewind to one would do, rewind the org to
 * one and undo that rewind, and delete them, without the editor.
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
 * has them deleted. `take`, `preview`, `rewind` and `undo` reach the org
 * through the `sf` CLI's session. A production org is refused by the
 * checkpoint's own guard, before any record is read, and no flag lifts it.
 *
 * `rewind` shows the preview, asks, then rewinds from that same preview, as
 * it read the org: what changed since it read is left as it is and named. A
 * rewind or an undo that does not ask (`--yes`) names its checkpoint: `latest`
 * could be one taken since by someone else.
 *
 * The host keeps nothing of its own past the command: its config store is a
 * folder of the system's temp directory made for the run, its owner's alone,
 * removed as the command ends. What lasts is the checkpoints, in the store.
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts take --org DEV --name baseline
 *   pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts preview --org DEV --fail-on-change
 *   pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts rewind --org DEV --checkpoint baseline --yes
 *   pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts list
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  blindedBy,
  checkpointIdSchema,
  checkpointIgnoredFieldsSchema,
  firedOnRemovalStepsOf,
  type CheckpointCustomSettingKind,
  type CheckpointCustomSettings,
  type CheckpointEmails,
  type CheckpointEstimate,
  type CheckpointLeftOutObject,
  type CheckpointListEntry,
  type CheckpointObject,
  type CheckpointRefusal,
  type CheckpointScopeCustomSetting,
  type CheckpointScopeFiles,
  type CheckpointScopeMode,
  type CheckpointScopeObject,
  type CheckpointTakeRequests,
  type ForgeRemovalSteps,
  type ForgeTargetAutomation,
  type OrgCheckpoint,
  type RewindDiff,
  type RewindDiffObject,
  type RewindResidual,
  type RewindResult,
  type RewindStatus,
  type RewindUndoCannot,
  type RewindUndoCannotReason,
  type SalesforceOrg,
} from '@sandforge/shared';
import { createPanelHost } from './panelHost.js';
import type { PanelAnswer, PanelHost, PanelHostOptions, PostedMessage } from './panelHost.js';
import { refuseUnreadArguments, type CommandFlags } from './commandLine.js';
import { DONE_EXIT, FAILED_EXIT, PARTIAL_EXIT, UNSTABLE_EXIT, endWith } from './exitCodes.js';
import { confirm, typed } from './prompt.js';
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
import { objectsWrittenBy } from '../src/modules/checkpoint/previewCheckpoint.js';
import { undoPlansOf } from '../src/modules/checkpoint/rewindJournal.js';
import { HELD_WHEN_PICKED } from '../src/modules/checkpoint/checkpointScope.js';
import { DEFAULT_MAX_TOTAL } from '../src/modules/checkpoint/takeCheckpoint.js';
import { formatMB } from '../src/modules/forge/ForgeRunGate.js';
import { holdOutputWhole } from './wholeOutput.js';

const HELP = `sandforge-checkpoint — take a checkpoint of an org's data, and rewind the org to it, without the editor.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts <command> --org <alias> [options]

Commands:
  take      read the org's records and keep them as a checkpoint on this machine
  list      name the checkpoints kept, newest first, with what a rewind and an undo can still reach
  preview   say what a rewind would delete, give back and bring back, who last changed it, and what
            it and an undo cannot take back; writes nothing
  rewind    return the org to a checkpoint: bring back from the recycle bin the records deleted
            since, give the records changed since their values back, delete the records created
            since, and put the files attached to its records back as they were — whoever made the
            changes; keep what it changes so it can be undone; then read the org again
  undo      take back the org's last rewind: bring back what it deleted, give back what it wrote
            over, send back to the bin what it brought back; what anyone changed since the rewind
            stays, and is said
  delete    delete a checkpoint from this machine; the org is not touched

Required:
  --org <alias>                  sf CLI alias of the org (list: every org of the store without it)

take:
  --name <text>                  what it is called (default: the date and time)
  --object <ApiName>             an object to keep; repeat for more (default: every object people
                                 work in, empty ones included, setup and log objects left out)
  --exclude-object <ApiName>     leave an object out; repeat for more
  --custom-setting <ApiName|all> keep a custom setting, or all of them, which a checkpoint leaves
                                 out unless named: a rewind sets their rows back, an integration's
                                 endpoint or an admin's switch among them; repeat for more; needs
                                 Customize Application
  --ignore-field <Object.Field>  do not compare a field, nor write it back (one your automation sets
                                 on every save); repeat for more
  --max-total <n>                refuse, before reading, more than <n> records (default: ${DEFAULT_MAX_TOTAL})
  --keep-days <n>                when it expires (default: ${DEFAULT_KEEP_DAYS}; 0 keeps it until deleted)
  --estimate                     say the records, API requests, time and disk it would take, then stop
preview, rewind, undo, delete:
  --checkpoint <id|name|latest>  which one (default: latest, for undo the one the last rewind went
                                 back to; rewind and undo with --yes need it named, by id or name)
preview:
  --fail-on-change               exit 3 when the org differs from the checkpoint
rewind:
  --dry-run                      the preview, then stop
  --accept-automation            rewind even when the org runs flows, Apex triggers, processes or
                                 workflow rules as records are updated, deleted or brought back;
                                 without it such a rewind writes nothing, exit 1
  --accept-no-undo               rewind even when undo could not bring back some records it deletes
                                 (objects Salesforce undeletes only with their parent, such as
                                 OpportunityLineItem); without it such a rewind writes nothing, exit 1
  --accept-recreate              make again, with new Ids, the records deleted since that the
                                 recycle bin no longer gives back: what outside Salesforce names
                                 their old Ids no longer finds them; without it a rewind that
                                 counts such records writes nothing, exit 1, and one Salesforce
                                 answers is no longer in the bin as it brings it back is left,
                                 named
  --accept-outside               (a checkpoint of picked objects) also delete the records outside it
                                 created under records it deletes, and the files it deletes that are
                                 attached outside it too; without it those parents stay, and those
                                 files are only removed from its records
  --ignore-field <Object.Field>  stop comparing a field from now on; kept in the checkpoint
  --yes                          do not ask before writing; without it and with no terminal — a CI
                                 step — it stops at its question, exit 2, having written nothing
undo:
  --accept-automation            as for rewind
  --yes                          as for rewind
delete:
  --all                          every checkpoint of the org
  --yes                          do not ask
Options:
  --store <dir>                  where checkpoints live (default: ~/.sandforge/checkpoints, or
                                 checkpoints/ in the folder SANDFORGE_JOURNAL_DIR names)
  --json                         the answer alone on stdout, every other line on stderr
  --help                         this text

A production org is refused before anything is read or written, exit 1. No flag lifts it.
The user the alias connects as needs View All Data and Modify All Data, and Customize
Application for a checkpoint that keeps custom settings: View All Custom Settings reads them,
never writes them.
A checkpoint holds the records' values as the org held them, personal data among them,
unencrypted, in files only you can read (on Windows: in your user profile). Expired checkpoints
are deleted as any command starts, each named.
list and delete read this machine alone and never contact the org. An org's checkpoints are the
ones taken under its alias or username, and the others kept of the same Organization Id.
rewind shows its preview and asks you to type the org's alias before it writes, then rewinds from
that preview as it read the org: a record someone changes after it read is left as they made it,
and said. A take, a rewind or an undo of the org under way on this machine, in the editor or in
another command line, refuses a rewind and an undo; other runs writing to the org are not seen
here, and what one of them changes after the preview read the org is left and said the same way.
Ctrl-C stops a take between two reads, and nothing of it is kept; a second Ctrl-C ends it at once,
and leaves a checkpoint listed as never taken, which delete removes. Ctrl-C stops a rewind or an
undo before its next call to the org, and leaves its journal: rewind again takes up from what still
differs, and undo still returns the org to how it was before the rewind.

A record deleted since that the recycle bin no longer gives back is made again from the
checkpoint, with a new Id, once --accept-recreate says so: the lookups the checkpoint holds that
named it name the new Id, and undo deletes it again. Salesforce still lists a record emptied from
the bin as deleted, for minutes to hours, and says the bin no longer holds it only as the rewind
asks it back: such a record, with what was to come back with it, is made again then, or left
and named without --accept-recreate.
A record the checkpoint does not hold that took records of it along when it was deleted since is
brought back for a moment with them, then deleted again with what came back with it.
A custom setting is kept only when --custom-setting names it. A rewind brings a row of one back
only once no other row holds its owner (a hierarchy: the org's default, a profile, a user) or
its name (a list): it deletes the row made since first, then brings the row back with its Id.
A checkpoint holds the files attached to its records, Salesforce Files and classic attachments:
which records each is attached to, its latest version and its size, never its content. A rewind
deletes the files attached to them since, brings back those deleted since with their links,
removes the links added since and puts back those removed since, under new Ids; a file
attached to no record of the checkpoint, a user's own or a library's, is left and counted.
Bringing files back from the recycle bin takes file storage again: a rewind or an undo that would
take more than the org has left is refused before it writes. Without Query All Files, other
users' files that no record of the checkpoint is attached to are not seen.
What a rewind cannot undo: a file deleted since and no longer in the recycle bin, whose body the
checkpoint does not hold, a file given a new version since, which keeps it, a lead converted
since, a contract activated since, a record deleted with a parent created since that Salesforce
does not undelete on its own, or with its parent of an object the checkpoint does not hold
(preview counts them); a field added since, deleted since, or hidden since from the user by
field-level security, which the preview tells apart and names; the values the org computes or
keeps itself (formulas, roll-ups, auto-numbers, created and modified dates); what left the org
(emails, callouts, outbound messages, platform events); metadata; the files of a checkpoint
taken before SandForge 1.70, which holds none. A record the org refuses to put back, or to make
again, is named by rewind, with its words.

JSON (--json), one value on stdout:
  list               [{id, name, org, organizationId, takenAt, records, bytes, expiresAt,
                       expiresSoon, binReachSince, lastRewind?, valid, why?, refreshedAt?}]
                     (name, org, takenAt, records and bytes are null for a damaged checkpoint;
                     expiresAt is null for one kept until deleted)
  take               {checkpoint, requests?, estimate}: the checkpoint as kept (its
                     checkpoint.json; files?, {documents, links, anchored, readByIds?}, for one
                     that holds files); requests, {total, byPhase}, the API requests the take sent
                     the org, SOAP calls among them; estimate, what it said before reading a record
  take --estimate    {mode, objects, leftOut, estimate, refusal?, files?, customSettings?}:
                     estimate.requestsByPhase splits the requests over a take's phases as
                     requests.byPhase does: guard, scope, start, counts, bin, snapshot, stability;
                     files, {held, queryAllFiles, addedToPicked}; customSettings, every custom
                     setting of the org, kept or not, [{objectApiName, label, kind?, records?}],
                     kind hierarchy or list, and objects[].customSetting for one kept; {mode,
                     refusal} for a take refused before its scope is read (a production org, a
                     user without the permissions)
  preview            {checkpoint: {id, name, takenAt, org}, toDelete, toGiveBack, toBringBack,
                      toRecreate, carriers, differs, diff, estimate, automation?, emails?,
                      emailsUncounted?, refusal?}: carriers, the records brought back for a
                     moment and deleted again, in none of the other numbers; diff, estimate,
                     automation and refusal as the extension answers them; refusal is the one a
                     rewind would meet now; emails, one per daily limit its writes send
                     against: {limit, emails, verdict, remaining?, max?, alertsCounted?,
                     objects: [{objectApiName, write, records, perRecord, sentBy}]};
                     emailsUncounted, what sends emails as it writes that could not be read — a
                     flow whose definition was refused, a package's, which no user reads — its
                     emails not counted, which --accept-automation covers;
                     diff.objects[].schemaDrift, of an object whose fields changed since:
                     {removed, added, changed, hidden?, uncertain?: {fields, reason?}}, removed
                     the custom fields deleted since, hidden those field-level security hides
                     from the user, uncertain those the org would not say which of; diff.files,
                     for a checkpoint that holds files: {unlink, relink, updateLinks,
                     outsideAdded, outsideDeleted, storage: {bringBack, remaining?, undo},
                     blindSpot?}, the links to remove, put back and give their sharing back, the
                     files left, and file storage in bytes
  rewind --dry-run   as preview
  rewind             {checkpoint: {id, name, takenAt, org}, rewindId, status, deleted, givenBack,
                      broughtBack, recreated (each {planned, done, left}), cannotUndo: [{object,
                      reason, count}], carriers?: [{object, count}], undo?: {until, cannot:
                      [{object, count, reason?}]}, verify: {differences, stable, passes,
                      notCompared}, residual: [{object, reason, by?, count, message?}], unread:
                      [{object, reason}], objects: [{object, deleted, givenBack, broughtBack,
                      refused}], apiRequests: {used, leftToday}, result}:
                     status success, partial, unstable, failure or cancelled; result as the
                     extension answers it; undo.cannot's reason deletedBeforeParent: deleted
                     before a record they point at, which the rewind deleted next; carriers, of
                     what it brought back and deleted, the records brought back for a moment;
                     files?: {unlinked, relinked, linksUpdated, linksRefused}, the links between
                     files and records it wrote, when it wrote one
  undo               as rewind, without recreated, cannotUndo, carriers and undo, with
                     carriedAlone?: [{object, count}], the records sent back to the recycle bin
                     on their own that had gone there with a record the rewind brought back for
                     a moment
  delete             {deleted: [id], kept: [id]}
  refused or failed  {refusal: {code, message}}
  A bad command line (exit 2) prints nothing on stdout.

Exit codes: 0 done (take: every record of its objects is kept; rewind and undo: read again, the
org matches among the objects and fields compared; preview, rewind --dry-run and list answered;
delete: every checkpoint named is deleted); 1 refused before it read or wrote (a production org,
missing permissions, automation without --accept-automation, deletions undo could not bring back
without --accept-no-undo, records to make again with new Ids without --accept-recreate, more than
--max-total records, more API requests or emails than the org
has left today, files to bring back taking more file storage than it has left, a checkpoint of
the org before a refresh or of an expired scratch org, a SandForge run writing to it), or nothing
done; 2 a bad command line, a --checkpoint name several checkpoints
have, rewind or undo with --yes and no checkpoint named, or a question with no terminal (give
--yes); 3 partial (rewind and undo: records still differ, each said with why; with
--fail-on-change, the org differs: records to delete, give back, bring back or make again,
links between files and records to remove, put back or give their sharing back, records the
rewind cannot take back or the checkpoint does not hold although they are dated before it, files
added or deleted since that no record of it is attached to, an object that
could not be read; delete: some were kept, each said with why); 4 unstable (someone else changed
records during the rewind or the undo: left as they made them); 130, 143, 129 Ctrl-C, SIGTERM or
SIGHUP stopped it — run rewind again: it takes up from what still differs, and undo still reaches
the state before it.
`;

// ─── The command line ────────────────────────────────────────────────────────

/** What the tool does, as its first word names it. */
const COMMANDS = ['take', 'list', 'preview', 'rewind', 'undo', 'delete'] as const;
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
      '--custom-setting',
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
  rewind: {
    words: 1,
    switches: [
      ...COMMON.switches,
      '--dry-run',
      '--accept-automation',
      '--accept-no-undo',
      '--accept-recreate',
      '--accept-outside',
      '--yes',
    ],
    values: [...COMMON.values, '--checkpoint', '--ignore-field'],
  },
  undo: {
    words: 1,
    switches: [...COMMON.switches, '--accept-automation', '--yes'],
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
  customSettings: '--custom-setting',
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
  customSettings?: CheckpointCustomSettings;
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
      command: 'rewind';
      org: string;
      checkpoint: string;
      dryRun: boolean;
      acceptAutomation: boolean;
      acceptNoUndo: boolean;
      acceptRecreate: boolean;
      acceptOutside: boolean;
      /** Fields, `Object.Field`, to stop comparing from now on. */
      ignoreFields: string[];
      yes: boolean;
    })
  | (CommonArgs & {
      command: 'undo';
      org: string;
      /** Absent: the checkpoint the org's last rewind went back to. */
      checkpoint?: string;
      acceptAutomation: boolean;
      yes: boolean;
    })
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
    return refuseLine(
      'Name the command first: take, list, preview, rewind, undo or delete. Run with --help.',
    );
  }
  if (!isCommand(command)) {
    return refuseLine(
      `"${command}" is not a command of sandforge-checkpoint: take, list, preview, rewind, undo ` +
        'or delete. Nothing was run. Run with --help.',
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
  // A rewind or an undo that does not ask is told which checkpoint it acts
  // on: `latest` could be one taken since, by someone else.
  const namedForYes = (checkpoint: string | undefined): void => {
    if (!args.includes('--yes')) return;
    if (checkpoint === undefined) {
      refuseLine(
        `${command} --yes needs --checkpoint <id|name>: one that does not ask is told which ` +
          'checkpoint it acts on. Nothing was run.',
      );
    }
    if (checkpoint === 'latest') {
      refuseLine(
        `${command} --yes needs the checkpoint named by its id or its name, not latest: a ` +
          'checkpoint taken since would be the one it acts on. Nothing was run.',
      );
    }
  };

  switch (command) {
    case 'list':
      return { ...common, command, ...(org !== undefined ? { org } : {}) };
    case 'take': {
      const named = orgNamed();
      const objects = values('--object');
      const excluded = values('--exclude-object');
      // `all` names every custom setting of the org, those named beside it among them.
      const settings = values('--custom-setting');
      const customSettings = settings.includes('all') ? ('all' as const) : settings;
      const ignoredFields = values('--ignore-field');
      const maxTotal = wholeNumber('--max-total');
      const take: TakeAsked = {
        name: single('--name') ?? defaultName(now),
        mode: objects.length > 0 ? 'picked' : 'everything',
        ...(objects.length > 0 ? { objects } : {}),
        ...(excluded.length > 0 ? { excluded } : {}),
        ...(customSettings.length > 0 ? { customSettings } : {}),
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
    case 'rewind': {
      const named = orgNamed();
      const checkpoint = single('--checkpoint');
      namedForYes(checkpoint);
      const ignoreFields = values('--ignore-field');
      const checked = checkpointIgnoredFieldsSchema.safeParse(ignoreFields);
      if (!checked.success) {
        return refuseLine(
          `--ignore-field: ${checked.error.issues[0]?.message ?? 'not read'}. Nothing was run.`,
        );
      }
      return {
        ...common,
        command,
        org: named,
        checkpoint: checkpoint ?? 'latest',
        dryRun: args.includes('--dry-run'),
        acceptAutomation: args.includes('--accept-automation'),
        acceptNoUndo: args.includes('--accept-no-undo'),
        acceptRecreate: args.includes('--accept-recreate'),
        acceptOutside: args.includes('--accept-outside'),
        ignoreFields,
        yes: args.includes('--yes'),
      };
    }
    case 'undo': {
      const named = orgNamed();
      const checkpoint = single('--checkpoint');
      namedForYes(checkpoint);
      return {
        ...common,
        command,
        org: named,
        ...(checkpoint !== undefined ? { checkpoint } : {}),
        acceptAutomation: args.includes('--accept-automation'),
        yes: args.includes('--yes'),
      };
    }
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
  base64: 'the content of files and other binary values, which a checkpoint doesn’t hold',
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
        `  records deleted before ${entry.binReachSince.slice(0, 10)} can't come back with their ` +
          'Id (recycle bin), sooner if the bin fills: a rewind makes them again, with new Ids',
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

/** What a take's scope answers: what it would hold and cost, and what it would hold of the org's files. */
export interface ScopeAnswer {
  mode: CheckpointScopeMode;
  objects: CheckpointScopeObject[];
  leftOut: CheckpointLeftOutObject[];
  estimate: CheckpointEstimate;
  refusal?: CheckpointRefusal;
  files?: CheckpointScopeFiles;
  customSettings?: CheckpointScopeCustomSetting[];
}

/**
 * Whether a take was refused before its scope was read: the org is a
 * production org, or the user lacks View All Data and Modify All Data. The
 * answer then holds no object, kept or left out, and an estimate of nothing.
 */
function refusedUnread(scope: ScopeAnswer): scope is ScopeAnswer & { refusal: CheckpointRefusal } {
  return scope.refusal !== undefined && scope.objects.length === 0 && scope.leftOut.length === 0;
}

/**
 * What `take --estimate --json` prints: the scope, or only its mode and the
 * refusal when the take was refused before its scope was read — an estimate
 * of nothing read as a take that would cost nothing.
 */
export function scopeJson(scope: ScopeAnswer): Record<string, unknown> {
  return refusedUnread(scope) ? { mode: scope.mode, refusal: scope.refusal } : { ...scope };
}

/**
 * The lines `take --estimate` prints. A take refused before its scope was
 * read prints the refusal alone: run as a Standard User, it printed "would
 * keep 0 objects … about 0 API requests of the 0 left today" above it, an
 * estimate of nothing that read as one of a take costing nothing. A refusal
 * met once the scope was counted — too many records, past the API requests
 * left — keeps the estimate it is about.
 */
export function scopeLines(orgName: string, scope: ScopeAnswer): string[] {
  if (refusedUnread(scope)) return [`refused: ${scope.refusal.message}`];
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
    ...(scope.files ? scopeFilesLines(scope.files) : []),
    ...customSettingsLines(scope),
    ...(scope.refusal ? [`refused: ${scope.refusal.message}`] : []),
  ];
}

/** A custom setting as a line names it: its name, kind and rows, as far as the org said them. */
function settingWords(setting: {
  objectApiName: string;
  kind?: CheckpointCustomSettingKind;
  records?: number;
}): string {
  const rows =
    setting.records === undefined
      ? undefined
      : `${count(setting.records)} ${setting.records === 1 ? 'row' : 'rows'}`;
  const said = [setting.kind, rows].filter((part) => part !== undefined);
  return said.length > 0 ? `${setting.objectApiName} (${said.join(', ')})` : setting.objectApiName;
}

/** A custom setting a take keeps, as a line names it. */
function keptSettingWords(
  object: Pick<CheckpointScopeObject, 'objectApiName' | 'customSetting' | 'records'>,
): string {
  return settingWords({
    objectApiName: object.objectApiName,
    ...(object.customSetting !== undefined ? { kind: object.customSetting } : {}),
    records: object.records,
  });
}

/**
 * The custom settings a take would keep, which a rewind sets back as it
 * holds them, and those of the org it leaves out, with the flag that keeps
 * them; nothing for an org that has none.
 */
function customSettingsLines(scope: ScopeAnswer): string[] {
  const kept = scope.objects.filter((object) => object.customSetting !== undefined);
  const held = new Set(kept.map((object) => object.objectApiName));
  const others = (scope.customSettings ?? []).filter((setting) => !held.has(setting.objectApiName));
  return [
    ...(kept.length > 0
      ? [
          `  custom settings kept: ${someOf(kept.map(keptSettingWords))} — a rewind sets their rows ` +
            'back as the checkpoint holds them, whoever changed them since',
        ]
      : []),
    ...(others.length > 0
      ? [
          `  custom settings not kept: ${someOf(others.map(settingWords))} — ` +
            '--custom-setting <ApiName|all> keeps them',
        ]
      : []),
  ];
}

/**
 * What a take would hold of the org's files, said before it reads a record:
 * the files attached to the records it holds, what it keeps of them and what
 * it leaves; the objects of files added to those picked; and, for a user
 * without Query All Files, what of other users' files it cannot see.
 */
function scopeFilesLines(files: CheckpointScopeFiles): string[] {
  if (!files.held) {
    return ['  files: not kept — a rewind leaves the files attached since as they are'];
  }
  return [
    '  files: it keeps which files are attached to its records (Salesforce Files, classic ' +
      "attachments) and each file's latest version, not its content; a rewind deletes the " +
      'files attached to them since and brings back those deleted since. A file attached to ' +
      "no record it holds, a user's own or a library's, is left as it is",
    ...addedToPickedLines(files.addedToPicked),
    ...(files.queryAllFiles ? [] : [BLIND_SPOT_LINE]),
  ];
}

/** The objects of files a scope of picked objects holds though they were not picked, said; nothing when there are none. */
function addedToPickedLines(added: readonly string[]): string[] {
  return added.length > 0
    ? [
        `  added to the objects picked: ${added.join(', ')} — without them a rewind would leave ` +
          'the files attached since as they are',
      ]
    : [];
}

/**
 * What a user without Query All Files does not see of the org's files, as
 * the take and the preview say it: another user's file is read only by its
 * id or through a record it is attached to.
 */
const BLIND_SPOT_LINE =
  "  the user the alias connects as doesn't have Query All Files: other users' files that no " +
  'record of the checkpoint is attached to (in a library the user is not a member of, say) ' +
  'are not seen, nor counted among the files left; files attached to its records are seen';

/**
 * The lines a take prints once its checkpoint is kept: of a checkpoint of
 * picked objects, `picked` names those the take was asked for.
 */
export function takeLines(
  checkpoint: OrgCheckpoint,
  folder: string,
  picked: readonly string[] = [],
): string[] {
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
    ...takenSettingsLines(checkpoint.objects),
    ...(checkpoint.files ? takenFilesLines(checkpoint, checkpoint.files, picked) : []),
    `  it holds the records' values unencrypted, in files only you can read: ${folder}`,
  ];
}

/** The custom settings a take kept, each with its kind and rows; nothing when it kept none. */
function takenSettingsLines(objects: readonly CheckpointObject[]): string[] {
  const kept = objects.filter((object) => object.customSetting !== undefined);
  if (kept.length === 0) return [];
  return [
    `  custom settings kept: ${someOf(kept.map(keptSettingWords))} — a rewind sets their rows back ` +
      'as the checkpoint holds them',
  ];
}

/**
 * What a take kept of the files attached to its records, and how it read
 * their links; as its estimate said them, the objects of files added to
 * those picked, and, for a user without Query All Files, what of other
 * users' files it does not see.
 */
function takenFilesLines(
  checkpoint: OrgCheckpoint,
  files: NonNullable<OrgCheckpoint['files']>,
  picked: readonly string[],
): string[] {
  const readByIds = files.readByIds ?? [];
  const asked = new Set(picked.map((name) => name.toLowerCase()));
  const held = new Set(checkpoint.objects.map(({ objectApiName }) => objectApiName.toLowerCase()));
  const added =
    checkpoint.scope.mode === 'picked'
      ? HELD_WHEN_PICKED.filter(
          (name) => held.has(name.toLowerCase()) && !asked.has(name.toLowerCase()),
        )
      : [];
  return [
    `  files: ${count(files.anchored)} attached to its records by ${count(files.links)} ` +
      'link(s): a rewind takes back what is attached to them since',
    ...addedToPickedLines(added),
    ...(readByIds.length > 0
      ? [
          `  the links of ${someOf(readByIds)} were read by lists of record Ids: ` +
            `${orgOf(checkpoint)} refused one query, or answered too late`,
        ]
      : []),
    ...(checkpoint.takenBy.queryAllFiles === false ? [BLIND_SPOT_LINE] : []),
  ];
}

/**
 * The line a take prints of the API requests it sent the org, phase by phase,
 * each beside what its estimate said when they differ.
 */
export function requestsLine(
  requests: CheckpointTakeRequests,
  estimate: Pick<CheckpointEstimate, 'apiRequests' | 'requestsByPhase'> | undefined,
): string {
  const phases = Object.entries(requests.byPhase).map(([phase, sent]) => {
    const said = estimate?.requestsByPhase?.[phase as keyof CheckpointTakeRequests['byPhase']];
    return said === undefined || said === sent ? `${phase} ${sent}` : `${phase} ${sent} (${said})`;
  });
  const said = estimate ? `, about ${count(estimate.apiRequests)} estimated` : '';
  return `  sent ${count(requests.total)} API requests to the org${said}: ${phases.join(', ')}`;
}

/**
 * What a rewind to a checkpoint would do, in the three numbers the preview
 * leads with, and the records it would make again with new Ids.
 */
export interface PreviewTotals {
  toDelete: number;
  toGiveBack: number;
  toBringBack: number;
  toRecreate: number;
}

const toDeleteOf = (o: RewindDiffObject): number =>
  o.toDelete.createdSince + o.toDelete.broughtBackSince + o.toDelete.comesBackWithParent;
const toBringBackOf = (o: RewindDiffObject): number =>
  o.toBringBack.inBin + o.toBringBack.withParent + o.toBringBack.deletedWhileTaken;
const cannotUndoOf = (o: RewindDiffObject): number =>
  o.cannotUndo.reduce((total, line) => total + line.count, 0);
const toRecreateOf = (o: RewindDiffObject): number => o.toRecreate ?? 0;
/**
 * Records the checkpoint does not hold brought back for a moment, with the
 * records of it their delete took along, then deleted again: in none of the
 * three numbers, but written twice.
 */
const carriersOf = (o: RewindDiffObject): number => o.toBringBack.carriers ?? 0;

/**
 * The three numbers: records to delete (created since, brought back from the
 * bin since, and those that come back with a parent and go again), to give
 * their values back, and to bring back from the recycle bin; and the records
 * the recycle bin no longer gives back, to make again with new Ids.
 */
export function previewTotals(diff: Pick<RewindDiff, 'objects'>): PreviewTotals {
  return diff.objects.reduce<PreviewTotals>(
    (totals, object) => ({
      toDelete: totals.toDelete + toDeleteOf(object),
      toGiveBack: totals.toGiveBack + object.toGiveBack.records,
      toBringBack: totals.toBringBack + toBringBackOf(object),
      toRecreate: totals.toRecreate + toRecreateOf(object),
    }),
    { toDelete: 0, toGiveBack: 0, toBringBack: 0, toRecreate: 0 },
  );
}

/**
 * The links between files and records a rewind writes: those added since it
 * removes, those removed since it puts back, those whose sharing it gives
 * back. None for a checkpoint that holds no files.
 */
export function linkWritesOf(diff: Partial<Pick<RewindDiff, 'files'>>): number {
  const files = diff.files;
  return files === undefined ? 0 : files.unlink + files.relink + files.updateLinks;
}

/** The files added or deleted since that no record of the checkpoint links to, which a rewind leaves. */
function filesLeftOf(diff: Partial<Pick<RewindDiff, 'files'>>): number {
  const files = diff.files;
  return files === undefined ? 0 : files.outsideAdded + files.outsideDeleted;
}

/**
 * Whether the org differs from the checkpoint, among the objects and fields
 * it holds: records a rewind would delete, give back, bring back or make
 * again; links between its files and its records to remove, put back or give
 * their sharing back; records it cannot take back, or that the checkpoint does
 * not hold although they are dated before it; files added or deleted since
 * that no record of it links to, which a rewind leaves; or an object that
 * could not be read, which is never taken for one that did not change.
 */
export function orgDiffers(
  diff: Pick<RewindDiff, 'objects' | 'unread'> & Partial<Pick<RewindDiff, 'files'>>,
): boolean {
  const totals = previewTotals(diff);
  return (
    totals.toDelete + totals.toGiveBack + totals.toBringBack + totals.toRecreate > 0 ||
    linkWritesOf(diff) + filesLeftOf(diff) > 0 ||
    diff.objects.some((object) => cannotUndoOf(object) > 0 || object.unexplained > 0) ||
    diff.unread.length > 0
  );
}

/** What a rewind cannot take back of an object, as the preview says it. */
const CANNOT_UNDO_WORDS: Readonly<Record<string, string>> = {
  goneForGood:
    'deleted since and no longer in the recycle bin, and not made again — a file, whose body ' +
    'the checkpoint does not hold, or a record deleted while it was taken: they can’t come back',
  convertedLead: 'leads converted since: Salesforce can’t unconvert a lead',
  activatedContract: 'contracts activated since: Salesforce won’t set them back to Draft',
  deletedWithCreatedParent:
    'deleted with a parent created since that Salesforce does not undelete on its own: they ' +
    'come back with that parent only',
  deletedWithParentOutside:
    'deleted with their parent, a record of an object the checkpoint does not hold: they come ' +
    'back with that parent only, which a checkpoint that holds its object brings back',
  newFileVersion:
    'files given a new version since: Salesforce deletes no version and won’t make an older ' +
    'one the latest again, so they keep their new content; the content each had is still in ' +
    'its version history, and their titles are given back',
};

/**
 * Why Undo couldn't bring back records a rewind deletes, in the order the
 * lines say them: as the preview says it, as a refusal for want of
 * `--accept-no-undo` does, and as the rewind's result does once they went.
 */
const UNDO_CANNOT_WORDS: ReadonlyArray<{
  reason: RewindUndoCannotReason;
  preview: string;
  refusal: string;
  result: string;
}> = [
  {
    reason: 'onlyWithParent',
    preview: 'Salesforce undeletes them only with their parent, and their parent stays',
    refusal: 'Salesforce undeletes them only with their parent, which stays',
    result: 'Salesforce undeletes them only with their parent',
  },
  {
    reason: 'deletedBeforeParent',
    preview:
      'deleted before a record they point at, which the rewind deletes next: Salesforce ' +
      'cannot bring them back after that',
    refusal:
      'deleted before a record they point at, which the rewind deletes next, Salesforce ' +
      'cannot bring them back after that',
    result:
      'deleted before a record they point at, which the rewind deleted next: Salesforce ' +
      'cannot bring them back after that',
  },
];

/**
 * What Undo couldn't bring back, by reason, for the reasons that apply: an
 * entry that names none is of the first, as a diff or a result made before
 * the second was told says it.
 */
function undoCannotByReason(
  cannot: readonly RewindUndoCannot[],
): Array<{ words: (typeof UNDO_CANNOT_WORDS)[number]; of: RewindUndoCannot[] }> {
  return UNDO_CANNOT_WORDS.flatMap((words) => {
    const of = cannot.filter((u) => (u.reason ?? 'onlyWithParent') === words.reason);
    return of.length > 0 ? [{ words, of }] : [];
  });
}

/** What the preview answers: the diff, what the org runs, the cost, and a rewind's refusal. */
export interface PreviewAnswer {
  diff: RewindDiff;
  automation?: ForgeTargetAutomation;
  emails?: CheckpointEmails[];
  /** Why the emails of what fires as the rewind writes were not all counted. */
  emailsUncounted?: string;
  estimate: CheckpointEstimate;
  refusal?: CheckpointRefusal;
}

/** How each daily email limit is said. */
const EMAIL_LIMIT_WORDS: Readonly<Record<CheckpointEmails['limit'], string>> = {
  SingleEmail: 'single emails',
  DailyWorkflowEmails: 'workflow emails',
};

/**
 * One line per daily email limit the rewind's writes send against: about how
 * many, by what, and what the org has left of it today.
 */
function emailLines(orgName: string, emails: readonly CheckpointEmails[]): string[] {
  return emails.map((check) => {
    const senders = [...new Set(check.objects.flatMap((object) => object.sentBy))];
    const sent =
      `  emails: ${orgName}'s automation sends about ${check.emails} ` +
      `${EMAIL_LIMIT_WORDS[check.limit]} as the rewind writes (${someOf(senders, 4)})` +
      (check.alertsCounted
        ? `, its email alerts among them: ${orgName} counts them against its single emails, ` +
          'as a Developer Edition does'
        : '');
    if (check.verdict === 'unread') {
      return `${sent}; what it has left today could not be read (${check.unread ?? ''})`;
    }
    if (check.verdict === 'fits') {
      return `${sent}; ${check.remaining ?? 0} of ${check.max ?? 0} left today`;
    }
    return (
      `${sent}, more than the ${check.remaining ?? 0} of ${check.max ?? 0} left today: a ` +
      'rewind is refused'
    );
  });
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

/**
 * The lines `preview` prints.
 *
 * @param user - The user the preview read the org as: who field-level
 *   security hides a field from.
 */
export function previewLines(
  orgName: string,
  checkpoint: Pick<OrgCheckpoint, 'name' | 'takenAt'>,
  answer: PreviewAnswer,
  user = 'the user SandForge connects as',
): string[] {
  const { diff } = answer;
  const totals = previewTotals(diff);
  const lines = [
    `Rewind ${orgName} to '${checkpoint.name}' (${when(checkpoint.takenAt)}), read at ${whenExactly(diff.readAt)}:`,
    `  ${count(totals.toDelete)} to delete · ${count(totals.toGiveBack)} to give back · ` +
      `${count(totals.toBringBack)} to bring back` +
      (totals.toRecreate > 0 ? ` · ${count(totals.toRecreate)} to make again` : ''),
  ];
  if (!orgDiffers(diff)) {
    lines.push(
      `  ${orgName} is as it was at '${checkpoint.name}' among the objects and fields it holds: ` +
        'nothing to rewind.',
    );
  }
  const shown = diff.objects.filter(
    (o) =>
      toDeleteOf(o) + o.toGiveBack.records + toBringBackOf(o) + toRecreateOf(o) + cannotUndoOf(o) >
      0,
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
  const carried = diff.objects.filter((o) => carriersOf(o) > 0);
  if (carried.length > 0) {
    lines.push(
      `  brought back for a moment: ${someOf(
        carried.map((o) => `${o.objectApiName} ${count(carriersOf(o))}`),
      )} — records the checkpoint does not hold that took records of it along when deleted ` +
        'since: Salesforce gives those back with them only, so they come back, then go back to ' +
        'the recycle bin with what came back with them; what the org runs on them runs twice',
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
  const remade = diff.objects.filter((o) => toRecreateOf(o) > 0);
  if (remade.length > 0) {
    lines.push(
      `  to make again, with new Ids: ${someOf(
        remade.map((o) => `${o.objectApiName} ${count(toRecreateOf(o))}`),
      )} — deleted since and no longer in the recycle bin: made again from the checkpoint, the ` +
        'lookups it holds that named them naming the new Ids; anything outside Salesforce that ' +
        'names their old Ids no longer finds them',
    );
  }
  if (totals.toBringBack > 0) {
    lines.push(
      '  if Salesforce answers that a record to bring back is no longer in the recycle bin — it ' +
        'still lists one emptied from it as deleted —, --accept-recreate makes it again with a ' +
        'new Id, with what was to come back with it; without it, the rewind leaves them and ' +
        'names them',
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
  for (const { words, of } of undoCannotByReason(diff.undoCannot)) {
    lines.push(
      `  undo couldn't bring back: ${someOf(
        of.map((u) => `${u.objectApiName} ${count(u.count)}`),
      )} — ${words.preview}`,
    );
  }
  for (const object of diff.objects) {
    for (const outside of object.outside) {
      // A file to delete attached outside the checkpoint too leaves it as
      // well: said as files, not as records created under them.
      lines.push(
        object.objectApiName === FILE_OBJECT && outside.objectApiName === FILE_LINK_OBJECT
          ? `  also attached outside the checkpoint: ${count(outside.parents)} file(s) it deletes, ` +
              `by ${count(outside.count)} link(s) to a library, a group or a record of another ` +
              'object — deleting them removes them from there as well'
          : `  also deleted with them, outside the checkpoint: ${count(outside.count)} ` +
              `${outside.objectApiName} created under ${count(outside.parents)} ${object.objectApiName}`,
      );
    }
  }
  lines.push(...previewFilesLines(orgName, diff));
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
    // Gone from the describe as a deleted field is, but there still: no
    // Deleted Fields brings it back, an access given does.
    if ((drift.hidden ?? []).length > 0) {
      lines.push(
        `  fields hidden from ${user} by field-level security since: ` +
          `${someOf(named(drift.hidden ?? []))} — rewind does not put them back; give ${user} ` +
          'read and edit access to them, then rewind again',
      );
    }
    if (drift.uncertain !== undefined && drift.uncertain.fields.length > 0) {
      lines.push(
        `  fields gone from what ${orgName} shows ${user}: ${someOf(named(drift.uncertain.fields))} ` +
          '— deleted since (restore them from Deleted Fields within 15 days), or hidden by ' +
          `field-level security (give ${user} read and edit access); rewind does not put them ` +
          'back' +
          (drift.uncertain.reason !== undefined
            ? ` (which, ${orgName} would not say: ${drift.uncertain.reason})`
            : ''),
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
  if (answer.emails) lines.push(...emailLines(orgName, answer.emails));
  if (answer.emailsUncounted !== undefined) {
    lines.push(
      `  emails: not counted, ${answer.emailsUncounted} could not be read — what they send as ` +
        'the rewind writes is not known; --accept-automation covers it',
    );
  }
  lines.push(estimateLine(answer.estimate));
  if (answer.refusal) lines.push(`  a rewind now would be refused: ${answer.refusal.message}`);
  return lines;
}

/** The object a Salesforce File is a record of, as a checkpoint that holds files holds it. */
const FILE_OBJECT = 'ContentDocument';

/** The link between a file and a record, which a checkpoint holds with its file. */
const FILE_LINK_OBJECT = 'ContentDocumentLink';

/**
 * What a rewind of a checkpoint that holds files does to the links between
 * its files and its records, and leaves of the org's files: the links it
 * removes, puts back and gives their sharing back, the files no record of the
 * checkpoint links to, the file storage what it brings back takes and what
 * Undo would take again, and what a user without Query All Files cannot see.
 * Nothing for a checkpoint that holds no files.
 */
function previewFilesLines(orgName: string, diff: Pick<RewindDiff, 'objects' | 'files'>): string[] {
  const files = diff.files;
  if (files === undefined) return [];
  const lines: string[] = [];
  if (files.unlink > 0) {
    lines.push(
      `  links to remove: ${count(files.unlink)} added since between a file and a record that ` +
        'both stay — the file stays, no longer attached to that record',
    );
  }
  if (files.relink > 0) {
    lines.push(
      `  links to put back: ${count(files.relink)} removed since between a file and a record ` +
        'that both stay, each under a new Id: Salesforce keeps no removed link in the recycle bin',
    );
  }
  if (files.updateLinks > 0) {
    lines.push(
      `  links to give their sharing back: ${count(files.updateLinks)} — who sees the file from ` +
        "the record, and with what access; a link to an account keeps its access, which Salesforce doesn't let change",
    );
  }
  if (files.outsideAdded > 0) {
    lines.push(
      `  kept: ${count(files.outsideAdded)} file(s) added since, as no record of this checkpoint ` +
        "links to them (a user's own, a library's)",
    );
  }
  if (files.outsideDeleted > 0) {
    lines.push(
      `  left in the recycle bin: ${count(files.outsideDeleted)} file(s) deleted since, as no ` +
        'record of this checkpoint linked to them',
    );
  }
  const fileRow = diff.objects.find((object) => object.objectApiName === FILE_OBJECT);
  const back = fileRow === undefined ? 0 : toBringBackOf(fileRow);
  const { storage } = files;
  if (back > 0 && storage.bringBack > 0) {
    lines.push(
      `  file storage: bringing back ${count(back)} file(s) takes ${megabytes(storage.bringBack)} ` +
        'again; ' +
        (storage.remaining === undefined
          ? `${orgName} did not say how much it has left`
          : `${orgName} has ${megabytes(storage.remaining)} left`),
    );
  }
  if (storage.undo > 0) {
    lines.push(
      `  undo would bring back the files this rewind deletes: ${megabytes(storage.undo)} of file ` +
        'storage again',
    );
  }
  if (files.blindSpot) lines.push(BLIND_SPOT_LINE);
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
    carriers: answer.diff.objects.reduce((total, o) => total + carriersOf(o), 0),
    differs: orgDiffers(answer.diff),
    diff: answer.diff,
    estimate: answer.estimate,
    ...(answer.automation ? { automation: answer.automation } : {}),
    ...(answer.emails ? { emails: answer.emails } : {}),
    ...(answer.emailsUncounted !== undefined ? { emailsUncounted: answer.emailsUncounted } : {}),
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

// ─── What a rewind and an undo say, and how they end the command ─────────────

/**
 * The objects whose records each step of a rewind writes, as its preview
 * counts them: brought back, given back, deleted — an order activated since
 * set back to Draft first, which the platform deletes no other way — and the
 * records it brings back for a moment, then deletes again.
 */
export function rewindStepsOf(
  diff: Pick<RewindDiff, 'objects'> & Partial<Pick<RewindDiff, 'files'>>,
): ForgeRemovalSteps {
  // What comes back for a moment is brought back and deleted, as the rewind
  // itself lists it: its automation runs on both.
  const deleted = diff.objects
    .filter((o) => toDeleteOf(o) + carriersOf(o) > 0)
    .map((o) => o.objectApiName);
  // A link between a file and a record removed is a delete, one put back an
  // insert, one given its sharing back an update, as the rewind lists them:
  // a trigger on links runs on each.
  const links = diff.files;
  const linked = (step: string[], writes: number): string[] =>
    writes > 0 ? [...step, FILE_LINK_OBJECT] : step;
  return {
    bringBack: diff.objects
      .filter((o) => toBringBackOf(o) + carriersOf(o) > 0)
      .map((o) => o.objectApiName),
    recreate: linked(
      diff.objects.filter((o) => toRecreateOf(o) > 0).map((o) => o.objectApiName),
      links?.relink ?? 0,
    ),
    giveBack: linked(
      diff.objects.filter((o) => o.toGiveBack.records > 0).map((o) => o.objectApiName),
      links?.updateLinks ?? 0,
    ),
    setToDraft: deleted.filter((name) => name === 'Order'),
    delete: linked(deleted, links?.unlink ?? 0),
  };
}

/** What a rewind is told it may do, by its flags. */
export interface RewindAccepted {
  acceptAutomation: boolean;
  acceptNoUndo: boolean;
  acceptRecreate: boolean;
}

/**
 * The refusal a rewind of what `answer` previewed would meet before it
 * writes, for want of a flag: deletions Undo couldn't bring back without
 * `--accept-no-undo`, records to make again with new Ids without
 * `--accept-recreate`, automation its writes fire — or that could not all be
 * read — without `--accept-automation`. Said before the question, as the page
 * holds its button until the box is ticked; the rewind itself refuses the
 * same, whatever this says.
 */
export function acceptanceRefusal(
  orgName: string,
  answer: Pick<PreviewAnswer, 'diff' | 'automation' | 'emailsUncounted'>,
  accepted: RewindAccepted,
): CheckpointRefusalLike | undefined {
  const { diff, automation, emailsUncounted } = answer;
  if (diff.undoCannot.length > 0 && !accepted.acceptNoUndo) {
    const said = undoCannotByReason(diff.undoCannot).map(({ words, of }) => {
      const records = of.reduce((total, u) => total + u.count, 0);
      const objects = [...new Set(of.map((u) => u.objectApiName))].join(', ');
      return (
        `Undo couldn't bring back ${count(records)} ${objects} record(s) this rewind deletes: ` +
        `${words.refusal}.`
      );
    });
    return {
      code: 'NO_UNDO',
      message:
        `${said.join(' ')} Rewind refused; give --accept-no-undo to rewind all the same. ` +
        'No record was written.',
    };
  }
  const remade = diff.objects.filter((o) => toRecreateOf(o) > 0);
  if (remade.length > 0 && !accepted.acceptRecreate) {
    const records = remade.reduce((total, o) => total + toRecreateOf(o), 0);
    return {
      code: 'RECREATE',
      message:
        `${count(records)} ${remade.map((o) => o.objectApiName).join(', ')} record(s) deleted ` +
        'since are no longer in the recycle bin, or Salesforce keeps them there for good: this ' +
        'rewind makes them again from the checkpoint, with new Ids. Anything outside Salesforce ' +
        'that names their old Ids — an integration, a link, a report filter — no longer finds ' +
        'them. Rewind refused; give --accept-recreate to rewind all the same. No record was ' +
        'written.',
    };
  }
  if (!automation || accepted.acceptAutomation) return undefined;
  const steps = rewindStepsOf(diff);
  const fired = firedOnRemovalStepsOf(automation, steps);
  if (fired.length === 0 && !blindedBy(automation.unread) && emailsUncounted === undefined) {
    return undefined;
  }
  const objects = [...new Set(fired.map((each) => each.objectApiName))];
  // A link put back is an insert of a link, no record made again.
  const makes = (steps.recreate ?? []).some((name) => name !== FILE_LINK_OBJECT)
    ? 'makes them again, '
    : '';
  const what =
    fired.length > 0
      ? `${fired.length} flow(s), trigger(s) or rule(s) of ${objects.join(', ')} run as the ` +
        `rewind brings records back, ${makes}gives them their values back or deletes them`
      : 'what runs as the rewind writes could not all be read, so automation may run';
  // Said here too: a rewind refused for its automation is the one place the
  // command line says it before nothing more is written.
  const uncounted =
    emailsUncounted !== undefined
      ? 'The emails it sends as the rewind writes were not counted against its daily limits, ' +
        `as what sends them was not read (${emailsUncounted}). `
      : '';
  return {
    code: 'AUTOMATION',
    message:
      `${orgName}: ${what}. ${uncounted}Rewind refused; give --accept-automation to rewind all ` +
      'the same. No record was written.',
  };
}

/** The question a rewind asks before it writes: what it does, typed as the page asks it. */
export function rewindQuestion(
  orgName: string,
  checkpoint: Pick<OrgCheckpoint, 'name' | 'takenAt'>,
  diff: Pick<RewindDiff, 'objects'> & Partial<Pick<RewindDiff, 'files'>>,
): string {
  const totals = previewTotals(diff);
  const remade =
    totals.toRecreate > 0
      ? `, and makes ${count(totals.toRecreate)} record(s) the recycle bin no longer holds again, ` +
        'with new Ids'
      : '';
  const carriers = diff.objects.reduce((total, o) => total + carriersOf(o), 0);
  const carried =
    carriers > 0
      ? `, with ${count(carriers)} record(s) brought back for a moment that had taken records ` +
        'of the checkpoint along, then deleted again'
      : '';
  const links = linkWritesOf(diff);
  const linked =
    links > 0
      ? `, and puts ${count(links)} link(s) between files and records back as they were`
      : '';
  return (
    `Rewind ${orgName} to '${checkpoint.name}': it deletes the ${count(totals.toDelete)} ` +
    `record(s) created since ${when(checkpoint.takenAt)}, gives ${count(totals.toGiveBack)} ` +
    `record(s) their values from then back, and brings back ${count(totals.toBringBack)} ` +
    `record(s) from the recycle bin${carried}${remade}${linked} — whoever made these changes. What it changes is ` +
    `kept, so it can be undone. Type ${orgName} to rewind it:`
  );
}

/** Planned, done and left of one brick's work, summed over its objects. */
interface Tally {
  planned: number;
  done: number;
  left: number;
}

const sumOf = <T>(rows: readonly T[], of: (row: T) => number): number =>
  rows.reduce((total, row) => total + of(row), 0);

/** What a rewind or an undo deleted, gave back and brought back, all objects together. */
function talliesOf(result: Pick<RewindResult, 'deleted' | 'restored' | 'undeleted'>): {
  deleted: Tally;
  givenBack: Tally;
  broughtBack: Tally;
} {
  const deletedDone = sumOf(result.deleted, (o) => o.deleted);
  const deletedPlanned = sumOf(result.deleted, (o) => o.planned);
  const givenDone = sumOf(result.restored, (o) => o.restored + (o.restoredWithout ?? 0));
  const givenPlanned = sumOf(result.restored, (o) => o.planned);
  const backDone = sumOf(result.undeleted, (o) => o.undeleted + o.alreadyBack);
  const backPlanned = sumOf(result.undeleted, (o) => o.planned);
  return {
    deleted: {
      planned: deletedPlanned,
      done: deletedDone,
      left: Math.max(0, deletedPlanned - deletedDone - sumOf(result.deleted, (o) => o.alreadyGone)),
    },
    givenBack: {
      planned: givenPlanned,
      done: givenDone,
      left: Math.max(0, givenPlanned - givenDone - sumOf(result.restored, (o) => o.alreadyGone)),
    },
    broughtBack: {
      planned: backPlanned,
      done: backDone,
      left: Math.max(0, backPlanned - backDone),
    },
  };
}

/** What a rewind made again with new Ids, all objects together. */
function recreatedTally(result: Pick<RewindResult, 'recreated'>): Tally {
  const made = result.recreated ?? [];
  const planned = sumOf(made, (o) => o.planned);
  const done = sumOf(made, (o) => o.created);
  return { planned, done, left: Math.max(0, planned - done) };
}

/**
 * Of what an undo sent to the recycle bin, the records the rewind had made
 * again: per object, as many of those it deleted as were made again and are
 * no longer in the org — the others went with a record it deleted.
 */
function remadeDeleted(result: Pick<RewindResult, 'deleted' | 'remade'>): number {
  return (result.remade ?? []).reduce((total, made) => {
    const deleted = sumOf(
      result.deleted.filter((o) => o.objectApiName === made.objectApiName),
      (o) => o.deleted,
    );
    return total + Math.min(deleted, made.count);
  }, 0);
}

/** A user, by the name the preview read for them, else by their id. */
function userOf(userId: string | undefined, names: Readonly<Record<string, string>>): string {
  if (userId === undefined) return 'another user';
  return names[userId] ?? userId;
}

/** Why a record still differs once a rewind or an undo read the org again, as a person reads it. */
function residualWords(
  act: 'rewind' | 'undo',
  residual: RewindResidual,
  names: Readonly<Record<string, string>>,
): string {
  switch (residual.reason) {
    case 'automation':
      return act === 'rewind'
        ? 'kept by your automation, which sets them again on save: rewind --ignore-field ' +
            '<Object.Field> stops comparing such a field'
        : 'set again on save by your automation, since the undo gave them back their values';
    case 'changedDuringRewind':
      return `changed during the ${act} by ${userOf(residual.by, names)}: left as they made them`;
    case 'changedSincePreview':
      return 'changed since the preview: rewind again to take them';
    case 'refused':
      return `refused: ${residual.message ?? 'the org gave no reason'}`;
    case 'notInBin':
      return (
        'no longer in the recycle bin — emptied from it, or kept there for good —: Salesforce ' +
        'still lists them as deleted but will not bring them back; --accept-recreate makes them ' +
        'again with new Ids'
      );
    case 'goneForGood':
      return (
        'deleted since and no longer in the recycle bin, and not made again (a file, whose body ' +
        "the checkpoint does not hold, or a record deleted while it was taken): they can't come back"
      );
    case 'kept':
      return residual.message ?? 'kept as they are';
  }
}

/** The lines a rewind prints once it answered, stopped part way included. */
export function rewindLines(
  orgName: string,
  checkpoint: Pick<OrgCheckpoint, 'checkpointId' | 'name'>,
  result: RewindResult,
  names: Readonly<Record<string, string>> = {},
): string[] {
  const differing = sumOf(result.residual, (r) => r.count);
  const others = result.residual.filter((r) => r.reason === 'changedDuringRewind');
  const head: Record<RewindStatus, string> = {
    success:
      `${orgName} is back at '${checkpoint.name}': read again, nothing differs among the ` +
      'objects and fields it holds.',
    partial:
      `${orgName} is back at '${checkpoint.name}' but for ${count(differing)} record(s) that ` +
      'still differ, each said with why:',
    unstable:
      `Someone kept writing to ${orgName} during the rewind: ` +
      `${[...new Set(others.map((r) => userOf(r.by, names)))].join(', ')} changed ` +
      `${count(sumOf(others, (r) => r.count))} record(s), left as they made them. Rewind again ` +
      'once they have stopped.',
    failure:
      `Nothing of the rewind of ${orgName} to '${checkpoint.name}' went through: what still ` +
      'differs is said with why:',
    cancelled:
      `Stopped part way: ${orgName} is between '${checkpoint.name}' and now. Rewind again to ` +
      `finish: it takes up from what still differs, and undo still returns ${orgName} to how it ` +
      'was before the rewind.',
  };
  const tallies = talliesOf(result);
  const cameBack = sumOf(result.undeleted, (o) => o.alreadyBack);
  const lines = [head[result.status]];
  if (tallies.deleted.done > 0) {
    lines.push(
      `  deleted ${count(tallies.deleted.done)} record(s) added since the checkpoint — created, ` +
        'or brought back from the recycle bin they were in when it was taken — (in the recycle ' +
        'bin for up to 15 days)',
    );
  }
  if (tallies.givenBack.done > 0) {
    lines.push(`  gave ${count(tallies.givenBack.done)} record(s) back their checkpoint values`);
  }
  if (tallies.broughtBack.done > 0) {
    lines.push(
      `  brought back ${count(tallies.broughtBack.done - cameBack)} record(s) deleted since the ` +
        'checkpoint, with their original Ids' +
        (cameBack > 0 ? `, and ${count(cameBack)} that came back with them` : ''),
    );
  }
  // A rewind that wrote nothing brought nothing back for a moment.
  const carriers = result.status === 'failure' ? [] : (result.carriers ?? []);
  if (carriers.length > 0) {
    const which = someOf(carriers.map((o) => `${o.objectApiName} ${count(o.count)}`));
    lines.push(
      result.status === 'cancelled'
        ? `  of them, brought back for a moment: ${which} — records the checkpoint does not hold ` +
            'that had taken records of it along; stopped before it was through, those it had not ' +
            'deleted again yet are still in the org: rewind again deletes them, with what came ' +
            'back with them'
        : `  of them, brought back for a moment and deleted again: ${which} — records the ` +
            'checkpoint does not hold that had taken records of it along, back in the recycle ' +
            'bin with what came back with them',
    );
  }
  const remade = recreatedTally(result);
  if (remade.done > 0) {
    lines.push(
      `  made again ${count(remade.done)} record(s) the recycle bin no longer held, with new Ids`,
    );
  }
  lines.push(...linksLines('rewind', orgName, result));
  lines.push(...followingLines('rewind', result, names));
  if (result.undo) {
    lines.push(
      `  undo it until ${when(result.undo.until)}, sooner if the recycle bin fills: undo ` +
        `--org ${orgName} --checkpoint ${checkpoint.checkpointId}`,
    );
    for (const { words, of } of undoCannotByReason(result.undo.cannot)) {
      lines.push(
        `  undo couldn't bring back: ${someOf(
          of.map((u) => `${u.objectApiName} ${count(u.count)}`),
        )} — ${words.result}`,
      );
    }
  }
  for (const gone of result.removedJournals ?? []) {
    lines.push(
      `  removed the journal of rewind ${gone.rewindId} of '${gone.name}': undo reaches the ` +
        'last rewind of the org alone',
    );
  }
  lines.push(requestsUsedLine(result));
  return lines;
}

/** The lines an undo prints once it answered, stopped part way included. */
export function undoLines(
  orgName: string,
  checkpoint: Pick<OrgCheckpoint, 'name'>,
  result: RewindResult,
): string[] {
  const kept =
    sumOf(result.restored, (o) => o.keptChanged) + sumOf(result.deleted, (o) => o.keptChanged);
  const refused = sumOf(
    [...result.deleted, ...result.restored, ...result.undeleted],
    (o) => o.refused,
  );
  const differing = sumOf(result.residual, (r) => r.count) + refused;
  const back = `${orgName} is back as it was before its rewind to '${checkpoint.name}'`;
  const head: Record<RewindStatus, string> = {
    success: `${back}.`,
    partial:
      kept > 0 && differing === 0
        ? `${back}, except ${count(kept)} record(s) changed since the rewind, left as they are now.`
        : `${back}, except ${count(differing + kept)} record(s), each said with why:`,
    unstable:
      `Someone changed records of ${orgName} during the undo: left as they made them, each said ` +
      'below.',
    failure: `Nothing of the undo of ${orgName}'s rewind went through: its reasons are said below.`,
    cancelled:
      `Stopped part way: ${orgName} is between the rewind and how it was before it. Undo again ` +
      'to finish: it takes up what this one left.',
  };
  const tallies = talliesOf(result);
  const lines = [head[result.status]];
  // What the rewind made again is deleted again, never sent back; what came
  // back with a record goes with it, never sent on its own: counted, the
  // feeds and histories that went with their records read as sends the undo
  // never made.
  const remade = remadeDeleted(result);
  const along = sumOf(result.wentAlong ?? [], (o) => o.count);
  const sentBack = tallies.deleted.done - remade - along;
  if (sentBack > 0) {
    lines.push(
      `  sent back to the recycle bin ${count(sentBack)} record(s) the rewind brought back` +
        (along > 0 ? ', with what came back with them' : ''),
    );
  }
  if (remade > 0) {
    lines.push(
      `  deleted again ${count(remade)} record(s) the rewind made again, with what went with them`,
    );
  }
  const alone = result.carriedAlone ?? [];
  if (alone.length > 0) {
    lines.push(
      `  of them, back in the recycle bin on their own: ${someOf(
        alone.map((o) => `${o.objectApiName} ${count(o.count)}`),
      )} — they had gone there with a record the rewind brought back for a moment, which stays ` +
        'there; they come back alone, under the parent the checkpoint gave them',
    );
  }
  if (tallies.broughtBack.done > 0) {
    lines.push(`  brought back ${count(tallies.broughtBack.done)} record(s) the rewind deleted`);
  }
  if (tallies.givenBack.done > 0) {
    lines.push(
      `  gave ${count(tallies.givenBack.done)} record(s) back the values they had before the rewind`,
    );
  }
  if (kept > 0) {
    lines.push(
      `  kept ${count(kept)} record(s) changed since the rewind: undo leaves them as they are now`,
    );
  }
  lines.push(...linksLines('undo', orgName, result));
  lines.push(...followingLines('undo', result, {}));
  lines.push(requestsUsedLine(result));
  return lines;
}

/**
 * What a rewind, or its undo, did to the links between files and records,
 * the parts that apply: an undo removed again what the rewind put back, put
 * back what it removed and gave back the sharing from before it.
 */
function linksLines(
  act: 'rewind' | 'undo',
  orgName: string,
  result: Pick<RewindResult, 'files'>,
): string[] {
  const files = result.files;
  if (files === undefined) return [];
  const said =
    act === 'rewind'
      ? {
          unlinked: 'removed {n} link(s) added since between files and records: the files stay',
          relinked: 'put back {n} link(s) removed since between files and records, under new Ids',
          linksUpdated: 'gave {n} link(s) between files and records their sharing back',
        }
      : {
          unlinked: 'removed again {n} link(s) between files and records the rewind put back',
          relinked:
            'put back {n} link(s) between files and records the rewind removed, under new Ids',
          linksUpdated:
            'gave {n} link(s) between files and records back the sharing they had before the rewind',
        };
  const lines = (['unlinked', 'relinked', 'linksUpdated'] as const)
    .filter((part) => files[part] > 0)
    .map((part) => `  ${said[part].replace('{n}', count(files[part]))}`);
  if (files.linksRefused > 0) {
    lines.push(
      `  ${orgName} refused to write ${count(files.linksRefused)} link(s) between files and records`,
    );
  }
  return lines;
}

/** What still differs and why, what was refused, and what could not be read again. */
function followingLines(
  act: 'rewind' | 'undo',
  result: RewindResult,
  names: Readonly<Record<string, string>>,
): string[] {
  const lines = result.residual.map(
    (r) => `  ${r.objectApiName} ${count(r.count)} — ${residualWords(act, r, names)}`,
  );
  // An undo names no residual for what the org refused it: its bricks say why.
  if (act === 'undo') {
    for (const object of [...result.deleted, ...result.restored, ...result.undeleted]) {
      if (object.refused === 0) continue;
      lines.push(
        `  ${object.objectApiName} ${count(object.refused)} — refused: ` +
          `${object.reasons[0] ?? 'the org gave no reason'}`,
      );
    }
  }
  for (const unread of result.unread ?? []) {
    lines.push(
      `  could not be read again: ${unread.objectApiName} — ${unread.reason} (never taken for ` +
        'unchanged)',
    );
  }
  return lines;
}

/** The line of what a rewind or an undo sent the org. */
function requestsUsedLine(result: Pick<RewindResult, 'apiRequests'>): string {
  return (
    `  sent ${count(result.apiRequests.used)} API requests to the org; ` +
    `${count(result.apiRequests.leftToday)} left today`
  );
}

/** What `rewind --json` and `undo --json` print: see the help. */
export function resultJson(
  act: 'rewind' | 'undo',
  orgName: string,
  checkpoint: Pick<OrgCheckpoint, 'checkpointId' | 'name' | 'takenAt' | 'ignoredFields'>,
  result: RewindResult,
  diff?: Pick<RewindDiff, 'objects'>,
): Record<string, unknown> {
  const objects = new Map<
    string,
    { object: string; deleted: number; givenBack: number; broughtBack: number; refused: number }
  >();
  const of = (name: string) => {
    let row = objects.get(name);
    if (!row) {
      row = { object: name, deleted: 0, givenBack: 0, broughtBack: 0, refused: 0 };
      objects.set(name, row);
    }
    return row;
  };
  for (const o of result.deleted) {
    of(o.objectApiName).deleted += o.deleted;
    of(o.objectApiName).refused += o.refused;
  }
  for (const o of result.restored) {
    of(o.objectApiName).givenBack += o.restored + (o.restoredWithout ?? 0);
    of(o.objectApiName).refused += o.refused;
  }
  for (const o of result.undeleted) {
    of(o.objectApiName).broughtBack += o.undeleted + o.alreadyBack;
    of(o.objectApiName).refused += o.refused;
  }
  for (const o of result.recreated ?? []) of(o.objectApiName).refused += o.refused;
  const unread = (result.unread ?? []).map((u) => ({ object: u.objectApiName, reason: u.reason }));
  return {
    checkpoint: {
      id: checkpoint.checkpointId,
      name: checkpoint.name,
      takenAt: checkpoint.takenAt,
      org: orgName,
    },
    rewindId: result.rewindId,
    status: result.status,
    ...talliesOf(result),
    ...(act === 'rewind'
      ? {
          recreated: recreatedTally(result),
          cannotUndo: (diff?.objects ?? []).flatMap((o) =>
            o.cannotUndo
              .filter((line) => line.count > 0)
              .map((line) => ({ object: o.objectApiName, reason: line.reason, count: line.count })),
          ),
        }
      : {}),
    ...(act === 'rewind' && (result.carriers ?? []).length > 0
      ? {
          carriers: (result.carriers ?? []).map((o) => ({
            object: o.objectApiName,
            count: o.count,
          })),
        }
      : {}),
    ...(act === 'undo' && (result.carriedAlone ?? []).length > 0
      ? {
          carriedAlone: (result.carriedAlone ?? []).map((o) => ({
            object: o.objectApiName,
            count: o.count,
          })),
        }
      : {}),
    ...(result.files ? { files: { ...result.files } } : {}),
    ...(result.undo
      ? {
          undo: {
            until: result.undo.until,
            cannot: result.undo.cannot.map((u) => ({
              object: u.objectApiName,
              count: u.count,
              ...(u.reason !== undefined ? { reason: u.reason } : {}),
            })),
          },
        }
      : {}),
    verify: {
      differences: sumOf(result.residual, (r) => r.count) + unread.length,
      stable: result.status !== 'unstable',
      passes: result.passes,
      notCompared: [...checkpoint.ignoredFields],
    },
    residual: result.residual.map((r) => ({
      object: r.objectApiName,
      reason: r.reason,
      ...(r.by !== undefined ? { by: r.by } : {}),
      count: r.count,
      ...(r.message !== undefined ? { message: r.message } : {}),
    })),
    unread,
    objects: [...objects.values()],
    apiRequests: result.apiRequests,
    result,
  };
}

/**
 * The exit code of a rewind or an undo, from how it ended: 0 when the org
 * reads as the checkpoint — or as before the rewind — among what it compares,
 * 3 when records still differ, 4 when someone else changed records during
 * it, 1 when nothing it set out to write went through; stopped part way, the
 * code of the signal that stopped it.
 */
export function resultExitCode(status: RewindStatus, stoppedBy?: StopSignal): number {
  switch (status) {
    case 'success':
      return DONE_EXIT;
    case 'partial':
      return PARTIAL_EXIT;
    case 'unstable':
      return UNSTABLE_EXIT;
    case 'failure':
      return FAILED_EXIT;
    case 'cancelled':
      return stoppedBy !== undefined ? stopExitCode(stoppedBy) : FAILED_EXIT;
  }
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
        // The rewind acts on the preview this command shows, as it read the org.
        wiring.handlers.rewindCheckpointsFromPreviewsAnswered();
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
        sameOrgOrStop(org, entry, checkpoint, args.org, 'preview');
        const answer = await host.request({
          type: 'checkpoint:preview',
          payload: { checkpointId: entry.checkpointId },
          timeoutMs: PREVIEW_TIMEOUT_MS,
        });
        if (answer.outcome !== 'answered') {
          throw new Stop(refusalOfAnswer(answer, 'The preview'));
        }
        const preview = payloadOf(answer) as unknown as PreviewAnswer;
        for (const line of previewLines(args.org, checkpoint, preview, org.username)) say(line);
        answerJson(previewJson(args.org, checkpoint, preview));
        endWith(previewExitCode(preview.diff, args.failOnChange));
        return;
      }
      case 'rewind':
      case 'undo': {
        const context: WriteContext = { host, registry, store, listAll, connect, say, answerJson };
        if (args.command === 'rewind') await rewind(args, context);
        else await undo(args, context);
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
      ...(asked.customSettings ? { customSettings: asked.customSettings } : {}),
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
      ...(answered.files ? { files: answered.files } : {}),
      ...(answered.customSettings ? { customSettings: answered.customSettings } : {}),
    };
    for (const line of scopeLines(args.org, scope)) say(line);
    answerJson(scopeJson(scope));
    endWith(scope.refusal ? FAILED_EXIT : DONE_EXIT);
    return;
  }

  say(
    `taking a checkpoint of ${args.org}: it reads every record of its objects (Ctrl-C stops it, ` +
      'and nothing of it is kept)',
  );
  // Ctrl-C stops the take as Live Operations' Cancel does, between two reads,
  // and nothing of it is kept.
  const { answer, stoppedBy } = await stoppable(
    registry,
    'the take stops after the read under way, and keeps nothing',
    () =>
      host.request({
        type: 'checkpoint:take',
        payload: { orgId: org.id, ...asked },
        timeoutMs: TAKE_TIMEOUT_MS,
      }),
  );
  if (answer.outcome !== 'answered') {
    const refusal = refusalOfAnswer(answer, 'The take');
    if (stoppedBy !== undefined && refusal.code === 'CANCELLED') {
      throw new Stop(refusal, stopExitCode(stoppedBy));
    }
    throw new Stop(refusal);
  }
  const taken = payloadOf(answer);
  const checkpoint = taken.checkpoint as OrgCheckpoint;
  const requests = taken.requests as CheckpointTakeRequests | undefined;
  const estimate = taken.estimate as CheckpointEstimate | undefined;
  const folder = store.folderOf(checkpoint.org.organizationId, checkpoint.checkpointId).dir;
  for (const line of takeLines(checkpoint, folder, asked.objects ?? [])) say(line);
  if (requests) say(requestsLine(requests, estimate));
  answerJson({
    checkpoint,
    ...(requests ? { requests } : {}),
    ...(estimate ? { estimate } : {}),
  });
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

/**
 * Refuse a checkpoint the org `alias` reaches did not take, before any record
 * is read: a sandbox refreshed since is another org, and one of another alias
 * is to be named by that alias.
 */
function sameOrgOrStop(
  org: SalesforceOrg,
  entry: CheckpointListEntry,
  checkpoint: OrgCheckpoint,
  alias: string,
  act: 'preview' | 'rewind' | 'undo',
): void {
  if (sameOrganization(org.orgId, entry.organizationId)) return;
  const takenUnder = checkpointsOf([entry], alias).length > 0;
  const verb = act === 'preview' ? 'preview it' : act === 'rewind' ? 'rewind to it' : 'undo it';
  throw new Stop({
    code: 'OTHER_ORG',
    message: takenUnder
      ? `${alias} answers as another org than the one '${checkpoint.name}' was taken of: a ` +
        'sandbox refreshed since is another org, and this checkpoint can only be deleted. No ' +
        'record was read.'
      : `'${checkpoint.name}' is a checkpoint of ${orgOf(checkpoint)}, not of ${alias}: ` +
        `${verb} with --org ${orgOf(checkpoint)}. No record was read.`,
  });
}

/**
 * Send `request` as a stop signal stops a take, a rewind or an undo: the
 * first Ctrl-C, SIGTERM or SIGHUP aborts it through the registry, as Live
 * Operations' Cancel does, and one that comes before it is listed stops it as
 * it is listed; a second one ends the process at once.
 *
 * @param interrupted - What the stop does, said on stderr.
 * @returns The answer, and the signal that stopped it, if one did.
 */
async function stoppable(
  registry: BackgroundOperationRegistry,
  interrupted: string,
  request: () => Promise<PanelAnswer>,
): Promise<{ answer: PanelAnswer; stoppedBy?: StopSignal }> {
  let stopped: StopSignal | undefined;
  const unlisten = registry.onEvent((operationId, type, operation) => {
    if (stopped !== undefined && type === 'started' && operation.module === 'checkpoint') {
      registry.abort(operationId);
    }
  });
  const release = onStopSignal((signal) => {
    stopped = signal;
    process.stderr.write(`\ninterrupted: ${interrupted} (Ctrl-C again ends it at once)\n`);
    for (const operation of registry.getRunning()) {
      if (operation.module === 'checkpoint') registry.abort(operation.operationId);
    }
  });
  try {
    const answer = await request();
    return stopped !== undefined ? { answer, stoppedBy: stopped } : { answer };
  } finally {
    release();
    unlisten();
  }
}

/** How long the page waits for a rewind or an undo it started: as long as a write run. */
const WRITE_TIMEOUT_MS = 12 * 60 * 60_000;

/** What a rewind and an undo are run with, beside their line. */
interface WriteContext {
  host: PanelHost;
  registry: BackgroundOperationRegistry;
  store: OrgCheckpointStore;
  listAll: () => Promise<CheckpointListEntry[]>;
  connect: (alias: string) => Promise<SalesforceOrg>;
  say: (line: string) => void;
  answerJson: (value: unknown) => void;
}

/** The answer a rewind or an undo came back with, as its result, or the stop it ends the command with. */
function resultOfAnswer(
  sent: { answer: PanelAnswer; stoppedBy?: StopSignal },
  what: string,
): RewindResult {
  const { answer, stoppedBy } = sent;
  if (answer.outcome !== 'answered') {
    const refusal = refusalOfAnswer(answer, what);
    if (stoppedBy !== undefined && refusal.code === 'CANCELLED') {
      throw new Stop(refusal, stopExitCode(stoppedBy));
    }
    throw new Stop(refusal);
  }
  return payloadOf(answer).result as RewindResult;
}

/**
 * `rewind`: the preview, said; the refusal it would meet for want of a flag;
 * the question, unless --yes; then the rewind, from that preview as it read
 * the org, and what still differs, said.
 */
async function rewind(
  args: Extract<CliArgs, { command: 'rewind' }>,
  context: WriteContext,
): Promise<void> {
  const { host, say, answerJson } = context;
  const all = await context.listAll();
  const entry = chosen(
    resolveCheckpoint(all, checkpointsOf(all, args.org), args.checkpoint, args.org),
  );
  const invalid = invalidRefusal(entry);
  if (invalid) throw new Stop(invalid);
  let checkpoint = entry.checkpoint as OrgCheckpoint;

  // Kept in the checkpoint before the preview, which then compares them no more.
  const added = args.ignoreFields.filter((field) => !checkpoint.ignoredFields.includes(field));
  if (added.length > 0) {
    const answer = await host.request({
      type: 'checkpoint:ignore-fields',
      payload: {
        checkpointId: entry.checkpointId,
        fields: [...checkpoint.ignoredFields, ...added],
      },
      timeoutMs: LOCAL_TIMEOUT_MS,
    });
    if (answer.outcome !== 'answered') {
      throw new Stop(refusalOfAnswer(answer, 'The fields not to compare'));
    }
    checkpoint = payloadOf(answer).checkpoint as OrgCheckpoint;
    say(
      `not compared from now on, nor written back: ${added.join(', ')} (kept in ` +
        `'${checkpoint.name}')`,
    );
  }

  const org = await context.connect(args.org);
  sameOrgOrStop(org, entry, checkpoint, args.org, 'rewind');
  const previewed = await host.request({
    type: 'checkpoint:preview',
    payload: { checkpointId: entry.checkpointId },
    timeoutMs: PREVIEW_TIMEOUT_MS,
  });
  if (previewed.outcome !== 'answered') throw new Stop(refusalOfAnswer(previewed, 'The preview'));
  const preview = payloadOf(previewed) as unknown as PreviewAnswer;
  for (const line of previewLines(args.org, checkpoint, preview, org.username)) say(line);
  const writes = objectsWrittenBy(preview.diff).length > 0;
  const gate = writes ? acceptanceRefusal(args.org, preview, args) : undefined;
  const outsideStays =
    !args.acceptOutside &&
    checkpoint.scope.mode === 'picked' &&
    preview.diff.objects.some((object) => object.outside.length > 0);
  if (outsideStays) {
    say(
      '  without --accept-outside, the records they hang from stay, and so do they: each is said ' +
        'once the rewind is through',
    );
  }
  if (args.dryRun) {
    if (gate && !preview.refusal) say(`  a rewind now would be refused: ${gate.message}`);
    answerJson(previewJson(args.org, checkpoint, preview));
    return;
  }
  if (preview.refusal) throw new Stop(preview.refusal);
  if (gate) throw new Stop(gate);
  if (writes && !args.yes) {
    const answer = await typed(rewindQuestion(args.org, checkpoint, preview.diff));
    if (answer !== args.org) throw new Stop({ code: 'DECLINED', message: 'Nothing was written.' });
  }

  const sent = await stoppable(
    context.registry,
    'the rewind stops before its next call to the org, and leaves its journal: rewind again ' +
      'takes up from what still differs',
    () =>
      host.request({
        type: 'checkpoint:rewind',
        payload: {
          checkpointId: entry.checkpointId,
          previewId: preview.diff.previewId,
          acceptAutomation: args.acceptAutomation,
          acceptNoUndo: args.acceptNoUndo,
          acceptRecreate: args.acceptRecreate,
          acceptOutside: args.acceptOutside,
        },
        timeoutMs: WRITE_TIMEOUT_MS,
      }),
  );
  const result = resultOfAnswer(sent, 'The rewind');
  for (const line of rewindLines(args.org, checkpoint, result, preview.diff.userNames)) say(line);
  answerJson(resultJson('rewind', args.org, checkpoint, result, preview.diff));
  endWith(resultExitCode(result.status, sent.stoppedBy));
}

/**
 * What an undo of the rewind `rewindId` takes back, read from its journal on
 * this machine, or nothing when the journal cannot be read: the handler then
 * refuses the undo itself.
 */
async function undoCounts(
  store: OrgCheckpointStore,
  entry: CheckpointListEntry,
  checkpoint: OrgCheckpoint,
  rewindId: string,
): Promise<
  { bringBack: number; giveBack: number; remove: number; along: number; remade: number } | undefined
> {
  try {
    const folder = store.folderOf(entry.organizationId, entry.checkpointId);
    const plans = await undoPlansOf(folder, rewindId, checkpoint.objects);
    try {
      return {
        bringBack: plans.bringBack.count,
        giveBack: plans.giveBack.count,
        // What came back with a parent goes back to the bin with it, never
        // sent on its own: not counted among what it sends.
        remove: plans.remove.spool.count,
        along: plans.goesWithParent.count,
        remade: plans.remade.keys.size,
      };
    } finally {
      await plans.dispose();
    }
  } catch {
    return undefined;
  }
}

/**
 * `undo`: the org's last rewind, by the checkpoint it went back to unless
 * one is named; what it takes back, said from its journal; the question,
 * unless --yes; then the undo, and what still differs, said.
 */
async function undo(
  args: Extract<CliArgs, { command: 'undo' }>,
  context: WriteContext,
): Promise<void> {
  const { host, say, answerJson } = context;
  const all = await context.listAll();
  const ofOrg = checkpointsOf(all, args.org);
  const entry =
    args.checkpoint === undefined
      ? ofOrg.find((candidate) => candidate.undo !== undefined)
      : chosen(resolveCheckpoint(all, ofOrg, args.checkpoint, args.org));
  if (!entry) {
    throw new Stop({
      code: 'NOT_FOUND',
      message:
        `No rewind of ${args.org} can be undone from this machine: Undo is offered for the last ` +
        'rewind of an org, for 15 days after it, until it is undone. Nothing was written.',
    });
  }
  const invalid = invalidRefusal(entry);
  if (invalid) throw new Stop(invalid);
  const checkpoint = entry.checkpoint as OrgCheckpoint;
  if (!entry.undo) {
    throw new Stop({
      code: 'UNDO_CLOSED',
      message:
        `'${checkpoint.name}' has no rewind that can be undone: Undo is offered for the last ` +
        'rewind of an org only, for 15 days after it, until it is undone. Nothing was written.',
    });
  }
  const { rewindId, until } = entry.undo;
  const counts = await undoCounts(context.store, entry, checkpoint, rewindId);
  say(
    `undo the rewind ${rewindId} of ${args.org} to '${checkpoint.name}' (open until ` +
      `${when(until)}, sooner if the recycle bin fills)` +
      (counts
        ? `: it brings back ${count(counts.bringBack)} record(s) the rewind deleted, gives ` +
          `${count(counts.giveBack)} record(s) back the values they had before it, and sends ` +
          `${count(counts.remove - counts.remade)} record(s) it brought back to the recycle bin` +
          (counts.along > 0 ? ', with what came back with them' : '') +
          (counts.remade > 0
            ? `, deleting again the ${count(counts.remade)} record(s) it made again`
            : '') +
          '; what anyone changed since the rewind stays'
        : ''),
  );
  const org = await context.connect(args.org);
  sameOrgOrStop(org, entry, checkpoint, args.org, 'undo');
  if (!args.yes) {
    const answer = await typed(`Type ${args.org} to undo its rewind:`);
    if (answer !== args.org) throw new Stop({ code: 'DECLINED', message: 'Nothing was written.' });
  }

  const sent = await stoppable(
    context.registry,
    'the undo stops before its next call to the org: undo again takes up what it left',
    () =>
      host.request({
        type: 'checkpoint:undo',
        payload: {
          checkpointId: entry.checkpointId,
          rewindId,
          acceptAutomation: args.acceptAutomation,
        },
        timeoutMs: WRITE_TIMEOUT_MS,
      }),
  );
  const result = resultOfAnswer(sent, 'The undo');
  for (const line of undoLines(args.org, checkpoint, result)) say(line);
  answerJson(resultJson('undo', args.org, checkpoint, result));
  endWith(resultExitCode(result.status, sent.stoppedBy));
}

// `tsx` runs this file directly; the check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-checkpoint')) {
  holdOutputWhole();
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
