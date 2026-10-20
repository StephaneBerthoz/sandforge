/**
 * What each Sync run created in its target, kept as the run writes it, so the
 * run can be taken back: the records it inserted, or upserted where the target
 * held none, and the files it created. A record it updated was the target's
 * before, and a version added to an earlier copy of a file is the copy's: no
 * removal is theirs to take.
 *
 * Kept in the extension's storage directory, one file per run under
 * `sync-runs/`, never in globalState, which VS Code writes whole on every
 * change. The run's file is appended to as soon as the ids are known — a line
 * names the run, then a line per write of an object or file, then a line once
 * the run ends — so a window that closes under the run leaves what it created
 * so far removable, and a line cut short by it is left out when the file is
 * read. Ids and dates alone: never a value of a record.
 *
 * What the removals of a run did, and what they left on its records for the
 * next one, is kept beside its file (`.removal.json`), written whole.
 *
 * The files are bounded on bytes: past {@link SYNC_RUNS_MAX_BYTES} the runs
 * removed with nothing left go first, oldest first; past
 * {@link SYNC_RUNS_HARD_MAX_BYTES}, the oldest runs whatever they hold. The run
 * being written is never one of them.
 */

import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import * as z from 'zod';
import type { ForgeRemovalSpan, ForgeUndoMark } from '@sandforge/shared';
import { forgeRemovalPlanLeft } from '@sandforge/shared';
import { SyncIdMap } from './SyncIdMap.js';

/** The directory, under the extension's storage, that the runs' files go in. */
export const SYNC_RUNS_DIR = 'sync-runs';

/**
 * The most the runs' files take, in bytes, before the runs removed with
 * nothing left go: about 200 000 record ids.
 */
export const SYNC_RUNS_MAX_BYTES = 4 * 1024 * 1024;

/** The most they take before the oldest runs go, whatever they hold. */
export const SYNC_RUNS_HARD_MAX_BYTES = 64 * 1024 * 1024;

/** The objects a run's files are kept under: removed before any record they hang on. */
export const SYNC_FILE_OBJECTS: readonly string[] = ['ContentDocument', 'Attachment'];

/** A file of the runs' directory. */
export interface SyncRunFileEntry {
  name: string;
  /** Its size, in bytes. */
  size: number;
}

/** File-system operations the store needs, injected so it stays testable. */
export interface SyncRunCreationsDeps {
  /** Directory the extension owns for persistent data (globalStorageUri). */
  storagePath: string;
  /**
   * The directory under it the runs' files go in: {@link SYNC_RUNS_DIR}
   * unless another module keeps its runs the same way (`SeedRunCreations`).
   */
  runsDir?: string;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  /** Add to the end of a file, creating it when it is not there. */
  appendFile: (filePath: string, content: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (dirPath: string) => Promise<void>;
  rm: (filePath: string) => Promise<void>;
  /** The files directly in a directory, with their sizes; none when it is not there. */
  listFiles: (dirPath: string) => Promise<SyncRunFileEntry[]>;
  /** The soft bound; {@link SYNC_RUNS_MAX_BYTES} unless a test sets another. */
  maxBytes?: number;
  /** The hard bound; {@link SYNC_RUNS_HARD_MAX_BYTES} unless a test sets another. */
  hardMaxBytes?: number;
}

/**
 * The store over Node's file system, under the extension's storage directory,
 * or the directory the command line is told.
 */
export function nodeSyncRunCreations(storagePath: string, runsDir?: string): SyncRunCreations {
  return new SyncRunCreations({
    storagePath,
    ...(runsDir !== undefined ? { runsDir } : {}),
    readFile: (filePath) => readFile(filePath, 'utf8'),
    writeFile: (filePath, content) => writeFile(filePath, content, 'utf8'),
    appendFile: (filePath, content) => appendFile(filePath, content, 'utf8'),
    rename: (from, to) => rename(from, to),
    mkdir: async (dirPath) => {
      await mkdir(dirPath, { recursive: true });
    },
    rm: (filePath) => rm(filePath, { force: true }),
    listFiles: async (dirPath) => {
      let names: string[];
      try {
        names = await readdir(dirPath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
      const files: SyncRunFileEntry[] = [];
      for (const name of names) {
        // Removed between the listing and now, by another window's bound.
        const info = await stat(path.join(dirPath, name)).catch(() => undefined);
        if (info?.isFile()) files.push({ name, size: info.size });
      }
      return files;
    },
  });
}

/** A Salesforce id, as every id kept is: they end up in deletes. */
const idSchema = z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/);
const objectSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/);
const dateSchema = z.string().min(1).max(40);

/** The first line of a run's file: the run, its configuration and its orgs. */
const headSchema = z.object({
  run: z.object({
    runId: z.string().min(1).max(200),
    configId: z.string().min(1).max(200),
    configName: z.string().max(500),
    sourceOrgId: z.string().min(1).max(200),
    targetOrgId: z.string().min(1).max(200),
    startedAt: dateSchema,
  }),
});

/**
 * A line per write: the records of one object, or the files, the run created,
 * and when, on this machine's clock — the latest is when the run last wrote,
 * which its removal reads the org's dates against.
 */
const createdSchema = z.object({
  object: objectSchema,
  created: z.array(idSchema).max(50_000),
  at: dateSchema.optional(),
});

/** The last line: how the run ended, on this machine's clock. */
const endSchema = z.object({
  end: z.object({
    at: dateSchema,
    status: z.enum(['success', 'partial', 'failure']),
    cancelled: z.literal(true).optional(),
  }),
});

/** What the removals of a run did, kept beside its file. */
const removalSchema = z.object({
  version: z.literal(1),
  undo: z
    .object({
      removedAt: dateSchema,
      deleted: z.number().int().nonnegative(),
      alreadyGone: z.number().int().nonnegative(),
      kept: z.number().int().nonnegative(),
      refused: z.number().int().nonnegative(),
      notReached: z.number().int().nonnegative().optional(),
      notVisible: z.number().int().nonnegative().optional(),
    })
    .optional(),
  removalStamps: z.record(idSchema, dateSchema).optional(),
  removalSpans: z
    .array(z.object({ first: dateSchema, last: dateSchema, userId: idSchema }))
    .optional(),
  removalLeft: z.array(idSchema).optional(),
});

/**
 * What the removals of a run did, read from what a file holds, or undefined
 * when it holds nothing that reads as such: external input, as every id in it
 * ends up in a delete.
 */
export function readRemovalState(raw: unknown): SyncRunRemovalState | undefined {
  const parsed = removalSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { undo, removalStamps, removalSpans, removalLeft } = parsed.data;
  return {
    ...(undo ? { undo } : {}),
    ...(removalStamps ? { removalStamps } : {}),
    ...(removalSpans ? { removalSpans } : {}),
    ...(removalLeft ? { removalLeft } : {}),
  };
}

/** What the removals of a run did, and left on its records for the next one. */
export interface SyncRunRemovalState {
  undo?: ForgeUndoMark;
  /** What earlier removals wrote to records they left, by id: see `RunRemovalOptions.removalStamps`. */
  removalStamps?: Record<string, string>;
  /** When earlier removals that wrote ran: see `RunRemovalOptions.removalSpans`. */
  removalSpans?: ForgeRemovalSpan[];
  /** The run's records its removals left in the org; all of them before any took one. */
  removalLeft?: string[];
}

/** The run a file names. */
export type SyncRunHead = z.infer<typeof headSchema>['run'];

/** What a run kept, read back from its file. */
export interface SyncRunKept extends SyncRunHead {
  /** How the run ended; absent from one a closed window stopped part way. */
  end?: z.infer<typeof endSchema>['end'];
  /** When the run last wrote something it created, on this machine's clock. */
  lastWrittenAt?: string;
  /**
   * What it created, per object in the order it first wrote each, the ids in
   * the order it wrote them — files under `ContentDocument` and `Attachment`.
   */
  created: Array<{ objectApiName: string; ids: string[] }>;
  /** What its removals did, once one ran. */
  removal?: SyncRunRemovalState;
}

/** A run id as it goes into a file name: letters, digits, `_` and `-`, the rest as `_`. */
function fileSegment(runId: string): string {
  return runId.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** A JSON line, or undefined for one that does not parse: a line a closed window cut short. */
function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * What a run's file says, or undefined when it names no run. Each object's
 * ids once, in the order first written.
 */
export function readRunFile(text: string): Omit<SyncRunKept, 'removal'> | undefined {
  let head: SyncRunHead | undefined;
  let end: SyncRunKept['end'];
  let lastWrittenAt: string | undefined;
  const byObject = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const value = parseLine(line);
    if (!head) {
      const parsed = headSchema.safeParse(value);
      if (parsed.success) head = parsed.data.run;
      continue;
    }
    const created = createdSchema.safeParse(value);
    if (created.success) {
      const at = created.data.at;
      if (
        at !== undefined &&
        (lastWrittenAt === undefined || Date.parse(at) > Date.parse(lastWrittenAt))
      ) {
        lastWrittenAt = at;
      }
      const ids = byObject.get(created.data.object) ?? [];
      for (const id of created.data.created) {
        const key = id.slice(0, 15);
        if (seen.has(key)) continue;
        seen.add(key);
        ids.push(id);
      }
      byObject.set(created.data.object, ids);
      continue;
    }
    const ended = endSchema.safeParse(value);
    if (ended.success) end = ended.data.end;
  }
  if (!head) return undefined;
  return {
    ...head,
    ...(end ? { end } : {}),
    ...(lastWrittenAt !== undefined ? { lastWrittenAt } : {}),
    created: [...byObject].flatMap(([objectApiName, ids]) =>
      ids.length > 0 ? [{ objectApiName, ids }] : [],
    ),
  };
}

/**
 * What a removal of a run sets out to take, in the order it hands it to the
 * removal: the files first — a file the run created is deleted before the
 * record it hangs on, which would leave it to whoever owns it — then each
 * object in the reverse of the order the run wrote them, children before
 * their parents as far as the run knows, the last record written first.
 * Less what earlier removals took.
 */
export function syncRemovalPlan(
  run: Pick<SyncRunKept, 'created' | 'removal'>,
): Array<{ objectApiName: string; ids: string[] }> {
  const files = SYNC_FILE_OBJECTS.flatMap((name) =>
    run.created.filter((object) => object.objectApiName === name),
  );
  const records = run.created.filter((object) => !SYNC_FILE_OBJECTS.includes(object.objectApiName));
  const ordered = [...files, ...[...records].reverse()].map(({ objectApiName, ids }) => ({
    objectApiName,
    ids: [...ids].reverse(),
  }));
  return forgeRemovalPlanLeft({
    objects: ordered,
    undo: run.removal?.undo,
    removalLeft: run.removal?.removalLeft,
  });
}

/** How many records and files a run created, in all. */
export function createdCount(run: Pick<SyncRunKept, 'created'>): number {
  return run.created.reduce((sum, object) => sum + object.ids.length, 0);
}

/** A run removed with nothing left behind: nothing more of it to remove. */
export function settled(run: SyncRunKept): boolean {
  return run.removal?.undo !== undefined && syncRemovalPlan(run).length === 0;
}

/**
 * Records, as one run writes them, what it creates. A run that creates
 * nothing leaves no file.
 */
export interface SyncCreationRecorder {
  /** The id the run's creations are kept under. */
  readonly runId: string;
  /**
   * The records of `objectApiName` — or the files, under `ContentDocument` and
   * `Attachment` — the run has just created: written at once, in the order
   * given, dated now, or `at` for a run that writes them down once it has
   * ended. Never throws: a write that fails is said by {@link flush}.
   */
  note(objectApiName: string, ids: readonly string[], at?: string): void;
  /**
   * Waits for what was noted to be written, and says why some of it could
   * not be, once: undefined when all of it was.
   */
  flush(): Promise<string | undefined>;
}

/** What a run's recorder is told of the run when it begins. */
export type SyncRunStart = Omit<SyncRunHead, 'startedAt'> & { startedAt?: string };

/**
 * What every Sync run created, and what the removals of each did: see the
 * module's comment.
 */
export class SyncRunCreations {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly hardMaxBytes: number;
  /** Changes to the removal files one after the other: two at once would lose one. */
  private queue: Promise<unknown> = Promise.resolve();
  /** See {@link idMap}. */
  private links?: SyncIdMap;

  /** @param deps - Injected storage path and file-system operations. */
  constructor(private readonly deps: SyncRunCreationsDeps) {
    this.dir = path.join(deps.storagePath, deps.runsDir ?? SYNC_RUNS_DIR);
    this.maxBytes = deps.maxBytes ?? SYNC_RUNS_MAX_BYTES;
    this.hardMaxBytes = Math.max(this.maxBytes, deps.hardMaxBytes ?? SYNC_RUNS_HARD_MAX_BYTES);
  }

  private runPath(runId: string): string {
    return path.join(this.dir, `${fileSegment(runId)}.ndjson`);
  }

  private removalPath(runId: string): string {
    return path.join(this.dir, `${fileSegment(runId)}.removal.json`);
  }

  /**
   * The recorder of one run. Its file is begun with the first ids noted, the
   * runs' files kept within their bounds first.
   */
  recorder(start: SyncRunStart): SyncCreationRecorder & {
    /** Note how the run ended, when it created anything. */
    end(ending: {
      status: 'success' | 'partial' | 'failure';
      cancelled?: boolean;
      /** When it ended, on this machine's clock; now, unless the run says. */
      at?: string;
    }): Promise<void>;
  } {
    const file = this.runPath(start.runId);
    const head: SyncRunHead = { ...start, startedAt: start.startedAt ?? new Date().toISOString() };
    let begun = false;
    let writes: Promise<void> = Promise.resolve();
    let failure: string | undefined;
    const append = (line: unknown): void => {
      writes = writes.then(async () => {
        if (failure !== undefined) return;
        try {
          if (!begun) {
            begun = true;
            await this.deps.mkdir(this.dir);
            // Room made for the run, as far as it can be: a run whose files
            // could not be listed or dropped keeps what it creates all the same.
            await this.keepWithinBounds(start.runId).catch(() => undefined);
            await this.deps.appendFile(file, `${JSON.stringify({ run: head })}\n`);
          }
          await this.deps.appendFile(file, `${JSON.stringify(line)}\n`);
        } catch (err: unknown) {
          failure = err instanceof Error ? err.message : String(err);
        }
      });
    };
    return {
      runId: start.runId,
      note: (objectApiName, ids, at) => {
        const valid = ids.filter((id) => idSchema.safeParse(id).success);
        if (valid.length === 0 || !objectSchema.safeParse(objectApiName).success) return;
        append({ object: objectApiName, created: valid, at: at ?? new Date().toISOString() });
      },
      flush: async () => {
        await writes;
        return failure;
      },
      end: async (ending) => {
        await writes;
        if (!begun || failure !== undefined) return;
        append({
          end: {
            at: ending.at ?? new Date().toISOString(),
            status: ending.status,
            ...(ending.cancelled ? { cancelled: true } : {}),
          },
        });
        await writes;
      },
    };
  }

  /**
   * Which record of the target each source record a saved configuration's
   * runs wrote became (`SyncIdMap`), kept in the same storage directory: what
   * a run reads and adds to, and what a removal of a run forgets.
   */
  idMap(): SyncIdMap {
    this.links ??= new SyncIdMap(this.deps);
    return this.links;
  }

  /** What one run kept, or undefined when nothing of it is. */
  async get(runId: string): Promise<SyncRunKept | undefined> {
    let text: string;
    try {
      text = await this.deps.readFile(this.runPath(runId));
    } catch {
      return undefined;
    }
    const run = readRunFile(text);
    if (!run || run.runId !== runId) return undefined;
    const removal = await this.readRemoval(runId);
    return removal ? { ...run, removal } : run;
  }

  /** Every run kept, newest first. A file that names no run is left out. */
  async list(): Promise<SyncRunKept[]> {
    const runs: SyncRunKept[] = [];
    for (const file of await this.deps.listFiles(this.dir)) {
      if (!file.name.endsWith('.ndjson')) continue;
      let text: string;
      try {
        text = await this.deps.readFile(path.join(this.dir, file.name));
      } catch {
        continue;
      }
      const run = readRunFile(text);
      if (!run) continue;
      const removal = await this.readRemoval(run.runId);
      runs.push(removal ? { ...run, removal } : run);
    }
    return runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || 0);
  }

  /**
   * Change what the removals of a run did: `change` is handed what is kept
   * and returns what to keep. Written whole, through a file beside it renamed
   * over it, so a window that stops mid-write leaves the last whole one.
   */
  updateRemoval(
    runId: string,
    change: (state: SyncRunRemovalState) => SyncRunRemovalState,
  ): Promise<void> {
    const next = this.queue.then(async () => {
      const state = change((await this.readRemoval(runId)) ?? {});
      const file = this.removalPath(runId);
      const written = `${file}.${process.pid}.tmp`;
      await this.deps.mkdir(this.dir);
      await this.deps.writeFile(written, JSON.stringify({ version: 1, ...state }));
      await this.deps.rename(written, file);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Forget a run: its file, and what its removals did. */
  async forget(runId: string): Promise<void> {
    await this.deps.rm(this.runPath(runId));
    await this.deps.rm(this.removalPath(runId));
  }

  private async readRemoval(runId: string): Promise<SyncRunRemovalState | undefined> {
    let raw: unknown;
    try {
      raw = JSON.parse(await this.deps.readFile(this.removalPath(runId)));
    } catch {
      return undefined;
    }
    return readRemovalState(raw);
  }

  /**
   * Keep the runs' files within their bounds before a run begins its own:
   * past the soft bound, the runs removed with nothing left go, oldest first;
   * past the hard one, the oldest runs, whatever they hold. The run beginning
   * is never one of them.
   */
  private async keepWithinBounds(beginning: string): Promise<void> {
    const files = await this.deps.listFiles(this.dir);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    if (total <= this.maxBytes) return;
    const sizes = new Map(files.map((file) => [file.name, file.size]));
    const runs = (await this.list()).filter((run) => run.runId !== beginning).reverse();
    const bytesOf = (run: SyncRunKept): number =>
      (sizes.get(path.basename(this.runPath(run.runId))) ?? 0) +
      (sizes.get(path.basename(this.removalPath(run.runId))) ?? 0);
    const drop = async (run: SyncRunKept): Promise<void> => {
      await this.deps.rm(this.runPath(run.runId));
      await this.deps.rm(this.removalPath(run.runId));
      total -= bytesOf(run);
    };
    for (const run of runs) {
      if (total <= this.maxBytes) return;
      if (settled(run)) await drop(run);
    }
    for (const run of runs) {
      if (total <= this.hardMaxBytes) return;
      if (!settled(run)) await drop(run);
    }
  }
}
