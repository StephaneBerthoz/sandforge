/**
 * The history of the pipeline runs the command line made on this machine
 * (`sandforge pipeline run`), kept where the editor reads it beside its own.
 *
 * The editor keeps its runs in its own storage, which a command line cannot
 * reach. A run from cron or a terminal writes its entry to `history.json` in
 * the pipeline's folder (`<journal>/pipelines/<pipeline>/`, see
 * `PipelineRunLock.ts`), and the History tab lists those entries with the
 * editor's, marked as command line runs. A run in a CI job writes to its
 * runner's disk, which this machine never reads.
 *
 * A file that does not read — cut short, edited by hand, written by a later
 * release — is said once in the log, and again only once it has changed: the
 * History tab is asked for at every visit, and the same warning at each one
 * would hide every other line of the log.
 */

import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import type { PipelineHistoryEntry } from '@sandforge/shared';
import { pipelineFolderOf } from './PipelineRunLock.js';

/** How many runs a pipeline's command-line history keeps: as many as the editor's. */
export const CLI_HISTORY_LIMIT = 50;

/** The name of a pipeline's command-line history in its folder. */
const HISTORY_FILE = 'history.json';

/** The version of the history file this release writes, and the highest it reads. */
const HISTORY_VERSION = 1;

/** The largest history file read: fifty runs of a pipeline of many steps fit well under it. */
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;

/** What a pipeline's folder is made with: its owner alone lists it. */
const FOLDER_MODE = 0o700;

/** What the history file is made with: its owner alone reads it. */
const FILE_MODE = 0o600;

const approvalSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'timedOut', 'cancelled']),
  via: z.enum(['notification', 'page', 'terminal', 'commandLine']).optional(),
  at: z.string().max(64),
  by: z.string().max(64).optional(),
});

const stepSchema = z.object({
  stepName: z.string().max(200),
  // Any text: a step of a type this release does not have was recorded refused.
  stepType: z.string().max(80),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped', 'stopped']),
  duration: z.number().nonnegative().optional(),
  summary: z.string().max(8_000).optional(),
  error: z.string().max(8_000).optional(),
  approval: approvalSchema.optional(),
});

/**
 * An entry of the history, as written and read back. Only these fields are
 * kept: whatever else an entry carries — the pipeline's definition, which
 * can hold a variable's value — is dropped on the way in and on the way out.
 */
const entrySchema = z.object({
  runId: z.string().min(1).max(200),
  pipelineId: z.string().min(1).max(200),
  pipelineName: z.string().max(200),
  status: z.enum([
    'idle',
    'queued',
    'running',
    'completed',
    'completed_with_warnings',
    'failed',
    'cancelled',
  ]),
  triggeredBy: z.enum([
    'manual',
    'schedule',
    'event',
    'webhook',
    'sandbox_refresh',
    'deployment_complete',
  ]),
  startTime: z.iso.datetime({ offset: true }),
  duration: z.number().nonnegative(),
  stepCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  steps: z.array(stepSchema).max(200).optional(),
});

const fileSchema = z.object({
  sandforgePipelineHistory: z.literal(HISTORY_VERSION),
  entries: z.array(z.unknown()).max(CLI_HISTORY_LIMIT * 4),
});

/** A run of the command line, as the History tab lists it beside the editor's. */
export type CliRunHistoryEntry = PipelineHistoryEntry & {
  ranFrom: 'commandLine';
  /** When it started, in epoch milliseconds: what the History tab sorts on. */
  timestamp: number;
};

/** Where a pipeline's command-line history is. */
export function cliHistoryFileOf(root: string, pipelineId: string): string {
  return join(pipelineFolderOf(root, pipelineId), HISTORY_FILE);
}

/** An entry read, as the History tab lists it. */
function listed(entry: z.infer<typeof entrySchema>): CliRunHistoryEntry {
  const startedAt = Date.parse(entry.startTime);
  return {
    ...(entry as PipelineHistoryEntry),
    ranFrom: 'commandLine',
    timestamp: Number.isNaN(startedAt) ? 0 : startedAt,
  };
}

/** The entries a history file holds, or why it does not read. */
function entriesIn(
  text: string,
): { entries: CliRunHistoryEntry[]; skipped: number } | { why: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { why: 'it is not JSON' };
  }
  const file = fileSchema.safeParse(value);
  if (!file.success) {
    const version = (value as { sandforgePipelineHistory?: unknown } | null)
      ?.sandforgePipelineHistory;
    return {
      why:
        typeof version === 'number' && version > HISTORY_VERSION
          ? `a later release of SandForge wrote it (version ${version})`
          : 'it is not a pipeline history',
    };
  }
  const entries: CliRunHistoryEntry[] = [];
  let skipped = 0;
  for (const raw of file.data.entries) {
    const entry = entrySchema.safeParse(raw);
    if (entry.success) entries.push(listed(entry.data));
    else skipped += 1;
  }
  return { entries, skipped };
}

/** Reads the command-line history of every pipeline of a root, telling the log of each file that does not read once. */
export interface CliRunHistoryReader {
  /** Every run of every pipeline's command-line history, newest first. */
  read(): CliRunHistoryEntry[];
}

/**
 * The command-line history of every pipeline under `root`.
 *
 * @param root - The pipelines' folder (`defaultPipelinesRoot`).
 * @param log - Where a file that does not read is said.
 */
export function cliRunHistory(root: string, log: (line: string) => void): CliRunHistoryReader {
  /** The files said not to read, with how they were then: said again once they change. */
  const said = new Map<string, string>();
  const sayOnce = (file: string, stamp: string, line: string): void => {
    if (said.get(file) === stamp) return;
    said.set(file, stamp);
    log(line);
  };
  return {
    read() {
      let folders: string[];
      try {
        folders = readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        // No pipeline ran from the command line here, or the folder cannot be read.
        return [];
      }
      const runs: CliRunHistoryEntry[] = [];
      for (const folder of folders.sort()) {
        const file = join(root, folder, HISTORY_FILE);
        let stamp: string;
        let text: string;
        try {
          const stat = statSync(file);
          stamp = `${stat.size}:${stat.mtimeMs}`;
          if (stat.size > MAX_HISTORY_BYTES) {
            sayOnce(
              file,
              stamp,
              `[WARN] pipeline history ${file} is not listed: at ${stat.size} bytes it is past ` +
                `the ${MAX_HISTORY_BYTES} a history of ${CLI_HISTORY_LIMIT} runs takes.`,
            );
            continue;
          }
          text = readFileSync(file, 'utf8');
        } catch {
          // A folder with no history yet: a run that was refused before its first step.
          continue;
        }
        const read = entriesIn(text);
        if ('why' in read) {
          sayOnce(
            file,
            stamp,
            `[WARN] pipeline history ${file} is not listed: ${read.why}. The runs it held are ` +
              'not shown in History; the next run from the command line starts it again.',
          );
          continue;
        }
        if (read.skipped > 0) {
          sayOnce(
            file,
            stamp,
            `[WARN] pipeline history ${file}: ${read.skipped} of its runs do not read and are not listed.`,
          );
        }
        runs.push(...read.entries);
      }
      return runs.sort((a, b) => b.timestamp - a.timestamp);
    },
  };
}

/** What recording a run did besides keeping it. */
export interface CliRunRecorded {
  /** How many runs the history keeps now. */
  kept: number;
  /** Where a history that did not read was put aside, rather than written over. */
  setAside?: string;
}

/**
 * Keep a run of the command line in its pipeline's history: newest first, the
 * same run id replacing its entry, the oldest dropped past
 * {@link CLI_HISTORY_LIMIT}. Written whole to a file of its own, then moved
 * in place, so the editor never reads half of it. A history that does not
 * read is moved aside, and said, rather than lost.
 *
 * @throws When the entry is not one the History tab can list, or the folder
 *   cannot be written: the run's caller says the run was not recorded.
 */
export function recordCliRun(
  root: string,
  pipelineId: string,
  entry: PipelineHistoryEntry,
): CliRunRecorded {
  const parsed = entrySchema.safeParse(entry);
  if (!parsed.success) {
    throw new Error(
      `The run was not recorded: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '(entry)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const folder = pipelineFolderOf(root, pipelineId);
  mkdirSync(folder, { recursive: true, mode: FOLDER_MODE });
  const file = join(folder, HISTORY_FILE);

  let kept: z.infer<typeof entrySchema>[] = [];
  let setAside: string | undefined;
  let text: string | undefined;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    text = undefined;
  }
  if (text !== undefined) {
    const read = entriesIn(text);
    if ('why' in read) {
      setAside = `${file}.unreadable-${Date.now()}`;
      renameSync(file, setAside);
    } else {
      kept = read.entries.map(({ ranFrom: _ranFrom, timestamp: _timestamp, ...rest }) =>
        entrySchema.parse(rest),
      );
    }
  }

  const entries = [parsed.data, ...kept.filter((old) => old.runId !== parsed.data.runId)]
    .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))
    .slice(0, CLI_HISTORY_LIMIT);
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(
    temp,
    `${JSON.stringify({ sandforgePipelineHistory: HISTORY_VERSION, entries }, null, 2)}\n`,
    { encoding: 'utf8', mode: FILE_MODE, flag: 'wx' },
  );
  try {
    renameSync(temp, file);
  } catch (err: unknown) {
    try {
      unlinkSync(temp);
    } catch {
      // Already gone.
    }
    throw err;
  }
  return { kept: entries.length, ...(setAside !== undefined ? { setAside } : {}) };
}
