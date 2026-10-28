/**
 * The file an agent's tests are created from, written into the user's
 * project, and the command lines that create and run them.
 *
 * SandForge never deploys the test and never runs it. A test is an
 * `AiEvaluationDefinition` (or an `AiTestingDefinition`), metadata the CLI
 * deploys, and a run spends the org's credits: the page shows the two
 * commands, `sf agent test create` then `sf agent test run`, for the user to
 * start. So the file is written where the CLI looks for one,
 * `specs/<Agent>-<pack>-sandforge-testSpec.yaml` beside the CLI's own
 * `specs/<Agent>-testSpec.yaml`, and never over a file that is there unless
 * the user says to: a spec the user edited by hand is theirs.
 *
 * The YAML is written here, not by a library: the shape is fixed — maps,
 * lists, texts — and every text is written double-quoted, as JSON writes a
 * string, which YAML reads as the same string whatever it holds, a colon, a
 * `#`, a quote or a line break. The CLI reads the file with the `yaml`
 * package; the tests read it back with the same one.
 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { agentTestSpecFor } from '@sandforge/shared';
import type {
  AgentCatalog,
  AgentTestRunner,
  AgentTestSpecModel,
  ScenarioPack,
} from '@sandforge/shared';
import {
  compiledForSidecar,
  withAgentChoice,
  type ScenarioRunSidecar,
} from '../seed/scenario/scenarioRunSidecar';
import { agentTestCases, type AgentTestLeftOut, type AgentTestRefusal } from './agentTestCases';

/** The folder of the project the files go in: the CLI's own for its specs. */
export const AGENT_TEST_SPECS_DIR = 'specs';

/** Longest API name `sf agent test create` takes for a test. */
const MAX_TEST_API_NAME = 80;

/** Minutes `sf agent test run` waits for the run to end before it hands back a job id. */
export const AGENT_TEST_RUN_WAIT_MINUTES = 10;

/** The tests as the file of one engine, in YAML. */
export function agentTestSpecYaml(model: AgentTestSpecModel, runner: AgentTestRunner): string {
  return yamlOf(agentTestSpecFor(model, runner));
}

/**
 * The file's name in {@link AGENT_TEST_SPECS_DIR}: the agent's API name and
 * the pack's id, then the suffix the CLI gives each engine's file
 * (`-testSpec.yaml`, `-ngtTestSpec.yaml` for Agentforce Studio), with
 * `sandforge` before it so that no file of the CLI's is taken for ours.
 */
export function agentTestSpecFileName(
  agentName: string,
  packId: string,
  runner: AgentTestRunner,
): string {
  const suffix = runner === 'agentforce-studio' ? 'ngtTestSpec' : 'testSpec';
  return `${fileSegment(agentName)}-${fileSegment(packId)}-sandforge-${suffix}.yaml`;
}

/**
 * The API name the test is created under: the agent's and the pack's, as the
 * CLI takes one — a letter first, letters, digits and single underscores, no
 * underscore last, at most eighty characters, the agent's part cut first.
 */
export function agentTestApiName(agentName: string, packId: string): string {
  const word = (text: string): string =>
    text.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const tail = `${word(packId)}_SandForge`;
  let head = word(agentName);
  if (!/^[A-Za-z]/.test(head)) head = `Agent_${head}`.replace(/_+$/, '');
  const room = MAX_TEST_API_NAME - tail.length - 1;
  head = head.slice(0, room).replace(/_+$/, '');
  return `${head}_${tail}`;
}

/** A command the page shows: its words, and the line to copy. */
export interface AgentTestCommand {
  argv: string[];
  line: string;
}

/**
 * The two commands that create the test in the org from the file and run
 * it, as `sf agent test create --help` and `sf agent test run --help` give
 * them, always naming the org: the user's default org may be another.
 */
export function agentTestCommands(options: {
  /** The file, relative to the project, with `/` between its parts. */
  specPath: string;
  apiName: string;
  alias: string;
  runner: AgentTestRunner;
}): { create: AgentTestCommand; run: AgentTestCommand } {
  const runner =
    options.runner === 'agentforce-studio' ? ['--test-runner', 'agentforce-studio'] : [];
  const create = [
    'sf',
    'agent',
    'test',
    'create',
    '--spec',
    options.specPath,
    '--api-name',
    options.apiName,
    ...runner,
    '-o',
    options.alias,
  ];
  const run = [
    'sf',
    'agent',
    'test',
    'run',
    '--api-name',
    options.apiName,
    '--wait',
    String(AGENT_TEST_RUN_WAIT_MINUTES),
    ...runner,
    '-o',
    options.alias,
  ];
  return {
    create: { argv: create, line: commandLine(create) },
    run: { argv: run, line: commandLine(run) },
  };
}

/** The file operations a test file is written with. */
export interface AgentTestSpecFiles {
  /** Make a directory and those above it. */
  mkdir: (dirPath: string) => Promise<void>;
  /** Write a file that is not there: false, and nothing written, when one is. */
  writeNew: (filePath: string, content: string) => Promise<boolean>;
  /** Write a file over the one there, whole. */
  replace: (filePath: string, content: string) => Promise<void>;
}

/** The test file's operations over Node's file system. */
export function nodeAgentTestSpecFiles(): AgentTestSpecFiles {
  return {
    mkdir: async (dirPath) => {
      await mkdir(dirPath, { recursive: true });
    },
    writeNew: async (filePath, content) => {
      try {
        // `wx`: the file is made by this call or not at all, so no file
        // written between a check and the write is ever written over.
        await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
        return true;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw err;
      }
    },
    replace: async (filePath, content) => {
      const written = `${filePath}.${process.pid}.tmp`;
      await writeFile(written, content, 'utf8');
      await rename(written, filePath);
    },
  };
}

/** The test file, as it was written or why it was not. */
export type AgentTestSpecWrite =
  | {
      kind: 'written';
      /** Where it was written. */
      path: string;
      /** The same, relative to the project, as the commands name it. */
      specPath: string;
      apiName: string;
      commands: { create: AgentTestCommand; run: AgentTestCommand };
    }
  /** A file is there by that name, and the user did not say to write over it: nothing written. */
  | { kind: 'exists'; path: string; specPath: string };

/** What a test file is written from. */
export interface AgentTestSpecWriteInput {
  /** The project's folder: where `sf agent test create` is run from. */
  projectDir: string;
  model: AgentTestSpecModel;
  runner: AgentTestRunner;
  packId: string;
  /** The org the commands name. */
  alias: string;
  /** Write over a file of the same name: only when the user said to. */
  overwrite?: boolean;
}

/** Write the test file into the project, never over one there unless told to. */
export async function writeAgentTestSpec(
  files: AgentTestSpecFiles,
  input: AgentTestSpecWriteInput,
): Promise<AgentTestSpecWrite> {
  const name = agentTestSpecFileName(input.model.subjectName, input.packId, input.runner);
  const specPath = `${AGENT_TEST_SPECS_DIR}/${name}`;
  const file = path.join(input.projectDir, AGENT_TEST_SPECS_DIR, name);
  const text = agentTestSpecYaml(input.model, input.runner);
  await files.mkdir(path.dirname(file));
  if (input.overwrite === true) await files.replace(file, text);
  else if (!(await files.writeNew(file, text))) return { kind: 'exists', path: file, specPath };
  const apiName = agentTestApiName(input.model.subjectName, input.packId);
  return {
    kind: 'written',
    path: file,
    specPath,
    apiName,
    commands: agentTestCommands({ specPath, apiName, alias: input.alias, runner: input.runner }),
  };
}

/** What the test file of a seed run is written from, once the run has ended. */
export interface ScenarioTestSpecInput {
  /** The run's companion file. */
  sidecar: ScenarioRunSidecar;
  /** The pack the run was seeded from: checked against the companion's fingerprint. */
  pack: ScenarioPack;
  /** The org's agents, as `readAgentCatalog` read them. */
  catalog: AgentCatalog;
  /** What the user matched the scenario to, from the page. */
  choice: unknown;
  projectDir: string;
  alias: string;
  overwrite?: boolean;
}

/** The test file of a seed run, written or not, and what the run's companion should now keep. */
export type ScenarioTestSpecResult =
  | (Extract<AgentTestSpecWrite, { kind: 'written' }> & {
      leftOut: AgentTestLeftOut[];
      /** The companion file with the agent matched, to keep in place of the one read. */
      sidecar: ScenarioRunSidecar;
    })
  | Extract<AgentTestSpecWrite, { kind: 'exists' }>
  /** The pack is not the run's, or the choice was refused: why, nothing written. */
  | { kind: 'refused'; refusals: AgentTestRefusal[] };

/**
 * The test file of a seed run: the tests compiled again from the pack, as
 * the run compiled them, matched to the agent as the user chose, written
 * into the project. Nothing is written when the pack has changed since the
 * run, when a name of the choice is not the agent's, or when a file is there.
 */
export async function writeScenarioTestSpec(
  files: AgentTestSpecFiles,
  input: ScenarioTestSpecInput,
): Promise<ScenarioTestSpecResult> {
  const recompiled = compiledForSidecar(input.sidecar, input.pack);
  if (!recompiled.ok) {
    return {
      kind: 'refused',
      refusals: [{ code: 'pack-changed', name: input.pack.id, message: recompiled.message }],
    };
  }
  const tests = agentTestCases({
    compiled: recompiled.compiled,
    catalog: input.catalog,
    choice: input.choice,
    openCaseIds: input.sidecar.openCases,
    runId: input.sidecar.runId,
  });
  if (!tests.ok) return { kind: 'refused', refusals: tests.refusals };
  const { choice } = tests;
  const written = await writeAgentTestSpec(files, {
    projectDir: input.projectDir,
    model: tests.spec,
    runner: choice.runner,
    packId: input.pack.id,
    alias: input.alias,
    ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {}),
  });
  if (written.kind === 'exists') return written;
  return { ...written, leftOut: tests.leftOut, sidecar: withAgentChoice(input.sidecar, choice) };
}

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------

/**
 * A value as a YAML document: maps and lists in block style, two spaces a
 * level, every text double-quoted. `undefined` is left out, as JSON leaves it.
 */
export function yamlOf(value: Readonly<Record<string, unknown>>): string {
  return `${mapLines(value, 0).join('\n')}\n`;
}

/** The lines of a map's entries at `indent`. */
function mapLines(map: Readonly<Record<string, unknown>>, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(map)) {
    if (value === undefined) continue;
    const head = `${pad}${yamlKey(key)}:`;
    if (Array.isArray(value)) {
      if (value.length === 0) lines.push(`${head} []`);
      else lines.push(head, ...listLines(value, indent + 2));
    } else if (isMap(value)) {
      if (Object.values(value).every((v) => v === undefined)) lines.push(`${head} {}`);
      else lines.push(head, ...mapLines(value, indent + 2));
    } else {
      lines.push(`${head} ${yamlScalar(value)}`);
    }
  }
  return lines;
}

/** The lines of a list's items at `indent`, each a `- ` and the item, a map's first entry on its line. */
function listLines(list: readonly unknown[], indent: number): string[] {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  for (const item of list) {
    const nested = Array.isArray(item)
      ? item.length === 0
        ? undefined
        : listLines(item, indent + 2)
      : isMap(item) && Object.values(item).some((v) => v !== undefined)
        ? mapLines(item, indent + 2)
        : undefined;
    if (nested === undefined) {
      lines.push(`${pad}- ${Array.isArray(item) ? '[]' : isMap(item) ? '{}' : yamlScalar(item)}`);
      continue;
    }
    lines.push(`${pad}- ${nested[0].slice(indent + 2)}`, ...nested.slice(1));
  }
  return lines;
}

function isMap(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A key as YAML writes it: as it is when it is a word, else double-quoted. */
function yamlKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : yamlString(key);
}

/** A scalar: a text double-quoted, a number or a flag as it is, nothing as `null`. */
function yamlScalar(value: unknown): string {
  if (typeof value === 'string') return yamlString(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value === null) return 'null';
  throw new TypeError(`No YAML scalar for ${typeof value}`);
}

/**
 * A text double-quoted. JSON's escapes are YAML's; what JSON leaves as it is
 * and YAML does not print — DEL, the C1 controls, the line and paragraph
 * separators, the byte-order mark, the two non-characters — is escaped too,
 * so that no reader takes one for a line break or drops it.
 */
function yamlString(text: string): string {
  return JSON.stringify(text).replace(
    /[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** A name as it goes into a file name: letters, digits, `_` and `-`, the rest as `_`. */
function fileSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * A command's words as one line to copy: a word with anything but letters,
 * digits and `_./:@=+,-` double-quoted, its quotes and backslashes escaped.
 */
function commandLine(argv: readonly string[]): string {
  return argv
    .map((word) =>
      /^[A-Za-z0-9_./:@=+,-]+$/.test(word) ? word : `"${word.replace(/(["\\])/g, '\\$1')}"`,
    )
    .join(' ');
}
