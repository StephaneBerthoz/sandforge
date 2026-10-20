import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readdir, rename, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import * as z from 'zod';
import {
  forgeAnonymizationRulesSchema,
  forgeConfigSchema,
  forgeGraphSchema,
  forgeRunCreatedRecords,
  type ForgeRemovalPlan,
  type IdMapRow,
} from '@sandforge/shared';
import { ForgeRunStore, journalLines, nodeRunFile, type RunFile } from './ForgeRunStore.js';
import type { RunRecords } from './ForgeRunRemoval.js';
import {
  callsInFlight,
  reconcileInFlight,
  type InFlightReconciliation,
  type InFlightTarget,
} from './ForgeInFlight.js';
import { HashedKeys, JournalPart } from './journalRecords.js';

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
  /**
   * Put a file in the place of another, whole: a file written beside the
   * journal — what removals left, what they stamped — is written next to it
   * and then put in its place, never left half written. Without it, the file
   * is written in place.
   */
  rename?: (from: string, to: string) => Promise<void>;
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
    rename: (from, to) => rename(from, to),
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

/**
 * Records mapped past which a run's summary keeps its counts and none of its
 * ids, which stay in the journal: 50 000 ids are a couple of MB of JSON, and a
 * run of whole tables can map a million. The command line's bound, whose
 * summary is a file of its own.
 */
export const SUMMARY_IDS_BOUND = 50_000;

/**
 * The same bound for a run of the extension, whose summary becomes an entry of
 * the run history and a removal plan: past it, both keep the counts and the
 * journal's name, never the ids. The history lives in VS Code's global state,
 * which is rewritten whole at every change and is not made for megabytes: at
 * the command line's bound, an entry held some 3 MB of ids, and the history
 * keeps twenty. Two thousand ids are about 130 KB of JSON, which a clone from
 * a record seldom reaches.
 */
export const HISTORY_IDS_BOUND = 2_000;

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

/** Beside a journal, the ids of what the removals of one of its parts left: one per line. */
function leftPathOf(filePath: string, part: number): string {
  return `${filePath.replace(/\.ndjson$/, '')}.part${part}.left`;
}

/**
 * Beside a journal, what the removals of one of its parts left on records
 * they did not delete: the `LastModifiedDate` the org left on each, one
 * `id date` per line (`RunRemovalOutcome.stamps`).
 */
function stampsPathOf(filePath: string, part: number): string {
  return `${filePath.replace(/\.ndjson$/, '')}.part${part}.stamps`;
}

/** A date as the org writes one: what a stamp holds. */
const stampDateSchema = z
  .string()
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)), 'not a date');

/** Ids written to a file of what removals left at a time. */
const LEFT_IDS_PER_WRITE = 10_000;

/** The ids of a part of a run whose summary keeps them in its journal, as its readers take them. */
export interface ForgeRunJournalIds {
  /** Source id to target id: every part's, the latest word on each. */
  table: Record<string, string>;
  /** What the part created, per object, in the order it created them. */
  createdByObject: Array<{ objectApiName: string; sourceIds: string[] }>;
  /** The source ids the part did not create: linked to, written over, or an earlier part's. */
  existing: string[];
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
 * What a run that writes has written, read and still owes, kept on disk as
 * it goes (see `ForgeRunStore`): a head line that names the run, the org it
 * writes to and what it was started with, then each part of the run — the
 * run, and every resumption of it — with what it created and linked to,
 * where each object's read stood, the lookups and statuses it owed, and
 * those it filled in.
 *
 * A run that ends in success records what it created in the run history, and
 * its journal goes — unless it mapped more records than the history keeps
 * the ids of (`HISTORY_IDS_BOUND`): its journal stays, ended, and holds them
 * for as long as the history or a removal plan names it. One stopped by a
 * cancel or a failure is kept in the
 * history with its journal, which says where to resume it from, and how its
 * last part ended. One whose window closed under it — the extension host
 * stopped, the machine slept for good — leaves a journal whose last part has
 * no end: it is found the next time the runs are listed (`leftOver`), its
 * records offered for removal and the run for resumption.
 *
 * Ids alone, and the run's setup, never a value of a record — but for the
 * status a draft is owed; of each insert call, before it goes, its rows'
 * source ids and a fingerprint of what each writes, which holds none of it
 * (`ForgeRunStore.sent`). One file per run under the extension's storage
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

  /**
   * Look in the target for the rows of the insert calls the journal
   * `journalId` names no answer of — a process killed while one was under
   * way — and keep in the journal what was found (`reconcileInFlight`):
   * before a part takes the run up, or its records are removed.
   */
  reconcile(journalId: string, target: InFlightTarget): Promise<InFlightReconciliation> {
    return this.reconcileAt(this.filePath(journalId), target);
  }

  /** {@link reconcile}, of the journal at `filePath`. */
  async reconcileAt(filePath: string, target: InFlightTarget): Promise<InFlightReconciliation> {
    const file = this.deps.openRunFile(filePath);
    try {
      return await reconcileInFlight(file, target);
    } finally {
      file.close();
    }
  }

  /**
   * The records the first and the last writes of the journal at `filePath`
   * name, every part of it: the first record it created, the last it
   * created, and the last it wrote to since — a lookup the second pass filled
   * in, a status given back — with the journal's last time on this machine's
   * clock. What a run taken back from its journal alone is dated by, its
   * summary saying no window (`writtenBetween`), read from the target. None
   * for a journal that names no record it created.
   */
  writeBoundsAt(filePath: string): {
    first?: { objectApiName: string; id: string };
    lastCreated?: { objectApiName: string; id: string };
    lastUpdated?: { objectApiName: string; id: string };
    /** The latest time a line of the journal holds, on the clock of the machine that wrote it. */
    lastAt?: string;
  } {
    const file = this.deps.openRunFile(filePath);
    try {
      let first: { objectApiName: string; id: string } | undefined;
      let lastCreated: { objectApiName: string; id: string } | undefined;
      let lastUpdated: { objectApiName: string; id: string } | undefined;
      /** The last record the second pass filled a lookup of, told by its id alone. */
      let lastFilled: string | undefined;
      let lastAt = Number.NEGATIVE_INFINITY;
      /** Each object the journal created records of, by the key prefix of their ids. */
      const objectOfPrefix = new Map<string, string>();
      for (const line of journalLines(file)) {
        const at = /"(?:startedAt|at)":"([^"]{10,40})"/.exec(line.text)?.[1];
        const sentAt = line.text.startsWith('["x"')
          ? /^\["x","[^"]*","[^"]*","([^"]+)"/.exec(line.text)?.[1]
          : undefined;
        for (const time of [at, sentAt]) {
          const epoch = time === undefined ? Number.NaN : Date.parse(time);
          if (Number.isFinite(epoch)) lastAt = Math.max(lastAt, epoch);
        }
        if (
          !line.text.startsWith('["c"') &&
          !line.text.startsWith('["p"') &&
          !line.text.startsWith('["g"')
        ) {
          continue;
        }
        let value: unknown;
        try {
          value = JSON.parse(line.text);
        } catch {
          continue;
        }
        if (!Array.isArray(value)) continue;
        const [tag, a, b, c] = value as unknown[];
        if (tag === 'c') {
          if (!idSchema.safeParse(b).success || !objectSchema.safeParse(c).success) continue;
          const created = { objectApiName: String(c), id: String(b) };
          first ??= created;
          lastCreated = created;
          objectOfPrefix.set(String(b).slice(0, 3), String(c));
        } else if (tag === 'g') {
          if (!idSchema.safeParse(b).success || !objectSchema.safeParse(a).success) continue;
          lastUpdated = { objectApiName: String(a), id: String(b) };
          lastFilled = undefined;
        } else if (idSchema.safeParse(a).success) {
          lastFilled = String(a);
        }
      }
      const filledOf = lastFilled ? objectOfPrefix.get(lastFilled.slice(0, 3)) : undefined;
      if (lastFilled && filledOf) lastUpdated = { objectApiName: filledOf, id: lastFilled };
      return {
        ...(first ? { first } : {}),
        ...(lastCreated ? { lastCreated } : {}),
        ...(lastUpdated ? { lastUpdated } : {}),
        ...(Number.isFinite(lastAt) ? { lastAt: new Date(lastAt).toISOString() } : {}),
      };
    } finally {
      file.close();
    }
  }

  /** The insert calls the journal `journalId` names no answer of: see {@link reconcile}. */
  callsInFlight(journalId: string): number {
    return this.callsInFlightAt(this.filePath(journalId));
  }

  /** The insert calls the journal at `filePath` names no answer of: see {@link reconcile}. */
  callsInFlightAt(filePath: string): number {
    const file = this.deps.openRunFile(filePath);
    try {
      return callsInFlight(file);
    } finally {
      file.close();
    }
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
    const filePath = this.filePath(journalId);
    await this.deps.rm(filePath);
    await this.deps.rm(endPathOf(filePath));
    // What the removals of its parts left, and stamped, goes with it.
    const prefix = `${path.basename(filePath).replace(/\.ndjson$/, '')}.part`;
    for (const name of await this.deps.listFiles(this.dir)) {
      if (name.startsWith(prefix) && (name.endsWith('.left') || name.endsWith('.stamps'))) {
        await this.deps.rm(path.join(this.dir, name));
      }
    }
  }

  /** The name of the file of the journal `journalId`, as {@link endedFiles} lists it. */
  fileNameOf(journalId: string): string {
    return `${fileSegment(journalId)}.ndjson`;
  }

  /** Of the journals `journalIds`, those that are there. */
  async present(journalIds: readonly string[]): Promise<Set<string>> {
    const names = new Set(await this.deps.listFiles(this.dir));
    return new Set(journalIds.filter((journalId) => names.has(this.fileNameOf(journalId))));
  }

  /**
   * The journals whose last part ended, by the name of their file: those a
   * run kept for its history entry, which says why — taken up where it
   * stopped, or its ids read from there.
   */
  async endedFiles(): Promise<string[]> {
    const names = await this.deps.listFiles(this.dir);
    const ended = new Set(names.filter((name) => name.endsWith('.end.json')));
    return names.filter(
      (name) => name.endsWith('.ndjson') && ended.has(name.replace(/\.ndjson$/, '.end.json')),
    );
  }

  /** Forget the journal whose file is `fileName`, as {@link forget} does. */
  async forgetFile(fileName: string): Promise<void> {
    const filePath = path.join(this.dir, fileName);
    const head = await this.headAt(filePath);
    if (head) await this.end(head.journalId);
    else {
      await this.deps.rm(filePath);
      await this.deps.rm(endPathOf(filePath));
    }
  }

  /**
   * The ids of the part `part` of the journal `journalId`, for a reader of a
   * run whose summary keeps them there: every part's table, what this part
   * created, and the rest as records it did not create — what its summary
   * would have held. Undefined when the journal is gone, or is not that run's.
   */
  async idsOf(journalId: string, part: number): Promise<ForgeRunJournalIds | undefined> {
    const filePath = this.filePath(journalId);
    const all = await this.readAt(filePath, 'all');
    if (all?.journalId !== journalId) return undefined;
    const mine = await this.readAt(filePath, part);
    if (!mine) return undefined;
    const created = new Set(mine.remap.createdByObject.flatMap(({ sourceIds }) => sourceIds));
    return {
      table: all.remap.table,
      createdByObject: mine.remap.createdByObject,
      existing: Object.keys(all.remap.table).filter((sourceId) => !created.has(sourceId)),
    };
  }

  /**
   * Keep, beside the journal, the target ids of the records the removals of
   * its part `part` left: what the next removal sets out to take, which the
   * history entry counts and does not hold.
   */
  async keepLeft(journalId: string, part: number, ids: readonly string[]): Promise<void> {
    const filePath = leftPathOf(this.filePath(journalId), part);
    await this.deps.rm(filePath);
    for (let at = 0; at < ids.length; at += LEFT_IDS_PER_WRITE) {
      await this.deps.appendFile(
        filePath,
        `${ids.slice(at, at + LEFT_IDS_PER_WRITE).join('\n')}\n`,
      );
    }
    // A removal that left none leaves a file that says so.
    if (ids.length === 0) await this.deps.appendFile(filePath, '');
  }

  /**
   * The records the part `part` of the journal `journalId` created that its
   * removals have not taken (`keepLeft`), as a removal takes them, read from
   * the journal a page at a time (`JournalPart`): what {@link idsOf} and
   * {@link leftOf} give whole, holding no id. Undefined when the journal is
   * gone or is not that run's, and for a journal of 1.50, read whole. `close`
   * lets the journal's file go, once the removal is through.
   */
  async recordsOf(
    journalId: string,
    part: number,
  ): Promise<{ records: RunRecords; close: () => void } | undefined> {
    if (!(await this.head(journalId))) return undefined;
    const left = await this.leftKeysOf(journalId, part);
    const file = this.deps.openRunFile(this.filePath(journalId));
    const read = JournalPart.read(file, part);
    if (!read) {
      file.close();
      return undefined;
    }
    return { records: read.runRecords(left), close: () => file.close() };
  }

  /**
   * The rows of the Id map of the part `part` of the journal `journalId`,
   * read from the journal as they are written (`JournalPart.idMapRows`): the
   * rows {@link idsOf} gives whole. Undefined as for {@link recordsOf}.
   */
  async idMapRowsOf(
    journalId: string,
    part: number,
  ): Promise<{ rows: Iterable<IdMapRow>; close: () => void } | undefined> {
    if (!(await this.head(journalId))) return undefined;
    const file = this.deps.openRunFile(this.filePath(journalId));
    const read = JournalPart.read(file, part);
    if (!read) {
      file.close();
      return undefined;
    }
    return { rows: read.idMapRows(), close: () => file.close() };
  }

  /**
   * The keys of the records the removals of the part `part` left, as
   * {@link keepLeft} kept them, a few bytes each and no id; undefined when no
   * removal left any record of it, or the file is gone.
   */
  async leftKeysOf(journalId: string, part: number): Promise<HashedKeys | undefined> {
    const filePath = leftPathOf(this.filePath(journalId), part);
    const names = await this.deps.listFiles(this.dir);
    if (!names.includes(path.basename(filePath))) return undefined;
    const keys = new HashedKeys();
    for await (const line of this.deps.readLines(filePath)) {
      const id = line.trim();
      if (idSchema.safeParse(id).success) keys.add(id.slice(0, 15));
    }
    return keys;
  }

  /**
   * Keep, beside the journal, the records a removal of its part `part` left,
   * as a removal hands them over a page at a time (`RunRemovalOutcome.left`):
   * written beside the file it replaces, then put in its place. Says how many
   * it left of each object.
   */
  async keepLeftPages(
    journalId: string,
    part: number,
    pages: AsyncIterable<{ objectApiName: string; ids: readonly string[] }>,
  ): Promise<Array<{ objectApiName: string; count: number }>> {
    const filePath = leftPathOf(this.filePath(journalId), part);
    const rename = this.deps.rename;
    const written = rename ? `${filePath}.next` : filePath;
    await this.deps.rm(written);
    // A removal that left none leaves a file that says so.
    await this.deps.appendFile(written, '');
    const counts = new Map<string, number>();
    for await (const { objectApiName, ids } of pages) {
      if (ids.length === 0) continue;
      counts.set(objectApiName, (counts.get(objectApiName) ?? 0) + ids.length);
      for (let at = 0; at < ids.length; at += LEFT_IDS_PER_WRITE) {
        await this.deps.appendFile(
          written,
          `${ids.slice(at, at + LEFT_IDS_PER_WRITE).join('\n')}\n`,
        );
      }
    }
    if (rename) await rename(written, filePath);
    return [...counts].map(([objectApiName, count]) => ({ objectApiName, count }));
  }

  /**
   * What the removals of the part `part` left on records they did not delete
   * (`RunRemovalOutcome.stamps`), kept beside the journal by
   * {@link keepStamps}: none when there is no file. A line that is not an id
   * and a date is left out.
   */
  async stampsOf(journalId: string, part: number): Promise<Record<string, string>> {
    const filePath = stampsPathOf(this.filePath(journalId), part);
    const names = await this.deps.listFiles(this.dir);
    if (!names.includes(path.basename(filePath))) return {};
    const stamps: Record<string, string> = {};
    for await (const line of this.deps.readLines(filePath)) {
      const [id, date] = line.trim().split(' ');
      if (idSchema.safeParse(id).success && stampDateSchema.safeParse(date).success) {
        stamps[id] = date;
      }
    }
    return stamps;
  }

  /**
   * Keep, beside the journal, what a removal of its part `part` left on the
   * records it did not delete, over what earlier removals left: a run past
   * the bound keeps none of it in its history entry, which would hold an id
   * for each record a removal left stamped.
   */
  async keepStamps(
    journalId: string,
    part: number,
    stamps: Readonly<Record<string, string>>,
  ): Promise<void> {
    if (Object.keys(stamps).length === 0) return;
    const filePath = stampsPathOf(this.filePath(journalId), part);
    const all = Object.entries({ ...(await this.stampsOf(journalId, part)), ...stamps });
    const rename = this.deps.rename;
    const written = rename ? `${filePath}.next` : filePath;
    await this.deps.rm(written);
    for (let at = 0; at < all.length; at += LEFT_IDS_PER_WRITE) {
      const lines = all.slice(at, at + LEFT_IDS_PER_WRITE).map(([id, date]) => `${id} ${date}`);
      await this.deps.appendFile(written, `${lines.join('\n')}\n`);
    }
    if (rename) await rename(written, filePath);
  }

  /**
   * The target ids the removals of the part `part` left, as {@link keepLeft}
   * kept them; undefined when no removal left any record of it, or the file
   * is gone. A line that is not an id is left out.
   */
  async leftOf(journalId: string, part: number): Promise<string[] | undefined> {
    const filePath = leftPathOf(this.filePath(journalId), part);
    const names = await this.deps.listFiles(this.dir);
    if (!names.includes(path.basename(filePath))) return undefined;
    const ids: string[] = [];
    for await (const line of this.deps.readLines(filePath)) {
      const id = line.trim();
      if (idSchema.safeParse(id).success) ids.push(id);
    }
    return ids;
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
