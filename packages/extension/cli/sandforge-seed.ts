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
  ForgeSweepListing,
  ForgeSweepResult,
  ForgeTargetAutomation,
  ForgeUndoObjectResult,
  ForgeUndoStatus,
  RunCheckpointEstimate,
  RunCheckpointInfo,
  RunCheckpointRequest,
  RunCheckpointTaken,
  SeedRelation,
  SeedTemplate,
  StorageRoomNotCounted,
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
import {
  objectsRemovedOf,
  removalOrg,
  setBackToDraftOf,
  type RemovalPreviewObject,
  type UndeletableObject,
} from '../src/modules/forge/ForgeRunRemoval.js';
import { previewSyncRun, removeSyncRun } from '../src/modules/sync/SyncRunRemoval.js';
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
import { isProductionTarget, refuseProductionTarget, typeTarget } from './targetKind.js';
import { refuseUnreadArguments, type CommandFlags } from './commandLine.js';
import { onStopSignal, stopExitCode, type StopSignal } from './stopSignals.js';
import { endWith, runExitCode } from './exitCodes.js';
import {
  refusalOfSummary,
  refusedLine,
  refusedRemovalSummary,
  refusedSummary,
  refusedSummaryWords,
  wouldBeRefusedJson,
  wouldBeRefusedLine,
  type RunRefusal,
} from './runRefused.js';
import { UNDELETABLE_NOT_LEFT, undeletableAnswer } from './undeletableAnswer.js';
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
import {
  readExistingParentIds,
  readPresentParentIds,
} from '../src/modules/seed/existingParents.js';
import { describedFieldsOf } from '../src/modules/seed/describedFields.js';
import { seedTemplatePayloadSchema } from '../src/bridge/validatePayload.js';
import { personRecordTypes, templateForAccountKinds } from '../src/modules/seed/seedRecordTypes.js';
import { seedObjectAccess, templateTheOrgTakes } from '../src/modules/seed/seedObjectAccess.js';
import { seedLocaleOf } from '../src/modules/seed/seedLocale.js';
import {
  SEED_STORAGE_EXCEEDED,
  seedFitBudgetOf,
  seedStorageBytes,
  seedStorageGate,
} from '../src/modules/seed/seedStorage.js';
import {
  SEED_CANNOT_FIT,
  SEED_FIT_STORAGE_UNREAD,
  fitSeedTemplate,
  fittedTemplate,
  seedRoomOf,
  seedWritesOf,
  type SeedFit,
  type SeedFitCaps,
} from '../src/modules/seed/seedFit.js';
import { STORAGE_RECOUNT_SECONDS } from '../src/modules/forge/fitBudget.js';
import {
  API_BUDGET_EXCEEDED,
  CHECKPOINT_REFUSED,
  bypassesToAssign,
  deliverabilityPartOf,
  emailCheckLines,
  formatMB,
  readEmailLimits,
  removalStepsAutomationLines,
  removalStepsAutomationRefusal,
  takeCheckpointFirst,
  type EmailLimit,
  type StorageCheck,
} from '../src/modules/forge/ForgeRunGate.js';
import {
  NO_APEX_IN_PRODUCTION,
  readEmailDeliverability,
  runEmailsOf,
} from '../src/modules/forge/targetDeliverability.js';
import { beforeRunFailedWords } from '../src/modules/checkpoint/beforeRunCheckpoint.js';
import {
  SEED_EMAILS_EXCEEDED,
  readSeedAutomation,
  seedAutomationLines,
  seedEmailGate,
  type SeedEmailGate,
} from '../src/modules/seed/seedAutomation.js';
import {
  dryRunMuteOf,
  isMuteRefusedError,
  muteForRun,
  muteLines,
  muteOrgOf,
  type HeldMute,
  type RunMute,
} from '../src/modules/forge/AutomationMuteLease.js';
import {
  removalStepsWithSweep,
  removalStepsWrites,
  sweepTakenObjects,
  type MutedAutomation,
} from '@sandforge/shared';
import {
  nodeSeedRunCreations,
  SEED_RUNS_DIR,
  seedRunKept,
} from '../src/modules/seed/SeedRunCreations.js';
import { duplicateSetsOfRemoval, seedSweepInput } from '../src/modules/seed/seedRunSweep.js';
import { listSweep, sweepParts, type SweepInput } from '../src/modules/forge/ForgeRunSweep.js';
import { removalStatusWithSweep } from '../src/modules/forge/removalOutcome.js';
import { withSweepFinds } from '../src/bridge/handlers/removalSweep.js';
import { keepRunUser } from '../src/modules/sync/runUser.js';
import {
  SWEEP_CLASS_FLAGS,
  automationHeldLines,
  commandSweepTies,
  journalDirOf,
  otherRunsOf,
  platformCopiesWords,
  runMuteSchema,
  runUserIdOf,
  sweepClassArgsOf,
  sweepClassOptions,
  sweepLines,
  sweepListingLines,
  sweepOrgOf,
  sweepPartsOptions,
  sweepOptionWords,
  sweepUnsaid,
  syncRunSpanOf,
  targetAutomationReader,
  type SweepClassArgs,
} from './sandforge-clone.js';
import {
  CHECKPOINT_FIRST_FLAGS,
  checkpointEstimateLines,
  checkpointFirstArgs,
  checkpointFirstHelp,
  checkpointOrgOf,
  checkpointStopWords,
  checkpointTakenLines,
  commandCheckpoints,
  settleCommandCheckpoint,
  type CommandCheckpointAsk,
} from './beforeRunCheckpoint.js';
import { holdOutputWhole } from './wholeOutput.js';
import type { ScenarioPack } from '@sandforge/shared';
import { readAgentCatalog, type AgentCatalogRead } from '../src/modules/agentforce/agentCatalog.js';
import { toolingQueryAll, type ToolingQueries } from '../src/modules/seed/scenario/scenarioOrg.js';
import { seedKnowledge, type KnowledgeOrg } from '../src/modules/seed/seedKnowledge.js';
import {
  keepScenarioRun,
  scenarioForTarget,
  scenarioKnowledgeLines,
  scenarioPackOf,
  scenarioPlanLines,
  testFileCommand,
  testFileMain,
  type ScenarioRunKept,
  type TestFileTarget,
} from './seedScenario.js';

/** The locales the faker draws in. */
const SUPPORTED_LOCALES: readonly string[] = Object.keys(LOCALE_DATA);

const HELP = `sandforge-seed — fill an org from a seed template, without the editor.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-seed.ts \\
    --target <alias> [--template <id> | --template-file <path> | --object <ApiName>:<count>
    | --scenario <id | file>] [options]

Required:
  --target <alias>       sf CLI alias of the org to fill

One of:
  --template <id>        a built-in template; --list-templates names them
  --scenario <id | file> test data for an Agentforce agent, from a scenario
                         pack: retail-orders, broadband-support, saas-support,
                         or a *.sandforge-scenario.json file. Its accounts,
                         contacts, cases with their history and comments, and
                         Knowledge articles are written as the pack says, each
                         child under the parent row its key names, the cases
                         under the target's own open and closed statuses; the
                         articles are published once written, each closed
                         case linked to its own, and skipped by an org
                         without Knowledge. No
                         AI key. Goes alone, as --template-file goes. Its run
                         keeps beside its file the ids of the cases its tests
                         are about, for --test-file
  --scenario-seed <n>    with --scenario: the names, companies and addresses
                         drawn; the same seed writes the same data. Two runs in
                         one org take two seeds, or their articles' URL names
                         meet                              (default: 1)
  --template-file <path> a seed template in a JSON file, as the panel runs
                         one: checked before any org is reached, and refused
                         with what does not hold. Its objects, field rules
                         and relations are the file's, so it goes with
                         neither --template, --object nor --relation; an
                         object it gives no batch size takes --batch-size
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
  --mute-automation      mute the target's automation for the run through
                         its own bypass: assign the user the run writes as,
                         for the run alone, the permission sets holding the
                         custom permissions its flows, processes and
                         workflow rules test to stay quiet, and take them
                         back as it ends; what no bypass keeps quiet still
                         runs, and is named. Refused on a production org and
                         for a user who cannot assign permission sets, exit
                         1; with --dry-run, says what would be muted and
                         assigns nothing                   (default: off)
  --accept-emails        write although the target delivers every email of
                         what still runs as the records go in, or would not
                         say whether it does: EMAILS_NOT_ACCEPTED, exit 1,
                         nothing written, without it. Asked only when what
                         still runs sends one: flows, processes and workflow
                         rules with an email action, and those whose
                         definition was not read, whatever --mute-automation
                         leaves. Whether the org delivers them is read with
                         one line of anonymous Apex that sends nothing
                         (Messaging.reserveSingleEmailCapacity(1)), as the
                         user the run writes as, never in a production org; on
                         System email only or No access, none of them goes
                         out, the org still counts them against its daily
                         limits, and nothing is asked. What an Apex trigger
                         sends is read nowhere             (default: off)
  --fit share            seed the largest share of every count that fits
                         the data storage the target has left: each object
                         about that share of its records, at least one, a
                         child no more than the parents kept can hold, rows a
                         template gives kept whole. It may take 80 % of what
                         the target says it has left, half a MB off first for
                         the rounding of what it says, less room for what its
                         flows still running create under the records (what
                         --mute-automation keeps quiet creates nothing); what
                         its Apex triggers create is named, not counted. Its
                         writes leave a tenth of the day's API requests. The
                         counts are said object by object, then the gate is
                         met again by them; a seed that cannot be cut to fit
                         is refused, exit 1 (SEED_CANNOT_FIT; one fitted to a
                         target that does not say what it has left,
                         SEED_FIT_STORAGE_UNREAD). With --dry-run, says the counts
                         and what they meet, and the summary's JSON carries
                         them as fit                       (default: off)
  --fit-cap <Object>=<n> | <n>
                         at most n records of that object, or of every object
                         another --fit-cap does not name; repeat for more. Its
                         children follow it. Caps alone that leave the seed
                         past what fits refuse it; with --fit share, the
                         share is taken of what the caps leave
  --fit-within <MB>      with --fit or --fit-cap: take no more than this many
                         MB, whatever the target has left
${checkpointFirstHelp({ run: 'the run', simulation: '--dry-run' })}
  --seed <n>             draw as the run that printed this seed did: the
                         same command with the same seed plans and writes
                         the same numbers. Every run prints its seed
                                                           (default: drawn)
  --locale <xx_XX>       the names, addresses and phone numbers drawn:
                         ${SUPPORTED_LOCALES.join(', ')}
                                     (default: the org's default locale)
  --record-type <Object>=<Name>[,<Name>]
                         with --object or --template-file, give that
                         object's records this record type, by API name;
                         several take turns at random. One the running user
                         may not use is refused, and so is one for an object
                         a template file gives a RecordTypeId rule already.
                         Without it, records take the running user's
                         default, and the run names the others.
                         A person account record type on Account writes
                         person accounts: a first and last name, the
                         person's email and phones, and no Name
  --json                 emit the run summary as JSON      (default: off)
                         Saved to a file, it is what --remove takes the
                         run back from: it names what the run created.
                         The run's file does too, whatever becomes of the
                         run (see SANDFORGE_JOURNAL_DIR). A dry run's says
                         too the data storage and the API requests its
                         records would take, each against what the target
                         has left today, and under wouldBeRefused what a
                         real run would be refused for, the code of each
                         under wouldBeRefusedCodes, as its line names it:
                         a real run would be refused (CODE): ... A run
                         refused before its first write prints "refused":
                         {"code", "message"} instead, the code its line
                         names: refused (SEED_STORAGE_EXCEEDED): ...
  --fail-on-partial      exit 3, not 0, when the run wrote some records and
                         the org refused others            (default: off)
  --run-id <id>          the run's id, which names its file, its summary's
                         run and what its removals keep: "env-" then
                         lowercase letters, digits and hyphens, 200
                         characters at most. Refused when a run of that id
                         is kept already, before any org is reached
                                                           (default: drawn)
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
writes nothing; a dry run says it would be. Past the storage or the API
requests, it says the counts --fit share would seed.

Remove what a run created:
  pnpm exec tsx packages/extension/cli/sandforge-seed.ts \\
    --remove <summary.json | run file | run id> --target <alias> [--preview]
    [--include-changed] [--accept-automation]
    [--sweep | --sweep-list] [--sweep-late] [--sweep-untied] [--json]

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
  --preview              say what the removal would do, and do nothing: per
                         object, the records it would delete, those it would
                         keep as changed since the run and who changed them,
                         those gone already — deleted, in the recycle bin or
                         emptied from it, which no read tells apart, so none
                         is counted as one a restore brings back —, those it
                         cannot see, and those it would leave because the
                         user may not delete them; what the target runs as
                         they go, and what a removal would be refused for,
                         each under the code it is refused with: a removal
                         would be refused (CODE): ..., with --json the codes
                         under "refusalCodes", in the order of "refusals".
                         It writes nothing, to the org or beside the summary,
                         and asks nothing; it exits 0 once it has said it.
                         It cannot know what the target's automation does as
                         the records go (a trigger or a flow that deletes,
                         keeps or creates other records), nor what hangs from
                         them, which a removal reads at each object's turn: a
                         record kept for records that stay is counted with
                         those to delete. With --sweep, it lists what the
                         sweep would take, and reads what fires on it with
                         the run's own. Not with --sweep-list.
                         --dry-run is refused on a removal: one that did not
                         read it would delete for real
  --include-changed      remove also the records changed since the run, which
                         are kept otherwise
  --accept-automation    remove although the target runs flows, Apex
                         triggers, processes or workflow rules as the removal
                         sets records back to Draft or deletes them, those
                         --sweep deletes included, or could not say what it
                         runs. Each is named before anything is deleted;
                         without the flag the removal then deletes nothing,
                         exit 1                              (default: off)
  --mute-automation      mute the target's automation for the removal through
                         its own bypass, as for a run; what no bypass keeps
                         quiet still needs --accept-automation (default: off)
  --sweep                before the run's records go, delete too what the
                         target's automation made for the run, that the run did
                         not write: what the run's user created under the
                         run's records, what they point at, or what hangs from
                         those, three links at most, at most a minute after the
                         record it is tied to — in the objects the run wrote
                         and their children, tasks, events, feed, email
                         messages, notes, case comments, and the objects the
                         target's flows create. What a record of the run
                         points at by a lookup the org refuses the delete for
                         goes once that record is gone. The window is the
                         run's inserts, read back from its records, from a
                         second before the first to a minute after the last.
                         Listed and kept: what is tied to the run but came
                         later, up to 15 minutes, or as the org's Automated
                         Process user; and what the run's user created in the
                         window tied to nothing of the run. Records someone
                         changed since stay, unless --include-changed
                                                           (default: off)
  --sweep-late           with --sweep, take too what it lists as made late;
                         with --sweep-list, say what it would take
  --sweep-untied         with --sweep, take too what it lists as tied to
                         nothing of the run; with --sweep-list, say what it
                         would take. Refused when another run of this
                         machine wrote to the org in the window, or when that
                         user created records in the window on objects neither
                         the run nor the automation reaches (hand work, likely).
  --sweep-list           list what --sweep would delete, per object with a few
                         names and how many it ties to the run, and delete
                         nothing, the run's records included. What a sweep
                         leaves: what another user created; what is tied to
                         nothing, unless --sweep-untied; what came more than
                         15 minutes after its record, or after the removal
                         began; what someone changed since; what the
                         automation changed rather than created; what left the
                         org; and what the panel or another machine wrote
  --leave-undeletable    remove the rest when the user the removal runs as
                         may not delete the records of some objects of the
                         run, leaving those with what they hang from; without
                         it the removal stops before its first delete and
                         names them                             (default: off)
  --json                 print the removal as JSON; refused before its first
                         delete, "refused": {"code", "message"}, the code its
                         line names: refused (CODE): ... — a production org
                         (PRODUCTION_TARGET), what fires as it deletes
                         (AUTOMATION_NOT_ACCEPTED), its mute (MUTE_PRODUCTION,
                         MUTE_NO_RIGHT, MUTE_FAILED), objects its user may not
                         delete (UNDELETABLE_NOT_LEFT)

  What the removal left on the run's records is kept beside the summary, in
  <summary>.removals.json, or beside the run's file, in <run id>.removal.json,
  and the next --remove of the same summary or file reads it.

Write the Agentforce test file of a --scenario run:
  pnpm exec tsx packages/extension/cli/sandforge-seed.ts \\
    --test-file <run file | run id> --target <alias> --agent <API name>
    --topic <scenario topic>=<agent topic>[:<action>[,<action>]] ...
    [--guard-topic <agent topic>] [--test-runner testing-center | agentforce-studio]
    [--scenario <id | file>] [--project <dir>] [--overwrite] [--json]

  --test-file <file | id> the run's file, which a --scenario run names as it
                         begins, or its run id: the ids of the cases its tests
                         are about are read from beside it
  --target <alias>       the org the run wrote to, whose agents are read, by
                         SOQL on their catalog alone
  --agent <API name>     the agent the tests are for. Without it, the target's
                         agents are listed, with their topics and actions, and
                         nothing is written, exit 2. An org with no agent is
                         said so, exit 1: create one, then write the file
  --topic <t>=<topic>[:<actions>]
                         each topic of the scenario, matched to a topic of the
                         agent, with the actions expected of it, by API name;
                         one the agent does not have is refused, named
  --guard-topic <topic>  the agent's topic that declines what no topic covers;
                         without it those tests are left out, and said
  --test-runner <r>      testing-center, Testing Center's file (the default),
                         or agentforce-studio, Agentforce Studio's
  --scenario <id | file> the pack the run was seeded from, when it is neither
                         shipped nor a file of the project: one edited since
                         is refused, its tests would name what no record holds
  --project <dir>        where the file goes, under specs/  (default: here)
  --overwrite            write over a file of that name, kept otherwise

  The file is never deployed, and the tests never run: both spend what the
  org has, and are the user's to start. From a Salesforce DX project, the two
  commands that do are printed; outside one, sf agent test create cannot run.
  Exit 0 written; 1 the org has no agent or would not read its catalog; 2 a
  bad line, a choice the agent refuses, a file there, a run or a pack it
  cannot be written from.

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
  --parent-ids <id>[,<id>]
                         draw the parents from these records, by id, in this
                         order: at most 2000, 15 or 18 characters each, each
                         once. Each must be a record of the parent object the
                         org holds: one that is not, or no longer is, refuses
                         the run before its first write, named. Not with
                         --existing, --where or --parent-limit. A template file
                         gives the same as "parents": {"kind": "records",
                         "ids": [...]}

Exit codes: 0 the run finished, some of its records refused included (read the
summary for per-object failures), or the removal took every record it set out
to, or a preview said what a removal would do, refusals included; 1 the run or
the removal could not be started, either was refused before it wrote or
deleted anything — a production org among the reasons; for the run, more data
storage than the org has left, more emails or API requests than it has left
today, emails it delivers without --accept-emails (EMAILS_NOT_ACCEPTED), a
checkpoint asked first refused or not taken (CHECKPOINT_REFUSED); for the
removal, what the target runs as it deletes, without --accept-automation —,
or the run produced only failures, or it stopped on an error (its file keeps
what it created); 2 a bad command line, a template file that does not hold, a
run id a run keeps already, or a summary or a file --remove cannot
take a run back from; 3 the removal left records of the run in the org, or its
sweep was refused or did not take all it was asked to (a --sweep-untied refused
included), or the run was partial and --fail-on-partial was given; 130 a Ctrl-C
stopped the run, 143 a SIGTERM (a CI job cancelled or timed out), 129 a SIGHUP:
its file keeps what it created.
`;

/** Everything the command line settled. */
interface CliArgs {
  target: string;
  /** Mute the target's automation for the run, through its own bypass (`--mute-automation`). */
  muteAutomation?: boolean;
  /**
   * Write although the target delivers every email what still runs sends, or
   * would not say whether it does (`--accept-emails`).
   */
  acceptEmails?: boolean;
  templateId?: string;
  /** A seed template in a JSON file, read and checked before any org is reached. */
  templateFile?: string;
  /** A scenario pack: a shipped one's id, or its file. */
  scenario?: string;
  /** What a scenario's names and addresses are drawn with; the default when absent. */
  scenarioSeed?: number;
  /** The run's id, given by whoever runs it (an environment); absent, one is drawn. */
  runId?: string;
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
  /** The fit asked of the run (`--fit`, `--fit-cap`, `--fit-within`); absent when none was. */
  fit?: CliFit;
  /**
   * Take a checkpoint of what the run writes before its first write
   * (`--checkpoint-first`): the days it is kept and the objects left out of
   * it. undefined = none.
   */
  checkpointFirst?: RunCheckpointRequest;
}

/** A fit to the target's storage, as the command line asks it. */
export interface CliFit {
  /** `--fit share`. */
  share: boolean;
  /** `--fit-cap`, by object, and for every object not named. */
  caps?: SeedFitCaps;
  /** `--fit-within`. */
  withinMB?: number;
}

/** SObject API name — letter-prefixed, alphanumeric and underscore. */
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** The largest seed: what a 32-bit draw starts from. */
const MAX_SEED = 2 ** 32 - 1;

/**
 * A run id given on the line: an environment's, `env-` then the names and the
 * number it builds it from. It names the run's file as it is, which takes 200
 * characters at most of letters, digits and hyphens (`SyncRunCreations`), and
 * it never collides with the ids a run draws for itself (`sandforge-seed-…`).
 */
export const ENV_RUN_ID_RE = /^env-[a-z0-9][a-z0-9-]{0,195}$/;

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

/** Why --parent-ids goes with none of the options that read the org's own parents. */
const PARENT_IDS_ALONE =
  '--parent-ids names the parents: it goes with neither --existing, --where nor --parent-limit.';

/** A record id as an org writes one: 15 letters and digits, or 18. */
const RECORD_ID_RE = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/**
 * The ids `--parent-ids` gives, comma-separated, each a record id, each
 * record once, at most as many as a relation reads of the org's own.
 */
function parentIdsOf(raw: string | undefined, refuse: (line: string) => never): string[] {
  const ids = (raw ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  const most = SEED_RELATION_LIMITS.maxExistingParents;
  if (ids.length === 0) refuse('--parent-ids wants record ids, comma-separated.');
  if (ids.length > most) refuse(`--parent-ids takes ${most} ids at most, not ${ids.length}.`);
  const notIds = ids.filter((id) => !RECORD_ID_RE.test(id));
  if (notIds.length > 0) {
    refuse(
      `--parent-ids takes record ids, 15 or 18 letters and digits, not "${notIds.slice(0, 3).join('", "')}".`,
    );
  }
  if (new Set(ids.map((id) => id.slice(0, 15))).size !== ids.length) {
    refuse('--parent-ids names a record twice: give each parent once.');
  }
  return ids;
}

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
    if (relation.parents.kind === 'records') refuse(PARENT_IDS_ALONE);
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
      '--parent-ids',
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
    } else if (flag === '--parent-ids') {
      if (relation.parents.kind === 'existing') refuse(PARENT_IDS_ALONE);
      relation.parents = { kind: 'records', ids: parentIdsOf(value, refuse) };
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
    } else if (relation.parents.kind === 'records') {
      parents = relation.parents.ids.length;
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
    // The line spreads by count; a placement by key comes with a template's rows, counted by them.
    if (relation.distribution.mode === 'byKey') continue;
    const planned = plannedChildCount(relation.distribution, parents);
    if (planned < 1) refuse(`--relation ${name} gives no parent a child: raise --ratio.`);
    (child as { recordCount: number }).recordCount = planned;
  }
  return counted;
}

/** What the line of a run reads; a removal's reads its own (`REMOVE_FLAGS`). */
const RUN_FLAGS: CommandFlags = {
  switches: [
    '--list-templates',
    '--dry-run',
    '--json',
    '--existing',
    '--fail-on-partial',
    '--mute-automation',
    '--accept-emails',
    ...CHECKPOINT_FIRST_FLAGS.switches,
  ],
  values: [
    '--target',
    '--template',
    '--template-file',
    '--scenario',
    '--scenario-seed',
    '--run-id',
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
    '--parent-ids',
    '--fit',
    '--fit-cap',
    '--fit-within',
    ...CHECKPOINT_FIRST_FLAGS.values,
  ],
};

/** The most records an object of a seed takes, and so the largest cap. */
const MAX_OBJECT_RECORDS = 100_000;

/**
 * The fit the line asks (`--fit share`, `--fit-cap`, `--fit-within`), or
 * nothing when it asks none; a line that does not read is refused by name.
 * Whether a capped object is one the seed writes is known once its template
 * is: checked there.
 */
export function fitOfArgs(
  args: readonly string[],
  refuse: (line: string) => never,
): CliFit | undefined {
  const values = (flag: string): string[] =>
    args.flatMap((arg, i) => (arg === flag && i + 1 < args.length ? [args[i + 1]] : []));
  const asked = (flag: string): boolean => args.includes(flag);
  const share = values('--fit');
  if (asked('--fit') && (share.length !== 1 || share[0] !== 'share')) {
    refuse(`--fit takes share, once, not "${share.join(' ')}".`);
  }
  const caps: { all?: number; objects: Record<string, number> } = { objects: {} };
  for (const raw of values('--fit-cap')) {
    const match = /^(?:([A-Za-z][A-Za-z0-9_]{0,79})=)?(\d{1,6})$/.exec(raw);
    const count = match ? Number(match[2]) : NaN;
    if (!match || count < 1 || count > MAX_OBJECT_RECORDS) {
      refuse(
        `--fit-cap wants "<Object>=<n>" or "<n>", n a whole number from 1 to ` +
          `${MAX_OBJECT_RECORDS}, not "${raw}".`,
      );
    }
    const objectApiName = (match as RegExpExecArray)[1];
    if (objectApiName === undefined) {
      if (caps.all !== undefined) refuse('--fit-cap <n> caps every object: give it once.');
      caps.all = count;
    } else {
      if (caps.objects[objectApiName] !== undefined) {
        refuse(`--fit-cap ${objectApiName}: give each object one cap.`);
      }
      caps.objects[objectApiName] = count;
    }
  }
  const capped = caps.all !== undefined || Object.keys(caps.objects).length > 0;
  let withinMB: number | undefined;
  if (asked('--fit-within')) {
    const [raw] = values('--fit-within');
    withinMB = Number(raw);
    if (!asked('--fit') && !capped) refuse('--fit-within goes with --fit share or --fit-cap.');
    if (
      raw === undefined ||
      !/^\d+(?:\.\d+)?$/.test(raw) ||
      withinMB <= 0 ||
      withinMB > 1_000_000
    ) {
      refuse(`--fit-within takes a number of MB above 0, up to 1000000, not "${raw ?? ''}".`);
    }
  }
  if (!asked('--fit') && !capped) return undefined;
  return {
    share: asked('--fit'),
    ...(capped
      ? {
          caps: {
            ...(caps.all !== undefined ? { all: caps.all } : {}),
            ...(Object.keys(caps.objects).length > 0 ? { objects: caps.objects } : {}),
          },
        }
      : {}),
    ...(withinMB !== undefined ? { withinMB } : {}),
  };
}

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
  const templateFile = get('--template-file');
  const scenario = get('--scenario');
  const rawObjects = collect('--object');
  if (!target) {
    process.stderr.write('Missing --target. Run with --help.\n');
    process.exit(2);
  }
  if (
    !templateId &&
    templateFile === undefined &&
    scenario === undefined &&
    rawObjects.length === 0
  ) {
    process.stderr.write(
      'Nothing to seed: give --template, --template-file, --scenario or --object. Run with ' +
        '--help.\n',
    );
    process.exit(2);
  }
  if (
    scenario !== undefined &&
    (templateId !== undefined ||
      templateFile !== undefined ||
      rawObjects.length > 0 ||
      args.includes('--relation') ||
      args.includes('--record-type'))
  ) {
    // The pack says what to write, every row and its parent row.
    refuse(
      'Give --scenario alone: the scenario names its records and their links, so it goes with ' +
        'neither --template, --template-file, --object, --relation nor --record-type.',
    );
  }
  let scenarioSeed: number | undefined;
  if (args.includes('--scenario-seed')) {
    const raw = get('--scenario-seed');
    scenarioSeed = Number(raw);
    if (scenario === undefined) refuse('--scenario-seed goes with --scenario.');
    if (
      raw === undefined ||
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(scenarioSeed) ||
      scenarioSeed > MAX_SEED
    ) {
      refuse(`--scenario-seed takes a whole number from 0 to ${MAX_SEED}, not "${raw ?? ''}".`);
    }
  }
  if (
    templateFile !== undefined &&
    (templateId !== undefined || rawObjects.length > 0 || args.includes('--relation'))
  ) {
    // The file says what to write, and how its objects hang together.
    refuse(
      'Give --template-file alone: the file names its objects, their rules and their ' +
        'relations, so it goes with neither --template, --object nor --relation.',
    );
  }
  if (templateId && rawObjects.length > 0) {
    // Two answers to "what should this write" is one too many.
    process.stderr.write('Give --template or --object, not both.\n');
    process.exit(2);
  }
  const runId = get('--run-id');
  if (runId !== undefined && !ENV_RUN_ID_RE.test(runId)) {
    refuse(
      `--run-id takes "env-" then lowercase letters, digits and hyphens, 200 characters at ` +
        `most, not "${runId}".`,
    );
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
    // A template file's objects are read once the file is: checked there.
    if (
      templateFile === undefined &&
      !objects.some((object) => object.objectApiName === objectApiName)
    ) {
      refuse(`--record-type ${objectApiName}: give ${objectApiName} with --object too.`);
    }
    recordTypes[objectApiName] = [...new Set(names.split(','))];
  }
  const fit = fitOfArgs(args, refuse);
  // A checkpoint of what the run writes, taken before its first write; with
  // --dry-run, said and not taken.
  const checkpointFirst = checkpointFirstArgs(args);

  return {
    target,
    templateId,
    ...(templateFile !== undefined ? { templateFile } : {}),
    ...(scenario !== undefined ? { scenario } : {}),
    ...(scenarioSeed !== undefined ? { scenarioSeed } : {}),
    ...(runId !== undefined ? { runId } : {}),
    objects: countChildren(objects, relations, refuse),
    relations,
    batchSize,
    dryRun: args.includes('--dry-run'),
    json: args.includes('--json'),
    failOnPartial: args.includes('--fail-on-partial'),
    muteAutomation: args.includes('--mute-automation'),
    acceptEmails: args.includes('--accept-emails'),
    ...(seed !== undefined ? { seed } : {}),
    ...(locale !== undefined ? { locale } : {}),
    recordTypes,
    ...(fit ? { fit } : {}),
    ...(checkpointFirst !== undefined ? { checkpointFirst } : {}),
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

/** The issues of a refused template file said at most, the first ones. */
const TEMPLATE_ISSUES_SAID = 10;

/**
 * The seed template a file holds, as the panel's `seed:execute` takes one —
 * checked by the same schema (`seedTemplatePayloadSchema`), each issue said
 * with where it is — or why it cannot be run. What the schema lets a template
 * leave out is filled as the panel fills it: an object's batch size from the
 * line's (`--batch-size`), and an id, a version and dates for a file that
 * gives none.
 *
 * @param batchSize - What an object the file gives no batch size takes.
 */
export function readTemplateFile(
  path: string,
  batchSize: number,
): { template: SeedTemplate } | { refusal: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err: unknown) {
    return {
      refusal: `--template-file ${path} cannot be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err: unknown) {
    return {
      refusal: `--template-file ${path} is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = seedTemplatePayloadSchema.safeParse(raw);
  if (!parsed.success) {
    const { issues } = parsed.error;
    const said = issues
      .slice(0, TEMPLATE_ISSUES_SAID)
      .map((issue) => `  ${issue.path.join('.') || '(the template)'}: ${issue.message}`);
    const more = issues.length - said.length;
    return {
      refusal: [
        `--template-file ${path} is not a seed template the panel would run:`,
        ...said,
        ...(more > 0 ? [`  and ${more} more`] : []),
      ].join('\n'),
    };
  }
  const now = new Date().toISOString();
  const given = parsed.data as typeof parsed.data & Partial<SeedTemplate>;
  return {
    template: {
      ...given,
      id: typeof given.id === 'string' && given.id !== '' ? given.id : `cli-${Date.now()}`,
      version: typeof given.version === 'number' ? given.version : 1,
      createdAt: typeof given.createdAt === 'string' ? given.createdAt : now,
      updatedAt: typeof given.updatedAt === 'string' ? given.updatedAt : now,
      objects: parsed.data.objects.map((object) => ({
        ...object,
        batchSize: object.batchSize ?? batchSize,
      })),
    } as SeedTemplate,
  };
}

/**
 * Why a run cannot take the id `--run-id` gave it, or nothing: a run of that
 * id is kept already, in the folder the runs' files go in. A second run under
 * it would write on in the first one's file, and a removal by that id would
 * take back both runs' records as one.
 *
 * @param journalDir - The folder `SANDFORGE_JOURNAL_DIR` names.
 */
export function runIdRefusal(runId: string, journalDir: string): string | undefined {
  const kept = runFileOf(runId, journalDir, SEED_RUNS_DIR);
  return kept === undefined
    ? undefined
    : `--run-id ${runId}: a run of that id is kept already, in ${kept}. Give an id no run has.`;
}

/**
 * Why `--record-type` cannot give a template file's objects the record types
 * it names, or nothing: an object the file does not write, or one the file
 * gives a record type already, by a `RecordTypeId` rule — two answers to
 * which record type its records take. Checked once the file is read, before
 * any org is reached.
 */
export function templateRecordTypesRefusal(
  template: Pick<SeedTemplate, 'objects'>,
  recordTypes: Readonly<Record<string, readonly string[]>>,
): string | undefined {
  for (const objectApiName of Object.keys(recordTypes)) {
    const object = template.objects.find((o) => o.objectApiName === objectApiName);
    if (object === undefined) {
      return (
        `--record-type ${objectApiName}: the template file writes no ${objectApiName}; it writes ` +
        `${template.objects.map((o) => o.objectApiName).join(', ')}.`
      );
    }
    if (object.fieldRules.some((rule) => rule.fieldApiName === 'RecordTypeId')) {
      return (
        `--record-type ${objectApiName}: the template file gives ${objectApiName} its record ` +
        'type already, by a RecordTypeId rule: give it in one place.'
      );
    }
  }
  return undefined;
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
    case 'byKey':
      return 'each under the parent row its key names';
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
  readPresentParentIds?: SeedOrchestratorDependencies['readPresentParentIds'];
  describeKeyPrefix?: SeedOrchestratorDependencies['describeKeyPrefix'];
  describePicklistValues?: SeedOrchestratorDependencies['describePicklistValues'];
  describeFieldLengths?: SeedOrchestratorDependencies['describeFieldLengths'];
  describeRequiredFields?: SeedOrchestratorDependencies['describeRequiredFields'];
  objectAccess?: SeedOrchestratorDependencies['objectAccess'];
  seed: number;
  locale?: string;
  /** The run's Ctrl-C: the orchestrator stops before its next object, as at the panel's Cancel. */
  signal?: AbortSignal;
  /** Told the id each row of an object of rows became: a scenario's cases, for its tests. */
  onRowIds?: SeedOrchestratorDependencies['onRowIds'];
  /** What a scenario does once every object is written: its articles published and linked. */
  knowledge?: SeedOrchestratorDependencies['knowledge'];
}): SeedOrchestrator {
  return new SeedOrchestrator({
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.onRowIds ? { onRowIds: deps.onRowIds } : {}),
    ...(deps.knowledge ? { knowledge: deps.knowledge } : {}),
    validator: new SeedValidator(),
    readExistingParentIds: deps.readExistingParentIds,
    ...(deps.readPresentParentIds ? { readPresentParentIds: deps.readPresentParentIds } : {}),
    ...(deps.describeKeyPrefix ? { describeKeyPrefix: deps.describeKeyPrefix } : {}),
    describeCreateableFields: deps.describeCreateableFields,
    ...(deps.describeVisibleFields ? { describeVisibleFields: deps.describeVisibleFields } : {}),
    ...(deps.describePicklistValues ? { describePicklistValues: deps.describePicklistValues } : {}),
    ...(deps.describeFieldLengths ? { describeFieldLengths: deps.describeFieldLengths } : {}),
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

/**
 * What a dry run's `--json` summary says of its storage and API requests, as
 * the gate counted them before the first write would go: the bytes its
 * records take, the requests its writes make, each against what the target
 * has left, and the refusal a real run would meet. Exported so it can be
 * tested.
 */
export function dryRunGatesJson(
  template: Pick<SeedTemplate, 'objects'>,
  personObjects: readonly string[],
  gate: Awaited<ReturnType<typeof seedStorageGate>>,
): { storage: Record<string, unknown>; apiRequests: Record<string, unknown> } {
  return {
    storage: {
      bytes: seedStorageBytes(template, personObjects),
      ...gate.check,
      ...(gate.refusedFor === 'storage' ? { refusal: gate.refusal } : {}),
    },
    apiRequests: {
      ...gate.api,
      ...(gate.refusedFor === 'apiRequests' ? { refusal: gate.refusal } : {}),
    },
  };
}

/** What a fit leaves out of the room it keeps, as a line names it. */
function notCountedWords(entry: StorageRoomNotCounted): string {
  switch (entry.kind) {
    case 'trigger':
      return `what Apex trigger ${entry.name} on ${entry.objectApiName} creates`;
    case 'notRead':
      return `what "${entry.name}" on ${entry.objectApiName} creates: it was not read`;
    case 'share':
      return `the ${entry.name} rows the flows of ${entry.objectApiName} create`;
  }
}

/** A share, as a line says it: a percentage, rounded down to a tenth. */
function shareWords(share: number): string {
  return `${Math.floor(share * 1000) / 10} %`;
}

/**
 * What the run says of a fit before it writes: the share and what held it,
 * the budget and its terms, each object's records of the template's, what
 * the room left out, and what the fitted seed takes. `applied` for the fit
 * the run seeds; otherwise the counts --fit share would seed.
 *
 * @param words.roomUnread - Why no room was kept: the target's automation was not read.
 * @param words.muted - Whether the run's mute keeps some of that automation quiet.
 */
export function seedFitLines(
  fit: SeedFit,
  target: string,
  words: { applied: boolean; roomUnread?: string; muted?: boolean },
): string[] {
  const { proposal } = fit;
  const budget = proposal.budget;
  const head = words.applied ? 'fit' : '--fit share would seed';
  if (proposal.cannotFit !== undefined) {
    return [`${head}: the seed cannot be fitted: ${proposal.cannotFit}`];
  }
  if (fit.heldBy === 'whole') {
    return [
      `${head}: the seed fits as it is, ${fit.records} records, about ` +
        `${formatMB(proposal.estimateMB)} MB: nothing cut`,
    ];
  }
  const fits = formatMB(budget.budgetMB + budget.automationMB);
  const held =
    fit.heldBy === 'apiRequests'
      ? `the largest whose writes leave ${target} a tenth of its daily API requests`
      : fit.heldBy === 'within'
        ? `the largest that fits the ${budget.withinMB ?? fits} MB asked (--fit-within)`
        : `the largest that fits ${fits} MB: ${budget.share * 100} % of the ${budget.remainingMB} MB ` +
          `${target} says it has left of ${budget.maxMB}, ${budget.roundingMB} MB kept first for ` +
          'the rounding of what it says';
  const room =
    words.roomUnread !== undefined
      ? `no room kept for what its automation creates: it could not be read (${words.roomUnread})`
      : budget.automationMB > 0
        ? `${formatMB(budget.automationMB)} MB of it kept for what its flows still running create ` +
          'under these records'
        : 'nothing kept for its flows: none still running creates records under these' +
          (words.muted ? ' (--mute-automation keeps the others quiet)' : '');
  const width = Math.max(...proposal.objects.map((o) => o.objectApiName.length));
  return [
    fit.heldBy === 'caps'
      ? `${head}: the caps asked, within the ${fits} MB that fit; ${room}`
      : `${head}: share ${shareWords(proposal.share)}, ${held}; ${room}`,
    ...proposal.objects.map(
      (o) =>
        `  ${o.objectApiName.padEnd(width)}  ${o.after} of ${o.before}` +
        (o.keptWhole === 'rows'
          ? '  (kept whole: the rows the template gives)'
          : o.keptWhole === 'byKey'
            ? '  (kept whole: each under the parent row its key names)'
            : ''),
    ),
    ...(budget.notCounted ?? []).map((entry) => `  not counted: ${notCountedWords(entry)}`),
    `  fitted seed: ${fit.records} records, about ${formatMB(proposal.estimateMB)} MB` +
      (budget.automationMB > 0 ? ' with what its flows create under them' : '') +
      `, ${fit.requests} API requests`,
    `  ${target} counts a load in what it says it has left up to ${STORAGE_RECOUNT_SECONDS} ` +
      'seconds after it: a run started sooner after another may read room it no longer has',
  ];
}

/**
 * What the summary's JSON says of a fit: the proposal, what held it, the
 * records and requests it comes to, what was asked, and whether the run
 * seeded it (`applied`) or a dry run past the storage or the requests only
 * proposes it. Exported so it can be tested.
 */
export function fitJson(
  fit: SeedFit,
  applied: boolean,
  asked: CliFit | undefined,
): Record<string, unknown> {
  return {
    applied,
    ...fit.proposal,
    heldBy: fit.heldBy,
    records: fit.records,
    requests: fit.requests,
    ...(asked?.caps ? { caps: asked.caps } : {}),
    ...(asked?.withinMB !== undefined ? { withinMB: asked.withinMB } : {}),
  };
}

/** Run one seed from the given command line; exported so its parsing can be tested. */
export async function main(argv: string[] = process.argv): Promise<void> {
  if (argv.slice(2).includes('--remove')) return removeMain(argv);
  if (argv.slice(2).includes('--test-file')) {
    if (argv.slice(2).includes('--help') || argv.slice(2).includes('-h')) parseArgs(argv);
    return testFileMain(argv, testFileTarget, journalDirOf());
  }
  const t0 = Date.now();
  const args = parseArgs(argv);
  // The scenario is read before any org is reached: a pack that does not
  // hold is a bad line, as a template file is.
  let scenarioPack: ScenarioPack | undefined;
  if (args.scenario !== undefined) {
    const named = scenarioPackOf(args.scenario);
    if ('refusal' in named) {
      process.stderr.write(`${named.refusal}\n`);
      process.exit(2);
    }
    scenarioPack = named.pack;
  }
  // The template file and the run id are checked before any org is reached:
  // a file that does not hold, or an id another run keeps, is a bad line.
  let fileTemplate: SeedTemplate | undefined;
  if (args.templateFile !== undefined) {
    const read = readTemplateFile(args.templateFile, args.batchSize);
    if ('refusal' in read) {
      process.stderr.write(`${read.refusal}\n`);
      process.exit(2);
    }
    fileTemplate = read.template;
    const refusal = templateRecordTypesRefusal(fileTemplate, args.recordTypes);
    if (refusal !== undefined) {
      process.stderr.write(`${refusal}\n`);
      process.exit(2);
    }
  }
  const takenRunId =
    args.runId !== undefined ? runIdRefusal(args.runId, journalDirOf()) : undefined;
  if (takenRunId !== undefined) {
    process.stderr.write(`${takenRunId}\n`);
    process.exit(2);
  }
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
  const session = await loadOrg(args.target);
  const conn = makeConn(session);
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
  let template = fileTemplate ?? prebuiltTemplate(args.templateId);
  /** The scenario compiled for the target, once read of it. */
  let scenario:
    Extract<Awaited<ReturnType<typeof scenarioForTarget>>, { compiled: unknown }> | undefined;
  if (scenarioPack !== undefined) {
    const compiled = await scenarioForTarget(
      {
        query: async (soql) => (await conn.query<Record<string, unknown>>(soql)).records,
        objectAccess: seedObjectAccess(conn),
        describe: (objectApiName) => conn.sobject(objectApiName).describe(),
      },
      scenarioPack,
      args.scenarioSeed,
    );
    if ('issues' in compiled) {
      process.stderr.write(`The scenario cannot be compiled: ${compiled.issues.join('; ')}\n`);
      process.exit(2);
    }
    scenario = compiled;
    template = compiled.compiled.template;
    for (const line of scenarioPlanLines(scenarioPack, compiled.preparation)) log(line);
  }
  for (const relation of args.relations) {
    const parents =
      relation.parents.kind === 'generated'
        ? `the ${relation.parentObject} records this run writes`
        : relation.parents.kind === 'records'
          ? `the ${relation.parents.ids.length} ${relation.parentObject} records named by id`
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
  // The record types --record-type gives a template file's objects, by API
  // name, as it gives an --object's: a rule each, read off the object's
  // describe, before the accounts' kind is told from them below. An
  // environment's file names record types by DeveloperName, the one name
  // every org gives a record type alike; their Ids are the org's own.
  if (fileTemplate !== undefined && Object.keys(args.recordTypes).length > 0) {
    const objects: SeedTemplate['objects'] = [];
    for (const object of fileTemplate.objects) {
      const chosen = args.recordTypes[object.objectApiName];
      if (!chosen) {
        objects.push(object);
        continue;
      }
      const described = await conn.sobject(object.objectApiName).describe();
      const typed = recordTypeRule(object.objectApiName, chosen, described.recordTypeInfos);
      if ('refusal' in typed) {
        process.stderr.write(`${typed.refusal}\n`);
        process.exit(2);
      }
      objects.push({ ...object, fieldRules: [...object.fieldRules, typed.rule] });
    }
    fileTemplate = { ...fileTemplate, objects };
    template = fileTemplate;
  }
  // Accounts a template file gives a person account's record type are
  // person accounts, as the panel writes the template it is sent: without
  // Name, with a person's fields, and refused when the types mix the kinds.
  if (fileTemplate?.objects.some((object) => object.objectApiName === ACCOUNT)) {
    const kinds = templateForAccountKinds(fileTemplate, await personRecordTypes(conn));
    if ('refusal' in kinds) {
      process.stderr.write(`${kinds.refusal}\n`);
      process.exit(2);
    }
    template = kinds.template;
    personObjects.push(...kinds.personObjects);
    for (const objectApiName of kinds.personObjects) {
      const line =
        `  ${objectApiName}: the template gives it person account record types: the ` +
        'accounts are written as person accounts, without Name, which the org builds from ' +
        'the two names';
      log(line);
      notes.push(line.trim());
    }
  }
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

  // An object --fit-cap names is one the seed writes: a cap on another is a
  // bad line, as a --record-type is.
  for (const objectApiName of Object.keys(args.fit?.caps?.objects ?? {})) {
    if (!template.objects.some((object) => object.objectApiName === objectApiName)) {
      process.stderr.write(`--fit-cap ${objectApiName}: the seed writes no ${objectApiName}.\n`);
      process.exit(2);
    }
  }
  // What the target runs on the objects the seed writes, read once and
  // first, as the panel reads it: the mute is planned from it, the emails
  // counted from it, and the room its flows take under the records from what
  // of it still runs, before the storage is held against what they take.
  const read: ForgeTargetAutomation | { unread: string } = await targetAutomationReader(conn)
    .read(
      args.target,
      template.objects.map((object) => object.objectApiName),
    )
    .catch((err: unknown) => ({ unread: err instanceof Error ? err.message : String(err) }));
  // Asked to mute, the run plans it from that read before it counts the
  // emails, which then leave out what the mute keeps quiet. Refused on a
  // production org or for a user who cannot assign, a real run writes
  // nothing; a dry run says so, and assigns nothing.
  const writes = seedWritesOf(template, scenario !== undefined);
  /**
   * Refuse a real run before its first write, as Sync refuses one: its line
   * names the code, and with --json the summary on stdout carries it, where a
   * CI job reads `.refused.code`. Refused for its storage, its checkpoint or
   * its mute, a seed said a sentence on stderr and left stdout empty.
   */
  const refuse = (refused: RunRefusal): never => {
    if (args.json) {
      process.stdout.write(
        refusedSummary(
          { tool: 'sandforge-seed', target: args.target, elapsedMs: Date.now() - t0 },
          refused,
        ),
      );
    }
    throw new Error(refusedLine(refused));
  };
  let mute: RunMute | undefined;
  /** Why a dry run's mute would be refused, said with the rest of its refusals. */
  let muteRefused: RunRefusal | undefined;
  if (args.muteAutomation) {
    try {
      mute = await muteForRun(async () => muteOrgOf(conn), read, { writes });
      for (const line of muteLines(mute.muted, args.target)) log(`  ${line}`);
    } catch (err: unknown) {
      if (!isMuteRefusedError(err)) throw err;
      if (!args.dryRun) refuse(err.refusal);
      muteRefused = err.refusal;
      log(`  ${wouldBeRefusedLine(err.refusal)}`);
    }
  }
  // What still runs of it once the mute's plan holds, nothing assigned, and
  // the room what it creates takes under the records: what a fit keeps.
  const room = seedRoomOf(read, mute?.plan, writes);
  const fitWords = {
    ...(room.unread !== undefined ? { roomUnread: room.unread } : {}),
    muted: (mute?.plan?.assign.length ?? 0) > 0,
  };

  const runId = args.runId ?? `sandforge-seed-${randomUUID()}`;
  // The checkpoint the run takes of what it writes before its first write:
  // scoped here from the objects the seed creates and what still runs as it
  // creates them, the mute's plan holding, no record read, its requests
  // counted with the seed's; taken once every gate let the seed through and
  // before the mute's lease; kept or deleted as the run ends. A dry run says
  // what it would hold and cost, and takes nothing. It reads the target
  // through a connection of its own: the run's calls stay the run's.
  const checkpoints = args.checkpointFirst
    ? commandCheckpoints({
        module: 'seed',
        operationId: runId,
        request: args.checkpointFirst,
        session,
        org: checkpointOrgOf(session, typedTarget ?? (await typeTarget(conn))),
        connect: makeConn,
        journalDir: journalDirOf(),
        say: log,
        own: { runId },
      })
    : undefined;
  /** The checkpoint as it was asked, and what it would hold and cost. */
  let checkpointPlanned: { ask: CommandCheckpointAsk; estimate: RunCheckpointEstimate } | undefined;
  /** Why a real run would be refused for its checkpoint, of a dry run. */
  const checkpointRefusals: RunRefusal[] = [];
  /** Refuse a real run for its checkpoint, nothing written; a dry run says it would be. */
  const refuseForCheckpoint = (refusal: string): void => {
    const refused = { code: CHECKPOINT_REFUSED, message: refusal };
    if (!args.dryRun) refuse(refused);
    checkpointRefusals.push(refused);
    log(`  ${wouldBeRefusedLine(refused)}`);
  };
  const writing = template.objects.filter((object) => object.recordCount > 0);
  if (checkpoints && writing.length > 0) {
    const ask: CommandCheckpointAsk = {
      written: writing.map((object) => object.objectApiName),
      running: room.running ?? { firing: [] },
    };
    try {
      checkpointPlanned = { ask, estimate: await checkpoints.scope(ask) };
    } catch (err: unknown) {
      refuseForCheckpoint(beforeRunFailedWords(err));
    }
  }

  // Whether the target delivers the emails of what still runs, read once the
  // mute's plan says what does and only when something may send one, as the
  // user the run writes as, before the gates count its requests. A seed
  // writes the addresses its template holds, those the faker draws on
  // reserved domains, none under .invalid. No Apex runs in a production org,
  // which a dry run reads: it is typed for it here.
  const emails = await runEmailsOf({
    read,
    ...(mute?.plan ? { plan: mute.plan } : {}),
    writes,
    readDeliverability: async () =>
      isProductionTarget(typedTarget ?? (await typeTarget(conn)))
        ? NO_APEX_IN_PRODUCTION
        : readEmailDeliverability(conn),
    accepted: args.acceptEmails === true,
    target: args.target,
    run: 'seed',
    keepsAddresses: true,
    mayMute: args.muteAutomation !== true,
  });
  const deliverabilityRequests = deliverabilityPartOf(emails.ofRun);

  // The data storage the records take against what the target has left,
  // before the first write, as the panel holds a seed: a dry run says what a
  // real run would meet, and a real run past it writes nothing.
  const objectAccess = seedObjectAccess(conn);
  // What it counts: an optional object the org does not take is skipped by the run.
  let taken = await templateTheOrgTakes(template, objectAccess);
  let storage = await seedStorageGate(
    conn,
    taken,
    personObjects,
    args.target,
    checkpointPlanned?.estimate,
    deliverabilityRequests,
  );
  /** The fit asked, or the one a refusal for the storage or the requests proposes. */
  let fit: { applied: boolean; fit: SeedFit } | undefined;
  /** Why a real run would be refused for its fit, of a dry run. */
  let fitRefused: RunRefusal | undefined;
  /** Refuse a real run for its fit, under its code; a dry run says it would be. */
  const refuseForFit = (refused: RunRefusal): void => {
    if (!args.dryRun) refuse(refused);
    fitRefused = refused;
    log(`  ${wouldBeRefusedLine(refused)}`);
  };
  // Refused for its checkpoint, there is nothing to fit: no smaller seed
  // answers it.
  if (args.fit && storage.refusedFor !== 'checkpoint' && checkpointRefusals.length === 0) {
    const budget = seedFitBudgetOf(storage, args.fit.withinMB);
    if ('unread' in budget) {
      refuseForFit({
        code: SEED_FIT_STORAGE_UNREAD,
        message:
          `The seed was refused before it wrote anything: it cannot be fitted to ${args.target}, ` +
          `whose data storage left could not be read (${budget.unread}). Nothing was written.`,
      });
    } else {
      const fitted = fitSeedTemplate({
        template: taken,
        personObjects,
        budget,
        room: room.room,
        ask: args.fit,
      });
      fit = { applied: true, fit: fitted };
      for (const line of seedFitLines(fitted, args.target, { applied: true, ...fitWords })) {
        log(line);
      }
      if (fitted.proposal.cannotFit !== undefined) {
        refuseForFit({
          code: SEED_CANNOT_FIT,
          message:
            'The seed was refused before it wrote anything: it cannot be fitted to ' +
            `${args.target}: ${fitted.proposal.cannotFit}. Nothing was written.`,
        });
      } else if (fitted.heldBy !== 'whole') {
        // The counts fitted, the gate is met again by them, its /limits read
        // again: a fit is never a pass, and an org that lost room since
        // refuses the seed again. Caps that fit are counts fitted too.
        template = fittedTemplate(template, fitted.proposal);
        taken = fittedTemplate(taken, fitted.proposal);
        storage = await seedStorageGate(
          conn,
          taken,
          personObjects,
          args.target,
          checkpointPlanned?.estimate,
          deliverabilityRequests,
        );
      }
    }
  }
  log(storageLine(storage.check, args.target));
  /** Why a real run would be refused for its storage or its requests, of a dry run. */
  let storageRefused: RunRefusal | undefined;
  if (checkpointPlanned) {
    for (const line of checkpointEstimateLines(checkpointPlanned.estimate)) log(line);
  }
  if (storage.refusedFor === 'checkpoint') {
    // The take's refusal in the command's words, its flags for the panel's box.
    refuseForCheckpoint(
      checkpointStopWords({
        code: CHECKPOINT_REFUSED,
        message: storage.refusal ?? '',
        ...(storage.checkpointRefusal ? { refusal: storage.checkpointRefusal } : {}),
      }),
    );
  } else if (storage.refusal) {
    // Unasked, what --fit share would seed: computed from what was read.
    if (!args.fit) {
      const budget = seedFitBudgetOf(storage);
      if (!('unread' in budget)) {
        const proposed = fitSeedTemplate({
          template: taken,
          personObjects,
          budget,
          room: room.room,
        });
        fit = { applied: false, fit: proposed };
        for (const line of seedFitLines(proposed, args.target, { applied: false, ...fitWords })) {
          log(`  ${line}`);
        }
      }
    }
    storageRefused = {
      code: storage.refusedFor === 'apiRequests' ? API_BUDGET_EXCEEDED : SEED_STORAGE_EXCEEDED,
      message: storage.refusal,
    };
    if (!args.dryRun) refuse(storageRefused);
    log(`  ${wouldBeRefusedLine(storageRefused)}`);
  }
  // What the target runs as these records are created, and the emails they
  // make it send, before the first write: a seed of 75 contacts left a
  // Developer Edition at -60 of its 15 single emails a day. A run that mutes
  // counts what still runs, what its mute keeps quiet held quiet.
  const automation = await seedAutomationCheck({
    target: args.target,
    objects: template.objects,
    readAutomation: async () => {
      const given = mute?.automation ?? read;
      if (typeof given.unread === 'string') throw new Error(given.unread);
      return given as ForgeTargetAutomation;
    },
    readLimits: () => readEmailLimits(conn),
  });
  for (const line of automation.lines) log(line);
  if (emails.gate.line !== undefined) log(`  ${emails.gate.line}`);
  const emailsExceeded =
    automation.gate.refusal !== undefined
      ? { code: SEED_EMAILS_EXCEEDED, message: automation.gate.refusal }
      : undefined;
  if (emailsExceeded) {
    if (!args.dryRun) refuse(emailsExceeded);
    log(`  ${wouldBeRefusedLine(emailsExceeded)}`);
  }
  // The flag the answer a question would have had; `--accept-automation`,
  // which a seed's line does not take, never stands for it.
  const emailsStop = emails.gate.stop;
  if (emailsStop) {
    if (!args.dryRun) refuse(emailsStop);
    log(`  ${wouldBeRefusedLine(emailsStop)}`);
  }
  log(`template: ${templateDisplayName(template)} (${template.objects.length} object(s))`);

  // What the run creates, kept as it writes it in its file, as the panel's
  // Seed keeps its runs (`SeedRunCreations`): the command kept it in memory,
  // printed once the run returned, and a run killed by its CI job's timeout,
  // out of memory or ended by an error left its records in the org with
  // nothing --remove could read. Ids and dates only.
  const runs = args.dryRun ? undefined : nodeSeedRunCreations(journalDirOf());
  const kept = runs?.recorder({
    runId,
    targetOrgId: args.target,
    startedAt,
    ...(typedTarget ? { targetOrganizationId: typedTarget.id } : {}),
  });
  // Who the run writes as, for the sweep of its removal: its file takes it
  // whenever the org says, and nothing waits for it, not even the end of the
  // process, which goes as `main` returns.
  keepRunUser(kept, () => conn.identity(), 'sandforge-seed');
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
  /**
   * Whether the seed sent a record to the org: the checkpoint it took first
   * is kept once it did, whatever became of the run after, and deleted when
   * it never did.
   */
  let wrote = false;
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
      // Answered record by record, as the REST path answers: rows placed by
      // key under these are then planned as the run places them.
      const ids = records.map((_, i) => `dry-${i}`);
      return { successIds: ids, errors: [], rows: ids.map((id) => ({ id })) };
    }
    if (records.length > 0) wrote = true;
    const answer = await write(orgId, objectApiName, records, batchSize);
    kept?.note(objectApiName, answer.successIds);
    log(
      `  ${objectApiName}: ${answer.successIds.length} written, ${answer.errors.length} refused` +
        (answer.stopped ? ', stopped' : ''),
    );
    return answer;
  };

  const described = describedFieldsOf((objectApiName) => conn.sobject(objectApiName).describe());
  /** The id each case of a scenario became, by its row key. */
  const caseIds: Record<string, string> = {};

  const orchestrator = seedOrchestrator({
    // A relation reads its parents from the org when told to, dry run or not:
    // a read writes nothing.
    readExistingParentIds: (objectApiName, where, limit) =>
      readExistingParentIds(conn, objectApiName, where, limit),
    // Parents named by id are checked before the first write, dry run or not.
    readPresentParentIds: (objectApiName, ids) => readPresentParentIds(conn, objectApiName, ids),
    describeKeyPrefix: described.keyPrefix,
    describeCreateableFields: described.createable,
    describeVisibleFields: described.visible,
    describePicklistValues: described.picklistValues,
    describeFieldLengths: described.lengths,
    describeRequiredFields: async (objectApiName) =>
      (await described.required(objectApiName)).filter(
        (field) =>
          !leftOutForAccountKind(
            objectApiName,
            field.fieldApiName,
            personObjects.includes(objectApiName) ? 'person' : 'business',
          ),
      ),
    objectAccess,
    insert,
    seed,
    locale,
    signal: stop.signal,
    // A scenario's tests know its cases by key: the id each became is kept
    // beside the run's file for --test-file.
    ...(scenario
      ? {
          onRowIds: (objectApiName: string, ids: Readonly<Record<string, string>>) => {
            if (objectApiName === 'Case') Object.assign(caseIds, ids);
          },
        }
      : {}),
    // Its articles published once every object is written, and each closed
    // case linked to the article of its topic, as the panel's run does, each
    // call kept in the run's file. Never on a dry run: its ids are no org's,
    // and a publication is a write.
    ...(scenario && !args.dryRun
      ? {
          knowledge: seedKnowledge({
            org: conn as unknown as KnowledgeOrg,
            plan: { publish: true, links: scenario.compiled.closedCaseArticles },
            ...(kept ? { journal: kept } : {}),
            signal: stop.signal,
          }),
        }
      : {}),
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
  /** What the run muted of the target's automation, once it ended. */
  let mutedAutomation: MutedAutomation | undefined = mute?.muted;
  /** The checkpoint the run took before its first write, once taken. */
  let checkpointTaken: RunCheckpointTaken | undefined;
  /** What became of it once the run ended: kept, or deleted for a run that wrote nothing. */
  let checkpointInfo: RunCheckpointInfo | undefined;
  /** Keep it once the seed sent a record, whatever became of the run after; delete it otherwise. */
  const settleCheckpoint = async (): Promise<void> => {
    if (!checkpoints || !checkpointTaken || checkpointInfo) return;
    checkpointInfo = await settleCommandCheckpoint(
      checkpoints,
      checkpointTaken,
      wrote,
      args.target,
      log,
    );
  };
  try {
    // The checkpoint asked first is taken once every gate let the seed
    // through, the flag the answer a question would have had, and before the
    // lease: the bypass is held for the writes alone. Ctrl-C stops it between
    // two reads, keeping nothing.
    if (!args.dryRun && checkpoints && checkpointPlanned) {
      const planned = checkpointPlanned;
      const took = await takeCheckpointFirst(() =>
        checkpoints.take(planned.ask, planned.estimate, { signal: stop.signal }),
      );
      if ('stop' in took) {
        if (took.stop.code === CHECKPOINT_REFUSED) {
          refuse({ code: CHECKPOINT_REFUSED, message: checkpointStopWords(took.stop) });
        }
        process.stderr.write(`${checkpointStopWords(took.stop)}\n`);
        endWith(stopExitCode(stoppedBy ?? 'SIGINT'));
        return;
      }
      checkpointTaken = took.checkpoint;
      // Named in the run's file, for its history to offer a rewind to before it.
      kept?.checkpoint?.(took.checkpoint);
      for (const line of checkpointTakenLines(
        took.checkpoint,
        args.target,
        args.muteAutomation === true,
      )) {
        log(line);
      }
    }
    // The lease is taken before the first write and given back as the run
    // ends, written, failed, stopped or thrown alike.
    const held =
      !args.dryRun && mute?.prepared
        ? await mute.prepared.acquire(runId).catch((err: unknown) => {
            if (!isMuteRefusedError(err)) throw err;
            return refuse(err.refusal);
          })
        : undefined;
    if (held) mutedAutomation = held.outcome;
    // A set the lease does not hold leaves running what it was to keep quiet:
    // a sender of it the run was not refused for refuses it now, the lease
    // given back and nothing written.
    const relit = held ? emails.afterLease(held.outcome, args.acceptEmails === true) : undefined;
    if (held && relit) {
      mutedAutomation = await held.release();
      for (const line of muteLines(mutedAutomation, args.target)) log(line);
      refuse(relit);
    }
    result = await orchestrator.execute(template, args.target, runId).finally(async () => {
      if (held) {
        mutedAutomation = await held.release();
        for (const line of muteLines(mutedAutomation, args.target)) log(line);
      }
    });
    if (mutedAutomation && !args.dryRun) result = { ...result, mutedAutomation };
    await settleCheckpoint();
  } catch (err: unknown) {
    // What it inserted before it threw stays removable, the run ended failed.
    await kept
      ?.end({ status: 'failure', finishedAt: new Date().toISOString(), objectResults: [] })
      .catch(keepFailed);
    // Its checkpoint kept once it sent a record, deleted when it sent none:
    // its lease refused after the take among them.
    await settleCheckpoint();
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
  // A scenario's companion beside the run's file, once that is kept: the
  // ids of its open cases by key, which --test-file writes the tests from.
  const scenarioKept =
    scenario && scenarioPack && keptInFile !== undefined
      ? await keepScenarioRun({
          journalDir: journalDirOf(),
          runId,
          pack: scenarioPack,
          compiled: scenario.compiled,
          options: scenario.options,
          caseIds,
        })
      : undefined;
  /** Whether the target has an agent to write the tests for, said once a scenario wrote its cases. */
  const agents =
    scenarioKept?.companion !== undefined
      ? await readAgentCatalog(toolingQueryAll(toolingOf(conn))).catch(() => undefined)
      : undefined;
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

  /** The checkpoint as the summary gives it: the dry run's estimate, the run's checkpoint. */
  const checkpointSaid = args.dryRun ? checkpointPlanned?.estimate : checkpointInfo;
  /** What a real run's records would be refused for, for their emails: past the day's, or delivered. */
  const emailRefusalSaid = automation.gate.refusal ?? emailsStop?.message;
  /**
   * What a dry run says a real run would be refused for, as an environment's
   * plan reads it, every refusal of the gate among them, as Sync's: its
   * storage and its API requests were said under `storage.refusal` and
   * `apiRequests.refusal` alone, and a pipeline reading `wouldBeRefused` took
   * a seed past them for one that would write. Each with the code a real
   * run is refused with: the words alone, a pipeline could not tell them apart.
   */
  const wouldBeRefused: RunRefusal[] = [
    ...(muteRefused !== undefined ? [muteRefused] : []),
    ...checkpointRefusals,
    ...(fitRefused !== undefined ? [fitRefused] : []),
    ...(storageRefused !== undefined ? [storageRefused] : []),
    ...(emailsExceeded !== undefined ? [emailsExceeded] : []),
    ...(emailsStop ? [emailsStop] : []),
  ];

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
            ...(emailRefusalSaid !== undefined ? { refusal: emailRefusalSaid } : {}),
            ...(automation.gate.unknown ? { unknown: automation.gate.unknown } : {}),
            // What still runs that may send them, and whether the org
            // delivers them: read only when something may.
            ...(emails.gate.deliverability ? { deliverability: emails.gate.deliverability } : {}),
          },
          // What a dry run's gates counted, for whoever sums them across
          // runs: an environment holds several seeds to one day's storage
          // and requests, which each seed alone fits. Of what the gates counted:
          // an optional object the org takes no record of is no storage of it.
          ...(args.dryRun ? dryRunGatesJson(taken, personObjects, storage) : {}),
          // The fit the run seeded, or, a dry run past the storage or the
          // requests, the counts --fit share would seed: the counts to write
          // in an environment's file, which is never fitted for it.
          ...(fit ? { fit: fitJson(fit.fit, fit.applied, args.fit) } : {}),
          // What a real run's mute would assign, silence, leave running and
          // lift beside, as the dry run's lines say it.
          ...(args.dryRun ? dryRunMuteOf(mute) : {}),
          // The checkpoint it took of what it writes before its first write
          // (--checkpoint-first): kept, or deleted once it wrote nothing; of
          // a dry run, what a real run's would hold and cost, and its refusal.
          ...(checkpointSaid ? { checkpoint: checkpointSaid } : {}),
          ...wouldBeRefusedJson(wouldBeRefused),
          result,
          // The run's file, which --remove takes it back from too.
          ...(keptInFile ? { runFile: keptInFile } : {}),
          // A scenario's: what its tests are and where their cases' ids are kept.
          ...(scenario && scenarioPack
            ? {
                scenario: {
                  packId: scenarioPack.id,
                  options: scenario.options,
                  tests: scenario.compiled.tests.length,
                  ...(scenarioKept ?? {}),
                  ...(agents?.kind === 'no-agent' ? { agents: 'none' } : {}),
                },
              }
            : {}),
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
  for (const line of scenarioKnowledgeLines(result.knowledge)) log(line);
  log(`seed: ${seed}`);
  if (!args.dryRun && created > 0) {
    log(
      `\ncreated ${created} record(s) in ${args.target}: ` +
        (keptInFile !== undefined
          ? `--remove ${keptInFile} takes them back`
          : 'run with --json and save the summary to a file, and --remove takes them back from it'),
    );
  }
  if (scenarioPack && scenarioKept && keptInFile !== undefined) {
    for (const line of scenarioKeptLines(
      scenarioKept,
      agents,
      keptInFile,
      args.target,
      scenarioPack,
    )) {
      log(line);
    }
  }
  if (interrupted) {
    process.stderr.write(`${seedInterruptedLine(keptInFile)}\n`);
    return;
  }
  log(`\ndone in ${elapsedMs}ms`);
}

/** A connection's Tooling API query and its next pages, as an agent's catalog is read through. */
function toolingOf(conn: ReturnType<typeof makeConn>): ToolingQueries {
  return {
    query: async (soql) => conn.tooling.query<Record<string, unknown>>(soql),
    queryMore: async (url) => conn.tooling.queryMore<Record<string, unknown>>(url),
  };
}

/** The org `--test-file` reads the agents of, by its alias. */
async function testFileTarget(alias: string): Promise<TestFileTarget> {
  const conn = makeConn(await loadOrg(alias));
  return { tooling: toolingOf(conn), organizationId: () => organizationIdOf(conn) };
}

/**
 * What a scenario's run kept for its test file, as the summary says it: the
 * command that writes the file, or why none can be written yet. Exported so
 * it can be tested.
 */
export function scenarioKeptLines(
  kept: ScenarioRunKept,
  agents: AgentCatalogRead | undefined,
  runFile: string,
  target: string,
  pack: ScenarioPack,
): string[] {
  const head = `\nscenario ${kept.packId}: ${kept.openCasesWritten} of its ${kept.openCases} open case(s) written, which its ${kept.tests} test(s) are about`;
  if (kept.unkept !== undefined) {
    return [
      head,
      `  the ids of its cases could not be kept (${kept.unkept}): no test file can be written from this run`,
    ];
  }
  if (kept.companion === undefined) {
    return [head, '  no open case was written: no test file can be written from this run'];
  }
  if (agents?.kind === 'no-agent')
    return [head, `  ${agents.message}`, `  ${testFileCommand(runFile, target, pack)}`];
  return [
    head,
    '  the test file is written from this run, never deployed nor run:',
    `  ${testFileCommand(runFile, target, pack)}`,
  ];
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

/** What `--remove` was given; `--sweep-late` and `--sweep-untied` among it, with `--sweep`. */
export interface RemoveArgs extends SweepClassArgs {
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
  /** Mute the target's automation for the removal, through its own bypass (`--mute-automation`). */
  muteAutomation: boolean;
  /** Say what the removal would do, and do nothing. Absent unless given. */
  preview?: true;
}

/** The flags a removal reads. */
const REMOVE_FLAGS: ReadonlySet<string> = new Set([
  '--remove',
  '--target',
  '--preview',
  '--include-changed',
  '--accept-automation',
  '--mute-automation',
  '--sweep',
  '--sweep-list',
  ...SWEEP_CLASS_FLAGS,
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
    if (arg === '--dry-run') {
      // A removal that ignored it would delete for real: the word for a
      // removal that writes nothing is --preview.
      process.stderr.write(
        '--remove does not take --dry-run: a removal that did not read it would delete for ' +
          'real. --preview says what the removal would do, and writes nothing. Run with --help.\n',
      );
      process.exit(2);
    }
    if (!REMOVE_FLAGS.has(arg)) {
      process.stderr.write(
        `--remove takes --target, --preview, --include-changed, --accept-automation, ` +
          `--mute-automation, --sweep, --sweep-late, --sweep-untied, --sweep-list, ` +
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
  // With --sweep, a preview reads what the sweep would take, as the removal
  // reads it before asking, and deletes nothing.
  if (args.includes('--preview') && args.includes('--sweep-list')) {
    process.stderr.write(
      '--preview writes nothing, and --sweep-list lists what a sweep would take: give ' +
        '--preview without it, or with --sweep. Run with --help.\n',
    );
    process.exit(2);
  }
  const classes = sweepClassArgsOf(args);
  if ('refusal' in classes) {
    process.stderr.write(`${classes.refusal} Run with --help.\n`);
    process.exit(2);
  }
  return {
    summaryPath,
    target,
    includeChanged: args.includes('--include-changed'),
    sweep: args.includes('--sweep'),
    sweepList: args.includes('--sweep-list'),
    ...classes,
    json: args.includes('--json'),
    leaveUndeletable: args.includes('--leave-undeletable'),
    acceptAutomation: args.includes('--accept-automation'),
    muteAutomation: args.includes('--mute-automation'),
    ...(args.includes('--preview') ? { preview: true as const } : {}),
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
  const refused = refusalOfSummary(raw, 'sandforge-seed');
  if (refused) return { refusal: refusedSummaryWords(refused) };
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
  /** The user it wrote as, when its summary or its file keeps it. */
  runUserId?: string;
  /** What its mute kept quiet and what still ran, when its summary says it. */
  muted?: z.infer<typeof runMuteSchema>;
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
    // The user the run wrote as, where its file keeps it (`SyncRunKept.runUserId`).
    ...runUserOfRun(run),
  };
}

/** The user a run's file keeps it wrote as, when it keeps one that reads as an id. */
function runUserOfRun(run: SyncRunKept): Pick<RemovalSubject, 'runUserId'> {
  const runUserId = runUserIdOf(run.runUserId);
  return runUserId ? { runUserId } : {};
}

/**
 * What a run's summary keeps beside its records that its removal's sweep is
 * told: the user it wrote as, and what its mute kept quiet and what still
 * ran, in its result. What does not read is left out.
 */
function sweptOfSummary(
  result: Record<string, unknown>,
): Pick<RemovalSubject, 'runUserId' | 'muted'> {
  const runUserId = runUserIdOf(result['runUserId']);
  const muted = runMuteSchema.safeParse(result['mutedAutomation']);
  return { ...(runUserId ? { runUserId } : {}), ...(muted.success ? { muted: muted.data } : {}) };
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
    ...sweptOfSummary(summary.result),
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
 * What a sweep of a run's removal is told: the run's records read back for
 * its window, and what the target's flows create; and what tells the records
 * tied to the run from the rest of what its user created in its window — the
 * other runs of this machine that wrote to the org meanwhile, its mute, when
 * its first removal began, what its earlier sweeps found made for it, and
 * made late. Read for a sweep, its listing, and a preview asked with one.
 */
async function seedRemovalSweepInput(
  conn: ReturnType<typeof makeConn>,
  target: string,
  organizationId: string,
  run: SyncRunKept,
  subject: Pick<RemovalSubject, 'earlier' | 'muted' | 'runUserId'>,
  signal?: AbortSignal,
): Promise<SweepInput> {
  const { earlier } = subject;
  let automation: ForgeTargetAutomation | { error: string };
  try {
    automation = await targetAutomationReader(conn).read(
      target,
      run.created.map((object) => object.objectApiName),
    );
  } catch (err: unknown) {
    automation = { error: err instanceof Error ? err.message : String(err) };
  }
  const ties = commandSweepTies({
    otherRuns: await otherRunsOf({
      organizationId,
      alias: target,
      span: syncRunSpanOf(run),
      own: { runId: run.runId, ids: run.created.flatMap((object) => object.ids) },
    }),
    ...(subject.muted ? { muted: subject.muted } : {}),
    ...(earlier?.removalSpans ? { removalSpans: earlier.removalSpans } : {}),
    ...(earlier?.madeEarlier ? { made: earlier.madeEarlier } : {}),
    ...(earlier?.lateEarlier ? { late: earlier.lateEarlier } : {}),
  });
  return seedSweepInput(
    removalOrg(conn, 'sandforge-seed --sweep'),
    run.created,
    automation,
    signal,
    undefined,
    [],
    { ...(subject.runUserId ? { runUserId: subject.runUserId } : {}), ties },
  );
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
  if (args.preview) return previewRemoval(args, subject, run, say, t0);

  /** What the sweep found, said before its first delete: what it took, and what it listed and kept. */
  let sweepListing: ForgeSweepListing | undefined;
  const output = (
    status: ForgeUndoStatus,
    objects: ForgeUndoObjectResult[],
    planned: number,
    sweep?: ForgeSweepResult,
    mutedAutomation?: MutedAutomation,
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
            result: {
              status,
              planned,
              objects,
              ...(sweep ? { sweep } : {}),
              ...(sweepListing ? { sweepListing } : {}),
              ...(mutedAutomation ? { mutedAutomation } : {}),
            },
            elapsedMs: Date.now() - t0,
          },
          null,
          2,
        )}\n`,
      );
      for (const line of automationHeldLines(objects, args)) say(line);
      return;
    }
    // The sweep ran first, before the run's records went.
    for (const line of sweep ? sweepLines(sweep) : []) say(line);
    for (const line of removalSummaryLines(status, objects)) say(line);
    for (const line of automationHeldLines(objects, args)) say(line);
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
  if (refusal) refuseTheRemoval({ code: 'PRODUCTION_TARGET', message: refusal });
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
  const sweepInput = (signal?: AbortSignal) =>
    seedRemovalSweepInput(conn, args.target, org.id, run, subject, signal);

  if (args.sweepList) {
    // What a sweep would delete, read and said; nothing is deleted, the
    // run's own records included.
    const listing = await listSweep(
      sweepOrgOf(conn, 'sandforge-seed --sweep-list'),
      await sweepInput(),
      earlier?.removalSpans ?? [],
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
      // Read before a sweep, with what --sweep-late and --sweep-untied would take.
      for (const line of sweepListingLines(listing, args.target, args, true)) say(line);
      say(`\ndone in ${Date.now() - t0}ms`);
    }
    return;
  }

  say(`sandforge-seed --remove  ${args.summaryPath}  from ${args.target}`);
  for (const { objectApiName, ids } of plan) say(`  ${objectApiName}: ${ids.length} to remove`);
  if (plan.length === 0) say('nothing left of the run to remove');
  if (args.sweep) {
    say(
      "before them, a sweep deletes what the target's automation made for the run, as the " +
        `run's user, tied to its records — run ${sweepOptionWords('--sweep-list')} to see what`,
    );
  }
  // Ctrl-C stops the removal before its next call to the org; a SIGTERM or a
  // SIGHUP does too.
  const stop = new AbortController();
  const releaseStop = onStopSignal(() => stop.abort());
  let state: SyncRunRemovalState = earlier ?? {};
  // The sweep comes before the run's records go, as the panel's does: a task
  // the target's automation opened on one of them would otherwise stay. The
  // removal makes its first part once it has read the run's records, what
  // hangs from them goes with them, and what one of them points at by a
  // lookup the org restricts the delete by goes once they are gone
  // (`sweepParts`).
  const parts = args.sweep
    ? sweepParts(
        sweepOrgOf(conn, 'sandforge-seed --sweep', stop.signal),
        await sweepInput(stop.signal),
        {
          includeChanged: args.includeChanged,
          // What the earlier removals of the run changed while they ran is no
          // change since the run.
          removalSpans: state.removalSpans ?? [],
          ...sweepClassOptions(args),
          // What it found, said before the first delete: --sweep asked for it.
          approve: async (listing) => {
            sweepListing = listing;
            say('');
            for (const line of sweepListingLines(listing, args.target, args)) say(line);
            return undefined;
          },
        },
      )
    : undefined;
  // The sweep reads what it takes and says it here, before the lease: the
  // lease is held for the deletes alone. It deletes at its turn.
  await parts?.ask();
  const unsaid = sweepUnsaid(parts, sweepListing);
  if (unsaid) {
    sweepListing = unsaid;
    say('');
    for (const line of sweepListingLines(unsaid, args.target, args)) say(line);
  }
  // What the target runs as the removal takes the run back, said before it
  // deletes and asked about as Sync's and the clone's removals ask: what
  // fires as it sets an activated order back to Draft, then before and after
  // each delete, what the sweep deletes among them: read before it, a Flow on
  // an asset the run never wrote refused the sweep's delete after the removal
  // had said that nothing fired. The command read it for the sweep alone, and
  // deleted without a word of it. A seed only creates, so nothing is brought
  // back from the recycle bin, and what runs on an undelete is not read. A stop
  // while the sweep read asks nothing: the removal stops at its next call.
  const removed = [...new Set(plan.map(({ objectApiName }) => objectApiName))];
  const steps: ForgeRemovalSteps = removalStepsWithSweep(
    { setToDraft: setBackToDraftOf(removed), delete: objectsRemovedOf(removed) },
    parts?.takes ?? [],
  );
  const deleted = steps.delete ?? [];
  /**
   * End the removal refused before its first delete, as a refused run ends:
   * its line names its code, and with --json stdout carries it. Refused for
   * a production org, what fires as it deletes, its mute or objects its user
   * may not delete, it said a sentence on stderr and left stdout empty.
   */
  function refuseTheRemoval(refused: RunRefusal): never {
    process.stderr.write(`${refusedLine(refused)}\n`);
    if (args.json) {
      process.stdout.write(
        refusedRemovalSummary(
          {
            tool: 'sandforge-seed',
            summary: args.summaryPath,
            target: args.target,
            elapsedMs: Date.now() - t0,
          },
          refused,
        ),
      );
    }
    return process.exit(1);
  }
  /** {@link refuseTheRemoval}, once Ctrl-C is heard for the removal. */
  const endRefused = (refused: RunRefusal): never => {
    releaseStop();
    return refuseTheRemoval(refused);
  };
  /** The removal's mute, asked with --mute-automation, held while it deletes. */
  let removalMute: RunMute | undefined;
  if (deleted.length > 0 && !stop.signal.aborted) {
    const read = await targetAutomationReader(conn).read(args.target, deleted);
    say('');
    for (const line of removalStepsAutomationLines(read, args.target, steps)) say(line);
    // Asked to mute, the removal plans it from what it read, and asks only
    // for what still runs; refused, it deletes nothing.
    if (args.muteAutomation) {
      try {
        removalMute = await muteForRun(async () => muteOrgOf(conn), read, {
          writes: removalStepsWrites(steps),
        });
        for (const line of muteLines(removalMute.muted, args.target)) say(`  ${line}`);
      } catch (err: unknown) {
        if (!isMuteRefusedError(err)) throw err;
        endRefused(err.refusal);
      }
    }
    const automation = removalMute?.automation ?? read;
    const automationStop = removalStepsAutomationRefusal(automation, args.target, {
      steps,
      // The sets that keep it quiet, which --mute-automation assigns under a
      // lease: never a command assigning them by hand, with the user's name.
      assign: bypassesToAssign(automation, removalStepsBypassesOf(automation, steps)),
      mayMute: removalMute === undefined,
    });
    if (automationStop && !args.acceptAutomation) {
      endRefused({ code: 'AUTOMATION_NOT_ACCEPTED', message: automationStop });
    }
  }
  let outcome: Awaited<ReturnType<typeof removeSyncRun>>;
  // The lease, taken right before the first write, once every question is
  // answered: the removal asks what to do of the records its user may not
  // delete once it has read them, and a lease taken before it kept the sets
  // assigned while the question stayed open, for nothing once it was answered
  // no. A stop before then assigns nothing.
  let held: HeldMute | undefined;
  let mutedAutomation: MutedAutomation | undefined = removalMute?.muted;
  const takeTheLease = async (): Promise<void> => {
    if (!removalMute?.prepared || stop.signal.aborted) return;
    held = await removalMute.prepared
      .acquire(`sandforge-seed --remove ${run.runId}`)
      .catch((err: unknown) => {
        if (!isMuteRefusedError(err)) throw err;
        return endRefused(err.refusal);
      });
    mutedAutomation = held.outcome;
  };
  const removalTarget = removalOrg(conn, 'sandforge-seed --remove');
  // Read before the first delete: the items that name them go with the records.
  const duplicateSets = await duplicateSetsOfRemoval(removalTarget, run.created);
  /** Why it stopped for objects its user may not delete, once it did. */
  let undeletableRefused: RunRefusal | undefined;
  try {
    outcome = await removeSyncRun({
      run,
      org: removalTarget,
      includeChanged: args.includeChanged,
      ...sweepPartsOptions(parts),
      ...(subject.runUserId ? { runUserId: subject.runUserId } : {}),
      onUndeletable: undeletableAnswer(args.leaveUndeletable, args.target, (refused) => {
        undeletableRefused = refused;
      }),
      beforeFirstWrite: takeTheLease,
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
    // What the sweep found made for the run, kept whatever the removal ended
    // on: once a record of the run is deleted, the org may clear the lookup
    // that told the tie, and the next sweep would list it as tied to nothing.
    // What it found made late, kept the same way, is late still for the next.
    const made = parts?.made ?? new Set<string>();
    const late = parts?.late ?? new Set<string>();
    // What it said gone is kept no more.
    const gone = parts?.gone ?? new Set<string>();
    if (made.size > 0 || late.size > 0 || gone.size > 0) {
      await subject
        .updateRemoval((earlierState) => withSweepFinds(earlierState, made, late, gone))
        .catch((err: unknown) => {
          process.stderr.write(
            `What the sweep found made for the run could not be kept (${err instanceof Error ? err.message : String(err)}): ` +
              'a later --sweep may list it as tied to nothing.\n',
          );
        });
    }
    if (held) {
      mutedAutomation = await held.release();
      for (const line of muteLines(mutedAutomation, args.target)) say(line);
    }
  }
  if (mutedAutomation) outcome = { ...outcome, result: { ...outcome.result, mutedAutomation } };
  // Stopped before its first delete, for objects the user may not delete:
  // nothing was removed.
  if (outcome.stoppedForUndeletable) {
    if (undeletableRefused) refuseTheRemoval(undeletableRefused);
    process.exit(1);
  }
  // Stopped, it makes no call to the org it can do without.
  const emptied = outcome.result.status === 'cancelled' ? {} : await duplicateSets.take();
  for (const note of [...outcome.notes, ...(emptied.note ? [emptied.note] : [])]) {
    process.stderr.write(`${note}\n`);
  }
  const sweep = parts?.result();
  const status = removalStatusWithSweep(outcome.result.status, sweep);
  output(
    status,
    emptied.object ? [...outcome.result.objects, emptied.object] : outcome.result.objects,
    outcome.planned,
    sweep,
    mutedAutomation,
  );
  if (status !== 'success') process.exit(RECORDS_LEFT_EXIT);
}

// ─── --remove --preview ──────────────────────────────────────────────────────

/** What `--remove --preview` says a removal of the run would do. */
export interface SeedRemovalPreview {
  /** The run's records a removal would set out to take. */
  planned: number;
  /** Per object, in the order a removal would take them: children before their parents. */
  objects: RemovalPreviewObject[];
  /** The objects whose records the user may not delete, with how many are in the org. */
  undeletable?: UndeletableObject[];
  /** The names of the users who changed records of the run since, by user Id. */
  userNames: Record<string, string>;
}

/**
 * What a preview never reads, said with each: what the target's automation
 * does as the records go, and what hangs from them, which a removal reads
 * record by record at each object's turn.
 */
export const PREVIEW_UNREAD =
  "not read by a preview: what the target's automation does as the records go — a trigger " +
  'or a flow that deletes, keeps or creates other records — and what hangs from them, which a ' +
  'removal reads at each object’s turn: a record kept for records that stay is counted with ' +
  'those to delete';

/** What `--remove --preview --json` prints: one JSON document, alone on stdout. */
export function removalPreviewJson(answer: {
  summary: string;
  target: string;
  includeChanged: boolean;
  preview: SeedRemovalPreview;
  /**
   * What a removal run now would be refused for, each in its own words under
   * `refusals`, and beside them, in their order, the code a removal is
   * refused with under `refusalCodes`.
   */
  refusals: readonly RunRefusal[];
  notes: readonly string[];
  elapsedMs: number;
  /** With `--sweep`, what the sweep would take, as `--sweep-list` lists it. */
  sweepListing?: ForgeSweepListing;
}): string {
  return `${JSON.stringify(
    {
      tool: 'sandforge-seed',
      action: 'remove-preview',
      summary: answer.summary,
      target: answer.target,
      includeChanged: answer.includeChanged,
      preview: answer.preview,
      ...(answer.sweepListing ? { sweepListing: answer.sweepListing } : {}),
      refusals: answer.refusals.map(({ message }) => message),
      refusalCodes: answer.refusals.map(({ code }) => code),
      notes: answer.notes,
      elapsedMs: answer.elapsedMs,
    },
    null,
    2,
  )}\n`;
}

/** What `--remove --preview` prints without `--json`. Exported so it can be tested. */
export function removalPreviewLines(
  preview: SeedRemovalPreview,
  refusals: readonly RunRefusal[],
  notes: readonly string[],
  includeChanged: boolean,
): string[] {
  const named = (userId: string): string => preview.userNames[userId] ?? userId;
  const lines = ['preview: what a removal would do; nothing was written'];
  for (const o of preview.objects) {
    const counts = [
      o.toDelete > 0 ? `${o.toDelete} to delete` : '',
      includeChanged && o.changedSince > 0 ? `${o.changedSince} of them changed since the run` : '',
      o.alreadyGone > 0 ? `${o.alreadyGone} gone already` : '',
      o.notVisible > 0 ? `${o.notVisible} not visible` : '',
      o.keptChanged > 0 ? `${o.keptChanged} kept, changed since the run` : '',
      o.undeletable > 0 ? `${o.undeletable} left, the user may not delete them` : '',
      o.unread > 0 ? `${o.unread} left, not read` : '',
    ].filter(Boolean);
    lines.push(
      `  ${o.objectApiName}: ${counts.join(', ') || 'nothing'} of ${o.planned}${platformCopiesWords(o)}`,
    );
    const by = Object.entries(o.changedBy).sort((a, b) => b[1] - a[1]);
    if (by.length > 0) {
      lines.push(
        `      last changed by: ${by.map(([userId, n]) => `${named(userId)} ${n}`).join(' · ')}`,
      );
    }
    for (const reason of o.reasons) lines.push(`      ${reason}`);
  }
  for (const refusal of refusals) lines.push(wouldBeRefusedLine(refusal, 'a removal'));
  return [...lines, ...notes];
}

/**
 * Say what a removal of the run would do, and do nothing (`--preview`): the
 * removal's own reading of the run's records before its first write
 * (`previewSyncRun`), what the target runs as they go, and what a removal
 * would be refused for, each under the code the removal is refused with — a
 * production org, that automation without `--accept-automation`, objects the
 * user may not delete without `--leave-undeletable`. Nothing is written to
 * the org, nor beside the summary or the run's file, and nothing is asked. A
 * preview only reads, so a production org is read and the refusal a removal
 * would meet is said; an org that is not the one the run wrote to is
 * refused, exit 1, as the removal refuses it.
 *
 * With `--sweep`, what the sweep would take is listed as `--sweep-list` lists
 * it, and what fires as its records go is read with the run's own: previewed
 * without it, `sandforge-env destroy --sweep` blocked nothing, and the
 * removal then refused the sweep's automation, the destroy stopped part way.
 */
async function previewRemoval(
  args: RemoveArgs,
  subject: RemovalSubject,
  run: SyncRunKept,
  say: (line: string) => void,
  t0: number,
): Promise<void> {
  const plan = syncRemovalPlan(run);
  const notes: string[] = [];
  /** With --sweep, what the sweep would take, once read. */
  let sweepListing: ForgeSweepListing | undefined;
  // A Bulk API job the run's file names that no line of it answers: a
  // removal reads it back into the file first. A preview writes no file.
  const jobs = subject.runs !== undefined ? (run.jobs ?? []).length : 0;
  if (jobs > 0) {
    notes.push(
      `the run's file names ${jobs} Bulk API job(s) no line of it answers: a removal reads ` +
        'back what they created first and removes it with the rest; this preview counts only ' +
        'what the file holds',
    );
  }
  const answer = (preview: SeedRemovalPreview, refusals: readonly RunRefusal[]): void => {
    notes.push(PREVIEW_UNREAD);
    if (args.json) {
      process.stdout.write(
        removalPreviewJson({
          summary: args.summaryPath,
          target: args.target,
          includeChanged: args.includeChanged,
          preview,
          refusals,
          notes,
          elapsedMs: Date.now() - t0,
          ...(sweepListing ? { sweepListing } : {}),
        }),
      );
      return;
    }
    say('');
    for (const line of removalPreviewLines(preview, refusals, notes, args.includeChanged)) {
      say(line);
    }
    say(`\ndone in ${Date.now() - t0}ms`);
  };

  say(`sandforge-seed --remove  ${args.summaryPath}  --preview  of ${args.target}`);
  // A sweep still has the run's window to look in.
  if (plan.length === 0 && !args.sweep) {
    notes.push(
      subject.earlier?.undo
        ? `what the run created was removed already, on ${subject.earlier.undo.removedAt}`
        : 'The run created nothing: there is nothing of it to remove.',
    );
    answer({ planned: 0, objects: [], userNames: {} }, []);
    return;
  }

  const session = await loadOrg(args.target);
  const conn = makeConn(session);
  const org = await typeTarget(conn);
  if (
    subject.targetOrgId !== undefined &&
    subject.targetOrgId.slice(0, 15) !== org.id.slice(0, 15)
  ) {
    process.stderr.write(
      `${args.target} is not the org the run wrote to (${subject.targetOrgId}): its records ` +
        'are read in that org only. Nothing of the run was read.\n',
    );
    process.exit(1);
  }
  const refusals: RunRefusal[] = [];
  const production = removalRefusal(args.target, org, 'sandforge-seed');
  if (production) refusals.push({ code: 'PRODUCTION_TARGET', message: production });
  // With --sweep, what it would take, listed as the removal lists it before
  // its first delete; nothing is deleted.
  if (args.sweep) {
    sweepListing = await listSweep(
      sweepOrgOf(conn, 'sandforge-seed --remove --preview --sweep'),
      await seedRemovalSweepInput(conn, args.target, org.id, run, subject),
      subject.earlier?.removalSpans ?? [],
    );
    say('');
    for (const line of sweepListingLines(sweepListing, args.target, args, true)) say(line);
  }
  // What the target runs as a removal takes the run back, and as its sweep
  // deletes, read and said as the removal says it before its first delete.
  const removed = [...new Set(plan.map(({ objectApiName }) => objectApiName))];
  const steps: ForgeRemovalSteps = removalStepsWithSweep(
    { setToDraft: setBackToDraftOf(removed), delete: objectsRemovedOf(removed) },
    sweepListing ? sweepTakenObjects(sweepListing, args) : [],
  );
  const automation = await targetAutomationReader(conn).read(args.target, steps.delete ?? []);
  say('');
  for (const line of removalStepsAutomationLines(automation, args.target, steps)) say(line);
  const automationStop = removalStepsAutomationRefusal(automation, args.target, {
    steps,
    assign: bypassesToAssign(automation, removalStepsBypassesOf(automation, steps)),
    mayMute: !args.muteAutomation,
  });
  if (automationStop && !args.acceptAutomation) {
    refusals.push({ code: 'AUTOMATION_NOT_ACCEPTED', message: automationStop });
  }
  // Nothing of the run left, the sweep goes alone.
  if (plan.length === 0) {
    notes.push('nothing left of the run to remove');
    answer({ planned: 0, objects: [], userNames: {} }, refusals);
    return;
  }

  // Ctrl-C stops the reads before the next one; nothing is said of a preview
  // stopped part way.
  const stop = new AbortController();
  let stoppedBy: StopSignal | undefined;
  const releaseStop = onStopSignal((signal) => {
    stoppedBy = signal;
    stop.abort();
  });
  let read: Awaited<ReturnType<typeof previewSyncRun>>;
  try {
    read = await previewSyncRun({
      run,
      org: removalOrg(conn, 'sandforge-seed --remove --preview'),
      includeChanged: args.includeChanged,
      signal: stop.signal,
    });
  } finally {
    releaseStop();
  }
  const preview = read.outcome.preview;
  if (!preview) {
    process.stderr.write(
      'interrupted: the preview stopped before it was through, and wrote nothing\n',
    );
    process.exit(stopExitCode(stoppedBy ?? 'SIGINT'));
  }
  const undeletable = read.outcome.undeletable ?? [];
  if (undeletable.length > 0 && !args.leaveUndeletable) {
    const named = undeletable.map((o) => `${o.objectApiName} (${o.records} records)`).join(', ');
    refusals.push({
      code: UNDELETABLE_NOT_LEFT,
      message:
        `The user SandForge connects as may not delete the records of ${named} in ` +
        `${args.target}: a removal stops before its first delete, unless given ` +
        '--leave-undeletable, which removes the rest and leaves those.',
    });
  }
  answer(
    {
      planned: read.planned,
      objects: preview.objects,
      ...(undeletable.length > 0 ? { undeletable } : {}),
      userNames: preview.userNames,
    },
    refusals,
  );
}

// `tsx` runs this file directly; the check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-seed')) {
  holdOutputWhole();
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
