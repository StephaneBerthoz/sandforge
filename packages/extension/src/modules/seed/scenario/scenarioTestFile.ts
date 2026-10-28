/**
 * The Agentforce test file of a scenario's seed run, written into the user's
 * project once the run has ended — at its end, or later from the run's card
 * or the command line, once the org has an agent — from the run's companion
 * file, the pack it was seeded from and the agent the user matched it to.
 *
 * SandForge writes the file and never deploys it or runs it: the page shows
 * `sf agent test create` then `sf agent test run`, which deploy metadata into
 * the org and spend its credits, for the user to start. `sf agent test
 * create` runs from a Salesforce DX project — it retrieves the test it
 * created into `force-app/main/default/aiEvaluationDefinitions` — so outside
 * one the file is written and the commands are not offered, and that is said.
 *
 * Nothing is written for a run whose companion file is gone or unreadable,
 * whose pack is no longer the one it was seeded from, or whose org has no
 * agent: each is said, in words the page and the command line show.
 */

import { access } from 'node:fs/promises';
import * as path from 'node:path';
import type {
  AgentTestChoice,
  ScenarioPack,
  SeedScenarioProject,
  SeedScenarioTestFileOutcome,
} from '@sandforge/shared';
import type { AgentCatalogRead } from '../../agentforce/agentCatalog';
import { writeScenarioTestSpec, type AgentTestSpecFiles } from '../../agentforce/testSpecWriter';
import {
  readScenarioRunSidecar,
  writeScenarioRunSidecar,
  type ScenarioSidecarFiles,
} from './scenarioRunSidecar';

/** The file that makes a folder a Salesforce DX project. */
export const DX_PROJECT_FILE = 'sfdx-project.json';

/**
 * Where a test file is written: the first workspace folder that is a
 * Salesforce DX project, else the first folder, else nowhere.
 *
 * @param isFile - Whether a file is there; Node's file system unless a test sets another.
 */
export async function scenarioProjectOf(
  folders: readonly string[],
  isFile: (filePath: string) => Promise<boolean> = fileIsThere,
): Promise<SeedScenarioProject> {
  for (const folder of folders) {
    if (await isFile(path.join(folder, DX_PROJECT_FILE))) return { kind: 'dx', dir: folder };
  }
  const first = folders[0];
  return first === undefined ? { kind: 'none' } : { kind: 'folder', dir: first };
}

/** Whether a file is there. */
async function fileIsThere(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** What a run's test file is written from. */
export interface RunTestFileInput {
  runId: string;
  /** Where the run's companion file is kept (`SeedRunCreations.storagePath`). */
  storagePath: string;
  project: SeedScenarioProject;
  /** The org the run wrote to, as the commands name it. */
  alias: string;
  /** What the user matched the scenario to. */
  choice: AgentTestChoice | unknown;
  overwrite?: boolean;
  /** The org's agents, as `readAgentCatalog` read them. */
  readCatalog: () => Promise<AgentCatalogRead>;
  /** The pack the run was seeded from, by its id and fingerprint; undefined when none is. */
  findPack: (packId: string, fingerprint: string) => Promise<ScenarioPack | undefined>;
}

/** The file operations the test file and the companion file are written with. */
export interface RunTestFileFiles {
  sidecar: ScenarioSidecarFiles;
  spec: AgentTestSpecFiles;
}

/**
 * Write the test file of a scenario's run, and keep in its companion file the
 * agent it was written for, so that the run's card says it.
 */
export async function writeRunTestFile(
  files: RunTestFileFiles,
  input: RunTestFileInput,
): Promise<SeedScenarioTestFileOutcome> {
  if (input.project.kind === 'none') {
    return {
      kind: 'unavailable',
      reason: 'no-workspace',
      message: 'Open a folder in VS Code: the test file is written into it.',
    };
  }
  const read = await readScenarioRunSidecar(files.sidecar, input.storagePath, input.runId);
  if (read.kind === 'absent') {
    return {
      kind: 'unavailable',
      reason: 'no-companion',
      message:
        'This run kept no companion file: it was not seeded from a scenario, or it wrote no ' +
        'open case for a test to be about.',
    };
  }
  if (read.kind === 'invalid') {
    return { kind: 'unavailable', reason: 'companion-invalid', message: read.message };
  }
  const { sidecar } = read;
  const pack = await input.findPack(sidecar.packId, sidecar.packFingerprint);
  if (!pack) {
    return {
      kind: 'unavailable',
      reason: 'pack-not-found',
      message:
        `The scenario ${sidecar.packId} this run was seeded from is no longer in the workspace ` +
        'as it was: its tests would be about subjects and addresses no record of the run holds.',
    };
  }
  const catalog = await input.readCatalog();
  if (catalog.kind === 'no-agent') {
    return { kind: 'no-agent', reason: catalog.reason, message: catalog.message };
  }
  if (catalog.kind === 'unreadable') {
    return { kind: 'unavailable', reason: 'catalog-unreadable', message: catalog.message };
  }
  const written = await writeScenarioTestSpec(files.spec, {
    sidecar,
    pack,
    catalog: catalog.catalog,
    choice: input.choice,
    projectDir: input.project.dir,
    alias: input.alias,
    ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {}),
  });
  if (written.kind === 'refused') return written;
  if (written.kind === 'exists') {
    return { kind: 'exists', path: written.path, specPath: written.specPath };
  }
  // The file is written: the card names the agent from now on. A companion
  // that could not be kept leaves the file as written.
  await writeScenarioRunSidecar(files.sidecar, input.storagePath, written.sidecar).catch(
    () => undefined,
  );
  const dx = input.project.kind === 'dx';
  return {
    kind: 'written',
    path: written.path,
    specPath: written.specPath,
    apiName: written.apiName,
    ...(dx
      ? { commands: { create: written.commands.create.line, run: written.commands.run.line } }
      : { notDxProject: true as const }),
    leftOut: written.leftOut,
  };
}
