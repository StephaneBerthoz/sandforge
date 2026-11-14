#!/usr/bin/env tsx
/**
 * sandforge-pipeline — an Automation pipeline exported from VS Code
 * (`<name>.sandforge-pipeline.json`), planned and run where the editor is
 * not: from cron, Task Scheduler, a CI job or a terminal.
 *
 * The run is the editor's own: the file's pipeline goes through the
 * Automation page's handler in a host stood up without the editor
 * (`pipelineHost.ts`), with the same steps, checks and guards. What the
 * command line adds is what only it can know, and is refused before the
 * first step, every cause at once, exit 2:
 *
 * - an org of the file that is another org here: a sandbox refreshed since,
 *   an alias moved (`ORG_MOVED`), by its Organization Id;
 * - a step that writes to a production org, whatever an Approval answers
 *   (`PRODUCTION_TARGET`): the editor lets a Sync write there behind an
 *   Approval, a command line run by cron never does;
 * - an Approval step with nobody to ask: no terminal, and no
 *   `--approve "<step>"` answering it ahead (`APPROVAL_NO_TERMINAL`); and one
 *   that stands before a write to a sandbox marked Staging, which only a
 *   person at a terminal answers, never `--approve` (`STAGING_NEEDS_PERSON`);
 * - a variable the pipeline requires that nothing gives.
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-pipeline.ts plan --file nightly.sandforge-pipeline.json
 *   pnpm exec tsx packages/extension/cli/sandforge-pipeline.ts run --file nightly.sandforge-pipeline.json \
 *     --dry-run
 *   pnpm exec tsx packages/extension/cli/sandforge-pipeline.ts run --file nightly.sandforge-pipeline.json \
 *     --triggered-by schedule --approve "Go?" --fail-on-partial
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CheckpointListEntry,
  PipelineExportOutcome,
  PipelineFileOrg,
  PipelineFileOrgKind,
  PipelineFileRefusal,
  PipelineHistoryEntry,
  PipelineRewindGrantResponse,
  PipelineRun,
  PipelineStepResult,
  SalesforceOrg,
  SandforgePipelineFile,
} from '@sandforge/shared';
import { PIPELINE_FILE_SETTINGS, readPipelineFile } from '@sandforge/shared';
import { SF_ALIAS_RE, unreadArgument, type CommandFlags } from './commandLine.js';
import { DONE_EXIT, FAILED_EXIT, PARTIAL_EXIT, endWith } from './exitCodes.js';
import { commandOf } from './invocation.js';
import type { PanelAnswer, PostedMessage } from './panelHost.js';
import {
  createPipelineHost,
  hostedPipeline,
  liveKindOf,
  markStaging,
  matchOrg,
  saveCarried,
  shareSnapshots,
  snapshotKeys,
  type PipelineHost,
} from './pipelineHost.js';
import { confirm, typed } from './prompt.js';
import { onStopSignal, stopExitCode, type StopSignal } from './stopSignals.js';
import { holdOutputWhole } from './wholeOutput.js';
import { previewLines, type PreviewAnswer } from './sandforge-checkpoint.js';
import { PIPELINE_SETTING_DEFAULTS } from '../src/modules/automation/pipelineExport.js';
import {
  acquirePipelineRunLock,
  defaultPipelinesRoot,
  pipelineFolderOf,
  pipelineLockTakenOverLine,
  pipelineRunLockHolder,
  pipelineRunningRefusal,
  type PipelineRunLock,
} from '../src/modules/automation/PipelineRunLock.js';
import {
  cliHistoryFileOf,
  cliRunHistory,
  recordCliRun,
} from '../src/modules/automation/cliRunHistory.js';
import type { ApprovalAnswer } from '../src/modules/automation/ApprovalGate.js';
import type { ApprovalQuestionText } from '../src/services.js';

const HELP = `sandforge pipeline — run an Automation pipeline exported from VS Code, without the editor.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-pipeline.ts plan --file <file> [options]
  pnpm exec tsx packages/extension/cli/sandforge-pipeline.ts run --file <file> [options]
  pnpm exec tsx packages/extension/cli/sandforge-pipeline.ts confirm --file <file> [--org <key>=<alias>]… [--store <dir>]
  pnpm exec tsx packages/extension/cli/sandforge-pipeline.ts history --file <file> [--json]

Commands:
  plan      connect each org, type it, and say what a run would do and refuse; writes nothing
  run       run the pipeline as the Automation page runs it; with --dry-run, the steps that
            write say what they would do, and the steps that read run
  confirm   confirm its Rewind steps at the terminal, as the page's confirmation does: the
            alias of each Rewind step's org is typed, and the confirmation kept in the store
  history   the runs of the pipeline the command line made on this machine, newest first

The file is the one the Automation page's Export… writes (<name>.sandforge-pipeline.json).

Options (plan, run):
  --file <file>             the pipeline file
  --org <key>=<alias>       the sf alias an org of the file is reached by here, by its key in
                            the file's "orgs"; repeat for more (default: the alias the file names)
  --accept-org <key>=<id>   take the org an alias reaches for the file's though its Organization
                            Id differs — a sandbox refreshed since — once you checked it is the
                            one; repeat for more
  --var <name>=<value>      a variable of the pipeline; repeat for more
  --var-env <name>=<VAR>    a variable read from an environment variable: a secret, which the
                            file never holds; repeat for more
  --approve <step>          answer the Approval step of that name ahead, yes, for a run with no
                            one at a terminal; repeat for more. Never one that stands before a
                            write to a sandbox marked Staging: a person answers it at a terminal
  --confirm-rewind <alias>  confirm the Rewind steps of the org of that alias, as typing it on
                            the page does; repeat for more
  --store <dir>             where the run keeps its state between runs: the Sync watermarks a
                            delta Sync reads on from, the Rewind confirmations, the audit
                            (default: the pipeline's folder under the folder
                            SANDFORGE_JOURNAL_DIR names, ~/.sandforge by default). A CI job
                            caches it between its runs
  --json                    the plan, or the run, as JSON on stdout; every other line on stderr
  --help                    this text

Options (run):
  --dry-run                 the steps that write say what they would do: a Sync simulates, an
                            Anonymize previews, a Rewind previews, a Checkpoint estimates, a
                            Seed says what it would seed; Compare and Pre-check run, and the
                            Conditions read what they found; no Delay waits, no Approval is
                            asked; nothing is kept in the history nor the audit
  --timeout <ms>            the run's time budget, sandforge.pipeline.timeout, from 30000 to
                            3600000 (default: the file's, or 300000); an Approval's wait, a
                            Delay and the steps that write have their own
  --triggered-by <how>      manual | schedule: what the history says started it (default: manual)
  --fail-on-partial         exit 3 when the run ended with warnings: a step past which it went on

Nothing is written to any org by plan, nor by run --dry-run. A run takes the pipeline's lock
on this machine, which a run in VS Code takes too: one run of a pipeline at a time. Each org
is named by its sf CLI alias: the Salesforce CLI (sf) must be installed and logged in to it.

Exit codes:
  0  the plan refuses nothing; the run completed (with warnings, unless --fail-on-partial)
  1  the run failed, or could not start
  2  a bad command line, a file that does not read, or a run refused before its first step,
     every cause said with what lifts it: nothing ran
  3  --fail-on-partial, and the run completed with warnings
  129, 130, 143  a SIGHUP, a Ctrl-C or a SIGTERM stopped it: the step under way is stopped, and
     the run ends cancelled
`;

/** What the command does. */
type Verb = 'plan' | 'run' | 'confirm' | 'history';

const VERBS: readonly Verb[] = ['plan', 'run', 'confirm', 'history'];

/** The flags each verb reads. */
const FLAGS: Readonly<Record<Verb, CommandFlags>> = {
  plan: {
    words: 1,
    switches: ['--json'],
    values: [
      '--file',
      '--org',
      '--accept-org',
      '--var',
      '--var-env',
      '--approve',
      '--confirm-rewind',
      '--store',
    ],
  },
  run: {
    words: 1,
    switches: ['--json', '--dry-run', '--fail-on-partial'],
    values: [
      '--file',
      '--org',
      '--accept-org',
      '--var',
      '--var-env',
      '--approve',
      '--confirm-rewind',
      '--store',
      '--timeout',
      '--triggered-by',
    ],
  },
  confirm: { words: 1, switches: [], values: ['--file', '--org', '--accept-org', '--store'] },
  history: { words: 1, switches: ['--json'], values: ['--file'] },
};

/** The exit code of a run refused before its first step, or of a bad line: nothing ran. */
export const REFUSED_EXIT = 2;

/** The bounds of `--timeout`: those of `sandforge.pipeline.timeout`. */
const TIMEOUT_RULE = PIPELINE_FILE_SETTINGS['pipeline.timeout'];

/**
 * How long the command waits for the run's answer: as long as the run takes,
 * which an Approval holds up to a day, and a Delay longer. The longest a
 * timer of Node waits.
 */
const RUN_WAIT_MS = 2_147_483_647;

/** How long a request that only reads the host's store, or an org once, is waited for. */
const STORE_WAIT_MS = 60_000;

/** How long the check of the pipeline is waited for: it reads the checkpoints its Rewind steps name. */
const CHECK_WAIT_MS = 5 * 60_000;

/** Everything the command line settled. */
export interface PipelineArgs {
  verb: Verb;
  file: string;
  /** `--org`: the alias of each org key. */
  orgs: Map<string, string>;
  /** `--accept-org`: the Organization Id taken for each org key. */
  accepted: Map<string, string>;
  /** `--var`, and `--var-env` read: each variable's value, and where it came from. */
  vars: Map<string, { value?: string; env?: string }>;
  approve: string[];
  confirmRewind: string[];
  store?: string;
  json: boolean;
  dryRun: boolean;
  timeoutMs?: number;
  triggeredBy: 'manual' | 'schedule';
  failOnPartial: boolean;
}

/** A refusal before the first step: why, and what lifts it. */
export interface PlanRefusal {
  code: string;
  message: string;
  /** What lifts it. */
  wayOut?: string;
  /** The step it is about, by name. */
  step?: string;
  /** The org it is about, by its key in the file. */
  org?: string;
}

/** Stop the command on a bad line: said on stderr, exit 2, nothing run. */
class BadLine extends Error {}

/** `key=value`, split at the first `=`; refused when either side is empty. */
function pairOf(flag: string, word: string): [string, string] {
  const at = word.indexOf('=');
  if (at <= 0 || at === word.length - 1) {
    throw new BadLine(`${flag} takes <key>=<value>, got "${word}". Nothing was run.`);
  }
  return [word.slice(0, at), word.slice(at + 1)];
}

/**
 * Read the command line, or say why it cannot be read.
 *
 * @param env - Where `--var-env` reads its variables.
 * @throws {BadLine} With what is wrong with it.
 */
export function parseArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): PipelineArgs {
  const args = argv.slice(2);
  const verb = args[0];
  if (verb === undefined || verb.startsWith('-')) {
    throw new BadLine(`Name the command: ${VERBS.join(', ')}. Nothing was run.`);
  }
  if (!(VERBS as readonly string[]).includes(verb)) {
    throw new BadLine(
      `"${verb}" is not a command of sandforge pipeline: ${VERBS.join(', ')}. Nothing was run.`,
    );
  }
  const flags = FLAGS[verb as Verb];
  const unread = unreadArgument(args, flags);
  if (unread !== undefined) throw new BadLine(unread);
  const all = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === flag && i + 1 < args.length) out.push(args[++i] as string);
      else if (flags.values.includes(args[i] as string)) i++;
    }
    return out;
  };
  const one = (flag: string): string | undefined => {
    const given = all(flag);
    if (given.length > 1)
      throw new BadLine(`${flag} is given ${given.length} times. Nothing was run.`);
    return given[0];
  };
  const file = one('--file');
  if (file === undefined) throw new BadLine('--file names the pipeline file. Nothing was run.');

  const orgs = new Map<string, string>();
  for (const word of all('--org')) {
    const [key, alias] = pairOf('--org', word);
    if (!SF_ALIAS_RE.test(alias)) {
      throw new BadLine(`--org ${key}=${alias}: "${alias}" is not an sf alias. Nothing was run.`);
    }
    if (orgs.has(key)) throw new BadLine(`--org names ${key} twice. Nothing was run.`);
    orgs.set(key, alias);
  }
  const accepted = new Map<string, string>();
  for (const word of all('--accept-org')) {
    const [key, id] = pairOf('--accept-org', word);
    if (!/^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id)) {
      throw new BadLine(
        `--accept-org ${key}=${id}: "${id}" is no Organization Id (00D…). Nothing was run.`,
      );
    }
    accepted.set(key, id);
  }
  const vars = new Map<string, { value?: string; env?: string }>();
  for (const word of all('--var')) {
    const [name, value] = pairOf('--var', word);
    if (vars.has(name)) throw new BadLine(`${name} is given twice. Nothing was run.`);
    vars.set(name, { value });
  }
  for (const word of all('--var-env')) {
    const [name, variable] = pairOf('--var-env', word);
    if (vars.has(name)) throw new BadLine(`${name} is given twice. Nothing was run.`);
    const value = env[variable];
    vars.set(name, { env: variable, ...(value !== undefined && value !== '' ? { value } : {}) });
  }

  let timeoutMs: number | undefined;
  const timeout = one('--timeout');
  if (timeout !== undefined) {
    timeoutMs = Number(timeout);
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < (TIMEOUT_RULE.minimum ?? 0) ||
      timeoutMs > (TIMEOUT_RULE.maximum ?? Infinity)
    ) {
      throw new BadLine(
        `--timeout takes milliseconds from ${TIMEOUT_RULE.minimum} to ${TIMEOUT_RULE.maximum}, got "${timeout}". Nothing was run.`,
      );
    }
  }
  const triggered = one('--triggered-by') ?? 'manual';
  if (triggered !== 'manual' && triggered !== 'schedule') {
    throw new BadLine(
      `--triggered-by takes manual or schedule, got "${triggered}". Nothing was run.`,
    );
  }
  const store = one('--store');
  return {
    verb: verb as Verb,
    file,
    orgs,
    accepted,
    vars,
    approve: all('--approve'),
    confirmRewind: all('--confirm-rewind'),
    ...(store !== undefined ? { store: resolve(store) } : {}),
    json: args.includes('--json'),
    dryRun: args.includes('--dry-run'),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    triggeredBy: triggered,
    failOnPartial: args.includes('--fail-on-partial'),
  };
}

/** This SandForge's version, which the check of a pipeline names. */
function sandforgeVersion(): string {
  try {
    const read = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof read.version === 'string' ? read.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** What the command reads of its process, so a test can give its own. */
export interface PipelineDeps {
  env?: NodeJS.ProcessEnv;
  /** Whether a person is at a terminal to answer an Approval step. */
  isTTY?: boolean;
  /** Where the terminal's questions are asked and answered. */
  terminal?: Parameters<typeof confirm>[1];
  /** The folder the pipelines' locks and histories are in. */
  pipelinesRoot?: string;
  /** This SandForge's version. */
  version?: string;
}

/** How the command says what it does: a line, or the JSON. */
interface Say {
  line: (text: string) => void;
  json: (value: unknown) => void;
}

/** The refusals of a file that does not read, said as the plan says each. */
export function fileRefusals(
  refusal: PipelineFileRefusal,
  verb: Verb,
  file: string,
): PlanRefusal[] {
  if (refusal.code === 'PIPELINE_FILE_NEWER' && refusal.exporterVersion !== undefined) {
    return [
      {
        code: refusal.code,
        message: refusal.message,
        wayOut: `npx -y sandforge@${refusal.exporterVersion} pipeline ${verb} --file ${file}`,
      },
    ];
  }
  if (refusal.issues.length === 0) return [{ code: refusal.code, message: refusal.message }];
  return [
    { code: refusal.code, message: refusal.message },
    ...refusal.issues.map((issue) => ({
      code: refusal.code,
      message: `${issue.path}: ${issue.message}`,
    })),
  ];
}

/** An org of the file, as this run reaches it. */
export interface RunOrg {
  key: string;
  alias: string;
  file: PipelineFileOrg;
  /** As connected and typed here; absent when it was not reached. */
  org?: SalesforceOrg;
  kind?: PipelineFileOrgKind;
}

/**
 * The alias each org of the file is reached by: `--org`, or the file's own.
 * An org with neither is refused, with the line that names it, as is an
 * `--org` that names no org of the file.
 */
export function aliasesOf(
  file: Pick<SandforgePipelineFile, 'orgs'>,
  given: ReadonlyMap<string, string>,
): { orgs: RunOrg[]; refusals: PlanRefusal[] } {
  const orgs: RunOrg[] = [];
  const refusals: PlanRefusal[] = [];
  for (const key of given.keys()) {
    if (!Object.prototype.hasOwnProperty.call(file.orgs, key)) {
      refusals.push({
        code: 'ORG_UNKNOWN_KEY',
        org: key,
        message: `--org names "${key}", and the file has no org of that key.`,
        wayOut: `name one of ${Object.keys(file.orgs).join(', ') || 'none'}.`,
      });
    }
  }
  for (const [key, org] of Object.entries(file.orgs)) {
    const alias = given.get(key) ?? org.alias;
    if (alias === undefined) {
      refusals.push({
        code: 'ORG_NO_ALIAS',
        org: key,
        message: `The org "${org.name ?? key}" (${org.organizationId}) has no alias in the file.`,
        wayOut: `give the sf alias it is reached by here: --org ${key}=<alias> (sf alias set <alias>=<username> names one).`,
      });
      continue;
    }
    orgs.push({ key, alias, file: org });
  }
  return { orgs, refusals };
}

/**
 * The value of each variable the run hands the pipeline: given on the line,
 * or the file's default. A variable the pipeline requires that nothing gives
 * is refused, as is one given that it does not declare.
 */
export function variablesOf(
  file: Pick<SandforgePipelineFile, 'pipeline'>,
  given: PipelineArgs['vars'],
): { values: Record<string, string>; refusals: PlanRefusal[] } {
  const values: Record<string, string> = {};
  const refusals: PlanRefusal[] = [];
  const declared = new Map(file.pipeline.variables.map((variable) => [variable.name, variable]));
  for (const [name, from] of given) {
    if (!declared.has(name)) {
      refusals.push({
        code: 'VARIABLE_UNKNOWN',
        message: `The pipeline declares no variable "${name}".`,
        wayOut: `name one of ${[...declared.keys()].join(', ') || 'none'}, or leave it out.`,
      });
    } else if (from.value !== undefined) {
      values[name] = from.value;
    } else if (from.env !== undefined) {
      refusals.push({
        code: 'VARIABLE_MISSING',
        message: `Variable "${name}" is to be read from ${from.env}, which is not set, or empty.`,
        wayOut: `set ${from.env} in the environment the run starts in.`,
      });
    }
  }
  for (const variable of file.pipeline.variables) {
    if (Object.prototype.hasOwnProperty.call(values, variable.name) || given.has(variable.name)) {
      continue;
    }
    if (variable.defaultValue !== undefined) {
      values[variable.name] = variable.defaultValue;
    } else if (variable.required) {
      refusals.push({
        code: 'VARIABLE_MISSING',
        message:
          `Variable "${variable.name}" is required, and the file gives it no value` +
          `${variable.type === 'secret' ? ': a secret never travels in it' : ''}.`,
        wayOut:
          variable.type === 'secret'
            ? `--var-env ${variable.name}=<environment variable that holds it>`
            : `--var ${variable.name}=<value>, or --var-env ${variable.name}=<environment variable>`,
      });
    }
  }
  return { values, refusals };
}

/** The steps of each type, by name, as the file holds them. */
function stepsOfType(file: Pick<SandforgePipelineFile, 'pipeline'>, type: string): string[] {
  return file.pipeline.steps.filter((step) => step.type === type).map((step) => step.name);
}

/**
 * The refusals `--approve` and `--confirm-rewind` make of the file alone: a
 * step name no Approval step has, an alias no Rewind step's org is reached by.
 */
export function namedStepRefusals(
  file: Pick<SandforgePipelineFile, 'pipeline'>,
  args: Pick<PipelineArgs, 'approve' | 'confirmRewind'>,
  orgs: readonly RunOrg[],
): PlanRefusal[] {
  const refusals: PlanRefusal[] = [];
  const approvals = stepsOfType(file, 'approval');
  for (const name of args.approve) {
    if (!approvals.includes(name)) {
      refusals.push({
        code: 'APPROVE_UNKNOWN_STEP',
        message: `--approve "${name}" names no Approval step of the pipeline.`,
        wayOut:
          approvals.length > 0
            ? `name one of ${approvals.map((each) => `"${each}"`).join(', ')}.`
            : 'leave it out: the pipeline has no Approval step.',
      });
    }
  }
  const rewound = new Set(
    file.pipeline.steps
      .filter((step) => step.type === 'rewind')
      .map((step) => orgs.find((org) => org.key === step.config['orgId'])?.alias)
      .filter((alias): alias is string => alias !== undefined),
  );
  for (const alias of args.confirmRewind) {
    if (!rewound.has(alias)) {
      refusals.push({
        code: 'CONFIRM_UNKNOWN_ORG',
        message: `--confirm-rewind ${alias} names no org a Rewind step of the pipeline rewinds.`,
        wayOut:
          rewound.size > 0
            ? `name ${[...rewound].join(', ')}.`
            : 'leave it out: the pipeline has no Rewind step.',
      });
    }
  }
  return refusals;
}

/** The steps a refused export's check is read from, by id. */
type CheckedStep = Extract<PipelineExportOutcome, { exported: true }>['steps'][number];

/** The orgs each step writes to, by the key of the file. */
function writesOf(
  file: Pick<SandforgePipelineFile, 'pipeline' | 'syncConfigs'>,
  stepId: string,
): string[] {
  const step = file.pipeline.steps.find((each) => each.id === stepId);
  if (!step) return [];
  if (step.type === 'sync') {
    const target = file.syncConfigs[String(step.config['configId'] ?? '')]?.targetOrgId;
    return typeof target === 'string' ? [target] : [];
  }
  if (['seed', 'anonymize', 'rewind', 'restore', 'delete'].includes(step.type)) {
    const org = step.config['orgId'];
    return typeof org === 'string' ? [org] : [];
  }
  return [];
}

/**
 * The refusals of the pipeline's check, as the Automation page's handler
 * makes it here — each step where it sits, then the whole — and those the
 * command line adds: a write to a production org, an Approval step with
 * nobody to answer it.
 */
export function checkRefusals(
  file: Pick<SandforgePipelineFile, 'pipeline' | 'syncConfigs'>,
  check: Extract<PipelineExportOutcome, { exported: true }>,
  orgs: readonly RunOrg[],
  answer: { approve: readonly string[]; isTTY: boolean },
): PlanRefusal[] {
  const refusals: PlanRefusal[] = [];
  const said = new Set<string>();
  const kindOf = (key: string): PipelineFileOrgKind | undefined =>
    orgs.find((org) => org.key === key)?.kind;
  const aliasOf = (key: string): string => orgs.find((org) => org.key === key)?.alias ?? key;
  for (const step of check.steps) {
    const production = writesOf(file, step.stepId).find((key) => kindOf(key) === 'production');
    if (production !== undefined) {
      const message =
        `Step "${step.name}" writes to ${aliasOf(production)}, a production org: a pipeline from ` +
        'the command line never writes to a production org, whatever an Approval answers.';
      refusals.push({
        code: 'PRODUCTION_TARGET',
        step: step.name,
        org: production,
        message,
        wayOut: `point the step at a sandbox, a scratch org or a Developer Edition org, and export again; or map ${production} to one with --org.`,
      });
      said.add(step.refusal ?? message);
      continue;
    }
    if (step.fate === 'refused' && step.refusal !== undefined) {
      refusals.push({ code: 'STEP_REFUSED', step: step.name, message: step.refusal });
      said.add(step.refusal);
      continue;
    }
    if (step.type !== 'approval') continue;
    refusals.push(...approvalRefusals(step, answer));
  }
  for (const problem of check.problems) {
    if (said.has(problem) || [...said].some((each) => problem.includes(each))) continue;
    refusals.push({ code: 'PIPELINE_REFUSED', message: problem });
  }
  return refusals;
}

/** Why an Approval step has nobody to answer it on this run, or nothing when it has. */
function approvalRefusals(
  step: CheckedStep,
  answer: { approve: readonly string[]; isTTY: boolean },
): PlanRefusal[] {
  const who = `Approval step "${step.name}"`;
  const ahead = answer.approve.includes(step.name);
  if (step.notes.includes('STAGING_NEEDS_PERSON')) {
    if (ahead) {
      return [
        {
          code: 'STAGING_NEEDS_PERSON',
          step: step.name,
          message: `${who} stands before a write to a sandbox marked Staging: only a person at a terminal answers it, never --approve.`,
          wayOut: `leave --approve "${step.name}" out and run it in a terminal; or take the Staging mark off the sandbox in Org Manager, and export again.`,
        },
      ];
    }
    if (!answer.isTTY) {
      return [
        {
          code: 'STAGING_NEEDS_PERSON',
          step: step.name,
          message: `${who} stands before a write to a sandbox marked Staging, and this run has no terminal: only a person at a terminal answers it.`,
          wayOut:
            'run it in a terminal; or take the Staging mark off the sandbox in Org Manager, and export again.',
        },
      ];
    }
    return [];
  }
  if (!ahead && !answer.isTTY) {
    return [
      {
        code: 'APPROVAL_NO_TERMINAL',
        step: step.name,
        message: `${who} has no one to ask: this run has no terminal.`,
        wayOut: `run it in a terminal, or add --approve "${step.name}".`,
      },
    ];
  }
  return [];
}

/** The value of a setting a step reads: the line's timeout, the file's, then the extension's default. */
export function settingOf(
  file: Pick<SandforgePipelineFile, 'settings'>,
  timeoutMs: number | undefined,
): <T>(key: string, fallback: T) => T {
  return <T>(key: string, fallback: T): T => {
    if (key === 'pipeline.timeout' && timeoutMs !== undefined) return timeoutMs as T;
    const settings = file.settings as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(settings, key)) return settings[key] as T;
    const defaults = PIPELINE_SETTING_DEFAULTS as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(defaults, key)) return defaults[key] as T;
    return fallback;
  };
}

/** A step of the run, as its last line and the JSON say it. */
interface StepLine {
  name: string;
  type: string;
  status: string;
  summary?: string;
  error?: string;
  output?: Record<string, unknown>;
  takeBack?: string;
}

/**
 * The line that takes back what a step wrote, by the command that takes it
 * back here: a Seed's run and a Sync's by their removal, an Anonymize's
 * values from its snapshot, a Rewind by its undo, a Checkpoint by its delete.
 * Nothing for a step that wrote nothing, nor for a dry run's.
 */
export function takeBackOf(
  result: Pick<PipelineStepResult, 'stepType' | 'output' | 'status'>,
  aliasOfId: (orgId: string) => string | undefined,
  store: string,
  syncTarget: (configId: string) => string | undefined,
): string | undefined {
  const output = result.output ?? {};
  if (output['dryRun'] === true) return undefined;
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined;
  const orgAlias =
    text(output['orgId']) !== undefined ? aliasOfId(String(output['orgId'])) : undefined;
  switch (result.stepType) {
    case 'seed': {
      const runId = text(output['runId']);
      if (runId === undefined || orgAlias === undefined) return undefined;
      if (Number(output['totalRecordsCreated'] ?? 0) === 0) return undefined;
      return `${commandOf('seed')} --remove ${runId} --target ${orgAlias}`;
    }
    case 'sync': {
      const runId = text(output['operationId']);
      const target = syncTarget(String(output['configId'] ?? ''));
      if (runId === undefined || target === undefined) return undefined;
      if (Number(output['totalSuccess'] ?? 0) === 0) return undefined;
      return `${commandOf('sync')} --remove ${runId} --target ${target} --store ${store}`;
    }
    case 'anonymize': {
      const snapshot = (output['snapshot'] ?? {}) as { operationId?: unknown };
      const id = text(snapshot.operationId);
      if (id === undefined || orgAlias === undefined) return undefined;
      return `${commandOf('dataops')} anonymize --org ${orgAlias} --restore ${id}`;
    }
    case 'rewind': {
      const checkpointId = text(output['checkpointId']);
      if (checkpointId === undefined || orgAlias === undefined) return undefined;
      if (output['undoUntil'] === undefined) return undefined;
      return `${commandOf('checkpoint')} undo --org ${orgAlias} --checkpoint ${checkpointId}`;
    }
    case 'checkpoint': {
      const checkpointId = text(output['checkpointId']);
      if (checkpointId === undefined || orgAlias === undefined) return undefined;
      return `${commandOf('checkpoint')} delete --org ${orgAlias} --checkpoint ${checkpointId}`;
    }
    default:
      return undefined;
  }
}

/** The exit code of a run, from how it ended. */
export function runExit(
  run: Pick<PipelineRun, 'status'>,
  failOnPartial: boolean,
  stoppedBy: StopSignal | undefined,
): number {
  switch (run.status) {
    case 'completed':
      return DONE_EXIT;
    case 'completed_with_warnings':
      return failOnPartial ? PARTIAL_EXIT : DONE_EXIT;
    case 'cancelled':
      return stoppedBy !== undefined ? stopExitCode(stoppedBy) : FAILED_EXIT;
    default:
      return FAILED_EXIT;
  }
}

/** What the run's history keeps of it, as the editor's History tab lists a run. */
export function historyEntryOf(
  run: PipelineRun,
  triggeredBy: PipelineRun['triggeredBy'] = run.triggeredBy,
): PipelineHistoryEntry {
  return {
    runId: run.id,
    pipelineId: run.pipelineId,
    pipelineName: run.pipelineName,
    status: run.status,
    // The handler runs every request it is sent as started by hand; the
    // launcher says what started it.
    triggeredBy,
    startTime: run.startTime,
    duration: run.duration ?? 0,
    stepCount: run.stepResults.filter((step) => step.status !== 'skipped').length,
    errorCount: run.stepResults.filter((step) => step.status === 'failed').length,
    steps: run.stepResults.map((step) => ({
      stepName: step.stepName,
      stepType: step.stepType,
      status: step.status,
      ...(step.duration !== undefined ? { duration: step.duration } : {}),
      ...(step.summary !== undefined ? { summary: step.summary } : {}),
      ...(step.error !== undefined ? { error: step.error } : {}),
      ...(step.approval !== undefined ? { approval: step.approval } : {}),
    })),
    ranFrom: 'commandLine',
  };
}

/** The folder a pipeline's store is in unless `--store` names one. */
export function defaultStoreOf(root: string, pipelineId: string): string {
  return join(pipelineFolderOf(root, pipelineId), 'store');
}

/** A request's payload, read loosely. */
function payloadOf(answer: PanelAnswer): Record<string, unknown> {
  return (answer.message?.payload ?? {}) as Record<string, unknown>;
}

/** Why a request to the host did not come back answered, in a sentence. */
function unanswered(answer: PanelAnswer, what: string): string {
  if (answer.outcome === 'unanswered') return `${what} was not answered in time.`;
  const payload = payloadOf(answer);
  return `${what} failed: ${String(payload['message'] ?? payload['error'] ?? answer.outcome)}`;
}

/** The refusals that leave an org of the file unreached: the steps are not checked then. */
const UNREACHED: ReadonlySet<string> = new Set([
  'ORG_NO_ALIAS',
  'ORG_UNKNOWN_KEY',
  'ORG_NOT_CONNECTED',
]);

/** A plan made: the file, the orgs as reached, the check, and every refusal. */
interface Planned {
  file: SandforgePipelineFile;
  digestMatches: boolean;
  orgs: RunOrg[];
  values: Record<string, string>;
  check?: Extract<PipelineExportOutcome, { exported: true }>;
  refusals: PlanRefusal[];
  notes: string[];
  hosted?: PipelineHost;
}

/**
 * Connect, type and check: everything a run does before its first step, and
 * nothing it does after. Each org is reached once; one that is not, or not
 * the file's, is a refusal, and the check is made only once each is.
 */
async function planIn(
  pipelineHost: PipelineHost,
  file: SandforgePipelineFile,
  args: PipelineArgs,
  deps: Required<Pick<PipelineDeps, 'isTTY'>>,
  base: {
    orgs: RunOrg[];
    values: Record<string, string>;
    refusals: PlanRefusal[];
    notes: string[];
  },
): Promise<Planned> {
  const { host, orgRegistry, configStore } = pipelineHost;
  const refusals = [...base.refusals];
  const notes = [...base.notes];
  const orgs: RunOrg[] = [];
  for (const each of base.orgs) {
    let org: SalesforceOrg;
    try {
      org = await host.connect(each.alias);
    } catch (err: unknown) {
      refusals.push({
        code: 'ORG_NOT_CONNECTED',
        org: each.key,
        message: `${each.alias} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
        wayOut: `"sf org display --target-org ${each.alias}" says what sf holds for it; sign in to it under that alias.`,
      });
      orgs.push(each);
      continue;
    }
    const kind = liveKindOf(org);
    const matched = matchOrg(
      each.key,
      each.alias,
      each.file,
      { organizationId: org.orgId ?? org.id, kind },
      args.accepted.get(each.key),
    );
    if (!matched.ok) {
      refusals.push({
        code: matched.code,
        org: each.key,
        message: matched.message,
        wayOut: matched.wayOut,
      });
    } else if (matched.note !== undefined) {
      notes.push(matched.note);
    }
    const marked = markStaging(orgRegistry, org, each.file, each.alias);
    if (marked.note !== undefined) notes.push(marked.note);
    orgs.push({ ...each, org: marked.org, kind });
  }
  // The steps are checked against the orgs they name: with one not reached,
  // the check would refuse each of its steps for an org it does not know.
  if (refusals.some((refusal) => UNREACHED.has(refusal.code))) {
    notes.push('The steps are checked once every org of the file is reached.');
    return { file, digestMatches: true, orgs, values: base.values, refusals, notes };
  }

  const idOf = (key: string): string | undefined => orgs.find((org) => org.key === key)?.org?.id;
  const hosted = hostedPipeline(file, idOf);
  saveCarried(configStore, file, hosted);
  const saved = await host.request({
    type: 'pipeline:save',
    payload: { id: hosted.pipeline.id, config: hosted.pipeline },
    timeoutMs: STORE_WAIT_MS,
  });
  if (saved.outcome !== 'answered') {
    refusals.push({
      code: 'PIPELINE_REFUSED',
      message: unanswered(saved, 'Saving the pipeline in the store'),
    });
    return { file, digestMatches: true, orgs, values: base.values, refusals, notes };
  }
  for (const alias of args.confirmRewind) {
    for (const step of file.pipeline.steps) {
      if (step.type !== 'rewind') continue;
      if (orgs.find((org) => org.key === step.config['orgId'])?.alias !== alias) continue;
      const granted = await host.request({
        type: 'pipeline:rewind-grant',
        payload: { pipelineId: hosted.pipeline.id, stepId: step.id, typed: alias },
        timeoutMs: CHECK_WAIT_MS,
      });
      const answer = payloadOf(granted) as Partial<PipelineRewindGrantResponse['payload']>;
      if (granted.outcome !== 'answered' || answer.granted !== true) {
        refusals.push({
          code: 'REWIND_NOT_CONFIRMED',
          step: step.name,
          message:
            granted.outcome !== 'answered'
              ? unanswered(granted, `The confirmation of Rewind step "${step.name}"`)
              : `Rewind step "${step.name}" was not confirmed for ${alias}: ${String(
                  (answer as { code?: unknown }).code ?? 'refused',
                )}${(answer as { why?: unknown }).why ? ` (${String((answer as { why?: unknown }).why)})` : ''}.`,
          wayOut:
            'take the checkpoint it names on this machine, or import it (sandforge checkpoint import).',
        });
      }
    }
  }

  const checked = await host.request({
    type: 'pipeline:export',
    payload: { pipelineId: hosted.pipeline.id },
    timeoutMs: CHECK_WAIT_MS,
  });
  const outcome = payloadOf(checked) as unknown as PipelineExportOutcome;
  if (checked.outcome !== 'answered' || outcome.exported !== true) {
    refusals.push({
      code: 'PIPELINE_REFUSED',
      message:
        checked.outcome !== 'answered'
          ? unanswered(checked, 'The check of the pipeline')
          : `The check of the pipeline did not run: ${outcome.exported === false ? outcome.message : ''}`,
    });
    return { file, digestMatches: true, orgs, values: base.values, refusals, notes };
  }
  refusals.push(
    ...checkRefusals(file, outcome, orgs, { approve: args.approve, isTTY: deps.isTTY }),
  );
  return { file, digestMatches: true, orgs, values: base.values, check: outcome, refusals, notes };
}

/** The lines a plan prints: the pipeline, its orgs, its steps, then each refusal. */
export function planLines(
  planned: Pick<Planned, 'file' | 'orgs' | 'check' | 'refusals' | 'notes' | 'digestMatches'>,
): string[] {
  const { file } = planned;
  const lines = [
    `Pipeline "${file.pipeline.name}" (${file.pipeline.steps.length} ${file.pipeline.steps.length === 1 ? 'step' : 'steps'}), ` +
      `exported from ${file.exportedBy} on ${file.exportedAt.slice(0, 10)}.`,
  ];
  if (!planned.digestMatches) {
    lines.push(
      '  The file was edited since it was exported: its digest no longer matches what it holds.',
    );
  }
  const uses = new Map((planned.check?.orgs ?? []).map((org) => [org.alias ?? '', org] as const));
  const orgLines = planned.orgs.map((org) => {
    const kind = org.kind ?? org.file.kind;
    const what = {
      sandbox: 'sandbox',
      scratch: 'scratch org',
      developer: 'Developer Edition org',
      production: 'production org',
    }[kind];
    const id = org.org?.orgId ?? org.file.organizationId;
    const used = uses.get(org.alias);
    const how =
      used === undefined
        ? ''
        : used.writtenBy.length > 0
          ? ` (written: ${used.writtenBy.join(', ')})`
          : ' (read)';
    return `${org.alias} ${what}${org.org?.staging === true ? ' marked Staging' : ''} ${id}${how}`;
  });
  if (orgLines.length > 0) lines.push(`Orgs: ${orgLines.join('; ')}`);
  for (const [index, step] of (planned.check?.steps ?? []).entries()) {
    const fate = step.fate === 'refused' ? 'refused' : step.fate === 'asks' ? 'asks' : 'runs';
    lines.push(`  ${index + 1} ${step.type} "${step.name}": ${fate}`);
  }
  for (const note of planned.notes) lines.push(`  ${note}`);
  if (planned.refusals.length > 0) {
    lines.push(`Refused before the first step, nothing run (exit ${REFUSED_EXIT}):`);
    for (const refusal of planned.refusals) {
      lines.push(
        `  - ${refusal.message}${refusal.wayOut ? ` ${capitalized(refusal.wayOut)}` : ''}`,
      );
    }
  }
  return lines;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The orgs as the JSON gives them. */
function orgsJson(orgs: readonly RunOrg[]): Array<Record<string, unknown>> {
  return orgs.map((org) => ({
    key: org.key,
    alias: org.alias,
    organizationId: org.org?.orgId ?? org.file.organizationId,
    kind: org.kind ?? org.file.kind,
    staging: org.org?.staging === true,
  }));
}

/** A copy of the store a plan reads, so that it keeps nothing of its own: removed after. */
function planStoreOf(store: string): string {
  const copy = mkdtempSync(join(tmpdir(), 'sandforge-pipeline-plan-'));
  const kept = join(store, 'configStore.json');
  if (existsSync(kept)) copyFileSync(kept, join(copy, 'configStore.json'));
  return copy;
}

/** The answer an Approval step gets: ahead from `--approve`, or at the terminal. */
function approvalAsker(
  approve: readonly string[],
  isTTY: boolean,
  terminal: PipelineDeps['terminal'],
  stopped: AbortSignal,
): (question: ApprovalQuestionText) => Promise<ApprovalAnswer | undefined> {
  return async (question) => {
    if (approve.includes(question.stepName)) return { decision: 'approve', via: 'commandLine' };
    if (!isTTY) return undefined;
    const yes = await confirm(
      `Approval step "${question.stepName}"${question.pipelineName ? ` of pipeline "${question.pipelineName}"` : ''}` +
        `${question.message ? `: ${question.message}` : ''} — approve? (it waits until ${question.expiresAt})`,
      terminal,
      stopped,
    );
    return { decision: yes ? 'approve' : 'reject', via: 'terminal' };
  };
}

/** Read the file, or say why not: exit 2, nothing run. */
function readFileArg(
  path: string,
):
  | { ok: true; file: SandforgePipelineFile; digestMatches: boolean }
  | { ok: false; refusal: PipelineFileRefusal } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err: unknown) {
    return {
      ok: false,
      refusal: {
        code: 'PIPELINE_FILE_NOT_JSON',
        message: `${path} could not be read: ${err instanceof Error ? err.message : String(err)}`,
        issues: [],
      },
    };
  }
  return readPipelineFile(text);
}

/** Run what the line asks; exported so it can be tested. */
export async function main(argv: string[] = process.argv, deps: PipelineDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  if (argv.slice(2).includes('--help') || argv.slice(2).includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  let args: PipelineArgs;
  try {
    args = parseArgs(argv, env);
  } catch (err: unknown) {
    if (!(err instanceof BadLine)) throw err;
    process.stderr.write(`${err.message} Run with --help.\n`);
    endWith(REFUSED_EXIT);
    return;
  }
  const say: Say = {
    line: (text) => process[args.json ? 'stderr' : 'stdout'].write(`${text}\n`),
    json: (value) => {
      if (args.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    },
  };
  const root = deps.pipelinesRoot ?? defaultPipelinesRoot(env);
  const read = readFileArg(args.file);
  if (!read.ok) {
    const refusals = fileRefusals(read.refusal, args.verb, args.file);
    for (const refusal of refusals) {
      process.stderr.write(
        `${refusal.message}${refusal.wayOut ? ` Run it with: ${refusal.wayOut}` : ''}\n`,
      );
    }
    say.json({ tool: 'sandforge-pipeline', refusals, exit: REFUSED_EXIT });
    endWith(REFUSED_EXIT);
    return;
  }
  const { file } = read;
  if (args.verb === 'history') {
    historyVerb(file, root, say);
    return;
  }
  const isTTY = deps.isTTY ?? process.stdin.isTTY === true;
  const store = args.store ?? defaultStoreOf(root, file.pipeline.id);
  if (args.verb === 'confirm') {
    await confirmVerb(
      file,
      args,
      store,
      { ...deps, isTTY, version: deps.version ?? sandforgeVersion() },
      say,
    );
    return;
  }
  await planOrRun(
    file,
    read.digestMatches,
    args,
    store,
    root,
    {
      isTTY,
      terminal: deps.terminal,
      version: deps.version ?? sandforgeVersion(),
    },
    say,
  );
}

/** `plan` and `run`: the plan, then for a run its steps as they go, how it ended, and how to take it back. */
async function planOrRun(
  file: SandforgePipelineFile,
  digestMatches: boolean,
  args: PipelineArgs,
  store: string,
  root: string,
  deps: { isTTY: boolean; terminal: PipelineDeps['terminal']; version: string },
  say: Say,
): Promise<void> {
  const running = args.verb === 'run';
  const aliases = aliasesOf(file, args.orgs);
  const vars = variablesOf(file, args.vars);
  const named = namedStepRefusals(file, args, aliases.orgs);
  const base = {
    orgs: aliases.orgs,
    values: vars.values,
    refusals: [...aliases.refusals, ...vars.refusals, ...named],
    notes: [] as string[],
  };

  // One run of a pipeline at a time on this machine, from before its store
  // is read until it ends: two runs of one store would write over each
  // other's watermarks.
  let lock: PipelineRunLock | undefined;
  if (running) {
    const taken = acquirePipelineRunLock(root, file.pipeline.id, {
      pipelineName: file.pipeline.name,
      ranFrom: 'commandLine',
      triggeredBy: args.triggeredBy,
      ...(args.dryRun ? { dryRun: true } : {}),
    });
    if ('busy' in taken) {
      const refusal: PlanRefusal = {
        code: 'PIPELINE_RUNNING',
        message: pipelineRunningRefusal(taken.busy, file.pipeline.name),
      };
      process.stderr.write(`${refusal.message}\n`);
      say.json({ tool: 'sandforge-pipeline', refusals: [refusal], exit: REFUSED_EXIT });
      endWith(REFUSED_EXIT);
      return;
    }
    lock = taken.lock;
    if (taken.tookOver) base.notes.push(pipelineLockTakenOverLine(taken.tookOver));
  } else {
    const holder = pipelineRunLockHolder(root, file.pipeline.id);
    if (holder !== undefined) base.notes.push(pipelineRunningRefusal(holder, file.pipeline.name));
  }

  const stop = new AbortController();
  let stoppedBy: StopSignal | undefined;
  let operationId: string | undefined;
  let pipelineHost: PipelineHost | undefined;
  const release = onStopSignal((signal) => {
    stoppedBy = signal;
    stop.abort();
    say.line(`Stopping (${signal}): the step under way is stopped, and the run ends cancelled.`);
    if (operationId !== undefined && pipelineHost !== undefined) {
      void pipelineHost.host.request({
        type: 'execution:abort',
        payload: { operationId },
        timeoutMs: STORE_WAIT_MS,
      });
    }
  });
  const hostStore = running ? store : planStoreOf(store);
  const lines: StepLine[] = [];
  /** The steps said as they ended. */
  const told = new Set<string>();
  const stepIndex = new Map(file.pipeline.steps.map((step, index) => [step.id, index]));
  try {
    try {
      pipelineHost = createPipelineHost({
        storeDir: hostStore,
        log: (line) => say.line(`  ${line}`),
        setting: settingOf(file, args.timeoutMs),
        notify: (message) => say.line(`  notification: ${message}`),
        sandforgeVersion: deps.version,
        askApproval: approvalAsker(args.approve, deps.isTTY, deps.terminal, stop.signal),
        onPost: (message) => {
          if (message.type !== 'pipeline:step') return;
          const payload = (message.payload ?? {}) as { stepId?: string; status?: string };
          if (payload.status !== 'running' && payload.stepId !== undefined)
            told.add(payload.stepId);
          stepLine(message, file, stepIndex, say);
        },
      });
    } catch (err: unknown) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      endWith(FAILED_EXIT);
      return;
    }
    const planned = await planIn(pipelineHost, file, args, deps, base);
    planned.digestMatches = digestMatches;
    if (stoppedBy !== undefined) {
      endWith(stopExitCode(stoppedBy));
      return;
    }
    for (const line of planLines(planned)) say.line(line);
    const pipelineJson = {
      id: file.pipeline.id,
      name: file.pipeline.name,
      file: args.file,
      digest: file.digest,
      digestMatches,
    };
    if (planned.refusals.length > 0 || !running) {
      const exit = planned.refusals.length > 0 ? REFUSED_EXIT : DONE_EXIT;
      say.json({
        tool: 'sandforge-pipeline',
        pipeline: pipelineJson,
        plan: !running,
        ...(running ? { dryRun: args.dryRun } : {}),
        orgs: orgsJson(planned.orgs),
        steps: (planned.check?.steps ?? []).map((step) => ({
          name: step.name,
          type: step.type,
          fate: step.fate,
          ...(step.refusal !== undefined ? { refusal: step.refusal } : {}),
        })),
        refusals: planned.refusals,
        notes: planned.notes,
        exit,
      });
      endWith(exit);
      return;
    }

    // The run: its lock handed to the handler, which takes it for the run
    // as the command line's, and lets it go as the run ends.
    lock?.release();
    lock = undefined;
    const before = snapshotKeys(pipelineHost.configStore);
    operationId = `cli-${randomUUID()}`;
    say.line(args.dryRun ? 'Dry run: the steps that write say what they would do.' : 'Run:');
    const answer = await pipelineHost.host.request({
      id: operationId,
      type: 'pipeline:execute',
      responseType: 'pipeline:run:response',
      payload: {
        pipeline: {
          ...(pipelineHost.configStore.get<Record<string, unknown>>(
            `pipeline:saved:${file.pipeline.id}`,
          ) ?? {}),
        },
        variables: planned.values,
        ...(args.dryRun ? { dryRun: true } : {}),
      },
      timeoutMs: RUN_WAIT_MS,
    });
    if (answer.outcome !== 'answered') {
      const payload = payloadOf(answer);
      const refused = payload['code'] === 'PIPELINE_RUNNING';
      const message = unanswered(answer, 'The run');
      process.stderr.write(`${message}\n`);
      say.json({
        tool: 'sandforge-pipeline',
        pipeline: pipelineJson,
        dryRun: args.dryRun,
        refusals: [{ code: String(payload['code'] ?? 'RUN_FAILED'), message }],
        exit: refused ? REFUSED_EXIT : FAILED_EXIT,
      });
      endWith(refused ? REFUSED_EXIT : FAILED_EXIT);
      return;
    }
    const run = payloadOf(answer) as unknown as PipelineRun & { dryRun?: boolean };
    const aliasOfId = (orgId: string): string | undefined =>
      planned.orgs.find((org) => org.org?.id === orgId)?.alias;
    const syncTarget = (configId: string): string | undefined => {
      const key = file.syncConfigs[configId]?.targetOrgId;
      return planned.orgs.find((org) => org.key === key)?.alias;
    };
    for (const result of run.stepResults) {
      const takeBack = takeBackOf(result, aliasOfId, store, syncTarget);
      lines.push({
        name: result.stepName,
        type: result.stepType,
        status: result.status,
        ...(result.summary !== undefined ? { summary: result.summary } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(takeBack !== undefined ? { takeBack } : {}),
      });
    }
    const exit = runExit(run, args.failOnPartial, stoppedBy);
    say.line(
      `${args.dryRun ? 'Dry run' : 'Run'} ${run.status}${run.error ? `: ${run.error}` : ''}` +
        ` (exit ${exit}).`,
    );
    // A step said as it ended is not said again; one the run refused or
    // passed over before it began is.
    for (const [index, line] of lines.entries()) {
      if (told.has(run.stepResults[index]?.stepId ?? '')) continue;
      say.line(
        `  ${line.type} "${line.name}": ${line.status}${line.summary ? ` — ${line.summary}` : ''}${line.error ? ` — ${line.error}` : ''}`,
      );
    }
    const takeBacks = lines.filter((line) => line.takeBack !== undefined).reverse();
    if (takeBacks.length > 0) {
      say.line('To take this run back, in this order:');
      for (const line of takeBacks) say.line(`  ${line.takeBack}`);
    }
    if (!args.dryRun) {
      const shared = shareSnapshots(pipelineHost.configStore, pipelineHost.backupDir, before);
      if (shared > 0) {
        say.line(
          `  ${shared} snapshot${shared === 1 ? '' : 's'} listed in ${pipelineHost.backupDir}, where sandforge dataops restores from.`,
        );
      }
      try {
        recordCliRun(root, file.pipeline.id, historyEntryOf(run, args.triggeredBy));
      } catch (err: unknown) {
        say.line(
          `  warning: the run was not kept in the history: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    say.json({
      tool: 'sandforge-pipeline',
      pipeline: pipelineJson,
      dryRun: args.dryRun,
      status: run.status,
      startedAt: run.startTime,
      endedAt: run.endTime,
      triggeredBy: args.triggeredBy,
      orgs: orgsJson(planned.orgs),
      steps: lines,
      approvals: run.stepResults
        .filter((step) => step.approval !== undefined)
        .map((step) => ({ step: step.stepName, ...step.approval })),
      notes: planned.notes,
      exit,
    });
    endWith(exit);
  } finally {
    release();
    lock?.release();
    pipelineHost?.dispose();
    if (hostStore !== store) rmSync(hostStore, { recursive: true, force: true });
  }
}

/** A step's line as it starts or ends, from the message the page is told of it. */
function stepLine(
  message: PostedMessage,
  file: SandforgePipelineFile,
  stepIndex: ReadonlyMap<string, number>,
  say: Say,
): void {
  const payload = (message.payload ?? {}) as {
    stepId?: string;
    status?: string;
    summary?: string;
    error?: string;
    approval?: { expiresAt?: string };
  };
  const index = stepIndex.get(payload.stepId ?? '');
  if (index === undefined) return;
  const step = file.pipeline.steps[index];
  if (step === undefined) return;
  const head = `  ${index + 1} ${step.type} "${step.name}"`;
  if (payload.status === 'running') {
    say.line(
      payload.approval
        ? `${head}: waits for its answer until ${payload.approval.expiresAt ?? '?'}`
        : `${head}: running`,
    );
    return;
  }
  say.line(
    `${head}: ${payload.status ?? '?'}${payload.summary ? ` — ${payload.summary}` : ''}${payload.error ? ` — ${payload.error}` : ''}`,
  );
}

/** `history`: the runs of the pipeline the command line made here, newest first. */
function historyVerb(file: SandforgePipelineFile, root: string, say: Say): void {
  const warnings: string[] = [];
  const runs = cliRunHistory(root, (line) => warnings.push(line))
    .read()
    .filter((entry) => entry.pipelineId === file.pipeline.id);
  for (const warning of warnings) process.stderr.write(`${warning}\n`);
  say.line(
    `Pipeline "${file.pipeline.name}": ${runs.length} ${runs.length === 1 ? 'run' : 'runs'} from the command line on this machine (${cliHistoryFileOf(root, file.pipeline.id)}).`,
  );
  for (const run of runs) {
    say.line(
      `  ${run.startTime}  ${run.status}  ${run.triggeredBy}  ${run.stepCount} ${run.stepCount === 1 ? 'step' : 'steps'}` +
        `${run.errorCount > 0 ? `, ${run.errorCount} failed` : ''}`,
    );
  }
  say.json({
    tool: 'sandforge-pipeline',
    pipeline: { id: file.pipeline.id, name: file.pipeline.name },
    runs,
  });
}

/**
 * `confirm`: each Rewind step confirmed at the terminal, as the page's
 * confirmation does it — its preview read from the org first, then its
 * org's alias typed — and kept in the store the runs read.
 */
async function confirmVerb(
  file: SandforgePipelineFile,
  args: PipelineArgs,
  store: string,
  deps: { isTTY: boolean; terminal?: PipelineDeps['terminal']; version: string },
  say: Say,
): Promise<void> {
  const rewinds = file.pipeline.steps.filter((step) => step.type === 'rewind');
  if (rewinds.length === 0) {
    say.line(`Pipeline "${file.pipeline.name}" has no Rewind step: nothing to confirm.`);
    return;
  }
  if (!deps.isTTY) {
    process.stderr.write(
      "confirm asks for each Rewind step's alias to be typed at a terminal: there is none. " +
        'Give --confirm-rewind <alias> to run instead. Nothing was confirmed.\n',
    );
    endWith(REFUSED_EXIT);
    return;
  }
  const aliases = aliasesOf(file, args.orgs);
  if (aliases.refusals.length > 0) {
    for (const refusal of aliases.refusals)
      process.stderr.write(`${refusal.message} ${capitalized(refusal.wayOut ?? '')}\n`);
    endWith(REFUSED_EXIT);
    return;
  }
  let pipelineHost: PipelineHost;
  try {
    pipelineHost = createPipelineHost({
      storeDir: store,
      log: (line) => say.line(`  ${line}`),
      setting: settingOf(file, undefined),
      notify: () => undefined,
      sandforgeVersion: deps.version,
    });
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    endWith(FAILED_EXIT);
    return;
  }
  try {
    const rewound = new Set(rewinds.map((step) => String(step.config['orgId'] ?? '')));
    const base = {
      orgs: aliases.orgs.filter((org) => rewound.has(org.key)),
      values: {},
      refusals: [] as PlanRefusal[],
      notes: [] as string[],
    };
    const planned = await planIn(
      pipelineHost,
      file,
      { ...args, approve: [], confirmRewind: [] },
      { isTTY: true },
      base,
    );
    const blocking = planned.refusals.filter((refusal) =>
      ['ORG_NOT_CONNECTED', 'ORG_MOVED'].includes(refusal.code),
    );
    if (blocking.length > 0) {
      for (const refusal of blocking)
        process.stderr.write(`${refusal.message} ${capitalized(refusal.wayOut ?? '')}\n`);
      endWith(REFUSED_EXIT);
      return;
    }
    let refused = 0;
    for (const step of rewinds) {
      const org = planned.orgs.find((each) => each.key === step.config['orgId']);
      if (org?.org === undefined) continue;
      const checkpointId = String(step.config['checkpointId'] ?? '');
      say.line(`Rewind step "${step.name}" rewinds ${org.alias} to checkpoint ${checkpointId}.`);
      const preview = await pipelineHost.host.request({
        type: 'checkpoint:preview',
        payload: { checkpointId },
        timeoutMs: CHECK_WAIT_MS,
      });
      if (preview.outcome !== 'answered') {
        say.line(`  ${unanswered(preview, 'Its preview')} It is not confirmed.`);
        refused += 1;
        continue;
      }
      const listed = await pipelineHost.host.request({
        type: 'checkpoint:list',
        timeoutMs: STORE_WAIT_MS,
      });
      const kept = ((payloadOf(listed)['checkpoints'] ?? []) as CheckpointListEntry[]).find(
        (entry) => entry.checkpointId === checkpointId,
      )?.checkpoint;
      for (const line of previewLines(
        org.alias,
        { name: kept?.name ?? checkpointId, takenAt: kept?.takenAt ?? '' },
        payloadOf(preview) as unknown as PreviewAnswer,
        org.org.username,
      )) {
        say.line(`  ${line}`);
      }
      const typedAlias = await typed(
        `Type ${org.alias} to confirm this step's rewind:`,
        deps.terminal,
      );
      if (typedAlias !== org.alias) {
        say.line('  Not confirmed: what was typed is not the alias.');
        refused += 1;
        continue;
      }
      const granted = await pipelineHost.host.request({
        type: 'pipeline:rewind-grant',
        payload: { pipelineId: file.pipeline.id, stepId: step.id, typed: typedAlias },
        timeoutMs: CHECK_WAIT_MS,
      });
      const answer = payloadOf(granted);
      if (granted.outcome === 'answered' && answer['granted'] === true) {
        say.line(
          `  Confirmed, kept in ${store}: the runs of this store rewind it without --confirm-rewind.`,
        );
      } else {
        say.line(
          `  Not confirmed: ${granted.outcome === 'answered' ? String(answer['code']) : unanswered(granted, 'The confirmation')}.`,
        );
        refused += 1;
      }
    }
    endWith(refused > 0 ? FAILED_EXIT : DONE_EXIT);
  } finally {
    pipelineHost.dispose();
  }
}

// `tsx` runs this file directly; the check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-pipeline')) {
  holdOutputWhole();
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
