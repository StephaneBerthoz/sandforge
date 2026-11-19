/**
 * The Seed runs the runs kept on this machine dropped while their records
 * were still in their org, which only the bound on the bytes their files take
 * does (`SyncRunCreationsDeps.onDropped`): a seed of tens of thousands of
 * records, never removed, pushed out by the files of the runs after it.
 *
 * Once its file was gone, the run asked for again from its results was said
 * to be one that "created nothing, or was dropped", with a rewind or an
 * emptying of its objects as the only ways on, and the command line read its
 * id as a summary it could not open. What is kept here says when it was
 * dropped, what it left in which org, and from what day: enough for the
 * `sandforge cleanup` line that lists, without deleting, every record the
 * user created there since, the run's among them. Ids none — the bound
 * dropped them for their bytes —, the latest {@link SEED_RUNS_DROPPED_KEPT}
 * runs at most, one line each.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as z from 'zod';
import type { SeedRunDropped } from '@sandforge/shared';
import { syncRemovalPlan, type SyncRunKept } from '../sync/SyncRunCreations.js';

/** The file, under the folder the runs' folder is in, that keeps the dropped runs. */
export const SEED_RUNS_DROPPED_FILE = 'seed-runs-dropped.ndjson';

/** Dropped runs kept at most: the oldest goes first past it. */
export const SEED_RUNS_DROPPED_KEPT = 50;

/** What the index reads and writes its file with. */
export interface SeedRunsDroppedFiles {
  /** The file's text; throws when there is none. */
  readFile: (filePath: string) => Promise<string>;
  appendFile: (filePath: string, content: string) => Promise<void>;
  writeFile: (filePath: string, content: string) => Promise<void>;
}

/**
 * Node's file system, the folder made first: a journal folder named by
 * `SANDFORGE_JOURNAL_DIR` may not be there yet.
 */
const NODE_FILES: SeedRunsDroppedFiles = {
  readFile: (filePath) => readFile(filePath, 'utf8'),
  appendFile: async (filePath, content) => {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, content, 'utf8');
  },
  writeFile: async (filePath, content) => {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  },
};

/** One line of the file, as it is read back: a line that does not hold is passed over. */
const droppedSchema = z.object({
  runId: z.string().min(1),
  targetOrgId: z.string().min(1),
  origin: z.enum(['csv', 'clone']).optional(),
  startedAt: z.string().min(1),
  droppedAt: z.string().min(1),
  left: z.array(
    z.object({ objectApiName: z.string().min(1), count: z.number().int().nonnegative() }),
  ),
});

/** What is kept of a run dropped at `droppedAt`: what a removal of it would still have taken. */
export function droppedOf(run: SyncRunKept, droppedAt: string): SeedRunDropped {
  return {
    runId: run.runId,
    targetOrgId: run.targetOrgId,
    ...(run.origin ? { origin: run.origin } : {}),
    startedAt: run.startedAt,
    droppedAt,
    left: syncRemovalPlan(run).map(({ objectApiName, ids }) => ({
      objectApiName,
      count: ids.length,
    })),
  };
}

/** The Seed runs dropped with their records still in their org: see the module's comment. */
export class SeedRunsDropped {
  /** The writes in turn: runs dropped at once are noted one after the other. */
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly files: SeedRunsDroppedFiles = NODE_FILES,
    private readonly kept: number = SEED_RUNS_DROPPED_KEPT,
  ) {}

  /**
   * Note a run the bound dropped. Never throws: a run whose line could not be
   * written is dropped all the same, and said by whoever was told of it.
   */
  note(run: SyncRunKept, droppedAt: string = new Date().toISOString()): Promise<void> {
    const entry = droppedOf(run, droppedAt);
    this.writes = this.writes.then(() => this.append(entry)).catch(() => undefined);
    return this.writes;
  }

  /** The latest line of a run, once the writes under way are done; undefined when none names it. */
  async find(runId: string): Promise<SeedRunDropped | undefined> {
    await this.writes;
    return (await this.read()).reverse().find((entry) => entry.runId === runId);
  }

  private async read(): Promise<SeedRunDropped[]> {
    let text: string;
    try {
      text = await this.files.readFile(this.file);
    } catch {
      return [];
    }
    const entries: SeedRunDropped[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = droppedSchema.safeParse(raw);
      if (parsed.success) entries.push(parsed.data);
    }
    return entries;
  }

  /** Add a line; past what is kept, write the file again with the latest alone. */
  private async append(entry: SeedRunDropped): Promise<void> {
    const entries = await this.read();
    if (entries.length < this.kept) {
      await this.files.appendFile(this.file, `${JSON.stringify(entry)}\n`);
      return;
    }
    const latest = [...entries.slice(entries.length - this.kept + 1), entry];
    await this.files.writeFile(this.file, latest.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }
}

/** The index of the dropped runs kept under `storagePath`, beside the runs' folder. */
export function nodeSeedRunsDropped(storagePath: string): SeedRunsDropped {
  return new SeedRunsDropped(join(storagePath, SEED_RUNS_DROPPED_FILE));
}

/**
 * What a refusal says of a run nothing of which is kept but this index's
 * line: when it was dropped, what it left in its org, and the cleanup line
 * (`line`, {@link droppedCleanupLine}) that lists it, deleting nothing. The
 * ways that take the records back without that line — a rewind, an emptying
 * — are the caller's to name, as its reader reaches them.
 */
export function droppedRunWords(dropped: SeedRunDropped, line: string): string {
  const left = dropped.left.reduce((sum, { count }) => sum + count, 0);
  const objects = dropped.left.map(({ objectApiName }) => objectApiName).join(', ');
  return (
    `Nothing this run created is kept: it was dropped on ${dropped.droppedAt} to keep the ` +
    `runs kept on this machine within their bound, ${left} of its records still in its org` +
    `${objects ? ` (${objects})` : ''}. ${line} lists, deleting nothing, every record you ` +
    'created there since the day the run started, its records among them; the same line ' +
    'without --dry-run deletes what it counted.'
  );
}

/**
 * The `sandforge cleanup` line that lists, without deleting, every record the
 * user created in `target` since the day the run started, by UTC — the day
 * `--since` reads —, of the objects it left, the last written first as the
 * cleanup deletes them, as many of each as the run left. It counts the run's
 * records among any others created there since: the line deletes nothing,
 * and the same line without `--dry-run` deletes what it counted.
 *
 * @param command - The command as the reader runs it: `npx sandforge cleanup`
 *   from the panel, `commandOf('cleanup')` on the command line.
 */
export function droppedCleanupLine(
  dropped: SeedRunDropped,
  command: string,
  target: string,
): string {
  const day = new Date(dropped.startedAt).toISOString().slice(0, 10);
  const objects = dropped.left.map(({ objectApiName }) => objectApiName);
  const most = Math.max(1, ...dropped.left.map(({ count }) => count));
  return [
    command,
    `--target ${target}`,
    `--since ${day}`,
    ...(objects.length > 0 ? [`--objects ${objects.join(',')}`, `--max ${most}`] : []),
    '--dry-run',
  ].join(' ');
}
