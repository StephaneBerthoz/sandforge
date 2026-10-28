/**
 * `sandforge-seed --scenario` and `--test-file`: a scenario pack seeded from
 * the command line, as the Seed page's scenario card seeds it, with no AI
 * key, and the Agentforce test file of its run written into a project.
 *
 * The pack is a shipped one, named by its id, or a `*.sandforge-scenario.json`
 * file. It is compiled with the target's own case statuses and the field its
 * articles' body can be written to, read before the first write; then the
 * run is a template's run — dry run, storage, automation and email gates,
 * Production Guard's refusal, the run file `--remove` takes it back from.
 * Beside the run file, a companion keeps the ids of the open cases the
 * agent's tests are about, by key: `--test-file` writes the file from it,
 * once the org has an agent, and never deploys it or runs it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  AgentDefinition,
  AgentTestChoice,
  CompiledScenario,
  ScenarioCompileOptions,
  ScenarioPack,
  SeedScenarioPreparation,
  SeedScenarioTestFileOutcome,
} from '@sandforge/shared';
import { AGENT_TEST_RUNNERS, BUILT_IN_SCENARIO_PACKS } from '@sandforge/shared';
import { readAgentCatalog, type AgentCatalogRead } from '../src/modules/agentforce/agentCatalog.js';
import { nodeAgentTestSpecFiles } from '../src/modules/agentforce/testSpecWriter.js';
import { compileScenario } from '../src/modules/seed/scenario/compileScenario.js';
import {
  prepareScenario,
  readScenarioCaseStatus,
  scenarioKnowledge,
  toolingQueryAll,
  type ScenarioDescribe,
  type ScenarioQuery,
  type ToolingQueries,
} from '../src/modules/seed/scenario/scenarioOrg.js';
import {
  findScenarioPack,
  nodeScenarioPackFiles,
  readScenarioPackText,
} from '../src/modules/seed/scenario/scenarioPackFiles.js';
import {
  nodeScenarioSidecarFiles,
  readScenarioRunSidecar,
  scenarioRunSidecar,
  writeScenarioRunSidecar,
} from '../src/modules/seed/scenario/scenarioRunSidecar.js';
import {
  scenarioProjectOf,
  writeRunTestFile,
} from '../src/modules/seed/scenario/scenarioTestFile.js';
import type { SeedObjectAccess } from '../src/modules/seed/SeedOrchestrator.js';
import { readRunFile } from '../src/modules/sync/SyncRunCreations.js';
import { refuseUnreadArguments, type CommandFlags } from './commandLine.js';

/** A pack the line names, read, or why it cannot be. */
export function scenarioPackOf(
  value: string,
  read: (file: string) => string = (file) => readFileSync(file, 'utf8'),
): { pack: ScenarioPack; from: string } | { refusal: string } {
  const shipped = BUILT_IN_SCENARIO_PACKS.find((pack) => pack.id === value);
  if (shipped) return { pack: shipped, from: 'built-in' };
  if (!existsSync(value)) {
    return {
      refusal:
        `--scenario takes the id of a scenario SandForge ships ` +
        `(${BUILT_IN_SCENARIO_PACKS.map((pack) => pack.id).join(', ')}) or a scenario file, ` +
        `not "${value}".`,
    };
  }
  let text: string;
  try {
    text = read(value);
  } catch (err: unknown) {
    return {
      refusal: `${value} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = readScenarioPackText(text);
  if ('issues' in parsed) {
    return {
      refusal: `${value} is not a scenario pack:\n${parsed.issues.map((issue) => `  ${issue}`).join('\n')}`,
    };
  }
  return { pack: parsed.pack, from: resolve(value) };
}

/** What the target is read through, before a scenario is compiled for it. */
export interface ScenarioTarget {
  query: ScenarioQuery;
  objectAccess: (objectApiName: string) => Promise<SeedObjectAccess>;
  describe: ScenarioDescribe;
}

/**
 * A pack compiled for the target, as the page compiles it: the target's case
 * statuses, the first field its articles' body can be written to, the seed
 * asked for. Or every issue of the pack.
 */
export async function scenarioForTarget(
  target: ScenarioTarget,
  pack: ScenarioPack,
  seed: number | undefined,
): Promise<
  | {
      preparation: SeedScenarioPreparation;
      compiled: CompiledScenario;
      options: ScenarioCompileOptions;
    }
  | { issues: string[] }
> {
  const prepared = prepareScenario(pack, {
    caseStatus: await readScenarioCaseStatus(target.query),
    knowledge: await scenarioKnowledge(target.objectAccess, target.describe),
    ...(seed !== undefined ? { seed } : {}),
  });
  if ('issues' in prepared) return prepared;
  const { options } = prepared.preparation;
  return { ...prepared, compiled: compileScenario(pack, options), options };
}

/** What a scenario's run would write, as the summary says it before the first write. */
export function scenarioPlanLines(
  pack: ScenarioPack,
  preparation: SeedScenarioPreparation,
): string[] {
  const { options, knowledge, caseStatusFrom } = preparation;
  return [
    `scenario: ${pack.id} (${pack.name}), seed ${options.seed}  (--scenario-seed ${options.seed} writes the same again)`,
    ...preparation.objects.map(
      (object) =>
        `  ${object.objectApiName}: ${object.recordCount} record(s)` +
        (object.optional ? ', skipped by an org without it' : ''),
    ),
    `  cases: open "${options.caseStatus.open}", closed "${options.caseStatus.closed}"` +
      (caseStatusFrom.from === 'org' ? " (the org's)" : ` (a new org's: ${caseStatusFrom.reason})`),
    knowledge.available
      ? `  articles: written as drafts, ` +
        (options.articleBodyField
          ? `their body in ${options.articleBodyField}`
          : 'with their summary alone: the org offers no long text field for a body')
      : `  articles: skipped, ${knowledge.reason}: the tests that answer from Knowledge are ` +
        'written, and the agent will have no article to cite',
    `  tests: ${preparation.tests}, written to a file once the run has ended (--test-file)`,
  ];
}

/** What a scenario's run kept for its test file, as the summary says it. */
export interface ScenarioRunKept {
  packId: string;
  tests: number;
  openCases: number;
  openCasesWritten: number;
  /** The companion file, once written; absent when no open case was. */
  companion?: string;
  /** Why the companion file could not be written. */
  unkept?: string;
}

/** Keep a scenario's companion file beside its run's, under the journal folder. */
export async function keepScenarioRun(input: {
  journalDir: string;
  runId: string;
  pack: ScenarioPack;
  compiled: CompiledScenario;
  options: ScenarioCompileOptions;
  caseIds: Readonly<Record<string, string>>;
}): Promise<ScenarioRunKept> {
  const openKeys = new Set(
    input.compiled.tests.flatMap((test) => (test.openCase ? [test.openCase.caseKey] : [])),
  );
  const openCasesWritten = Object.keys(input.caseIds).filter((key) => openKeys.has(key)).length;
  const kept: ScenarioRunKept = {
    packId: input.pack.id,
    tests: input.compiled.tests.length,
    openCases: openKeys.size,
    openCasesWritten,
  };
  if (openCasesWritten === 0) return kept;
  try {
    const companion = await writeScenarioRunSidecar(
      nodeScenarioSidecarFiles(),
      input.journalDir,
      scenarioRunSidecar({
        runId: input.runId,
        pack: input.pack,
        compiled: input.compiled,
        options: input.options,
        caseIds: input.caseIds,
      }),
    );
    return { ...kept, companion };
  } catch (err: unknown) {
    return { ...kept, unkept: err instanceof Error ? err.message : String(err) };
  }
}

/** The command that writes a run's test file, its agent and topics to fill in. */
export function testFileCommand(runFile: string, target: string, pack: ScenarioPack): string {
  return [
    'sandforge-seed --test-file',
    runFile,
    '--target',
    target,
    '--agent <agent API name>',
    ...pack.topics.map((topic) => `--topic ${topic.key}=<agent topic>`),
  ].join(' ');
}

/** An org's agents as the line lists them: each with its topics and their actions. */
export function agentLines(agents: readonly AgentDefinition[]): string[] {
  return agents.flatMap((agent) => [
    `  ${agent.name}${agent.label ? ` (${agent.label})` : ''}`,
    ...agent.topics.map(
      (topic) =>
        `    topic ${topic.name}` +
        (topic.actions.length > 0
          ? `: ${topic.actions.map((action) => action.name).join(', ')}`
          : ''),
    ),
  ]);
}

// ─── --test-file ─────────────────────────────────────────────────────────────

/** What `--test-file` was given. */
export interface TestFileArgs {
  /** The run's file, or its id. */
  run: string;
  target: string;
  agent?: string;
  topics: AgentTestChoice['topics'];
  guardTopic: string | null;
  runner: AgentTestChoice['runner'];
  /** The pack, when it is neither shipped nor a file of the project. */
  scenario?: string;
  /** The project the file is written into. */
  project: string;
  overwrite: boolean;
  json: boolean;
}

/** What the line of `--test-file` reads. */
const TEST_FILE_FLAGS: CommandFlags = {
  switches: ['--overwrite', '--json'],
  values: [
    '--test-file',
    '--target',
    '--agent',
    '--topic',
    '--guard-topic',
    '--test-runner',
    '--scenario',
    '--project',
  ],
};

/** `<pack topic>=<agent topic>[:<action>[,<action>]]`. */
const TOPIC_RE = /^([a-z][a-z0-9-]*)=([^\s:=,]+)(?::([^\s:=]+))?$/;

/** Read the line of `--test-file`, or say why it cannot be read: exit 2. */
export function parseTestFileArgs(argv: string[]): TestFileArgs {
  const args = argv.slice(2);
  refuseUnreadArguments(args, TEST_FILE_FLAGS);
  const refuse = (line: string): never => {
    process.stderr.write(`${line}\n`);
    process.exit(2);
  };
  const get = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    return at >= 0 && at + 1 < args.length ? args[at + 1] : undefined;
  };
  const run = get('--test-file');
  const target = get('--target');
  if (!run || !target) {
    refuse(
      '--test-file takes the file of a scenario run, or its run id, and --target the org it ' +
        'wrote to. Run with --help.',
    );
  }
  const topics: AgentTestChoice['topics'] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--topic') continue;
    const value = args[i + 1] ?? '';
    const match = TOPIC_RE.exec(value);
    if (!match) {
      refuse(
        `--topic wants "<scenario topic>=<agent topic>" or "<scenario topic>=<agent topic>:` +
          `<action>,<action>", not "${value}".`,
      );
    }
    const [, packTopic, agentTopic, actions] = match as RegExpExecArray;
    topics.push({ packTopic, agentTopic, actions: actions ? actions.split(',') : [] });
  }
  const runner = get('--test-runner') ?? 'testing-center';
  if (!(AGENT_TEST_RUNNERS as readonly string[]).includes(runner)) {
    refuse(`--test-runner takes ${AGENT_TEST_RUNNERS.join(' or ')}, not "${runner}".`);
  }
  const agent = get('--agent');
  const scenario = get('--scenario');
  return {
    run: run as string,
    target: target as string,
    ...(agent !== undefined ? { agent } : {}),
    topics,
    guardTopic: get('--guard-topic') ?? null,
    runner: runner as AgentTestChoice['runner'],
    ...(scenario !== undefined ? { scenario } : {}),
    project: resolve(get('--project') ?? process.cwd()),
    overwrite: args.includes('--overwrite'),
    json: args.includes('--json'),
  };
}

/** The run `--test-file` names: its id, where its files are kept, and the org its file names. */
export function testFileRunOf(
  value: string,
  journalDir: string,
): { runId: string; storagePath: string; targetOrganizationId?: string; targetOrgId?: string } {
  if (existsSync(value) && value.endsWith('.ndjson')) {
    const run = readRunFile(readFileSync(value, 'utf8'));
    if (run) {
      return {
        runId: run.runId,
        // `<storage>/seed-runs/<run id>.ndjson`: the companion is beside it.
        storagePath: dirname(dirname(resolve(value))),
        targetOrgId: run.targetOrgId,
        ...(run.targetOrganizationId ? { targetOrganizationId: run.targetOrganizationId } : {}),
      };
    }
  }
  return { runId: value, storagePath: journalDir };
}

/** What `--test-file` reads the target through. */
export interface TestFileTarget {
  tooling: ToolingQueries;
  /** The target's own Organization id. */
  organizationId: () => Promise<string | undefined>;
}

/**
 * Write the test file of a scenario's run: exit 0 once written; 1 when the
 * org has no agent or its catalog could not be read; 2 for a line, a choice,
 * a run or a pack it cannot be written from, or a file there already.
 */
export async function testFileMain(
  argv: string[],
  connect: (alias: string) => Promise<TestFileTarget>,
  journalDir: string,
): Promise<void> {
  const args = parseTestFileArgs(argv);
  const say = (line: string): void => {
    process[args.json ? 'stderr' : 'stdout'].write(`${line}\n`);
  };
  const stop = (code: number, line: string): void => {
    process.stderr.write(`${line}\n`);
    process.exitCode = code;
  };
  const run = testFileRunOf(args.run, journalDir);
  const read = await readScenarioRunSidecar(nodeScenarioSidecarFiles(), run.storagePath, run.runId);
  if (read.kind !== 'read') {
    stop(
      2,
      read.kind === 'absent'
        ? `${args.run}: no scenario run kept a companion file by that name, so there is no ` +
            'test file to write from it.'
        : read.message,
    );
    return;
  }
  const { sidecar } = read;
  let pack: ScenarioPack | undefined;
  if (args.scenario !== undefined) {
    const named = scenarioPackOf(args.scenario);
    if ('refusal' in named) {
      stop(2, named.refusal);
      return;
    }
    pack = named.pack;
  }
  const found =
    pack ??
    (await findScenarioPack(
      nodeScenarioPackFiles(),
      [args.project],
      sidecar.packId,
      sidecar.packFingerprint,
    ));
  const target = await connect(args.target);
  if (run.targetOrganizationId !== undefined) {
    const id = await target.organizationId();
    if (id !== undefined && id.slice(0, 15) !== run.targetOrganizationId.slice(0, 15)) {
      stop(2, `${args.target} is not the org this run wrote to: give --target that org.`);
      return;
    }
  }
  const catalog: AgentCatalogRead = await readAgentCatalog(toolingQueryAll(target.tooling));
  if (catalog.kind === 'no-agent') {
    stop(1, catalog.message);
    return;
  }
  if (catalog.kind === 'unreadable') {
    stop(1, catalog.message);
    return;
  }
  if (args.agent === undefined) {
    say(`the agents of ${args.target}:`);
    for (const line of agentLines(catalog.catalog.agents)) say(line);
    stop(
      2,
      '--test-file takes --agent, the API name of the agent the tests are for, and a --topic ' +
        `for each topic of the scenario ${sidecar.packId}` +
        (found ? ` (${found.topics.map((topic) => topic.key).join(', ')})` : '') +
        '. Run with --help.',
    );
    return;
  }
  const choice: AgentTestChoice = {
    agent: args.agent,
    runner: args.runner,
    topics: args.topics,
    guardTopic: args.guardTopic,
  };
  const outcome: SeedScenarioTestFileOutcome = await writeRunTestFile(
    { sidecar: nodeScenarioSidecarFiles(), spec: nodeAgentTestSpecFiles() },
    {
      runId: run.runId,
      storagePath: run.storagePath,
      project: await scenarioProjectOf([args.project]),
      alias: args.target,
      choice,
      overwrite: args.overwrite,
      readCatalog: async () => catalog,
      findPack: async () => found,
    },
  );
  if (args.json)
    process.stdout.write(`${JSON.stringify({ tool: 'sandforge-seed', outcome }, null, 2)}\n`);
  for (const line of testFileOutcomeLines(outcome)) say(line);
  if (outcome.kind !== 'written') process.exitCode = outcome.kind === 'no-agent' ? 1 : 2;
}

/** What writing a test file did, as the line says it. */
export function testFileOutcomeLines(outcome: SeedScenarioTestFileOutcome): string[] {
  switch (outcome.kind) {
    case 'written':
      return [
        `test file: ${outcome.path}`,
        ...outcome.leftOut.map((left) => `  left out ${left.test}: ${left.message}`),
        ...(outcome.commands
          ? [
              "SandForge never deploys the test nor runs it, which spends the org's credits: from " +
                'the project, run',
              `  ${outcome.commands.create}`,
              `  ${outcome.commands.run}`,
            ]
          : [
              'This folder is no Salesforce DX project (no sfdx-project.json): sf agent test ' +
                'create runs from one, which it writes the test it creates into.',
            ]),
      ];
    case 'exists':
      return [`${outcome.path} is there already: --overwrite writes over it.`];
    case 'refused':
      return outcome.refusals.map((refusal) => `refused: ${refusal.message}`);
    case 'no-agent':
    case 'unavailable':
      return [outcome.message];
  }
}
