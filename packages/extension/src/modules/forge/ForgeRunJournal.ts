import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import {
  forgeAnonymizationRulesSchema,
  forgeConfigSchema,
  forgeGraphSchema,
  forgeRunCreatedRecords,
  type ForgeRemovalPlan,
} from '@sandforge/shared';
import { ForgeRunStore, nodeRunFile, type RunFile } from './ForgeRunStore.js';

/** File-system operations the journal needs, injected so it stays testable. */
export interface ForgeRunJournalDeps {
  /** Directory the extension owns for persistent data (globalStorageUri). */
  storagePath: string;
  /** Add to the end of a file, creating it when it is not there. */
  appendFile: (filePath: string, content: string) => Promise<void>;
  /** A file's lines, one at a time, without holding the file whole. */
  readLines: (filePath: string) => AsyncIterable<string>;
  mkdir: (dirPath: string) => Promise<void>;
  rm: (filePath: string) => Promise<void>;
  /** The names of the files directly in a directory; none when it is not there. */
  listFiles: (dirPath: string) => Promise<string[]>;
  /** A journal's file, for the store of the run under way to write and read as it goes. */
  openRunFile: (filePath: string) => RunFile;
}

/**
 * The journal of runs over Node's file system, under the extension's storage
 * directory, in `forge-runs/`.
 */
export function nodeRunJournal(storagePath: string): ForgeRunJournal {
  return new ForgeRunJournal({
    storagePath,
    appendFile: (filePath, content) => appendFile(filePath, content, 'utf8'),
    readLines: (filePath) => linesOf(filePath),
    mkdir: async (dirPath) => {
      await mkdir(dirPath, { recursive: true });
    },
    rm: (filePath) => rm(filePath, { force: true }),
    listFiles: (dirPath) =>
      readdir(dirPath).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }),
    openRunFile: (filePath) => nodeRunFile(filePath),
  });
}

/** A file's lines, read a chunk at a time; the file is closed however the reading ends. */
async function* linesOf(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** A Salesforce id, as every id a journal holds is: they end up in deletes. */
const idSchema = z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/);
const objectSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/);

/**
 * What a journal keeps of the run it was begun for, beside its head, so that
 * the run can be taken up where it stopped: the orgs, the record it cloned
 * from, and the fingerprint of its setup (`forgeRunFingerprint`).
 */
const resumeSchema = z.object({
  sourceOrgId: z.string().min(1).max(128),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  /** The target's own id, as Salesforce gives it, when the run knew it. */
  targetSalesforceOrgId: idSchema.optional(),
  /** The record a clone of one record started from. */
  recordId: idSchema.optional(),
});

/**
 * What the run was started with, which the extension runs again to take it
 * up. Read apart: the command's graph, whose lookups do not all have a name,
 * may not read as one the panel sends, and the command rediscovers its own.
 */
const startedWithSchema = z.object({
  graph: forgeGraphSchema,
  config: forgeConfigSchema,
  anonymizationRules: forgeAnonymizationRulesSchema.optional(),
});

/** See `resumeSchema` and `startedWithSchema`. */
export type ForgeRunResumeHead = z.infer<typeof resumeSchema> & {
  startedWith?: z.infer<typeof startedWithSchema>;
};

/** The setup a head says its run was begun with; undefined when it says none, or not one that reads. */
function resumeOf(value: unknown): ForgeRunResumeHead | undefined {
  const setup = resumeSchema.safeParse(value);
  if (!setup.success) return undefined;
  const startedWith = startedWithSchema.safeParse((value as { startedWith?: unknown }).startedWith);
  return { ...setup.data, ...(startedWith.success ? { startedWith: startedWith.data } : {}) };
}

/** The first line of a journal: the run, and the org it writes to. */
const headSchema = z.object({
  run: z.object({
    journalId: z.string().min(1).max(200),
    targetOrgId: z.string().min(1).max(128),
    startedAt: z.string().min(1).max(40),
    // Read apart: a setup that no longer parses leaves the run removable,
    // and not resumable.
    resume: z.unknown().optional(),
  }),
});

/** A part's start: see `ForgeRunStore.beginPart`. */
const partSchema = z.object({
  part: z.object({ n: z.number().int().nonnegative(), startedAt: z.string().max(40).optional() }),
});

/** How a part ended, once its run is kept in the history. */
const endSchema = z.object({
  end: z.object({
    status: z.enum(['success', 'cancelled', 'failure', 'interrupted']),
    forgeId: z.string().min(1).max(200),
    /** When it ended, on the machine's clock. */
    at: z.string().max(40).optional(),
  }),
});

/** A line of a page written, as a journal of 1.50 kept it: the records it created. */
const pageSchema = z.object({
  object: objectSchema,
  created: z.array(z.tuple([idSchema, idSchema])),
});

/** The head of a journal: the run, its org, what it was started with. */
export type ForgeRunJournalHead = Pick<
  ForgeRunJournalRead,
  'journalId' | 'targetOrgId' | 'startedAt' | 'resume'
>;

/** Beside a journal, how its last part ended: read at once, where the journal is read whole. */
function endPathOf(filePath: string): string {
  return filePath.replace(/\.ndjson$/, '') + '.end.json';
}

/** How a part of a run ended; `interrupted` for one a closed window stopped, recorded once found. */
export type ForgeRunPartEnd = z.infer<typeof endSchema>['end']['status'];

/** What a journal says of its run, read from its lines. */
export interface ForgeRunJournalRead {
  journalId: string;
  targetOrgId: string;
  startedAt: string;
  /** What the run was started with; absent from a journal kept before runs could be resumed. */
  resume?: ForgeRunResumeHead;
  /** Parts the run has had. */
  parts: number;
  /** How the last part ended, and when; absent while it has not, or since a window closed under it. */
  lastEnd?: { status: ForgeRunPartEnd; forgeId: string; at?: string };
  /** When the last part began, as its line says; the run's start for a journal of 1.50. */
  partStartedAt: string;
  /** How the part before the last ended, when there is one. */
  endBefore?: { status: ForgeRunPartEnd; forgeId: string };
  /** What the last part created, in the order a removal takes it, by target id. */
  created: ForgeRemovalPlan['objects'];
  /**
   * What the last part created and linked to, by source id, as a run's
   * history entry keeps it: the records it created per object, in the order
   * it created them, and those it linked to.
   */
  remap: {
    table: Record<string, string>;
    createdByObject: Array<{ objectApiName: string; sourceIds: string[] }>;
    linked: string[];
  };
}

/** A journal id as it goes into a file name: letters, digits, `_` and `-`. */
function fileSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * What a run read and written page by page has written, read and still owes,
 * kept on disk as it goes (see `ForgeRunStore`): a head line that names the
 * run, the org it writes to and what it was started with, then each part of
 * the run — the run, and every resumption of it — with what it created and
 * linked to, where each object's read stood, the lookups and statuses it
 * owed.
 *
 * A run that ends in success records what it created in the run history, and
 * its journal goes. One stopped by a cancel or a failure is kept in the
 * history with its journal, which says where to resume it from, and how its
 * last part ended. One whose window closed under it — the extension host
 * stopped, the machine slept for good — leaves a journal whose last part has
 * no end: it is found the next time the runs are listed (`leftOver`), its
 * records offered for removal and the run for resumption.
 *
 * Ids alone, and the run's setup, never a value of a record — but for the
 * status a draft is owed. One file per run under the extension's storage
 * (`forge-runs/`).
 */
export class ForgeRunJournal {
  private readonly dir: string;

  constructor(private readonly deps: ForgeRunJournalDeps) {
    this.dir = path.join(deps.storagePath, 'forge-runs');
  }

  /** The file of the journal `journalId`. */
  pathOf(journalId: string): string {
    return path.join(this.dir, `${fileSegment(journalId)}.ndjson`);
  }

  private filePath(journalId: string): string {
    return this.pathOf(journalId);
  }

  /**
   * Start the journal of a run about to write to `targetOrgId`, with what it
   * was started with when it can be resumed.
   */
  async begin(
    journalId: string,
    targetOrgId: string,
    startedAt: Date,
    resume?: ForgeRunResumeHead,
  ): Promise<void> {
    await this.deps.mkdir(this.dir);
    const head = {
      run: {
        journalId,
        targetOrgId,
        startedAt: startedAt.toISOString(),
        ...(resume ? { resume } : {}),
      },
    };
    await this.deps.appendFile(this.filePath(journalId), `${JSON.stringify(head)}\n`);
  }

  /** The store the run under way writes its journal through: see `ForgeRunStore`. */
  open(journalId: string): ForgeRunStore {
    return this.openAt(this.filePath(journalId));
  }

  /** {@link open}, of the journal at `filePath`. */
  openAt(filePath: string): ForgeRunStore {
    return ForgeRunStore.open(this.deps.openRunFile(filePath));
  }

  /** Say how the last part of the run ended, once the run is in the history as `forgeId`. */
  stop(journalId: string, status: ForgeRunPartEnd, forgeId: string): Promise<void> {
    return this.stopAt(this.filePath(journalId), status, forgeId);
  }

  /** {@link stop}, of the journal at `filePath`. */
  async stopAt(filePath: string, status: ForgeRunPartEnd, forgeId: string): Promise<void> {
    const line = `${JSON.stringify({ end: { status, forgeId, at: new Date().toISOString() } })}\n`;
    await this.deps.appendFile(filePath, line);
    await this.deps.rm(endPathOf(filePath));
    await this.deps.appendFile(endPathOf(filePath), line);
  }

  /** A part resuming the run begins: its last part's end no longer stands. */
  resuming(journalId: string): Promise<void> {
    return this.resumingAt(this.filePath(journalId));
  }

  /** {@link resuming}, of the journal at `filePath`. */
  resumingAt(filePath: string): Promise<void> {
    return this.deps.rm(endPathOf(filePath));
  }

  /** How the last part of the run ended, or undefined while it has not, or the journal is gone. */
  lastEnd(journalId: string): Promise<ForgeRunJournalRead['lastEnd']> {
    return this.lastEndAt(this.filePath(journalId));
  }

  /** {@link lastEnd}, of the journal at `filePath`. */
  async lastEndAt(filePath: string): Promise<ForgeRunJournalRead['lastEnd']> {
    for await (const line of this.deps.readLines(endPathOf(filePath))) {
      if (line.trim() === '') continue;
      try {
        const end = endSchema.safeParse(JSON.parse(line));
        return end.success ? end.data.end : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /** Drop the journal of a run that ended: the run history holds what it created. */
  async end(journalId: string): Promise<void> {
    await this.deps.rm(this.filePath(journalId));
    await this.deps.rm(endPathOf(this.filePath(journalId)));
  }

  /**
   * The head of the journal `journalId`: the run, its org, what it was started
   * with — read from its first line alone. Undefined when there is none.
   */
  async head(journalId: string): Promise<ForgeRunJournalHead | undefined> {
    const head = await this.headAt(this.filePath(journalId));
    return head?.journalId === journalId ? head : undefined;
  }

  /** {@link head}, of the journal at `filePath`. */
  async headAt(filePath: string): Promise<ForgeRunJournalHead | undefined> {
    for await (const line of this.deps.readLines(filePath)) {
      if (line.trim() === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return undefined;
      }
      const parsed = headSchema.safeParse(value);
      if (!parsed.success) return undefined;
      const { resume, ...run } = parsed.data.run;
      const setup = resumeOf(resume);
      return { ...run, ...(setup ? { resume: setup } : {}) };
    }
    return undefined;
  }

  /** What the journal `journalId` says of its run; undefined when there is none, or it is not one. */
  async read(journalId: string): Promise<ForgeRunJournalRead | undefined> {
    const names = await this.deps.listFiles(this.dir);
    const name = `${fileSegment(journalId)}.ndjson`;
    if (!names.includes(name)) return undefined;
    const read = await this.readAt(path.join(this.dir, name));
    return read?.journalId === journalId ? read : undefined;
  }

  /**
   * What the journal at `filePath` says of its run, and what its last part —
   * or every part, or the part of that index — created and linked to.
   */
  readAt(
    filePath: string,
    parts: 'last' | 'all' | number = 'last',
  ): Promise<ForgeRunJournalRead | undefined> {
    return this.readFile(filePath, parts);
  }

  /**
   * The journals whose last part never ended — a window closed under the
   * run — with what that part created: each, as a run stopped part way, to
   * remove, and, when its head says what the run was started with, to
   * resume. A line that is not what the journal writes is left out — the
   * last one of a window that closed mid-write among them — and the others
   * stand; a journal whose first line is not a run's is left out whole.
   *
   * @param running - The journals of runs under way, which are not left over.
   */
  async leftOver(running: ReadonlySet<string> = new Set()): Promise<ForgeRunJournalRead[]> {
    const found: ForgeRunJournalRead[] = [];
    const names = await this.deps.listFiles(this.dir);
    const ended = new Set(names.filter((name) => name.endsWith('.end.json')));
    for (const name of names) {
      if (!name.endsWith('.ndjson')) continue;
      // Ended, as the file beside it says: not read again at each listing.
      if (ended.has(name.replace(/\.ndjson$/, '.end.json'))) continue;
      const read = await this.readFile(path.join(this.dir, name), 'last');
      if (!read || running.has(read.journalId) || read.lastEnd) continue;
      found.push(read);
    }
    return found;
  }

  /**
   * The removal plan of what the last part of a journal's run created, as
   * a run stopped part way: see `leftOver`. Undefined when it created
   * nothing.
   */
  static planOf(
    read: ForgeRunJournalRead,
    forgeId: string = read.journalId,
  ): ForgeRemovalPlan | undefined {
    if (read.created.length === 0) return undefined;
    return {
      forgeId,
      targetOrgId: read.targetOrgId,
      timestamp: read.startedAt,
      duration: 0,
      status: 'partial',
      objects: read.created,
      linked: 0,
    };
  }

  /** Forget the journal `journalId`, once what it held is kept elsewhere. */
  forget(journalId: string): Promise<void> {
    return this.end(journalId);
  }

  private async readFile(
    filePath: string,
    which: 'last' | 'all' | number,
  ): Promise<ForgeRunJournalRead | undefined> {
    let head: z.infer<typeof headSchema>['run'] | undefined;
    let parts = 0;
    let lastEnd: ForgeRunJournalRead['lastEnd'];
    let endBefore: ForgeRunJournalRead['lastEnd'];
    let partStartedAt: string | undefined;
    /** The last part's records, by source id: the latest word on each. */
    let table = new Map<string, { targetId: string; object: string; created: boolean }>();
    const newPart = (): void => {
      parts++;
      endBefore = lastEnd;
      lastEnd = undefined;
      if (which === 'last') table = new Map();
    };
    /** Whether the part under way is one whose records are read. */
    const reading = (): boolean => typeof which !== 'number' || parts - 1 === which;
    for await (const line of this.deps.readLines(filePath)) {
      if (line.trim() === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!head) {
        const parsed = headSchema.safeParse(value);
        if (!parsed.success) return undefined;
        head = parsed.data.run;
        continue;
      }
      if (Array.isArray(value)) {
        const [tag, sourceId, targetId, object] = value as unknown[];
        if (tag !== 'c' && tag !== 'e' && tag !== 'u') continue;
        if (!reading()) continue;
        if (!idSchema.safeParse(sourceId).success || !idSchema.safeParse(targetId).success)
          continue;
        table.set(String(sourceId), {
          targetId: String(targetId),
          object:
            typeof object === 'string' && objectSchema.safeParse(object).success ? object : '',
          created: tag === 'c',
        });
        continue;
      }
      const part = partSchema.safeParse(value);
      if (part.success) {
        newPart();
        partStartedAt = part.data.part.startedAt;
        continue;
      }
      const end = endSchema.safeParse(value);
      if (end.success) {
        lastEnd = end.data.end;
        continue;
      }
      // A journal of 1.50: one part, its pages' records.
      const page = pageSchema.safeParse(value);
      if (page.success) {
        if (parts === 0) newPart();
        if (!reading()) continue;
        for (const [sourceId, targetId] of page.data.created) {
          table.set(sourceId, { targetId, object: page.data.object, created: true });
        }
      }
    }
    if (!head) return undefined;
    const resume = resumeOf(head.resume);
    const idRemapTable: Record<string, string> = {};
    const byObject = new Map<string, string[]>();
    const linked: string[] = [];
    for (const [sourceId, { targetId, object, created }] of table) {
      if (!object) continue;
      idRemapTable[sourceId] = targetId;
      if (!created) {
        linked.push(sourceId);
        continue;
      }
      const ids = byObject.get(object) ?? [];
      ids.push(sourceId);
      byObject.set(object, ids);
    }
    const createdByObject = [...byObject].map(([objectApiName, sourceIds]) => ({
      objectApiName,
      sourceIds,
    }));
    return {
      journalId: head.journalId,
      targetOrgId: head.targetOrgId,
      startedAt: head.startedAt,
      ...(resume ? { resume } : {}),
      parts,
      partStartedAt: partStartedAt ?? head.startedAt,
      ...(lastEnd ? { lastEnd } : {}),
      ...(endBefore ? { endBefore } : {}),
      created: forgeRunCreatedRecords({
        idRemapTable,
        idRemapExisting: linked,
        idRemapCreated: createdByObject,
      }),
      remap: { table: idRemapTable, createdByObject, linked },
    };
  }
}
