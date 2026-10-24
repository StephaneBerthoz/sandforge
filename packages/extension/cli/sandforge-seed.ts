#!/usr/bin/env tsx
/**
 * sandforge-seed — headless Seed runner.
 *
 * The third of these, for the same reason as the first two: running the
 * product against a real org is the only thing that has ever found a defect in
 * it. Forge gave up eleven that way and Sync three, none of which any test,
 * mutation run or workflow had seen.
 *
 * It drives the same `SeedOrchestrator` the panel drives, with the same
 * validator, plan builder, field mapper and reference linker, and writes
 * through the same write path (`seedInsert`): REST calls, a Bulk API job past
 * 200 records of an object, an object an active duplicate rule watches
 * through REST, each object generated and written a slice at a time. What it leaves out is what the panel adds
 * around a run: progress posted to a webview, the AI field generator (the
 * faker fallback covers every rule on its own) and grappe partitioning.
 *
 * A run's draws are seeded: the summary prints the seed, and `--seed` takes it
 * back, so a dry run and the run after it plan and write the same numbers. A
 * run printed with `--json` and saved to a file can be taken back: `--remove`
 * deletes from the org the records it created, with the removal Sync, Forge
 * and Frozen run, from the summary alone.
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-seed.ts \
 *     --target TGT --template prebuilt-minimal-demo
 *   pnpm exec tsx packages/extension/cli/sandforge-seed.ts \
 *     --target TGT --object Account:3 --object Contact:1 \
 *     --relation Contact.AccountId=Account --per-parent 3
 *   pnpm exec tsx packages/extension/cli/sandforge-seed.ts \
 *     --remove <summary.json> --target TGT [--include-changed] [--accept-automation] [--json]
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type {
  ForgeEmailLimit,
  ForgeRemovalSteps,
  ForgeSweepResult,
  ForgeTargetAutomation,
  ForgeUndoObjectResult,
  ForgeUndoStatus,
  SeedRelation,
  SeedTemplate,
} from '@sandforge/shared';
import {
  DEFAULT_ROBUSTNESS_CONFIG,
  PREBUILT_SEED_TEMPLATES,
  SEED_RELATION_LIMITS,
  describedFieldRule,
  groupRecordErrors,
  integerDigitsOf,
  plannedChildCount,
  removalStepsBypassesOf,
} from '@sandforge/shared';
import { BulkApiManager } from '../src/core/engine/BulkApiManager.js';
import { RetryableOperation } from '../src/core/engine/RetryableOperation.js';
import { seedInsert, type SeedInsertConnection } from '../src/modules/seed/seedInsert.js';
import { ACCOUNT, leftOutForAccountKind } from '../src/core/common/platformRecords.js';
import { parseRecordTypeInfos } from '../src/core/metadata/recordTypeAvailability.js';
import { LOCALE_DATA } from '../src/modules/seed/LocaleData.js';
import { removalOrg, setBackToDraftOf } from '../src/modules/forge/ForgeRunRemoval.js';
import { removeSyncRun } from '../src/modules/sync/SyncRunRemoval.js';
import {
  nodeSyncRunCreations,
  readRemovalState,
  readRunFile,
  syncRemovalPlan,
  type SyncRunCreations,
  type SyncRunKept,
  type SyncRunRemovalState,
} from '../src/modules/sync/SyncRunCreations.js';
import { answerJobsInFlight, type IngestJobReading } from '../src/modules/sync/inFlightJob.js';
import { writtenElsewhere } from '../src/modules/sync/runWriter.js';
import {
  jobLines,
  removalRefusal,
  removalSummaryLines,
  removalsPathOf,
  runFileOf,
} from './sandforge-sync.js';
import { loadOrg, makeConn } from './sfSession.js';
import { refuseProductionTarget, typeTarget } from './targetKind.js';
import { refuseUnreadArguments, type CommandFlags } from './commandLine.js';
import { onStopSignal, stopExitCode, type StopSignal } from './stopSignals.js';
import { endWith, runExitCode } from './exitCodes.js';
import { undeletableAnswer } from './undeletableAnswer.js';
import {
  SeedOrchestrator,
  type InsertResult,
  type SeedOrchestratorDependencies,
} from '../src/modules/seed/SeedOrchestrator.js';
import { SeedValidator } from '../src/modules/seed/SeedValidator.js';
import { DataPlanBuilder } from '../src/modules/seed/DataPlanBuilder.js';
import { FieldMapper } from '../src/modules/seed/FieldMapper.js';
import { ReferenceLinker } from '../src/modules/seed/ReferenceLinker.js';
import { FakerFallback } from '../src/modules/seed/FakerFallback.js';
import { AIDataGenerator } from '../src/modules/seed/AIDataGenerator.js';
import { readExistingParentIds } from '../src/modules/seed/existingParents.js';
import { describedFieldsOf } from '../src/modules/seed/describedFields.js';
import { seedObjectAccess } from '../src/modules/seed/seedObjectAccess.js';
import { seedLocaleOf } from '../src/modules/seed/seedLocale.js';
import { seedStorageGate } from '../src/modules/seed/seedStorage.js';
import {
  bypassesToAssign,
  emailCheckLines,
  formatMB,
  readEmailLimits,
  removalStepsAutomationLines,
  removalStepsAutomationRefusal,
  type EmailLimit,
  type StorageCheck,
} from '../src/modules/forge/ForgeRunGate.js';
import {
  readSeedAutomation,
  seedAutomationLines,
  seedEmailGate,
  type SeedEmailGate,
} from '../src/modules/seed/seedAutomation.js';
import {
  nodeSeedRunCreations,
  SEED_RUNS_DIR,
  seedRunKept,
} from '../src/modules/seed/SeedRunCreations.js';
import { seedSweepInput } from '../src/modules/seed/seedRunSweep.js';
import { listSweep, sweepRunRecords } from '../src/modules/forge/ForgeRunSweep.js';
import {
  journalDirOf,
  sweepLines,
  sweepListingLines,
  targetAutomationReader,
} from './sandforge-clone.js';

/** The locales the faker draws in. */
const SUPPORTED_LOCALES: readonly string[] = Object.keys(LOCALE_DATA);

const HELP = `sandforge-seed — fill an org from a seed template, without the editor.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-seed.ts \\
    --target <alias> [--template <id> | --object <ApiName>:<count>] [options]

Required:
  --target <alias>       sf CLI alias of the org to fill

One of:
  --template <id>        a built-in template; --list-templates names them
  --object <Api>:<n>     an object and how many rows; repeat for more, in
                         insert order. Fields are generated by the faker.

Options:
  --list-templates       name the built-in templates, then stop
  --batch-size <n>       records per REST call             (default: 200)
                         As in the panel, an object of more than 200 records
                         goes as a Bulk API 2.0 job — through REST all the same
                         when an active duplicate rule watches it, as a job
                         cannot carry the header that lets the rule's matches
                         be saved — generated and written 10 000 records at a
                         time at most, a job for each. Ctrl-C stops the run
                         before its next call, or aborts the job still open,
                         and the summary says what it wrote
  --dry-run              build and map, write nothing      (default: off)
  --seed <n>             draw as the run that printed this seed did: the
                         same command with the same seed plans and writes
                         the same numbers. Every run prints its seed
                                                           (default: drawn)
  --locale <xx_XX>       the names, addresses and phone numbers drawn:
                         ${SUPPORTED_LOCALES.join(', ')}
                                     (default: the org's default locale)
  --record-type <Object>=<Name>[,<Name>]
                         with --object, give that object's records this
                         record type, by API name; several take turns at
                         random. One the running user may not use is
                         refused. Without it, records take the running
                         user's default, and the run names the others.
                         A person account record type on Account writes
                         person accounts: a first and last name, the
                         person's email and phones, and no Name
  --json                 emit the run summary as JSON      (default: off)
                         Saved to a file, it is what --remove takes the
                         run back from: it names what the run created.
                         The run's file does too, whatever becomes of the
                         run (see SANDFORGE_JOURNAL_DIR).
  --fail-on-partial      exit 3, not 0, when the run wrote some records and
                         the org refused others            (default: off)
  --help                 this text

Contact points: an object's standard email and phone fields are filled, with
addresses under domains no mailbox can be at (example.com, .example, .test)
and numbers from ranges nobody holds: nobody can be reached. A record the org
refuses on a field its validation rule names (a phone in another format) is
written again without that field, and the summary says which, and why.

Before the first write, dry run included: the data storage the records take,
and what the target runs as they are created (its flows, Apex triggers,
processes and workflow rules, what of them sends emails or creates records,
the custom permissions that keep them quiet), with the emails the records make
it send against what it has left today. A real run past either is refused, and
writes nothing; a dry run says it would be.

Remove what a run created:
  pnpm exec tsx packages/extension/cli/sandforge-seed.ts \\
    --remove <summary.json | run file | run id> --target <alias> [--include-changed]
    [--accept-automation] [--sweep | --sweep-list] [--json]

  --remove <file | id>   the summary a run printed with --json, saved to a
                         file; or the run's file, which it names as it
                         begins, or its run id. Deletes from the org the
                         records the run created, the last object written
                         first, into the recycle bin. From its file, a run
                         killed, stopped or ended by an error is taken back
                         too: a Bulk API job it had under way, which ran on in
                         the org, is read back by its id first, and its
                         records go with the rest.
  --target <alias>       the org the run wrote to, and no other. It must be a
                         sandbox or a Developer Edition org.
  --include-changed      remove also the records changed since the run, which
                         are kept otherwise
  --accept-automation    remove although the target runs flows, Apex
                         triggers, processes or workflow rules as the removal
                         sets records back to Draft or deletes them, or could
                         not say what it runs. Each is named before anything
                         is deleted; without the flag the removal then
                         deletes nothing, exit 1             (default: off)
  --sweep                before the run's records go, delete too what the
                         target's automation created during the run, as the
                         run's user, that the run did not write: in the objects
                         the run wrote, tasks, events, feed, email messages,
                         notes, case comments, and the objects the target's
                         flows create. The window is the run's inserts, read
                         back from its records, from a second before the first
                         to a minute after the last. Refused when that user
                         created records in the window on objects neither the
                         run nor the automation reaches (hand work, likely).
                         Records someone changed since stay, unless
                         --include-changed                 (default: off)
  --sweep-list           list what --sweep would delete, per object with a few
                         names, and delete nothing, the run's records included
  --leave-undeletable    remove the rest when the user the removal runs as
                         may not delete the records of some objects of the
                         run, leaving those with what they hang from; without
                         it the removal stops before its first delete and
                         names them                             (default: off)
  --json                 print the removal as JSON

  What the removal left on the run's records is kept beside the summary, in
  <summary>.removals.json, or beside the run's file, in <run id>.removal.json,
  and the next --remove of the same summary or file reads it.

Environment:
  SANDFORGE_JOURNAL_DIR=<dir>
                         where every run that writes keeps its file, in
                         <dir>/seed-runs/<run id>.ndjson (default: ~/.sandforge),
                         said as it begins: what it created, insert by insert,
                         its calls as they went and answered, a Bulk API job's
                         id once the org opened it, and how it ended. Ids and
                         dates only.

Relations (with --object; the options after a --relation apply to it):
  --relation <Child>.<Lookup>=<Parent>
                         fill a lookup of one --object from a parent object's
                         records. The child gets the records the relation
                         plans, in place of the count given with --object
  --per-parent <n>       exactly n children per parent     (default: 1)
  --between <min>-<max>  a whole number from min to max per parent, at random
  --ratio <r>            r children per parent on average; 0.5 gives a child
                         to every other parent
  --existing             draw the parents from records already in the org
                         instead of the ones this run writes
  --where <condition>    only records meeting this SOQL WHERE condition
                         (implies --existing)
  --parent-limit <n>     the most records --existing reads (default: 10)

Exit codes: 0 the run finished, some of its records refused included (read the
summary for per-object failures), or the removal took every record it set out
to; 1 the run or the removal could not be started, either was refused before
it wrote or deleted anything — a production org among the reasons, and for
the removal what the target runs as it deletes, without --accept-automation —,
or the run produced only failures, or it stopped on an error (its file keeps
what it created); 2 a bad command line, or a summary or a file --remove cannot
take a run back from; 3 the removal left records of the run in the org, or the
run was partial and --fail-on-partial was given; 130 a Ctrl-C stopped the run,
143 a SIGTERM (a CI job cancelled or timed out), 129 a SIGHUP: its file keeps
what it created.
`;

/** Everything the command line settled. */
interface CliArgs {
  target: string;
  templateId?: string;
  /** In insert order; a relation's child carries the count the relation plans. */
  objects: Array<{ objectApiName: string; recordCount: number }>;
  relations: SeedRelation[];
  batchSize: number;
  dryRun: boolean;
  json: boolean;
  /** Exit 3, not 0, when the run wrote some records and the org refused others. */
  failOnPartial: boolean;
  /** What the run's draws are seeded with; absent, one is drawn and printed. */
  seed?: number;
  /** The locale the faker draws in. */
  locale?: string;
  /** Per object, the record types its records take, by API name. */
  recordTypes: Record<string, string[]>;
}

/** SObject API name — letter-prefixed, alphanumeric and underscore. */
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** The largest seed: what a 32-bit draw starts from. */
const MAX_SEED = 2 ** 32 - 1;

/**
 * A generator of numbers in [0, 1), the same sequence for the same seed
 * (mulberry32): what a relation's `--between` draws with, so that the run
 * after a dry run gives each parent the children the dry run gave it. Drawn
 * with `Math.random`, a dry run planned 38 contacts and the run wrote 40.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * What sets the faker's stream and the other rules' apart from the stream a
 * relation draws from, all three from the run's seed.
 */
const FAKER_STREAM = 0x9e3779b9;
const RULE_STREAM = 0x85ebca6b;

/** `Child.Lookup=Parent`, each part an API name. */
const RELATION_RE =
  /^([A-Za-z][A-Za-z0-9_]{0,79})\.([A-Za-z][A-Za-z0-9_]{0,79})=([A-Za-z][A-Za-z0-9_]{0,79})$/;

/** How many existing parents a relation reads when --parent-limit does not say. */
const DEFAULT_PARENT_LIMIT = 10;

/**
 * The relations on the command line, each with the options that follow it up
 * to the next --relation.
 */
function parseRelations(args: string[], refuse: (line: string) => never): SeedRelation[] {
  const relations: SeedRelation[] = [];
  const most = SEED_RELATION_LIMITS.maxPerParent;
  const wholeIn = (raw: string | undefined, min: number, max: number, flag: string): number => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      refuse(`${flag} takes a whole number from ${min} to ${max}, not "${raw ?? ''}".`);
    }
    return value;
  };
  const existing = (
    relation: SeedRelation,
  ): Extract<SeedRelation['parents'], { kind: 'existing' }> => {
    if (relation.parents.kind !== 'existing') {
      relation.parents = { kind: 'existing', limit: DEFAULT_PARENT_LIMIT };
    }
    return relation.parents;
  };

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '--relation') {
      const match = RELATION_RE.exec(value ?? '');
      if (!match) refuse(`--relation wants "Child.Lookup=Parent", not "${value ?? ''}".`);
      const [, childObject, lookupField, parentObject] = match as RegExpExecArray;
      relations.push({
        childObject,
        lookupField,
        parentObject,
        parents: { kind: 'generated' },
        distribution: { mode: 'perParent', count: 1 },
      });
      i++;
      continue;
    }
    const isRelationOption = [
      '--per-parent',
      '--between',
      '--ratio',
      '--existing',
      '--where',
      '--parent-limit',
    ].includes(flag);
    if (!isRelationOption) continue;
    const current = relations.at(-1);
    if (!current) refuse(`${flag} applies to a relation: give --relation before it.`);
    const relation = current as SeedRelation;

    if (flag === '--existing') {
      existing(relation);
      continue;
    }
    i++;
    if (flag === '--per-parent') {
      relation.distribution = { mode: 'perParent', count: wholeIn(value, 1, most, flag) };
    } else if (flag === '--between') {
      const range = /^(\d+)-(\d+)$/.exec(value ?? '');
      if (!range) refuse(`--between wants "<min>-<max>", not "${value ?? ''}".`);
      const [, low, high] = range as RegExpExecArray;
      const min = wholeIn(low, 0, most, flag);
      const max = wholeIn(high, Math.max(1, min), most, flag);
      relation.distribution = { mode: 'range', min, max };
    } else if (flag === '--ratio') {
      const ratio = Number(value);
      if (!Number.isFinite(ratio) || ratio < SEED_RELATION_LIMITS.minRatio || ratio > most) {
        refuse(
          `--ratio takes a number from ${SEED_RELATION_LIMITS.minRatio} to ${most}, not "${value ?? ''}".`,
        );
      }
      relation.distribution = { mode: 'ratio', ratio };
    } else if (flag === '--where') {
      if (!value?.trim()) refuse('--where wants a SOQL condition.');
      existing(relation).where = value;
    } else {
      existing(relation).limit = wholeIn(value, 1, SEED_RELATION_LIMITS.maxExistingParents, flag);
    }
  }
  return relations;
}

/**
 * The objects with each relation's child counted the way the panel counts it:
 * the parents it will find — the parent object's count for records this run
 * writes, the bound for records read from the org — times what each receives.
 */
function countChildren(
  objects: CliArgs['objects'],
  relations: SeedRelation[],
  refuse: (line: string) => never,
): CliArgs['objects'] {
  const counted = objects.map((object) => ({ ...object }));
  for (const relation of relations) {
    const name = `${relation.childObject}.${relation.lookupField}`;
    const child = counted.find((object) => object.objectApiName === relation.childObject);
    if (!child) refuse(`--relation ${name}: give ${relation.childObject} with --object too.`);
    let parents: number;
    if (relation.parents.kind === 'existing') {
      parents = relation.parents.limit;
    } else {
      const parent = counted.find((object) => object.objectApiName === relation.parentObject);
      if (!parent || relation.parentObject === relation.childObject) {
        refuse(
          `--relation ${name}: the ${relation.parentObject} records this run writes cannot be the ` +
            `parents; give ${relation.parentObject} with --object, or add --existing.`,
        );
      }
      parents = (parent as { recordCount: number }).recordCount;
    }
    const planned = plannedChildCount(relation.distribution, parents);
    if (planned < 1) refuse(`--relation ${name} gives no parent a child: raise --ratio.`);
    (child as { recordCount: number }).recordCount = planned;
  }
  return counted;
}

/** What the line of a run reads; a removal's reads its own (`REMOVE_FLAGS`). */
const RUN_FLAGS: CommandFlags = {
  switches: ['--list-templates', '--dry-run', '--json', '--existing', '--fail-on-partial'],
  values: [
    '--target',
    '--template',
    '--object',
    '--batch-size',
    '--seed',
    '--locale',
    '--record-type',
    '--relation',
    '--per-parent',
    '--between',
    '--ratio',
    '--where',
    '--parent-limit',
  ],
};

/** Read the command line, or explain why it cannot be read. */
export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  // `--dry-run=true` or `--dryrun` dropped without a word ran for real.
  refuseUnreadArguments(args, RUN_FLAGS);
  if (args.includes('--list-templates')) {
    for (const template of PREBUILT_SEED_TEMPLATES) {
      process.stdout.write(
        `${template.id.padEnd(34)}${template.objects.length} object(s)  ${templateDisplayName(template)}\n`,
      );
    }
    process.exit(0);
  }
  const get = (flag: string, fallback?: string): string | undefined => {
    const at = args.indexOf(flag);
    return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback;
  };
  const refuse = (line: string): never => {
    process.stderr.write(`${line}\n`);
    process.exit(2);
  };
  const collect = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && i + 1 < args.length) out.push(args[i + 1]);
    }
    return out;
  };

  const target = get('--target');
  const templateId = get('--template');
  const rawObjects = collect('--object');
  if (!target) {
    process.stderr.write('Missing --target. Run with --help.\n');
    process.exit(2);
  }
  if (!templateId && rawObjects.length === 0) {
    process.stderr.write('Nothing to seed: give --template or --object. Run with --help.\n');
    process.exit(2);
  }
  if (templateId && rawObjects.length > 0) {
    // Two answers to "what should this write" is one too many.
    process.stderr.write('Give --template or --object, not both.\n');
    process.exit(2);
  }

  const objects = rawObjects.map((raw) => {
    const at = raw.lastIndexOf(':');
    const objectApiName = at > 0 ? raw.slice(0, at) : raw;
    const recordCount = at > 0 ? Number(raw.slice(at + 1)) : NaN;
    if (!API_NAME_RE.test(objectApiName)) {
      process.stderr.write(`Not an SObject API name: "${objectApiName}"\n`);
      process.exit(2);
    }
    if (!Number.isInteger(recordCount) || recordCount < 1 || recordCount > 100_000) {
      process.stderr.write(`--object wants "Name:<count>", not "${raw}".\n`);
      process.exit(2);
    }
    return { objectApiName, recordCount };
  });

  const batchSize = Number(get('--batch-size', '200') ?? '200');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    process.stderr.write('--batch-size takes a whole number between 1 and 10000.\n');
    process.exit(2);
  }

  const relations = parseRelations(args, refuse);
  if (relations.length > 0 && templateId) {
    refuse('--relation goes with --object: a built-in template carries its own links.');
  }

  let seed: number | undefined;
  if (args.includes('--seed')) {
    const raw = get('--seed');
    seed = Number(raw);
    if (raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(seed) || seed > MAX_SEED) {
      refuse(`--seed takes a whole number from 0 to ${MAX_SEED}, not "${raw ?? ''}".`);
    }
  }

  const locale = get('--locale');
  if (args.includes('--locale') && (locale === undefined || !SUPPORTED_LOCALES.includes(locale))) {
    refuse(`--locale takes one of ${SUPPORTED_LOCALES.join(', ')}, not "${locale ?? ''}".`);
  }

  const recordTypes: Record<string, string[]> = {};
  for (const pair of collect('--record-type')) {
    const match =
      /^([A-Za-z][A-Za-z0-9_]{0,79})=([A-Za-z][A-Za-z0-9_]{0,79}(?:,[A-Za-z][A-Za-z0-9_]{0,79})*)$/.exec(
        pair,
      );
    if (!match) refuse(`--record-type wants "Object=Name" or "Object=Name,Other", not "${pair}".`);
    const [, objectApiName, names] = match as RegExpExecArray;
    if (!objects.some((object) => object.objectApiName === objectApiName)) {
      refuse(`--record-type ${objectApiName}: give ${objectApiName} with --object too.`);
    }
    recordTypes[objectApiName] = [...new Set(names.split(','))];
  }

  return {
    target,
    templateId,
    objects: countChildren(objects, relations, refuse),
    relations,
    batchSize,
    dryRun: args.includes('--dry-run'),
    json: args.includes('--json'),
    failOnPartial: args.includes('--fail-on-partial'),
    ...(seed !== undefined ? { seed } : {}),
    ...(locale !== undefined ? { locale } : {}),
    recordTypes,
  };
}

/** The webview's English catalogue, where the prebuilt templates' names are written. */
const ENGLISH_CATALOGUE = join(
  __dirname,
  '..',
  '..',
  'webview',
  'src',
  'i18n',
  'locales',
  'en.json',
);

let englishCatalogue: Record<string, unknown> | null | undefined;

/** The English catalogue, read once; null when this checkout has none. */
function readEnglishCatalogue(): Record<string, unknown> | null {
  if (englishCatalogue === undefined) {
    try {
      englishCatalogue = JSON.parse(readFileSync(ENGLISH_CATALOGUE, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      englishCatalogue = null;
    }
  }
  return englishCatalogue;
}

/**
 * A template's name as the Seed page shows it in English.
 *
 * A prebuilt template is named by its catalogue key, which the page
 * translates: `--list-templates` and the run's summary printed
 * "seed.templates.minimalDemo.name" where the page reads "Minimal Demo". A
 * template a user saved is named in plain words, and so is one whose key the
 * catalogue does not hold. Synchronous, because `--list-templates` answers
 * from inside the parse of the command line.
 *
 * @param template - The template, prebuilt or saved.
 * @param catalogue - The English catalogue; read from the webview's by default.
 */
export function templateDisplayName(
  template: Pick<SeedTemplate, 'name'>,
  catalogue: Record<string, unknown> | null = readEnglishCatalogue(),
): string {
  if (!template.name.startsWith('seed.templates.') || !catalogue) return template.name;
  let node: unknown = catalogue;
  for (const part of template.name.split('.')) {
    if (node === null || typeof node !== 'object') return template.name;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' && node.trim() !== '' ? node : template.name;
}

/** A built-in template by id, or `null` when the flags describe the objects. */
export function prebuiltTemplate(templateId: string | undefined): SeedTemplate | null {
  if (!templateId) return null;
  const found = PREBUILT_SEED_TEMPLATES.find((t) => t.id === templateId);
  if (!found) {
    const names = PREBUILT_SEED_TEMPLATES.map((t) => t.id).join(', ');
    process.stderr.write(`No template "${templateId}". There is: ${names}\n`);
    process.exit(2);
  }
  return found;
}

/**
 * The fields to fill for an object, and what to fill them with.
 *
 * An object with no field rules writes nothing — the validator refuses it now
 * — so `--object Name:count` has to name some. They come from the target's own
 * describe, through the same `describedFieldRule` the panel gives a field it
 * has just described, so what this writes is what the panel would write for
 * the same object: a text cut to the field's length, a number within its
 * digits, a percentage within 100. Picking the method alone, as this did,
 * drew numbers up to 1000 for a two-digit field, which the org refuses.
 *
 * What the platform insists on, plus `Name` and the object's standard email
 * and phone fields: a seed is meant to make an org usable, not to fill every
 * column it has, and run into a client sandbox, contacts and accounts with
 * neither an email nor a phone were no use to test anything that reaches a
 * customer. The faker draws addresses under reserved domains and numbers from
 * the ranges kept for fiction (`LocaleData`), so nobody is reached. A lookup
 * is filled by a relation the command line names, never by a rule of its own.
 * The object decides whose name a name field holds, as in the panel: a
 * person's on a contact, a company's on an account. An account is written as a
 * business account, without the fields only a person account holds — unless
 * `--record-type` gave it a person account's record type: then it is written
 * as a person account, with a person's first and last names and the person's
 * email and phones (`PersonEmail`, `PersonMobilePhone`…), drawn as a contact's
 * are, and without `Name`, which the platform computes from the two names and
 * refuses from a write.
 *
 * @param accountKind - How an account is written: a business account unless a
 *   person account's record type was chosen (`accountKindOfRecordTypes`).
 */
export function rulesFromDescribe(
  fields: Array<{
    name: string;
    type: string;
    createable: boolean;
    nillable: boolean;
    defaultedOnCreate?: boolean;
    length?: number;
    precision?: number;
    scale?: number;
    digits?: number;
    picklistValues?: Array<{ value?: string | null; active?: boolean }>;
  }>,
  objectApiName?: string,
  accountKind: 'business' | 'person' = 'business',
): SeedTemplate['objects'][number]['fieldRules'] {
  const person = accountKind === 'person' && objectApiName === ACCOUNT;
  const wanted = fields.filter(
    (f) =>
      f.createable &&
      !leftOutForAccountKind(objectApiName ?? '', f.name, person ? 'person' : 'business') &&
      (f.name === 'Name' ||
        isContactPoint(f) ||
        (person && PERSON_NAME_PARTS.has(f.name)) ||
        (!f.nillable && f.defaultedOnCreate !== true)),
  );
  const rules: SeedTemplate['objects'][number]['fieldRules'] = [];
  for (const field of wanted) {
    const rule = describedFieldRule({
      fieldApiName: field.name,
      type: field.type,
      picklistValues: (field.picklistValues ?? [])
        .filter((p) => p.active !== false && typeof p.value === 'string')
        .map((p) => p.value as string),
      referenceTo: [],
      length: field.length ?? 0,
      integerDigits: integerDigitsOf(field),
      objectApiName,
    });
    // Nothing to fill it with: the platform answers for the field.
    if (rule.ruleType === 'static' && rule.config.staticValue === undefined) continue;
    rules.push({
      fieldApiName: field.name,
      fieldType: field.type,
      ruleType: rule.ruleType,
      config: rule.config,
    });
  }
  return rules;
}

/**
 * A standard email or phone field — `Email`, `Phone`, `MobilePhone`, `Fax` —
 * which a seed fills with a value nobody holds. A custom one is the org's
 * own, which a validation rule or a duplicate rule may watch: left to a rule.
 */
function isContactPoint(field: { name: string; type: string }): boolean {
  return (field.type === 'email' || field.type === 'phone') && !field.name.includes('__');
}

/**
 * The name parts a person account is written with, which its describe lets
 * be empty — a business account holds none — and the platform builds `Name`
 * from: without a last name the account is refused.
 */
const PERSON_NAME_PARTS: ReadonlySet<string> = new Set(['FirstName', 'LastName']);

/** The org's person account record types, by API name. */
const PERSON_TYPES_SOQL =
  "SELECT DeveloperName FROM RecordType WHERE SobjectType = 'Account' AND IsPersonType = true";

/**
 * The API names of the org's person account record types: none when it has no
 * person accounts — such an org has no `IsPersonType`, and refuses the read.
 */
export async function personRecordTypeNames(conn: {
  query: (soql: string) => PromiseLike<{ records: Array<Record<string, unknown>> }>;
}): Promise<ReadonlySet<string>> {
  try {
    const answer = await conn.query(PERSON_TYPES_SOQL);
    return new Set(
      answer.records.flatMap((row) =>
        typeof row.DeveloperName === 'string' ? [row.DeveloperName] : [],
      ),
    );
  } catch {
    return new Set();
  }
}

/**
 * How the accounts `--record-type` gives these record types are written: as
 * person accounts when every one is a person account's, as business accounts
 * when none is, and refused when they mix the two — a person account and a
 * business account take different fields, and a run writes one set.
 */
export function accountKindOfRecordTypes(
  names: readonly string[],
  personTypes: ReadonlySet<string>,
): { kind: 'business' | 'person' } | { refusal: string } {
  const persons = names.filter((name) => personTypes.has(name));
  if (persons.length === 0) return { kind: 'business' };
  if (persons.length === names.length) return { kind: 'person' };
  const business = names.filter((name) => !personTypes.has(name));
  return {
    refusal:
      `--record-type ${ACCOUNT}: ${persons.join(', ')} ${persons.length === 1 ? 'is a person account record type' : 'are person account record types'} ` +
      `and ${business.join(', ')} ${business.length === 1 ? 'is' : 'are'} not: a person account ` +
      'and a business account take different fields. Seed one kind in a run.',
  };
}

/** What a run says of accounts written as person accounts. */
export function personAccountLine(names: readonly string[]): string {
  return (
    `  ${ACCOUNT}: ${names.join(', ')} ${names.length === 1 ? 'is a person account record type' : 'are person account record types'}: ` +
    'the accounts are written as person accounts, with a first and last name, the person’s ' +
    'email and phones, and no Name, which the org builds from the two names'
  );
}

/** A record type of the org, as `recordTypeRule` reads it from the describe. */
type DescribedRecordTypes = Parameters<typeof parseRecordTypeInfos>[0];

/**
 * The rule that gives an object's records the record types `--record-type`
 * names, by API name, or why it cannot: a name the object has no active
 * record type of, or one the running user may not use. One type is given to
 * every record; several take turns at random.
 *
 * @param recordTypeInfos - The object's describe's `recordTypeInfos`.
 */
export function recordTypeRule(
  objectApiName: string,
  names: readonly string[],
  recordTypeInfos: DescribedRecordTypes,
): { rule: SeedTemplate['objects'][number]['fieldRules'][number] } | { refusal: string } {
  const infos = parseRecordTypeInfos(recordTypeInfos).filter((info) => !info.master);
  const open = infos.filter((info) => info.active && info.available);
  const ids: string[] = [];
  for (const name of names) {
    const info = infos.find((i) => i.developerName === name);
    if (!info || !info.active || !info.available) {
      const offered = open.map((i) => i.developerName).join(', ') || 'none';
      return {
        refusal:
          `--record-type ${objectApiName}=${name}: ` +
          (!info
            ? `${objectApiName} has no record type ${name}`
            : !info.active
              ? `record type ${name} is inactive`
              : `the running user may not use record type ${name}`) +
          `. Open to them: ${offered}.`,
      };
    }
    ids.push(info.recordTypeId);
  }
  return {
    rule:
      ids.length === 1
        ? {
            fieldApiName: 'RecordTypeId',
            fieldType: 'reference',
            ruleType: 'static',
            config: { staticValue: ids[0] },
          }
        : {
            fieldApiName: 'RecordTypeId',
            fieldType: 'reference',
            ruleType: 'picklist_random',
            config: { picklistValues: ids },
          },
  };
}

/**
 * What a run says of an object whose records take the running user's default
 * record type while others are open to them: which, and how to choose. Nothing
 * for an object with one record type, or none.
 */
export function recordTypeChoiceLine(
  objectApiName: string,
  recordTypeInfos: DescribedRecordTypes,
): string | undefined {
  const open = parseRecordTypeInfos(recordTypeInfos).filter(
    (info) => !info.master && info.active && info.available,
  );
  if (open.length < 2) return undefined;
  const fallback = open.find((info) => info.defaultRecordTypeMapping);
  return (
    `  ${objectApiName}: ${open.length} record types open to you (` +
    `${open.map((info) => info.developerName).join(', ')}); the records take ` +
    `${fallback ? `your default, ${fallback.developerName}` : 'your default'}: ` +
    `--record-type ${objectApiName}=<Name> chooses`
  );
}

/** How a relation spreads its children, in words. */
export function describeDistribution(distribution: SeedRelation['distribution']): string {
  switch (distribution.mode) {
    case 'perParent':
      return `${distribution.count} per parent`;
    case 'range':
      return `${distribution.min} to ${distribution.max} per parent`;
    case 'ratio':
      return `${distribution.ratio} per parent on average`;
  }
}

/**
 * The orchestrator a run drives, the panel's, with what the command line
 * gives it: the org's reads and writes, the seed its draws are made with, the
 * locale the faker draws in. A dry run and a run built with the same seed give
 * each parent the same children, and draw the same names, companies and
 * values: the faker and the other rules draw from the seed too, each from a
 * stream of its own, so that what one draws does not move the other's.
 */
export function seedOrchestrator(deps: {
  insert: SeedOrchestratorDependencies['insert'];
  describeCreateableFields: NonNullable<SeedOrchestratorDependencies['describeCreateableFields']>;
  describeVisibleFields?: SeedOrchestratorDependencies['describeVisibleFields'];
  readExistingParentIds: NonNullable<SeedOrchestratorDependencies['readExistingParentIds']>;
  describePicklistValues?: SeedOrchestratorDependencies['describePicklistValues'];
  describeRequiredFields?: SeedOrchestratorDependencies['describeRequiredFields'];
  objectAccess?: SeedOrchestratorDependencies['objectAccess'];
  seed: number;
  locale?: string;
  /** The run's Ctrl-C: the orchestrator stops before its next object, as at the panel's Cancel. */
  signal?: AbortSignal;
}): SeedOrchestrator {
  return new SeedOrchestrator({
    ...(deps.signal ? { signal: deps.signal } : {}),
    validator: new SeedValidator(),
    readExistingParentIds: deps.readExistingParentIds,
    describeCreateableFields: deps.describeCreateableFields,
    ...(deps.describeVisibleFields ? { describeVisibleFields: deps.describeVisibleFields } : {}),
    ...(deps.describePicklistValues ? { describePicklistValues: deps.describePicklistValues } : {}),
    ...(deps.describeRequiredFields ? { describeRequiredFields: deps.describeRequiredFields } : {}),
    ...(deps.objectAccess ? { objectAccess: deps.objectAccess } : {}),
    planBuilder: new DataPlanBuilder(),
    // An AI generator that refuses. The faker answers every rule the templates
    // here carry, and a run that needs an API key is a run nobody can
    // reproduce — but a template written elsewhere may carry an `ai` rule, and
    // silently filling those with something else would be worse than saying so.
    fieldMapper: new FieldMapper({
      aiGenerator: new AIDataGenerator(() => {
        throw new Error(
          'This template has an AI field rule. sandforge-seed runs without an ' +
            'AI key: use the panel for it, or replace the rule with a faker one.',
        );
      }),
      fakerFallback: new FakerFallback(deps.locale, {
        random: seededRandom(deps.seed ^ FAKER_STREAM),
      }),
      random: seededRandom(deps.seed ^ RULE_STREAM),
    }),
    referenceLinker: new ReferenceLinker(),
    insert: deps.insert,
    generateId: () => `cli-${Math.random().toString(36).slice(2)}`,
    now: () => new Date().toISOString(),
    random: seededRandom(deps.seed),
  });
}

/**
 * How the panel's write path sends an insert of `count` records, as a dry run
 * says it of a slice: past `bulkThreshold`, a Bulk API job — or REST, for an
 * object an active duplicate rule watches, which a run finds out as it
 * writes; under it, REST calls. A slice holds 10 000 records at most
 * (`SEED_SLICE_RECORDS`), never past the count from which `seedInsert`
 * gathers a job's records a chunk at a time. Exported so it can be tested.
 */
export function seedWritePathOf(count: number, bulkThreshold: number): string {
  if (count > bulkThreshold) {
    return '(a Bulk API job, or REST when an active duplicate rule watches the object)';
  }
  return '(REST)';
}

/** What the run says of the data storage its records take, against what the target has left. */
export function storageLine(check: StorageCheck, target: string): string {
  const taken = `data storage: about ${formatMB(check.estimateMB)} MB to write`;
  if (check.verdict === 'unread') {
    return `${taken}; what ${target} has left could not be read (${check.unread})`;
  }
  return (
    `${taken}, ${target} has ${check.remainingMB} MB left of ${check.maxMB} MB` +
    (check.verdict === 'near' ? ': close to what it has left' : '')
  );
}

/** What the run says of the target's automation before it writes, and the gate its emails met. */
export interface SeedAutomationCheck {
  lines: string[];
  gate: SeedEmailGate;
}

/**
 * What the target runs as the run's records are created, and the emails
 * they make it send against what it has left today, as the panel holds a
 * seed: said before the first write, a dry run's included. A read that fails
 * is said, and refuses nothing.
 *
 * @param input.objects - The records the run creates, by object.
 * @param input.readAutomation - What the target runs on the given objects.
 * @param input.readLimits - The target's daily email limits, as `/limits` say them.
 */
export async function seedAutomationCheck(input: {
  target: string;
  objects: ReadonlyArray<{ objectApiName: string; recordCount: number }>;
  readAutomation: (objects: readonly string[]) => Promise<ForgeTargetAutomation>;
  readLimits: () => Promise<Partial<Record<ForgeEmailLimit, EmailLimit>>>;
}): Promise<SeedAutomationCheck> {
  const read = await readSeedAutomation({
    org: input.target,
    objects: input.objects.map((o) => o.objectApiName),
    readAutomation: input.readAutomation,
    readLimits: input.readLimits,
  });
  const gate = seedEmailGate(read, input.objects, input.target);
  return {
    lines: [
      ...seedAutomationLines(read, input.target),
      ...emailCheckLines(gate.checks, input.target),
      ...(gate.unknown ?? []).map((line) => `  emails: ${line}`),
    ],
    gate,
  };
}

/** Run one seed from the given command line; exported so its parsing can be tested. */
export async function main(argv: string[] = process.argv): Promise<void> {
  if (argv.slice(2).includes('--remove')) return removeMain(argv);
  const t0 = Date.now();
  const args = parseArgs(argv);
  // On stderr with --json, where stdout carries the summary alone: dropped
  // there, a refusal before the first write said nothing at all.
  const log = (line: string): void => {
    process[args.json ? 'stderr' : 'stdout'].write(`${line}\n`);
  };
  // Drawn once and printed, given back with --seed: the same command draws
  // the same children per parent, a dry run as the run after it.
  const seed = args.seed ?? randomInt(0, MAX_SEED + 1);
  const startedAt = new Date().toISOString();

  log(`sandforge-seed  -> ${args.target}`);
  log(`seed: ${seed}  (--seed ${seed} draws the same again)`);
  const conn = makeConn(await loadOrg(args.target));
  // Refused before anything is read on a production org, or one that will
  // not say what it is: the seed went from the session to its writes, and
  // its own --remove refuses such an org, so what it wrote there stayed. A
  // dry run only reads.
  const typedTarget = args.dryRun
    ? undefined
    : await refuseProductionTarget(conn, args.target, {
        tool: 'sandforge-seed',
        action: 'write',
        readOnly: '--dry-run',
      });
  // Drawn in the org's own locale unless --locale says otherwise, as the
  // panel draws.
  const locale = await seedLocaleOf(args.locale, conn);
  log(`locale: ${locale}${args.locale ? '' : "  (the org's; --locale draws in another)"}`);

  const now = new Date().toISOString();
  let template = prebuiltTemplate(args.templateId);
  for (const relation of args.relations) {
    const parents =
      relation.parents.kind === 'generated'
        ? `the ${relation.parentObject} records this run writes`
        : `at most ${relation.parents.limit} ${relation.parentObject} records already in the org` +
          (relation.parents.where ? ` where ${relation.parents.where}` : '');
    const count = args.objects.find((o) => o.objectApiName === relation.childObject)?.recordCount;
    log(
      `  relation ${relation.childObject}.${relation.lookupField}: up to ${count} record(s), ` +
        `${describeDistribution(relation.distribution)}, over ${parents}`,
    );
  }
  /** What the run says of how it writes, beside its result: in the summary too. */
  const notes: string[] = [];
  /** The objects written as person accounts, which take 4 KB of data storage a record. */
  const personObjects: string[] = [];
  if (!template) {
    const objects: SeedTemplate['objects'] = [];
    for (const [index, spec] of args.objects.entries()) {
      const described = await conn.sobject(spec.objectApiName).describe();
      // The record types the line chose, or a word on the ones it could choose.
      const chosen = args.recordTypes[spec.objectApiName];
      // Accounts given a person account's record type are person accounts:
      // written as business accounts, with a company's name and none of a
      // person's fields, the org refused them or took them as companies.
      let accountKind: 'business' | 'person' = 'business';
      if (chosen && spec.objectApiName === ACCOUNT) {
        const decided = accountKindOfRecordTypes(chosen, await personRecordTypeNames(conn));
        if ('refusal' in decided) {
          process.stderr.write(`${decided.refusal}\n`);
          process.exit(2);
        }
        accountKind = decided.kind;
        if (accountKind === 'person') {
          personObjects.push(ACCOUNT);
          const line = personAccountLine(chosen);
          log(line);
          notes.push(line.trim());
        }
      }
      // A user who may not create the object reads none of its fields as one
      // to set, so it was given no field to fill, and the validator refused
      // the whole run for want of one: run as a Standard User, a seed of
      // accounts and products wrote no account either. Its fields are picked
      // as for a user who may create it, and the run skips it alone, saying
      // why, as it skips a template's (`closedObject`), with what hangs on it.
      const closed = described.createable === false;
      const fields = described.fields as unknown as Parameters<typeof rulesFromDescribe>[0];
      const rules = rulesFromDescribe(
        closed ? fields.map((field) => ({ ...field, createable: true })) : fields,
        spec.objectApiName,
        accountKind,
      );
      if (chosen) {
        const typed = recordTypeRule(spec.objectApiName, chosen, described.recordTypeInfos);
        if ('refusal' in typed) {
          process.stderr.write(`${typed.refusal}\n`);
          process.exit(2);
        }
        rules.push(typed.rule);
      } else {
        const choice = recordTypeChoiceLine(spec.objectApiName, described.recordTypeInfos);
        if (choice) log(choice);
      }
      log(
        closed
          ? `  ${spec.objectApiName}: the user this seed runs as may not create its records: skipped`
          : `  ${spec.objectApiName}: ${rules.map((r) => r.fieldApiName).join(', ') || '(none)'}`,
      );
      objects.push({
        objectApiName: spec.objectApiName,
        recordCount: spec.recordCount,
        fieldRules: rules,
        excludedFields: [],
        insertOrder: index,
        batchSize: args.batchSize,
      });
    }
    template = {
      id: `cli-${Date.now()}`,
      name: 'sandforge-seed',
      description: 'Headless run',
      version: 1,
      strategy: 'faker',
      objects,
      ...(args.relations.length > 0 ? { relations: args.relations } : {}),
      tags: ['cli'],
      createdAt: now,
      updatedAt: now,
    };
  }

  // The data storage the records take against what the target has left,
  // before the first write, as the panel holds a seed: a dry run says what a
  // real run would meet, and a real run past it writes nothing.
  const storage = await seedStorageGate(conn, template, personObjects, args.target);
  log(storageLine(storage.check, args.target));
  if (storage.refusal) {
    if (!args.dryRun) throw new Error(storage.refusal);
    log(`  a real run would be refused: ${storage.refusal}`);
  }
  // What the target runs as these records are created, and the emails they
  // make it send, before the first write: a seed of 75 contacts left a
  // Developer Edition at -60 of its 15 single emails a day.
  const automation = await seedAutomationCheck({
    target: args.target,
    objects: template.objects,
    readAutomation: (objects) => targetAutomationReader(conn).read(args.target, objects),
    readLimits: () => readEmailLimits(conn),
  });
  for (const line of automation.lines) log(line);
  if (automation.gate.refusal) {
    if (!args.dryRun) throw new Error(automation.gate.refusal);
    log(`  a real run would be refused: ${automation.gate.refusal}`);
  }
  log(`template: ${templateDisplayName(template)} (${template.objects.length} object(s))`);

  // What the run creates, kept as it writes it in its file, as the panel's
  // Seed keeps its runs (`SeedRunCreations`): the command kept it in memory,
  // printed once the run returned, and a run killed by its CI job's timeout,
  // out of memory or ended by an error left its records in the org with
  // nothing --remove could read. Ids and dates only.
  const runId = `sandforge-seed-${randomUUID()}`;
  const runs = args.dryRun ? undefined : nodeSeedRunCreations(journalDirOf());
  const kept = runs?.recorder({
    runId,
    targetOrgId: args.target,
    startedAt,
    ...(typedTarget ? { targetOrganizationId: typedTarget.id } : {}),
  });
  const runFilePath = runs?.pathOf(runId);

  // Ctrl-C stops the run as the panel's Cancel does: before the next call, or
  // the Bulk API job still open aborted; what was written is kept in the
  // summary and the run's file, which --remove takes back. A SIGTERM — a CI
  // job cancelled or timed out — or a SIGHUP stops it the same way.
  const stop = new AbortController();
  let stoppedBy: StopSignal | undefined;
  const interrupt = (signal: StopSignal): void => {
    stoppedBy = signal;
    process.stderr.write(
      '\ninterrupted: the seed stops before its next call to the org, and says what it wrote\n',
    );
    stop.abort();
  };
  // The panel's write path (`seedInsert`): an object of more than the Bulk API
  // threshold goes as a job, an object a duplicate rule watches through REST,
  // each a slice at a time (`SeedOrchestrator.slicesOf`).
  const robustness = DEFAULT_ROBUSTNESS_CONFIG;
  const progressSaid = new Map<string, number>();
  const write = seedInsert({
    conn: conn as unknown as SeedInsertConnection,
    bulkThreshold: robustness.bulk.threshold,
    bulkManager: new BulkApiManager(robustness.bulk.maxConcurrentJobs),
    retry: new RetryableOperation({ retryConfig: robustness.retry, signal: stop.signal }),
    signal: stop.signal,
    label: 'sandforge-seed',
    log: (line) => log(`  ${line}`),
    onProgress: (processed, total, step) => {
      const tenth = total > 0 ? Math.floor((processed / total) * 10) : 10;
      if ((progressSaid.get(step) ?? -1) >= tenth) return;
      progressSaid.set(step, tenth);
      log(`  ${step}: ${processed} of ${total}`);
    },
    // Each call kept before it goes — a Bulk API job with its id once the org
    // opened it — and as it answers, as the panel's run keeps them: a job
    // under way when the run was killed is read back by its id.
    ...(kept
      ? {
          calls: {
            sending: (objectApiName, rows, call) => kept.sending(objectApiName, rows, call),
            answered: (objectApiName, ids) => kept.answered(objectApiName, ids),
          },
        }
      : {}),
  });
  const insert = async (
    orgId: string,
    objectApiName: string,
    records: Record<string, unknown>[],
    batchSize: number,
  ): Promise<InsertResult> => {
    if (args.dryRun) {
      log(
        `  [dry-run] ${objectApiName}: ${records.length} record(s) ${seedWritePathOf(records.length, robustness.bulk.threshold)}`,
      );
      return { successIds: records.map((_, i) => `dry-${i}`), errors: [] };
    }
    const answer = await write(orgId, objectApiName, records, batchSize);
    kept?.note(objectApiName, answer.successIds);
    log(
      `  ${objectApiName}: ${answer.successIds.length} written, ${answer.errors.length} refused` +
        (answer.stopped ? ', stopped' : ''),
    );
    return answer;
  };

  const described = describedFieldsOf((objectApiName) => conn.sobject(objectApiName).describe());

  const orchestrator = seedOrchestrator({
    // A relation reads its parents from the org when told to, dry run or not:
    // a read writes nothing.
    readExistingParentIds: (objectApiName, where, limit) =>
      readExistingParentIds(conn, objectApiName, where, limit),
    describeCreateableFields: described.createable,
    describeVisibleFields: described.visible,
    describePicklistValues: described.picklistValues,
    describeRequiredFields: async (objectApiName) =>
      (await described.required(objectApiName)).filter(
        (field) =>
          !leftOutForAccountKind(
            objectApiName,
            field.fieldApiName,
            personObjects.includes(objectApiName) ? 'person' : 'business',
          ),
      ),
    objectAccess: seedObjectAccess(conn),
    insert,
    seed,
    locale,
    signal: stop.signal,
  });

  log(args.dryRun ? '\nexecuting… (DRY-RUN)' : '\nexecuting… (REAL)');
  // Said before the first write, on stderr with --json: the file is begun
  // with the first records the org takes.
  if (runFilePath !== undefined) {
    log(`run file: ${runFilePath} (--remove ${runFilePath} takes back what the run creates)`);
  }
  const releaseStop = args.dryRun ? () => undefined : onStopSignal(interrupt);
  let result: Awaited<ReturnType<typeof orchestrator.execute>>;
  /** What could not be written to the run's file, said once the run has ended. */
  let unkept: string | undefined;
  const keepFailed = (err: unknown): void => {
    unkept = err instanceof Error ? err.message : String(err);
  };
  try {
    result = await orchestrator.execute(template, args.target, runId);
  } catch (err: unknown) {
    // What it inserted before it threw stays removable, the run ended failed.
    await kept
      ?.end({ status: 'failure', finishedAt: new Date().toISOString(), objectResults: [] })
      .catch(keepFailed);
    if (runFilePath !== undefined && existsSync(runFilePath)) {
      process.stderr.write(
        `the seed stopped on an error; what it created is kept in ${runFilePath}, and ` +
          `--remove ${runFilePath} takes it back\n`,
      );
    }
    throw err;
  } finally {
    releaseStop();
  }
  await kept
    ?.end({
      finishedAt: new Date().toISOString(),
      status: result.status,
      ...(result.cancelled ? { cancelled: true } : {}),
      objectResults: result.objectResults,
    })
    .catch(keepFailed);
  if (unkept !== undefined) {
    process.stderr.write(
      `what the run created could not all be written to ${runFilePath ?? 'its file'} ` +
        `(${unkept}): --remove takes it back from the --json summary\n`,
    );
  }
  const keptInFile = runFilePath !== undefined && existsSync(runFilePath) ? runFilePath : undefined;
  const elapsedMs = Date.now() - t0;
  // Said last, after the summary that names what it wrote: the run stopped.
  const interrupted = stop.signal.aborted;
  endWith(
    interrupted
      ? stopExitCode(stoppedBy ?? 'SIGINT')
      : // A seed whose every record the org refused exited 0, as one that wrote them all.
        runExitCode(result.status, args.failOnPartial),
  );
  const created = result.objectResults.reduce((sum, o) => sum + o.createdIds.length, 0);
  // The org's own id, so --remove takes the run back from it and no other,
  // whatever alias names it then.
  const targetOrgId =
    !args.dryRun && created > 0 ? (typedTarget?.id ?? (await organizationIdOf(conn))) : undefined;

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          tool: 'sandforge-seed',
          target: args.target,
          ...(targetOrgId ? { targetOrgId } : {}),
          dryRun: args.dryRun,
          seed,
          startedAt,
          finishedAt: new Date().toISOString(),
          ...(notes.length > 0 ? { notes } : {}),
          // What the records made the target send, as the gate counted it:
          // a dry run's refusal is said here too.
          emails: {
            checks: automation.gate.checks,
            ...(automation.gate.refusal ? { refusal: automation.gate.refusal } : {}),
            ...(automation.gate.unknown ? { unknown: automation.gate.unknown } : {}),
          },
          result,
          // The run's file, which --remove takes it back from too.
          ...(keptInFile ? { runFile: keptInFile } : {}),
          elapsedMs,
          ...(interrupted ? { interrupted: true } : {}),
        },
        null,
        2,
      )}\n`,
    );
    if (interrupted) process.stderr.write(`${seedInterruptedLine(keptInFile)}\n`);
    return;
  }

  log(`\nstatus:  ${String((result as { status?: string }).status ?? 'unknown')}`);
  log(`created: ${String((result as { totalRecordsCreated?: number }).totalRecordsCreated ?? 0)}`);
  for (const entry of result.objectResults ?? []) {
    log(`  ${entry.objectApiName}: ${entry.recordsCreated} created, ${entry.recordsFailed} failed`);
    for (const line of refusalLines(entry.errors ?? [])) log(`      ${line}`);
  }
  log(`seed: ${seed}`);
  if (!args.dryRun && created > 0) {
    log(
      `\ncreated ${created} record(s) in ${args.target}: ` +
        (keptInFile !== undefined
          ? `--remove ${keptInFile} takes them back`
          : 'run with --json and save the summary to a file, and --remove takes them back from it'),
    );
  }
  if (interrupted) {
    process.stderr.write(`${seedInterruptedLine(keptInFile)}\n`);
    return;
  }
  log(`\ndone in ${elapsedMs}ms`);
}

/** Reasons the summary names for one object; the others are counted. */
const MAX_SUMMARY_REASONS = 5;

/**
 * An object's refusals as the summary says them: grouped by what refused them
 * — the status code and the fields it named — the most frequent first, each
 * with how many records and the first one's words, as the panel's results
 * group them. The summary printed the first three refusals as they came, and
 * a rule refusing fifty records read as three identical lines.
 */
export function refusalLines(errors: readonly string[]): string[] {
  const groups = groupRecordErrors(errors);
  const lines = groups.slice(0, MAX_SUMMARY_REASONS).flatMap((group) => {
    const fields = group.fields.length > 0 ? ` (${group.fields.join(', ')})` : '';
    const head = `${group.count} × ${group.code ?? group.example}${fields}`;
    return group.code === null ? [head] : [head, `  ${group.example}`];
  });
  const others = groups.length - MAX_SUMMARY_REASONS;
  return others > 0 ? [...lines, `and ${others} other reason(s)`] : lines;
}

/**
 * What a seed Ctrl-C stopped says last. Exported so it can be tested.
 *
 * @param runFile - The run's file, when it keeps what the run created.
 */
export function seedInterruptedLine(runFile?: string): string {
  return runFile !== undefined
    ? `interrupted: the seed stopped before it was through; ${runFile} keeps what it wrote, ` +
        `and --remove ${runFile} takes it back`
    : 'interrupted: the seed stopped before it was through; the summary above says what it ' +
        'wrote, and --remove takes it back from that summary saved to a file (--json)';
}

/** The org's own id, or undefined when it does not say. */
async function organizationIdOf(conn: ReturnType<typeof makeConn>): Promise<string | undefined> {
  try {
    const answer = await conn.query<{ Id?: string }>('SELECT Id FROM Organization LIMIT 1');
    const id = answer.records[0]?.Id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

// ─── --remove ────────────────────────────────────────────────────────────────

/** What `--remove` was given. */
export interface RemoveArgs {
  /** The summary a run printed with `--json`, saved to a file; or the run's file, or its id. */
  summaryPath: string;
  /** sf CLI alias of the org the run wrote to. */
  target: string;
  /** Remove also the records changed since the run. */
  includeChanged: boolean;
  /** Sweep first what the target's automation created during the run. */
  sweep: boolean;
  /** List what a sweep would delete, and delete nothing. */
  sweepList: boolean;
  /** Print the removal as JSON on stdout, every other line on stderr. */
  json: boolean;
  /** Remove the rest when the user may not delete some of the run's objects; else stop. */
  leaveUndeletable: boolean;
  /** Remove although the target runs automation as the removal writes, or could not say what. */
  acceptAutomation: boolean;
}

/** The flags a removal reads. */
const REMOVE_FLAGS: ReadonlySet<string> = new Set([
  '--remove',
  '--target',
  '--include-changed',
  '--accept-automation',
  '--sweep',
  '--sweep-list',
  '--leave-undeletable',
  '--json',
]);
const REMOVE_VALUE_FLAGS: ReadonlySet<string> = new Set(['--remove', '--target']);

/** Read the command line of a removal, or explain why it cannot be read. */
export function parseRemoveArgs(argv: string[]): RemoveArgs {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (REMOVE_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (!REMOVE_FLAGS.has(arg)) {
      process.stderr.write(
        `--remove takes --target, --include-changed, --accept-automation, --sweep, --sweep-list, ` +
          `--leave-undeletable and --json, not "${arg}". Run with --help.\n`,
      );
      process.exit(2);
    }
  }
  const get = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    return at >= 0 && at + 1 < args.length ? args[at + 1] : undefined;
  };
  const summaryPath = get('--remove');
  const target = get('--target');
  if (!summaryPath || !target || REMOVE_FLAGS.has(summaryPath) || REMOVE_FLAGS.has(target)) {
    process.stderr.write(
      '--remove takes the file a run printed its --json summary to, or the run file it named ' +
        'as it began, or its run id, and --target the org the run wrote to. Run with --help.\n',
    );
    process.exit(2);
  }
  if (args.includes('--sweep') && args.includes('--sweep-list')) {
    process.stderr.write(
      '--sweep deletes and --sweep-list only lists: give one of them. Run with --help.\n',
    );
    process.exit(2);
  }
  return {
    summaryPath,
    target,
    includeChanged: args.includes('--include-changed'),
    sweep: args.includes('--sweep'),
    sweepList: args.includes('--sweep-list'),
    json: args.includes('--json'),
    leaveUndeletable: args.includes('--leave-undeletable'),
    acceptAutomation: args.includes('--accept-automation'),
  };
}

/** A Salesforce id, as every id a summary names is: they end up in deletes. */
const ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** The summary a run printed with `--json`, as `--remove` reads it: external input. */
const runSummarySchema = z
  .object({
    tool: z.literal('sandforge-seed'),
    target: z.string().min(1),
    targetOrgId: z.string().regex(ID).optional(),
    dryRun: z.boolean(),
    startedAt: z.string().min(1).max(40).optional(),
    finishedAt: z.string().min(1).max(40).optional(),
    result: z
      .object({
        operationId: z.string().min(1).max(200).optional(),
        status: z.enum(['success', 'partial', 'failure']),
        objectResults: z.array(
          z
            .object({
              objectApiName: z.string().regex(API_NAME_RE),
              createdIds: z.array(z.string().regex(ID)),
              truncated: z.boolean().optional(),
            })
            .loose(),
        ),
      })
      .loose(),
  })
  .loose();

/** A run summary, as `--remove` reads it. */
export type SeedRunSummary = z.infer<typeof runSummarySchema>;

/** The summary in `text`, or why `--remove` cannot take a run back from it. */
export function readRunSummary(text: string): { summary: SeedRunSummary } | { refusal: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { refusal: 'is not JSON: save the output of a run printed with --json.' };
  }
  const parsed = runSummarySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      refusal:
        `is not the summary of a sandforge-seed run (${issue.path.join('.') || 'summary'}: ` +
        `${issue.message}).`,
    };
  }
  if (parsed.data.dryRun) {
    return {
      refusal: 'is the summary of a dry run, which wrote nothing: there is nothing to remove.',
    };
  }
  if (parsed.data.result.objectResults.some((o) => o.truncated === true)) {
    return {
      refusal:
        'names only the first of the records some object created: the rest cannot be told ' +
        'apart from the org’s own.',
    };
  }
  return { summary: parsed.data };
}

/**
 * The run a summary names, as the removal Sync runs reads it
 * (`removeSyncRun`): what it created per object, in the order it wrote them,
 * which the removal takes back the last first.
 */
export function runOfSummary(summary: SeedRunSummary, removal?: SyncRunRemovalState): SyncRunKept {
  // Built as the panel builds the run it keeps, so the two take a run back alike.
  return seedRunKept(
    {
      runId: summary.result.operationId ?? 'sandforge-seed',
      targetOrgId: summary.target,
      ...(summary.startedAt !== undefined ? { startedAt: summary.startedAt } : {}),
      ...(summary.finishedAt !== undefined ? { finishedAt: summary.finishedAt } : {}),
      status: summary.result.status,
      objectResults: summary.result.objectResults,
    },
    removal,
  );
}

/** The exit code of a removal that left records of the run in the org. */
const RECORDS_LEFT_EXIT = 3;

/** What a removal takes a run back from: the summary it printed, or its file. */
interface RemovalSubject {
  /** The run, as the removal reads it, with what earlier removals of it did. */
  run: SyncRunKept;
  /** The Organization id of the org it wrote to, when it says it. */
  targetOrgId?: string;
  /** What earlier removals of it did. */
  earlier?: SyncRunRemovalState;
  /** Keep what this removal does, for the next one. */
  updateRemoval: (change: (state: SyncRunRemovalState) => SyncRunRemovalState) => Promise<void>;
  /** Its file's store, when it is taken back from its file: its jobs are read back into it. */
  runs?: SyncRunCreations;
}

/**
 * The run a file of the command keeps, as its file reads it, with what its
 * removals did, kept beside it in its directory (`SeedRunCreations`).
 */
async function subjectOfRunFile(file: string, args: RemoveArgs): Promise<RemovalSubject> {
  const runs = nodeSyncRunCreations(dirname(file), '');
  let read: ReturnType<typeof readRunFile>;
  try {
    read = readRunFile(readFileSync(file, 'utf8'));
  } catch (err: unknown) {
    process.stderr.write(
      `--remove ${file} cannot be read: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
  if (!read || read.configId !== 'sandforge-seed') {
    process.stderr.write(`--remove ${file} names no run of sandforge-seed.\n`);
    process.exit(2);
  }
  // Read by its run's id, beside what its removals did: under another name,
  // a removal would not find what the one before it did.
  if (runs.pathOf(read.runId) !== file) {
    process.stderr.write(
      `--remove ${file} is the file of the run ${read.runId} under another name: give it as ` +
        `${runs.pathOf(read.runId)}, where what its removals did is kept beside it.\n`,
    );
    process.exit(2);
  }
  const run: SyncRunKept = (await runs.get(read.runId)) ?? read;
  if (run.targetOrganizationId === undefined && run.targetOrgId !== args.target) {
    process.stderr.write(
      `The run wrote to ${run.targetOrgId}, and what it created is removed from that org only: ` +
        `give --target ${run.targetOrgId}.\n`,
    );
    process.exit(2);
  }
  return {
    run,
    ...(run.targetOrganizationId !== undefined ? { targetOrgId: run.targetOrganizationId } : {}),
    ...(run.removal ? { earlier: run.removal } : {}),
    updateRemoval: (change) => runs.updateRemoval(run.runId, change),
    runs,
  };
}

/** The run a summary names, and where what its removals did is kept: beside the summary. */
function subjectOfSummary(args: RemoveArgs, say: (line: string) => void): RemovalSubject {
  let text: string;
  try {
    text = readFileSync(args.summaryPath, 'utf8');
  } catch (err: unknown) {
    process.stderr.write(
      `--remove ${args.summaryPath} cannot be read: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
  const read = readRunSummary(text);
  if ('refusal' in read) {
    process.stderr.write(`--remove ${args.summaryPath} ${read.refusal}\n`);
    process.exit(2);
  }
  const { summary } = read;
  if (summary.targetOrgId === undefined && summary.target !== args.target) {
    process.stderr.write(
      `The run wrote to ${summary.target}, and what it created is removed from that org only: ` +
        `give --target ${summary.target}.\n`,
    );
    process.exit(2);
  }

  // What earlier removals of this summary left on the run's records.
  const removalsFile = removalsPathOf(args.summaryPath);
  const runId = summary.result.operationId ?? 'sandforge-seed';
  let earlier: SyncRunRemovalState | undefined;
  let removalsText: string | undefined;
  try {
    removalsText = readFileSync(removalsFile, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      process.stderr.write(
        `${removalsFile} cannot be read: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(2);
    }
  }
  if (removalsText !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(removalsText);
    } catch {
      raw = undefined;
    }
    const ofRun = (raw as { runId?: unknown } | undefined)?.runId;
    earlier = ofRun === runId ? readRemovalState(raw) : undefined;
    if (ofRun !== runId) {
      say(`${removalsFile} is of another run: it is not read, and this removal's takes its place`);
    } else if (!earlier) {
      process.stderr.write(`${removalsFile} does not read as what earlier removals did.\n`);
      process.exit(2);
    }
  }
  const run = runOfSummary(summary, earlier);
  let state: SyncRunRemovalState = earlier ?? {};
  return {
    run,
    ...(summary.targetOrgId !== undefined ? { targetOrgId: summary.targetOrgId } : {}),
    ...(earlier ? { earlier } : {}),
    // Kept beside the summary whatever the removal ended on, written whole
    // through a file renamed over it.
    updateRemoval: async (change) => {
      state = change(state);
      const written = `${removalsFile}.${process.pid}.tmp`;
      writeFileSync(
        written,
        `${JSON.stringify({ version: 1, runId: run.runId, ...state }, null, 2)}\n`,
      );
      renameSync(written, removalsFile);
    },
  };
}

/**
 * Remove from the org what a run created, from the summary the run printed
 * with `--json`, or from its file — the file's path, or the run's id — which
 * a run killed, stopped or ended by an error leaves too: the removal Sync runs
 * (`removeSyncRun`), which is Forge's and Frozen's — every object read before
 * anything is deleted, a record changed since the run kept unless
 * `--include-changed`, children before their parents, into the recycle bin,
 * refusals counted with their reasons. The summary, or the file, and what
 * earlier removals of it kept beside it are read and checked before any org is
 * contacted; then the org is typed, and refused unless it is a sandbox or a
 * Developer Edition org, and the org the run wrote to. A Bulk API job the file
 * names that no line of it answers is read back from the org first, by its
 * id, and its records are removed with the rest.
 */
export async function removeMain(argv: string[] = process.argv): Promise<void> {
  const t0 = Date.now();
  const args = parseRemoveArgs(argv);
  // In --json mode stdout carries the outcome alone, for a parser to read.
  const say = (line: string): void => {
    process[args.json ? 'stderr' : 'stdout'].write(`${line}\n`);
  };

  const file = runFileOf(args.summaryPath, journalDirOf(), SEED_RUNS_DIR);
  const subject =
    file !== undefined ? await subjectOfRunFile(file, args) : subjectOfSummary(args, say);
  const { earlier } = subject;
  let run = subject.run;
  // A run with no end whose process is alive is still being written — by a
  // window of the extension, or another command line — and not one that
  // stopped: its open Bulk API job would be aborted mid-upload, and what it
  // goes on to create would never be offered for removal.
  if (writtenElsewhere(run)) {
    process.stderr.write(
      `The run is still writing, in process ${run.writer?.pid ?? '?'}: remove it once it has ` +
        'ended. Nothing was deleted.\n',
    );
    process.exit(1);
  }

  const output = (
    status: ForgeUndoStatus,
    objects: ForgeUndoObjectResult[],
    planned: number,
    sweep?: ForgeSweepResult,
  ) => {
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            tool: 'sandforge-seed',
            action: 'remove',
            summary: args.summaryPath,
            target: args.target,
            includeChanged: args.includeChanged,
            result: { status, planned, objects, ...(sweep ? { sweep } : {}) },
            elapsedMs: Date.now() - t0,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    // The sweep ran first, before the run's records went.
    for (const line of sweep ? sweepLines(sweep) : []) say(line);
    for (const line of removalSummaryLines(status, objects)) say(line);
    say(`\ndone in ${Date.now() - t0}ms`);
  };

  /** Whether the run's file names a Bulk API job that no line of it answers. */
  const jobsUnanswered = subject.runs !== undefined && (run.jobs ?? []).length > 0;
  // A sweep, or its listing, still has the run's window to look in; a job
  // no line answers, the records it created.
  if (syncRemovalPlan(run).length === 0 && !jobsUnanswered && !args.sweep && !args.sweepList) {
    say(
      earlier?.undo
        ? `what the run created was removed already, on ${earlier.undo.removedAt}`
        : 'The run created nothing: there is nothing of it to remove.',
    );
    output('success', [], 0);
    return;
  }

  const session = await loadOrg(args.target);
  const conn = makeConn(session);
  const org = await typeTarget(conn);
  // A listing deletes nothing; a removal and a sweep delete, and are refused
  // before either reads anything outside a sandbox or a Developer Edition.
  const refusal = args.sweepList ? undefined : removalRefusal(args.target, org, 'sandforge-seed');
  if (refusal) {
    process.stderr.write(`${refusal}\n`);
    process.exit(1);
  }
  if (
    subject.targetOrgId !== undefined &&
    subject.targetOrgId.slice(0, 15) !== org.id.slice(0, 15)
  ) {
    process.stderr.write(
      `${args.target} is not the org the run wrote to (${subject.targetOrgId}), and what it ` +
        'created is removed from that org only. Nothing was deleted.\n',
    );
    process.exit(1);
  }
  // The Bulk API jobs the run's file names that no line of it answers: a run
  // killed, or ended by an error, while one ran. The job ran on to its end in
  // the org; read back by its id, what it created goes into the run's file,
  // and is removed with the rest.
  if (jobsUnanswered && subject.runs) {
    const runs = subject.runs;
    const answered = await answerJobsInFlight(runs, run, conn as unknown as IngestJobReading, () =>
      removalOrg(conn, 'sandforge-seed --remove').serverTime(),
    );
    for (const line of jobLines(answered, args.target)) say(line);
    if (answered.some((job) => job.answered)) run = (await runs.get(run.runId)) ?? run;
  }
  const plan = syncRemovalPlan(run);
  /** What a sweep is told: the run's records read back for its window, and what the target's flows create. */
  const sweepInput = async (signal?: AbortSignal) => {
    let automation: ForgeTargetAutomation | { error: string };
    try {
      automation = await targetAutomationReader(conn).read(
        args.target,
        run.created.map((object) => object.objectApiName),
      );
    } catch (err: unknown) {
      automation = { error: err instanceof Error ? err.message : String(err) };
    }
    return seedSweepInput(
      removalOrg(conn, 'sandforge-seed --sweep'),
      run.created,
      automation,
      signal,
    );
  };

  if (args.sweepList) {
    // What a sweep would delete, read and said; nothing is deleted, the
    // run's own records included.
    const listing = await listSweep(
      removalOrg(conn, 'sandforge-seed --sweep-list'),
      await sweepInput(),
    );
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            tool: 'sandforge-seed',
            action: 'sweep-list',
            summary: args.summaryPath,
            target: args.target,
            listing,
            elapsedMs: Date.now() - t0,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      for (const line of sweepListingLines(listing, args.target)) say(line);
      say(`\ndone in ${Date.now() - t0}ms`);
    }
    return;
  }

  say(`sandforge-seed --remove  ${args.summaryPath}  from ${args.target}`);
  for (const { objectApiName, ids } of plan) say(`  ${objectApiName}: ${ids.length} to remove`);
  if (plan.length === 0) say('nothing left of the run to remove');
  if (args.sweep) {
    say(
      "before them, a sweep deletes what the target's automation created during the run, as " +
        "the run's user — run with --sweep-list to see what",
    );
  }
  // What the target runs as the removal takes the run back, said before it
  // deletes and asked about as Sync's and the clone's removals ask: what
  // fires as it sets an activated order back to Draft, then before and after
  // each delete. The command read it for the sweep alone, and deleted without
  // a word of it. A seed only creates, so nothing is brought back from the
  // recycle bin, and what runs on an undelete is not read.
  const removed = [...new Set(plan.map(({ objectApiName }) => objectApiName))];
  if (removed.length > 0) {
    const steps: ForgeRemovalSteps = { setToDraft: setBackToDraftOf(removed), delete: removed };
    const automation = await targetAutomationReader(conn).read(args.target, removed);
    say('');
    for (const line of removalStepsAutomationLines(automation, args.target, steps)) say(line);
    const automationStop = removalStepsAutomationRefusal(automation, args.target, {
      steps,
      assign: bypassesToAssign(
        automation,
        removalStepsBypassesOf(automation, steps),
        session.username ? { alias: args.target, username: session.username } : undefined,
      ),
    });
    if (automationStop && !args.acceptAutomation) {
      process.stderr.write(`${automationStop}\n`);
      process.exit(1);
    }
  }

  // Ctrl-C stops the removal before its next call to the org; a SIGTERM or a
  // SIGHUP does too.
  const stop = new AbortController();
  const releaseStop = onStopSignal(() => stop.abort());
  let state: SyncRunRemovalState = earlier ?? {};
  // The sweep comes before the run's records go, as the panel's does: a task
  // the target's automation opened on one of them would otherwise stay. The
  // removal makes it once it has read the run's records.
  const sweepMade: { result?: ForgeSweepResult } = {};
  const sweepFirst = args.sweep
    ? async (): Promise<boolean> => {
        sweepMade.result = await sweepRunRecords(
          removalOrg(conn, 'sandforge-seed --sweep'),
          await sweepInput(stop.signal),
          {
            includeChanged: args.includeChanged,
            // What the earlier removals of the run changed while they ran is no
            // change since the run.
            removalSpans: state.removalSpans ?? [],
            // What it found, said before the first delete: --sweep asked for it.
            approve: async (listing) => {
              say('');
              for (const line of sweepListingLines(listing, args.target)) say(line);
              return undefined;
            },
          },
        );
        return sweepMade.result.objects.some((object) => object.deleted > 0);
      }
    : undefined;
  let outcome: Awaited<ReturnType<typeof removeSyncRun>>;
  try {
    outcome = await removeSyncRun({
      run,
      org: removalOrg(conn, 'sandforge-seed --remove'),
      includeChanged: args.includeChanged,
      ...(sweepFirst ? { sweep: sweepFirst } : {}),
      onUndeletable: undeletableAnswer(args.leaveUndeletable, args.target),
      signal: stop.signal,
      store: {
        // Kept beside the summary, or beside the run's file, whatever the
        // removal ended on.
        updateRemoval: (_runId, change) =>
          subject.updateRemoval((kept) => {
            state = change(kept);
            return state;
          }),
      },
    });
  } finally {
    releaseStop();
  }
  // Stopped before its first delete, for objects the user may not delete:
  // named above, and nothing was removed.
  if (outcome.stoppedForUndeletable) process.exit(1);
  for (const note of outcome.notes) process.stderr.write(`${note}\n`);
  const sweep = sweepMade.result;
  output(outcome.result.status, outcome.result.objects, outcome.planned, sweep);
  if (outcome.result.status !== 'success' || (sweep && sweep.status !== 'success')) {
    process.exit(RECORDS_LEFT_EXIT);
  }
}

// `tsx` runs this file directly; the check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-seed')) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
