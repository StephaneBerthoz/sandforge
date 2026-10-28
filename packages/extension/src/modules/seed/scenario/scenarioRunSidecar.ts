/**
 * What a scenario's seed run keeps beside its run file, so that its agent's
 * test file can be written once the run has ended — at its end, or later
 * from the run's card, once the org has an agent: `seed-runs/<runId>.scenario.json`.
 *
 * It keeps what the tests are made from that the pack alone does not give:
 * the choices the pack was compiled with, the id each open case was given,
 * by its row key, and the agent the user matched the scenario to. And the
 * pack's fingerprint: the tests are compiled again from the pack, and a pack
 * edited since the run would give tests about subjects and addresses no
 * record of the run holds. No value of a record is kept — ids and keys, as
 * the run file keeps ids and dates (`SeedRunCreations`).
 *
 * Written whole, through a file beside it renamed over it, so a window that
 * stops mid-write leaves the last whole one.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as z from 'zod';
import {
  agentTestChoiceSchema,
  scenarioCompileOptionsSchema,
  scenarioKeySchema,
} from '@sandforge/shared';
import type {
  AgentTestChoice,
  CompiledScenario,
  ScenarioCompileOptions,
  ScenarioPack,
} from '@sandforge/shared';
import { SEED_RUNS_DIR } from '../SeedRunCreations';
import { SCENARIO_COMPANION_SUFFIX } from '../../sync/SyncRunCreations';
import { compileScenario, ScenarioCompileError } from './compileScenario';

/**
 * What a run's companion file is named by, after its run's id: the name the
 * runs' store forgets with the run (`SyncRunCreations.forget`).
 */
export const SCENARIO_SIDECAR_SUFFIX = SCENARIO_COMPANION_SUFFIX;

/** A record id, in either of its forms. */
const recordIdSchema = z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/, 'A record id');

/** A run's companion file, version 1. */
export const scenarioRunSidecarSchema = z.strictObject({
  version: z.literal(1),
  runId: z.string().min(1).max(200),
  packId: scenarioKeySchema,
  /** The sha256 of the pack the run was compiled from: {@link scenarioPackFingerprint}. */
  packFingerprint: z.string().regex(/^[0-9a-f]{64}$/, 'A sha256, in lower-case hexadecimal'),
  /** The choices the pack was compiled with, its seed always among them. */
  compile: scenarioCompileOptionsSchema.refine((options) => options.seed !== undefined, {
    message: 'The seed the pack was compiled with is kept',
    path: ['seed'],
  }),
  /** The id each open case was given, by its row key; a case the org refused has none. */
  openCases: z.record(z.string().min(1).max(255), recordIdSchema),
  /** The agent the user matched the scenario to, once matched. */
  agent: agentTestChoiceSchema.optional(),
});

/** A run's companion file (`scenarioRunSidecarSchema`). */
export type ScenarioRunSidecar = z.infer<typeof scenarioRunSidecarSchema>;

/**
 * The fingerprint of a pack: the sha256 of its JSON, every object's keys in
 * order, so that a pack saved again with its keys in another order is the
 * same pack, and one with a word changed is not.
 */
export function scenarioPackFingerprint(pack: ScenarioPack): string {
  return createHash('sha256').update(canonicalJson(pack)).digest('hex');
}

/** What a run's companion file is made from, once the run has written its cases. */
export interface ScenarioRunSidecarInput {
  runId: string;
  pack: ScenarioPack;
  compiled: CompiledScenario;
  /** The choices the pack was compiled with, as the run handed them to `compileScenario`. */
  options?: ScenarioCompileOptions;
  /**
   * The id the run gave each row of `Case` it wrote, by its row key. Of
   * them, the open cases' are kept: those the tests are about.
   */
  caseIds: Readonly<Record<string, string>>;
}

/** A run's companion file, with no agent matched yet. */
export function scenarioRunSidecar(input: ScenarioRunSidecarInput): ScenarioRunSidecar {
  const openCases: Record<string, string> = {};
  for (const test of input.compiled.tests) {
    const key = test.openCase?.caseKey;
    if (key === undefined) continue;
    const id = input.caseIds[key];
    if (id !== undefined) openCases[key] = id;
  }
  return scenarioRunSidecarSchema.parse({
    version: 1,
    runId: input.runId,
    packId: input.pack.id,
    packFingerprint: scenarioPackFingerprint(input.pack),
    compile: { ...input.options, seed: input.compiled.seed },
    openCases,
  });
}

/** The companion file with the agent the user matched the scenario to, in place of any before. */
export function withAgentChoice(
  sidecar: ScenarioRunSidecar,
  choice: AgentTestChoice,
): ScenarioRunSidecar {
  return scenarioRunSidecarSchema.parse({ ...sidecar, agent: choice });
}

/**
 * The scenario's tests compiled again for a run, as they were when it ran;
 * refused, with why, when the pack is not the one the run was compiled from.
 */
export function compiledForSidecar(
  sidecar: ScenarioRunSidecar,
  pack: ScenarioPack,
): { ok: true; compiled: CompiledScenario } | { ok: false; message: string } {
  if (pack.id !== sidecar.packId) {
    return {
      ok: false,
      message: `The run was seeded from the scenario ${sidecar.packId}, not ${pack.id}`,
    };
  }
  if (scenarioPackFingerprint(pack) !== sidecar.packFingerprint) {
    return {
      ok: false,
      message:
        `The scenario ${pack.id} has changed since the run: its tests would be about subjects ` +
        'and addresses no record of the run holds',
    };
  }
  try {
    return { ok: true, compiled: compileScenario(pack, sidecar.compile) };
  } catch (err: unknown) {
    if (err instanceof ScenarioCompileError) return { ok: false, message: err.message };
    throw err;
  }
}

/** The file operations the companion file is kept with. */
export interface ScenarioSidecarFiles {
  /** A file's text; throws one whose `code` is `ENOENT` when it is not there. */
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  /** Make a directory and those above it. */
  mkdir: (dirPath: string) => Promise<void>;
}

/** The companion file's operations over Node's file system. */
export function nodeScenarioSidecarFiles(): ScenarioSidecarFiles {
  return {
    readFile: (filePath) => readFile(filePath, 'utf8'),
    writeFile: (filePath, content) => writeFile(filePath, content, 'utf8'),
    rename: (from, to) => rename(from, to),
    mkdir: async (dirPath) => {
      await mkdir(dirPath, { recursive: true });
    },
  };
}

/**
 * The companion file of a run, under the extension's storage, beside the
 * run's own file: its id written as the run file's name writes it, letters,
 * digits, `_` and `-`, the rest as `_`.
 */
export function scenarioSidecarPath(storagePath: string, runId: string): string {
  return path.join(
    storagePath,
    SEED_RUNS_DIR,
    `${runId.replace(/[^A-Za-z0-9_-]/g, '_')}${SCENARIO_SIDECAR_SUFFIX}`,
  );
}

/** Write a run's companion file, whole; where it was written. */
export async function writeScenarioRunSidecar(
  files: ScenarioSidecarFiles,
  storagePath: string,
  sidecar: ScenarioRunSidecar,
): Promise<string> {
  const kept = scenarioRunSidecarSchema.parse(sidecar);
  const file = scenarioSidecarPath(storagePath, kept.runId);
  const written = `${file}.${process.pid}.tmp`;
  await files.mkdir(path.dirname(file));
  await files.writeFile(written, `${JSON.stringify(kept, null, 2)}\n`);
  await files.rename(written, file);
  return file;
}

/** A run's companion file as it was read. */
export type ScenarioRunSidecarRead =
  | { kind: 'read'; sidecar: ScenarioRunSidecar }
  /** The run kept none: it was not a scenario's, or it wrote no open case. */
  | { kind: 'absent' }
  /** A file that does not parse, or not as a companion file: what is wrong with it. */
  | { kind: 'invalid'; message: string };

/** Read a run's companion file. Never throws on what the file holds: it says it. */
export async function readScenarioRunSidecar(
  files: ScenarioSidecarFiles,
  storagePath: string,
  runId: string,
): Promise<ScenarioRunSidecarRead> {
  const file = scenarioSidecarPath(storagePath, runId);
  let text: string;
  try {
    text = await files.readFile(file);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'invalid', message: `${path.basename(file)} is not JSON` };
  }
  const parsed = scenarioRunSidecarSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      kind: 'invalid',
      message: `${path.basename(file)}: ${issue.path.join('.') || 'the file'}: ${issue.message}`,
    };
  }
  if (parsed.data.runId !== runId) {
    return {
      kind: 'invalid',
      message: `${path.basename(file)} is the companion of the run ${parsed.data.runId}, not ${runId}`,
    };
  }
  return { kind: 'read', sidecar: parsed.data };
}

/** `value` as JSON, every object's keys in order, `undefined` left out as JSON leaves it. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
