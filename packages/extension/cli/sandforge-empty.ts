#!/usr/bin/env tsx
/**
 * sandforge-empty — empty the objects named of a sandbox, a scratch org or a
 * Developer Edition org, or every object people work in there, without the
 * editor: a dry run first, always, then the deletes, to the recycle bin with
 * an undo, or for good.
 *
 * Every act goes through the extension's own composition (`panelHost.ts`):
 * DataOps Cleanup's requests (`dataops:empty:*`), answered by the handler the
 * page talks to, its guards, journal and undo the page's own. Its journals and
 * the org's lock are kept where the panel keeps them (`setEmptyStores`): a run
 * stopped here is taken up or undone from the editor, and the other way round,
 * and one emptying of an org runs at a time on this machine, whichever started
 * it.
 *
 * A production org is refused before anything is read, whatever is given, and
 * no flag lifts it. The command never asks a question: without --dry-run or
 * --yes it is refused, exit 1, having read nothing. With --yes it reads the
 * org as its dry run does, says it all, and empties from that read only when
 * nothing would refuse it: the run reads the org again and refuses what the
 * read did not show.
 *
 * The host keeps nothing of its own past the command: its config store is a
 * folder of the system's temp directory made for the run, its owner's alone,
 * removed as the command ends. What lasts is the journals of the runs.
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-empty.ts --target DEV --objects Contact,Case --dry-run
 *   pnpm exec tsx packages/extension/cli/sandforge-empty.ts --target DEV --org --yes
 *   pnpm exec tsx packages/extension/cli/sandforge-empty.ts --target DEV --undo em-20261113-101500-ab12 --yes
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  DataOpsAutomationAnswer,
  DataOpsEmptyCounted,
  DataOpsEmptyLeftOutReason,
  DataOpsEmptyLikelyRefusalCode,
  DataOpsEmptyPreviewKept,
  DataOpsEmptyRefusal,
  DataOpsEmptyRunResult,
  DataOpsEmptyScopeRequest,
  DataOpsEmptyStatus,
  DataOpsEmptyUndoResult,
  DataOpsWriteAccord,
  SalesforceOrg,
} from '@sandforge/shared';
import { createPanelHost } from './panelHost.js';
import type { PanelAnswer, PanelHost, PanelHostOptions, PostedMessage } from './panelHost.js';
import { refuseUnreadArguments, type CommandFlags } from './commandLine.js';
import { DONE_EXIT, FAILED_EXIT, PARTIAL_EXIT, endWith } from './exitCodes.js';
import { onStopSignal, stopExitCode, type StopSignal } from './stopSignals.js';
import { commandLineGuard } from './commandLineGuard.js';
import { fileConfigStore } from './fileConfigStore.js';
import {
  accordOf,
  dataOpsAutomationHelp,
  DATAOPS_AUTOMATION_SWITCHES,
} from './dataOpsAutomationCli.js';
import { refusedLine, wouldBeRefusedLine } from './runRefused.js';
import { holdOutputWhole } from './wholeOutput.js';
import type { InfraServices } from '../src/bridge/handlers/HandlerTypes.js';
import { BackgroundOperationRegistry } from '../src/core/engine/BackgroundOperationRegistry.js';
import { AuditTrailStore } from '../src/modules/audit/auditTrail.js';
import {
  defaultCheckpointStoreRoot,
  openCheckpointStore,
} from '../src/modules/checkpoint/OrgCheckpointStore.js';
import {
  defaultEmptyRoot,
  EmptyJournalStore,
  isEmptyRunId,
} from '../src/modules/dataops/empty/emptyJournal.js';

const TOOL = 'sandforge-empty';

const HELP = `sandforge-empty — empty objects of a sandbox, or the whole of it, without the editor:
a dry run first, then the deletes, to the recycle bin with an undo, or for good.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-empty.ts --target <alias> (--objects <A,B> | --org [--exclude-object <ApiName>]...) (--dry-run | --yes) [options]
  pnpm exec tsx packages/extension/cli/sandforge-empty.ts --target <alias> --undo <run> --yes [options]
  pnpm exec tsx packages/extension/cli/sandforge-empty.ts --target <alias> --resume <run> --yes [options]

  Run from the repository root of a checkout, after pnpm install and
  pnpm build:shared.

Required:
  --target <alias>       sf CLI alias of the sandbox, scratch org or Developer
                         Edition org to empty. A production org is refused
                         before anything is read, and nothing lifts it.
  --objects <A,B>        empty these objects, by API name, comma-separated:
                         every record of each, and what the org deletes along
                         with them
  --org                  empty every object people work in, as checkpoints
                         read them: never users, profiles, setup, Chatter,
                         history, sharing, the org's flows, settings and
                         definitions, or the standard price book
  --dry-run              read the org and say everything a run would do and
                         meet, deleting nothing; exit 1 when a run would be
                         refused, its refusals listed
  --yes                  empty: the dry run is read and said first, and the
                         run goes only when nothing refuses it. Without
                         --dry-run or --yes, refused, exit 1: this command
                         asks no question

Options of --org:
  --exclude-object <ApiName>
                         leave this object out, named in the dry run;
                         repeat it for several
  --custom-settings      empty the custom settings too (left out unless given)
  --files                empty the files and attachments too (left out unless
                         given)
  --managed-packages     empty the objects of managed packages too (left out
                         unless given)
  --unrestorable         empty too, by passes of their own, the objects whose
                         records Salesforce does not bring back from the
                         recycle bin on their own (left out unless given;
                         what they hold under a record emptied goes along
                         with it all the same). What their passes send is
                         said beyond Undo: NO_UNDO, exit 1, without
                         --accept-no-undo

Options:
  --hard-delete          delete for good, with what goes along: nothing goes
                         to the recycle bin and no undo brings anything back.
                         Needs the user's Bulk API Hard Delete permission,
                         read before anything is deleted:
                         HARD_DELETE_NOT_PERMITTED, exit 1, without it
  --accept-no-undo       empty although some records go before a record they
                         name, as Salesforce requires, so that once both have
                         gone Undo cannot bring them back: NO_UNDO, exit 1,
                         without it
  --checkpoint-first     take a checkpoint of the objects emptied before the
                         first delete, to rewind to (sandforge-checkpoint);
                         refused past 500,000 records or the disk's room, and
                         then nothing is deleted
${dataOpsAutomationHelp('deleted', '--dry-run')}  --audit <file>         add the run's entry, or the undo's, to the audit trail
                         kept in <file>: the entry the panel keeps in Reports ->
                         Audit trail, counts only. Not with --dry-run,
                         which adds none
  --json                 print the answer as JSON on stdout, every other line on
                         stderr
  -h, --help             show this help and exit

Undo and resume:
  --undo <run>           bring back from the recycle bin what the org's last
                         emptying deleted, parents first, while the bin holds
                         them; refused for a run that deleted for good. <run>
                         is its id (em-...), or the folder of its journal
  --resume <run>         take up the org's last emptying where it stopped, on
                         what its journal confirmed: records already gone count
                         as deleted
  Both need --yes, and take --accept-automation, --accept-emails,
  --mute-automation and --audit.

Before it deletes, it says per object the records it deletes and what goes
along, in the order it takes them; what will likely refuse, and what it does
first so that it does not (an activated order set back to Draft); the records
of objects left that block a delete; what no undo would bring back; what is
left out and why; the API requests, Bulk API batches and time it takes against
what the org has left today, and the recycle bin's load; what the user is not
proven to see; and what the org runs as the records go, and its emails.

It is refused, exit 1, before anything is deleted, every refusal said: a
production org; another act of this machine writing to the org; the org's last
emptying stopped part way (resume or undo it first); someone else changing
records of these objects in the last hour; more requests or batches than the
org has left today; the automation, emails and mute, as every DataOps act asks
them; a checkpoint refused; and the org changed since the dry run beyond what
it showed. A sandbox marked Staging in the extension, whose whole the panel
never empties, is not known here: the command registers the org afresh, from
what it says it is.

Journals are kept in empty/ under the folder SANDFORGE_JOURNAL_DIR names
(~/.sandforge by default), shared with the panel. Undo reaches the org's last
emptying alone.

Exit codes:
  0  emptied, or a dry run nothing would refuse
  1  refused before anything was deleted, or nothing went through
  2  a bad command line
  3  partial: records the org refused, each said with why
  130, 143, 129  a Ctrl-C, a SIGTERM or a SIGHUP stopped it before its next
     call or job: --resume takes it up, --undo brings back what it deleted
`;

/** What the line reads. */
const FLAGS: CommandFlags = {
  switches: [
    '--org',
    '--custom-settings',
    '--files',
    '--managed-packages',
    '--unrestorable',
    '--hard-delete',
    '--dry-run',
    '--yes',
    '--json',
    '--accept-no-undo',
    '--checkpoint-first',
    ...DATAOPS_AUTOMATION_SWITCHES,
  ],
  values: ['--target', '--objects', '--exclude-object', '--undo', '--resume', '--audit'],
};

/** An object's API name, as `--objects` and `--exclude-object` take one. */
const OBJECT_API_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** An org alias, or the username it stands for. */
const ALIAS = /^[A-Za-z0-9_][A-Za-z0-9_.@+-]{0,254}$/;

/** What the line asks. */
export type EmptyArgs =
  | ({
      act: 'empty';
      request: DataOpsEmptyScopeRequest;
      hard: boolean;
      dryRun: boolean;
      acceptNoUndo: boolean;
      checkpointFirst: boolean;
    } & CommonArgs)
  | ({ act: 'undo' | 'resume'; runId: string } & CommonArgs);

interface CommonArgs {
  target: string;
  json: boolean;
  accord: DataOpsWriteAccord;
  audit?: string;
}

/** Refuse a bad line, exit 2, said on stderr. */
function badLine(line: string): never {
  process.stderr.write(`${line} Run with --help.\n`);
  process.exit(2);
}

/** The values a flag repeated was given, in order. */
function valuesOf(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] !== undefined) values.push(args[i + 1] as string);
  }
  return values;
}

/** The run a `--undo` or `--resume` names: its id, or the folder of its journal. */
export function runIdOf(value: string): string | undefined {
  const trimmed = value.replace(/[\\/]+$/, '');
  const id = basename(trimmed);
  return isEmptyRunId(id) ? id : undefined;
}

/**
 * Read the line. A bad one stops the command, exit 2; one with neither
 * --dry-run nor --yes, exit 1, said: it would have deleted with nobody asked.
 */
export function parseArgs(argv: readonly string[]): EmptyArgs {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  refuseUnreadArguments(args, FLAGS);
  const has = (flag: string): boolean => args.includes(flag);
  const once = (flag: string): string | undefined => {
    const values = valuesOf(args, flag);
    if (values.length > 1) badLine(`${flag} is given ${values.length} times: give it once.`);
    return values[0];
  };
  const target = once('--target');
  if (target === undefined) badLine('--target <alias> names the org to empty.');
  if (!ALIAS.test(target)) badLine(`--target ${target} is not an sf CLI alias.`);
  const json = has('--json');
  const accord = accordOf(args);
  const audit = once('--audit');
  const common: CommonArgs = { target, json, accord, ...(audit !== undefined ? { audit } : {}) };

  const undo = once('--undo');
  const resume = once('--resume');
  const objectsValue = once('--objects');
  const excluded = valuesOf(args, '--exclude-object');
  const orgMode = has('--org');
  const options = ['--custom-settings', '--files', '--managed-packages', '--unrestorable'].filter(
    has,
  );

  if (undo !== undefined || resume !== undefined) {
    const flag = undo !== undefined ? '--undo' : '--resume';
    if (undo !== undefined && resume !== undefined) badLine('--undo and --resume go apart.');
    const scoped = [
      ...(objectsValue !== undefined ? ['--objects'] : []),
      ...(orgMode ? ['--org'] : []),
      ...(excluded.length > 0 ? ['--exclude-object'] : []),
      ...options,
      ...['--hard-delete', '--accept-no-undo', '--checkpoint-first', '--dry-run'].filter(has),
    ];
    if (scoped.length > 0) {
      badLine(
        `${flag} acts on what its run's journal holds, and does not go with ${scoped.join(', ')}.`,
      );
    }
    const value = (undo ?? resume) as string;
    const runId = runIdOf(value);
    if (runId === undefined) {
      badLine(`${flag} ${value} names no emptying: give its id (em-...) or its journal's folder.`);
    }
    if (!has('--yes')) refuseUnasked(common, undo !== undefined ? 'undo' : 'resume');
    return { act: undo !== undefined ? 'undo' : 'resume', runId, ...common };
  }

  if (objectsValue !== undefined && orgMode) badLine('--objects and --org go apart: give one.');
  if (objectsValue === undefined && !orgMode) {
    badLine('Name the objects to empty with --objects <A,B>, or the whole org with --org.');
  }
  if (!orgMode) {
    const orgOnly = [...(excluded.length > 0 ? ['--exclude-object'] : []), ...options];
    if (orgOnly.length > 0) badLine(`${orgOnly.join(', ')} goes with --org alone.`);
  }
  const objects =
    objectsValue === undefined
      ? undefined
      : objectsValue
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name !== '');
  if (objects !== undefined && objects.length === 0) badLine('--objects names no object.');
  for (const name of [...(objects ?? []), ...excluded]) {
    if (!OBJECT_API_NAME.test(name)) badLine(`${name} is not an object API name.`);
  }
  const dryRun = has('--dry-run');
  const yes = has('--yes');
  if (dryRun && yes) badLine('--dry-run and --yes go apart: a dry run deletes nothing.');
  if (!dryRun && !yes) refuseUnasked(common, 'empty');
  if (dryRun && audit !== undefined) badLine('--audit records a run: a dry run adds no entry.');
  const request: DataOpsEmptyScopeRequest = orgMode
    ? {
        mode: 'org',
        ...(excluded.length > 0 ? { excluded: [...new Set(excluded)] } : {}),
        ...(has('--custom-settings') ? { customSettings: true } : {}),
        ...(has('--files') ? { files: true } : {}),
        ...(has('--managed-packages') ? { managedPackages: true } : {}),
        ...(has('--unrestorable') ? { unrestorable: true } : {}),
      }
    : { mode: 'objects', objects: [...new Set(objects ?? [])] };
  return {
    act: 'empty',
    request,
    hard: has('--hard-delete'),
    dryRun,
    acceptNoUndo: has('--accept-no-undo'),
    checkpointFirst: has('--checkpoint-first'),
    ...common,
  };
}

/**
 * The refusal of a line that would delete with nobody asked: exit 1, as a
 * refusal before anything is written, with the answer under `refused`.
 */
function refuseUnasked(common: CommonArgs, act: 'empty' | 'undo' | 'resume'): never {
  const refused: DataOpsEmptyRefusal = {
    code: 'NOT_CONFIRMED',
    message:
      act === 'empty'
        ? `${TOOL} asks no question: add --dry-run to read what it would delete, or --yes to ` +
          'empty once the dry run said it. Nothing was read or deleted.'
        : `${TOOL} asks no question: add --yes to ${act === 'undo' ? 'undo' : 'take up'} the ` +
          'emptying. Nothing was read or written.',
  };
  process.stderr.write(`${refusedLine(refused)}\n`);
  if (common.json) {
    process.stdout.write(
      `${JSON.stringify({ tool: TOOL, target: common.target, action: act, refused }, null, 2)}\n`,
    );
  }
  process.exit(FAILED_EXIT);
}

// ─── Lines ───────────────────────────────────────────────────────────────────

const count = (n: number): string => n.toLocaleString('en-US');

/** A count the org gave, or that it gave none, and why. */
function countedWords(counted: DataOpsEmptyCounted): string {
  if (counted.records === undefined) return `not counted (${counted.unread ?? 'no count'})`;
  const more = counted.atMost ? ' at most' : counted.atLeast ? ' at least' : '';
  return `${count(counted.records)}${more}`;
}

const LEFT_OUT_WORDS: Readonly<Record<DataOpsEmptyLeftOutReason, string>> = {
  configuration: 'configuration: flows, orchestrations, settings, definitions',
  notRestorable: 'cannot come back from the recycle bin (--unrestorable empties them)',
  excludedByUser: 'left out as asked',
  notFound: 'the org has no such object',
  chatter: 'Chatter',
  history: 'field history',
  sharing: 'sharing',
  changeEvent: 'change events',
  unsupportedKind: 'big, external or platform event object',
  customSetting: 'a custom setting (--custom-settings empties them)',
  files: 'files (--files empties them)',
  managedPackage: 'a managed package (--managed-packages empties them)',
  documents: 'documents',
  heldWithFiles: 'goes with the files',
  setup: 'setup',
  platformCreated: 'made by the platform',
  metadata: 'metadata',
  notDeletable: 'the user may not delete its records',
  notDescribed: 'the org would not describe it',
  noRecycleBin: 'its records never go to the recycle bin',
  notForGood: 'its records are never deleted for good',
};

const LIKELY_WORDS: Readonly<Record<DataOpsEmptyLikelyRefusalCode, string>> = {
  activatedOrder:
    'activated order(s): set back to Draft first, as Salesforce deletes none activated',
  standardPriceBook: 'the standard price book: kept, never deleted',
  directContactRelation: 'direct relation(s) of a contact to its account: they go with the contact',
  personAccountContact: 'person account contact(s): they go with their account',
};

/** What a dry run answers, as the page reads it. */
export type EmptyPreviewAnswer = DataOpsEmptyPreviewKept & {
  automation: DataOpsAutomationAnswer;
  refusals: DataOpsEmptyRefusal[];
  /** The requests the dry run sent the org, counted as sent. */
  requestsSent?: number;
};

/**
 * What `--json` says of the API requests: `estimate`, what the dry run priced
 * the emptying at, its own reads and its run's together; and `sent`, every
 * request the emptying's dry run and run sent the org, counted as they were
 * sent, through each connection they read and delete through. The org's
 * `/limits`, the only other count, are the whole org's and read a minute or
 * two late: a dry run took 153 where the estimate said 25. Neither holds the
 * two reads that register the org as the command connects, nor a checkpoint
 * taken first, which says its own. Exported so it can be tested.
 */
export function apiRequestsJson(
  estimate: number | undefined,
  ...sent: Array<number | undefined>
): { apiRequests: { estimate?: number; sent?: number } } | Record<string, never> {
  const counted = sent.every((each) => each !== undefined)
    ? sent.reduce<number>((sum, each) => sum + (each ?? 0), 0)
    : undefined;
  if (estimate === undefined && counted === undefined) return {};
  return {
    apiRequests: {
      ...(estimate !== undefined ? { estimate } : {}),
      ...(counted !== undefined ? { sent: counted } : {}),
    },
  };
}

/** The flag a refusal's code is lifted by, where the command line has one. */
const FLAG_OF_CODE: Readonly<Record<string, string>> = {
  NO_UNDO: '--accept-no-undo',
};

/** A refusal in the command line's words: the flag that accepts it named, where one does. */
export function refusalWords(refusal: DataOpsEmptyRefusal): DataOpsEmptyRefusal {
  const flag = FLAG_OF_CODE[refusal.code];
  return flag && !refusal.message.includes(flag)
    ? { ...refusal, message: `${refusal.message} (${flag} accepts it)` }
    : refusal;
}

/** What no undo brings back of one object, and why, as a line says it. */
function undoLostLine(lost: EmptyPreviewAnswer['preview']['undoLost'][number]): string {
  switch (lost.reason) {
    case 'standardPrices':
      return (
        `${lost.objectApiName} standard prices, going with ${lost.parent ?? 'their product'}: ` +
        'Salesforce did not bring them back with it'
      );
    case 'notRestorable':
      return `${lost.objectApiName} sent by its own pass: Salesforce does not bring them back`;
    default:
      return (
        `${lost.objectApiName} before ${lost.parent ?? 'its parent'}` +
        `${lost.field !== undefined ? ` (${lost.field})` : ''}: they go before a record they name`
      );
  }
}

/** The lines a dry run says, before any refusal. */
export function previewLines(target: string, answer: EmptyPreviewAnswer): string[] {
  const { preview } = answer;
  const lines: string[] = [];
  const what =
    preview.mode === 'org'
      ? 'every object people work in'
      : `${preview.passes.length} object(s) picked`;
  lines.push(
    `${TOOL}  target=${target}  ${what}  ${preview.deleteMode === 'hard' ? 'FOR GOOD' : 'to the recycle bin'}`,
  );
  lines.push(`read at ${answer.readAt} on the org's clock: records made after it are left`);
  lines.push(
    `${count(preview.total.records)} record(s) of ${count(preview.total.objects)} object(s)` +
      (preview.total.uncounted.length > 0
        ? `, and ${preview.total.uncounted.join(', ')} not counted`
        : ''),
  );
  // The objects that hold records, or that the org would not count: a whole
  // org's two hundred passes printed every one that holds none.
  const holding = preview.passes.filter(
    (pass) => pass.records.records === undefined || pass.records.records > 0,
  );
  if (preview.passes.length > 0) {
    lines.push('', 'Emptied, in the order the run takes them:');
    for (const pass of holding) {
      const sent =
        pass.sent.records !== pass.records.records
          ? `, ${countedWords(pass.sent)} sent by its own pass`
          : '';
      const archived = pass.archived?.records ? `, ${countedWords(pass.archived)} archived` : '';
      const kept = pass.kept?.records ? `, ${countedWords(pass.kept)} kept` : '';
      lines.push(
        `  ${pass.objectApiName.padEnd(40)} ${countedWords(pass.records)}${sent}${archived}${kept}`,
      );
    }
    const empty = preview.passes.length - holding.length;
    if (empty > 0) {
      lines.push(`  and ${count(empty)} object(s) holding no record (--json lists them)`);
    }
  }
  if (preview.along.length > 0) {
    lines.push('', 'Going along, deleted by the org with a record emptied:');
    for (const along of preview.along) {
      // Once each: the routes of one lookup from several emptied objects
      // printed the same lookup three times.
      const via = [...new Set(along.via.map((route) => `${route.field} → ${route.parent}`))].join(
        ', ',
      );
      lines.push(
        `  ${along.objectApiName.padEnd(40)} ${countedWords(along.records)}${via ? `  (${via})` : ''}`,
      );
    }
  }
  const likely = preview.refusals.filter((each) => each.records.records !== 0);
  if (likely.length > 0) {
    lines.push('', 'Likely refused by the org, or done first so that it is not:');
    for (const each of likely) {
      lines.push(
        `  ${each.objectApiName}: ${countedWords(each.records)} — ${LIKELY_WORDS[each.code]}`,
      );
    }
  }
  const blockers = preview.blockers.filter((each) => each.records.records !== 0);
  if (blockers.length > 0) {
    lines.push('', 'Blocking: records of objects not emptied whose lookup refuses the delete:');
    for (const each of blockers) {
      lines.push(
        `  ${each.objectApiName}.${each.field} → ${each.parent}: ${countedWords(each.records)}`,
      );
    }
  }
  const lost = preview.undoLost.filter((each) => each.records.records !== 0);
  if (preview.deleteMode === 'recycle' && lost.length > 0) {
    lines.push('', 'Undo cannot bring back:');
    for (const each of lost) lines.push(`  ${undoLostLine(each)}: ${countedWords(each.records)}`);
  }
  if (preview.leftOut.length > 0) {
    // Each object the user named, by name; of the whole org's, how many for
    // each reason — hundreds, which --json lists one by one.
    const named = (reason: DataOpsEmptyLeftOutReason): boolean =>
      preview.mode === 'objects' || reason === 'excludedByUser' || reason === 'notFound';
    const byReason = new Map<DataOpsEmptyLeftOutReason, number>();
    lines.push('', `Left out: ${count(preview.leftOut.length)} object(s)`);
    for (const each of preview.leftOut) {
      if (named(each.reason)) {
        lines.push(`  ${each.objectApiName}: ${LEFT_OUT_WORDS[each.reason]}`);
      } else {
        byReason.set(each.reason, (byReason.get(each.reason) ?? 0) + 1);
      }
    }
    for (const [reason, n] of byReason) {
      lines.push(`  ${count(n)} object(s): ${LEFT_OUT_WORDS[reason]}`);
    }
  }
  lines.push('', ...costLines(answer));
  lines.push(...accessLines(answer));
  if (answer.checkpoint) {
    const { estimate, objects, refusal } = answer.checkpoint;
    lines.push(
      refusal
        ? `checkpoint first: refused (${refusal.code}): ${refusal.message}`
        : `checkpoint first: ${count(objects.length)} object(s), about ${count(estimate.records)} ` +
            `record(s) and ${count(estimate.apiRequests)} API request(s), taken before the first delete`,
    );
  }
  if (answer.openRun) {
    lines.push(
      `the last emptying of ${target}, ${answer.openRun.runId}, stopped part way: --resume ` +
        `${answer.openRun.runId} takes it up, --undo ${answer.openRun.runId} brings back what it deleted`,
    );
  }
  if (answer.automation.lines.length > 0) lines.push('', ...answer.automation.lines);
  return lines;
}

/** What the run costs, against what the org has left today. */
function costLines(answer: EmptyPreviewAnswer): string[] {
  const { cost } = answer.preview;
  const against = (check: typeof cost.api): string =>
    check.verdict === 'unread'
      ? ` (what the org has left today could not be read: ${check.unread})`
      : ` of ${count(check.remaining)} left today${check.verdict === 'exceeds' ? ': too many' : ''}`;
  const lines = [
    `about ${count(cost.api.estimate)} API request(s), the dry run's reads and the run's ` +
      `together${against(cost.api)}, ` +
      `${count(cost.bulkBatches)} Bulk API batch(es)` +
      (cost.batches ? against(cost.batches) : '') +
      `, about ${count(Math.ceil(cost.seconds))} s`,
  ];
  if (answer.preview.deleteMode === 'recycle') {
    lines.push(
      `${count(cost.binRecords)} record(s) to the recycle bin` +
        (cost.bin?.past
          ? `: past the ${count(cost.bin.documentedCapacity)} the bin is documented to hold, it ` +
            'empties its oldest first, colleagues’ deletions among them, and Undo may not bring all back'
          : ''),
    );
  } else {
    lines.push('deleted for good, with what goes along: no undo brings anything back');
  }
  return lines;
}

/** What the user sees of what goes, may delete for good, and who else is at work. */
function accessLines(answer: EmptyPreviewAnswer): string[] {
  const lines: string[] = [];
  if (answer.access.kind === 'org') {
    lines.push('the user sees every record: View All Data and Modify All Data');
  } else {
    lines.push(
      'the user holds ' +
        (answer.access.viewAllData ? 'View All Data' : 'no View All Data') +
        ' and ' +
        (answer.access.modifyAllData ? 'Modify All Data' : 'no Modify All Data') +
        ': the records of an object it is not proven to see whole are neither counted nor ' +
        'deleted, but those a deleted parent takes along are',
    );
    for (const unseen of answer.access.unseen) {
      lines.push(`  not proven to see ${unseen.objectApiName} whole: ${unseen.reason}`);
    }
  }
  if (answer.preview.deleteMode === 'hard') {
    lines.push(
      answer.hardDelete.permitted
        ? 'the user holds Bulk API Hard Delete'
        : `the user does not hold Bulk API Hard Delete${answer.hardDelete.unread ? ` (${answer.hardDelete.unread})` : ''}`,
    );
  }
  if (answer.peopleActive.people > 0) {
    lines.push(
      `${count(answer.peopleActive.people)} other person(s) changed records of these objects in ` +
        'the hour before the read',
    );
  }
  return lines;
}

/** The lines a run says once it ended. */
export function runLines(target: string, result: DataOpsEmptyRunResult): string[] {
  if (result.runId === '') return result.notes;
  const lines = [
    `${result.resumed ? 'took up' : 'emptied'} ${target}: ${result.runId}, ${result.status}` +
      (result.hard ? ', for good' : ''),
  ];
  // The passes that moved or met the org's refusal: a whole org's two
  // hundred printed "deleted 0" for each that held nothing. --json keeps them.
  const moved = result.passes.filter(
    (pass) =>
      pass.deleted + pass.gone + pass.refused + (pass.notReached ?? 0) + (pass.madeSince ?? 0) >
        0 || pass.reasons.length > 0,
  );
  for (const pass of moved) {
    const parts = [
      `deleted ${count(pass.deleted)}`,
      ...(pass.gone > 0 ? [`gone before ${count(pass.gone)}`] : []),
      ...(pass.refused > 0 ? [`refused ${count(pass.refused)}`] : []),
      ...((pass.notReached ?? 0) > 0 ? [`not reached ${count(pass.notReached ?? 0)}`] : []),
      ...((pass.madeSince ?? 0) > 0 ? [`made since and left ${count(pass.madeSince ?? 0)}`] : []),
    ];
    lines.push(`  ${pass.objectApiName.padEnd(40)} ${parts.join(', ')}`);
    for (const reason of pass.reasons) lines.push(`      ${reason}`);
  }
  const still = result.passes.length - moved.length;
  if (still > 0) {
    lines.push(
      `  and ${count(still)} object(s) whose pass found nothing to delete (--json lists them)`,
    );
  }
  const { totals } = result;
  lines.push(
    `deleted ${count(totals.deleted)} record(s), ${count(totals.gone)} gone before their ` +
      `delete, ${count(totals.refused)} refused, ${count(totals.notReached)} not reached`,
  );
  if (result.hardRefused) lines.push(`the org refused to delete for good: ${result.hardRefused}`);
  if (result.checkpoint?.state === 'taken') {
    lines.push(
      `checkpoint taken first: ${result.checkpoint.name} (${result.checkpoint.checkpointId}); ` +
        `sandforge-checkpoint rewind --org ${target} --checkpoint ${result.checkpoint.checkpointId} ` +
        'returns the objects it holds to it',
    );
  } else if (result.checkpoint?.state === 'deleted') {
    lines.push('the checkpoint taken first was deleted again: the run deleted nothing');
  }
  for (const note of result.notes) lines.push(note);
  if (result.status === 'cancelled' || result.status === 'failure') {
    lines.push(
      `${TOOL} --target ${target} --resume ${result.runId} --yes takes it up; ` +
        `--undo ${result.runId} --yes brings back what it deleted`,
    );
  } else if (result.undo.offered) {
    lines.push(
      `${TOOL} --target ${target} --undo ${result.runId} --yes brings them back while the ` +
        'recycle bin holds them, as long as no other emptying of the org follows',
    );
  } else if (result.undo.why === 'hard') {
    lines.push('no undo: it deleted for good');
  }
  return lines;
}

/** The lines an undo says once it ended. */
export function undoLines(target: string, result: DataOpsEmptyUndoResult): string[] {
  const lines = [`undid the emptying ${result.runId} of ${target}: ${result.status}`];
  for (const object of result.objects) {
    const parts = [
      `brought back ${count(object.undeleted)}`,
      ...(object.alreadyBack > 0 ? [`already back ${count(object.alreadyBack)}`] : []),
      ...(object.notInBin > 0 ? [`no longer in the recycle bin ${count(object.notInBin)}`] : []),
      ...(object.othersDeletion > 0
        ? [`deleted by another user, Modify All Data needed ${count(object.othersDeletion)}`]
        : []),
      ...(object.refused > 0 ? [`refused ${count(object.refused)}`] : []),
      ...((object.notReached ?? 0) > 0 ? [`not reached ${count(object.notReached ?? 0)}`] : []),
    ];
    lines.push(`  ${object.objectApiName.padEnd(40)} ${parts.join(', ')}`);
    for (const reason of object.reasons) lines.push(`      ${reason}`);
  }
  for (const note of result.notes) lines.push(note);
  return lines;
}

/**
 * The exit code of a run or an undo, from how it ended: 0 done, 3 partial, 1
 * nothing done, and a stop's own code when a signal stopped it.
 */
export function emptyExitCode(status: DataOpsEmptyStatus, stoppedBy?: StopSignal): number {
  if (status === 'success') return DONE_EXIT;
  if (status === 'partial') return PARTIAL_EXIT;
  if (status === 'cancelled')
    return stoppedBy !== undefined ? stopExitCode(stoppedBy) : FAILED_EXIT;
  return FAILED_EXIT;
}

// ─── The run ─────────────────────────────────────────────────────────────────

/** How long a dry run may read the org for. */
const PREVIEW_TIMEOUT_MS = 60 * 60_000;

/** How long a run or an undo may take: as long as a write run. */
const WRITE_TIMEOUT_MS = 12 * 60 * 60_000;

/** The module the handler lists its acts under, in the registry. */
const MODULE = 'dataops';

/** What the command runs with, beside its line; tests give their own. */
export interface EmptyCliDeps {
  /** Stands the host up: the product's own unless a test gives another. */
  createHost?: (options: PanelHostOptions) => PanelHost;
  /** Where the orgs' locks are; `~/.sandforge/locks` unless a test names another. */
  locksDir?: string;
  /** Where the journals are kept; `empty/` under SANDFORGE_JOURNAL_DIR unless a test names another. */
  journalRoot?: string;
  /** Where a checkpoint taken first is kept; the panel's store unless a test names another. */
  checkpointRoot?: string;
}

/** A refusal, said on stderr and, with --json, as the answer on stdout. */
class Stop extends Error {
  constructor(
    readonly refusal: DataOpsEmptyRefusal,
    readonly code: number = FAILED_EXIT,
    readonly also: readonly DataOpsEmptyRefusal[] = [],
  ) {
    super(refusal.message);
    this.name = 'Stop';
  }
}

/** The payload of an answer, as an object. */
function payloadOf(answer: PanelAnswer): Record<string, unknown> {
  return (answer.message?.payload ?? {}) as Record<string, unknown>;
}

/** An answer that is not the response, as the refusal it stands for, and the others beside it. */
function stopOf(answer: PanelAnswer, what: string, stoppedBy?: StopSignal): Stop {
  if (answer.outcome === 'unanswered') {
    return new Stop({ code: 'UNANSWERED', message: `${what}: no answer came in time.` });
  }
  const payload = payloadOf(answer);
  const message = typeof payload.message === 'string' ? payload.message : JSON.stringify(payload);
  const code = typeof payload.code === 'string' ? payload.code : answer.outcome.toUpperCase();
  const also = Array.isArray(payload.alsoRefused)
    ? payload.alsoRefused.flatMap((each: unknown) => {
        const fields = (each ?? {}) as Record<string, unknown>;
        return typeof fields.code === 'string' && typeof fields.message === 'string'
          ? [{ code: fields.code, message: fields.message }]
          : [];
      })
    : [];
  if (stoppedBy !== undefined && code === 'CANCELLED') {
    return new Stop({ code, message }, stopExitCode(stoppedBy));
  }
  return new Stop(refusalWords({ code, message }), FAILED_EXIT, also.map(refusalWords));
}

/**
 * Send `request` as a stop signal stops a run: the first Ctrl-C, SIGTERM or
 * SIGHUP aborts it through the registry, as Live Operations' Cancel does —
 * before its next call or job — and one that comes before it is listed stops
 * it as it is listed; a second one ends the process at once.
 */
async function stoppable(
  registry: BackgroundOperationRegistry,
  interrupted: string,
  request: () => Promise<PanelAnswer>,
): Promise<{ answer: PanelAnswer; stoppedBy?: StopSignal }> {
  let stopped: StopSignal | undefined;
  const unlisten = registry.onEvent((operationId, type, operation) => {
    if (stopped !== undefined && type === 'started' && operation.module === MODULE) {
      registry.abort(operationId);
    }
  });
  const release = onStopSignal((signal) => {
    stopped = signal;
    process.stderr.write(`\ninterrupted: ${interrupted} (Ctrl-C again ends it at once)\n`);
    for (const operation of registry.getRunning()) {
      if (operation.module === MODULE) registry.abort(operation.operationId);
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

/** Run the command; exported so it can be run on the memory org. */
export async function main(argv: string[] = process.argv, deps: EmptyCliDeps = {}): Promise<void> {
  const args = parseArgs(argv);
  // On stderr with --json, where stdout carries the JSON alone.
  const say = (line: string): void => {
    process[args.json ? 'stderr' : 'stdout'].write(`${line}\n`);
  };
  const answerJson = (value: Record<string, unknown>): void => {
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ tool: TOOL, target: args.target, action: args.act, ...value }, null, 2)}\n`,
      );
    }
  };

  const hostDir = mkdtempSync(join(tmpdir(), 'sandforge-empty-'));
  const registry = new BackgroundOperationRegistry();
  let hostConfig: ReturnType<typeof fileConfigStore> | undefined;
  let lastStep: string | undefined;
  try {
    const opened = openCheckpointStore({
      root: deps.checkpointRoot ?? defaultCheckpointStoreRoot(),
      ...(deps.locksDir !== undefined ? { locksDir: deps.locksDir } : {}),
    });
    if ('refusal' in opened) {
      throw new Stop({
        code: 'STORE_REFUSED',
        message:
          `The org's lock and a checkpoint taken first cannot be kept in ${opened.refusal.path} ` +
          `(${opened.refusal.reason}). Nothing was read or deleted.`,
      });
    }
    const store = opened.store;
    const journals = new EmptyJournalStore(deps.journalRoot ?? defaultEmptyRoot());

    const host = (deps.createHost ?? createPanelHost)({
      storeDir: hostDir,
      log: (line) => {
        if (line.startsWith('[WARN] ')) say(`warning: ${line.slice('[WARN] '.length)}`);
      },
      compose: (wiring) => {
        hostConfig = wiring.configStore;
        // The checkpoint taken first, and what else writes to the org, read
        // from the panel's store; the journals and the lock, the panel's.
        wiring.handlers.setCheckpointStore(store);
        wiring.handlers.setEmptyStores({
          journals,
          lock: (organizationId) => store.lock(organizationId, 'empty'),
        });
        // The registry, which Ctrl-C stops a run through as Live Operations'
        // Cancel does, and Production Guard with nobody to ask: no for a
        // production org, which the emptying refused before it, and yes for
        // any other, which --yes answered.
        wiring.handlers.setInfraServices({
          backgroundRegistry: registry,
          productionGuard: commandLineGuard(say, args.target),
        } as Partial<InfraServices> as InfraServices);
      },
      onPost: (message: PostedMessage) => {
        if (message.type !== 'operation:progress') return;
        const step = (message.payload as { currentStep?: unknown } | undefined)?.currentStep;
        if (typeof step !== 'string' || step === lastStep) return;
        lastStep = step;
        say(`  ${step}`);
      },
    });

    let org: SalesforceOrg;
    try {
      org = await host.connect(args.target);
    } catch (err: unknown) {
      throw new Stop({
        code: 'NOT_CONNECTED',
        message: `${args.target} could not be reached: ${err instanceof Error ? err.message : String(err)}. Nothing was read or deleted.`,
      });
    }
    const accord = { ...args.accord };

    if (args.act !== 'empty') {
      const undoing = args.act === 'undo';
      say(
        undoing
          ? `undo the emptying ${args.runId} of ${args.target}: bring back what it deleted, parents first`
          : `take up the emptying ${args.runId} of ${args.target} where it stopped`,
      );
      const sent = await stoppable(
        registry,
        undoing
          ? 'the undo stops before its next call to the org: --undo again takes up what it left'
          : 'the run stops before its next call or job, and keeps its journal: --resume takes it up',
        () =>
          host.request({
            type: undoing ? 'dataops:empty:undo' : 'dataops:empty:run',
            payload: undoing
              ? { orgId: org.id, runId: args.runId, ...accord }
              : { orgId: org.id, resumeRunId: args.runId, ...accord },
            timeoutMs: WRITE_TIMEOUT_MS,
          }),
      );
      copyAudit(hostConfig, args.audit);
      if (sent.answer.outcome !== 'answered') {
        throw stopOf(sent.answer, undoing ? 'The undo' : 'The run', sent.stoppedBy);
      }
      if (undoing) {
        const result = payloadOf(sent.answer).result as DataOpsEmptyUndoResult;
        for (const line of undoLines(args.target, result)) say(line);
        answerJson({
          runId: args.runId,
          result,
          ...apiRequestsJson(undefined, result.requestsSent),
        });
        endWith(emptyExitCode(result.status, sent.stoppedBy));
      } else {
        const result = payloadOf(sent.answer).result as DataOpsEmptyRunResult;
        for (const line of runLines(args.target, result)) say(line);
        answerJson({
          runId: args.runId,
          result,
          ...apiRequestsJson(undefined, result.requestsSent),
        });
        endWith(emptyExitCode(result.status, sent.stoppedBy));
      }
      return;
    }

    // ─── The dry run, read and said before anything ───
    const previewed = await host.request({
      type: 'dataops:empty:preview',
      payload: {
        orgId: org.id,
        request: args.request,
        deleteMode: args.hard ? 'hard' : 'recycle',
        ...(args.acceptNoUndo ? { acceptNoUndo: true } : {}),
        ...(args.checkpointFirst ? { checkpointFirst: true } : {}),
        ...accord,
      },
      timeoutMs: PREVIEW_TIMEOUT_MS,
    });
    if (previewed.outcome !== 'answered') throw stopOf(previewed, 'The dry run');
    const preview = payloadOf(previewed) as unknown as EmptyPreviewAnswer;
    for (const line of previewLines(args.target, preview)) say(line);
    const refusals = preview.refusals.map(refusalWords);
    const summary = {
      dryRun: args.dryRun,
      previewId: preview.previewId,
      readAt: preview.readAt,
      tier: preview.tier,
      preview: preview.preview,
      access: preview.access,
      hardDelete: preview.hardDelete,
      peopleActive: preview.peopleActive,
      ...(preview.checkpoint ? { checkpoint: preview.checkpoint } : {}),
      ...(preview.openRun ? { openRun: preview.openRun } : {}),
      automation: preview.automation,
    };
    const estimate = preview.preview.cost.api.estimate;
    if (args.dryRun) {
      for (const each of refusals) say(`  ${wouldBeRefusedLine(each)}`);
      if (refusals.length === 0) say('  a real run would not be refused');
      answerJson({
        ...summary,
        ...apiRequestsJson(estimate, preview.requestsSent),
        ...(refusals.length > 0
          ? {
              wouldBeRefused: refusals.map((each) => each.message),
              wouldBeRefusedCodes: refusals.map((each) => each.code),
            }
          : {}),
      });
      endWith(refusals.length > 0 ? FAILED_EXIT : DONE_EXIT);
      return;
    }
    const [first, ...also] = refusals;
    if (first) {
      process.stderr.write(`${refusedLine(first)}\n`);
      for (const each of also) process.stderr.write(`${refusedLine(each)}\n`);
      answerJson({
        ...summary,
        ...apiRequestsJson(estimate, preview.requestsSent),
        refused: first,
        ...(also.length > 0 ? { alsoRefused: also } : {}),
      });
      endWith(FAILED_EXIT);
      return;
    }

    // ─── The run, on that same read ───
    const sent = await stoppable(
      registry,
      'the run stops before its next call or job, and keeps its journal: --resume takes it up, ' +
        '--undo brings back what it deleted',
      () =>
        host.request({
          type: 'dataops:empty:run',
          payload: {
            orgId: org.id,
            previewId: preview.previewId,
            ...(args.acceptNoUndo ? { acceptNoUndo: true } : {}),
            ...(args.checkpointFirst ? { checkpointFirst: true } : {}),
            ...accord,
          },
          timeoutMs: WRITE_TIMEOUT_MS,
        }),
    );
    copyAudit(hostConfig, args.audit);
    if (sent.answer.outcome !== 'answered') throw stopOf(sent.answer, 'The run', sent.stoppedBy);
    const result = payloadOf(sent.answer).result as DataOpsEmptyRunResult;
    for (const line of runLines(args.target, result)) say(line);
    if (result.runId !== '') say(`journal: ${journals.root}`);
    answerJson({
      ...summary,
      ...apiRequestsJson(estimate, preview.requestsSent, result.requestsSent),
      result,
    });
    endWith(emptyExitCode(result.status, sent.stoppedBy));
  } catch (err: unknown) {
    const stop =
      err instanceof Stop
        ? err
        : new Stop({ code: 'FAILED', message: err instanceof Error ? err.message : String(err) });
    process.stderr.write(`${refusedLine(stop.refusal)}\n`);
    for (const each of stop.also) process.stderr.write(`${refusedLine(each)}\n`);
    answerJson({
      refused: stop.refusal,
      ...(stop.also.length > 0 ? { alsoRefused: [...stop.also] } : {}),
    });
    endWith(stop.code);
  } finally {
    registry.dispose();
    rmSync(hostDir, { recursive: true, force: true });
  }
}

/**
 * Add the entries the handler recorded in the host's audit trail, which goes
 * with the host's folder, to the one `--audit` keeps: the panel's own entry,
 * as it recorded it. Nothing without the flag. A file that cannot be written
 * is said, and the run's own outcome stands.
 */
function copyAudit(
  hostConfig: ReturnType<typeof fileConfigStore> | undefined,
  path: string | undefined,
): void {
  if (path === undefined || hostConfig === undefined) return;
  try {
    const kept = new AuditTrailStore(fileConfigStore(path));
    const entries = new AuditTrailStore(hostConfig).list({ limit: 1_000 }).entries;
    for (const entry of [...entries].reverse()) kept.append(entry);
  } catch (err: unknown) {
    process.stderr.write(
      `The entry could not be added to the audit trail in ${path} (${err instanceof Error ? err.message : String(err)}).\n`,
    );
  }
}

// `tsx` runs this file directly; the check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-empty')) {
  holdOutputWhole();
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
