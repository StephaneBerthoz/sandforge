/**
 * The journal of an emptying: what it was confirmed to delete, the ids each
 * pass read, and what the org answered for each delete, on disk as it goes —
 * so that a run stopped part way is taken up where it stopped, and its Undo
 * knows what to bring back.
 *
 * One run keeps one folder, `<root>/<org>/<runId>/`, its owner's alone to
 * read, as a rewind keeps its journal beside its checkpoint:
 *
 * ```
 * journal.ndjson      one line per step, each flushed to the disk as written
 * ids/<n>-<object>/   the ids of each pass, read from the org at its turn (`spoolTableIds`)
 * ```
 *
 * Its lines:
 *
 * - `head`: what was confirmed — the request, whether to the recycle bin or
 *   for good (`hard`), the passes in their order with the records the
 *   preview counted of each, the pairs whose records go before the record
 *   they name (`beforeParent`), what it said no undo would bring back
 *   (`undoLost`), and when the preview read the org: the run never deletes a
 *   record made after that;
 * - `attempt`: the run, or a resume of it, starting;
 * - `spooled`: a pass's ids read, before any of them is deleted;
 * - `settled`: what the org answered for a delete — the ids it deleted, and
 *   those it said were gone (`ENTITY_IS_DELETED`), which a parent deleted
 *   before took along or someone deleted since. Written once the org
 *   answered: a stop of the process in between leaves those deletes unnamed,
 *   and its Undo then reads them back from the pass's ids (`undoIdsOf`);
 * - `end`: an attempt ended, with its status and what each pass did;
 * - `undo`: its Undo ended.
 *
 * A run whose last attempt did not end through — stopped, failed, its
 * process gone — is open: the org's next emptying takes it up, or its Undo
 * takes it back, before any other may start. The org's lock is held
 * whenever a journal is written: one emptying or undo of an org at a time.
 * A line a stop cut short, the last one, is dropped as the journal is read;
 * any other line that does not read is damage, and the journal is not used.
 */

import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import * as z from 'zod';
import { sanitizeSoqlObjectName, type DataOpsEmptyPassResult } from '@sandforge/shared';
import {
  CHECKPOINT_FILE_MODE,
  makePrivateDir,
  organizationKey,
} from '../../checkpoint/OrgCheckpointStore.js';

/** The file of a journal's lines, in its run's folder. */
export const JOURNAL_FILE = 'journal.ndjson';

/** Ids one line names at most: a line of a few tens of kilobytes, a million ids in some five hundred. */
export const IDS_PER_LINE = 2_000;

/** A run's id: `em-20261112-140512-a1b2`, from this machine's clock in UTC, sorting in the order runs began. */
const RUN_ID = /^em-\d{8}-\d{6}-[a-z0-9]{4}$/;

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A new run's id. */
export function newEmptyRunId(now: Date = new Date()): string {
  const iso = now.toISOString();
  const day = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`;
  const time = `${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  const tail = Array.from(randomBytes(4), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join(
    '',
  );
  return `em-${day}-${time}-${tail}`;
}

/** Whether `runId` names a run, as {@link newEmptyRunId} makes them. */
export function isEmptyRunId(runId: string): boolean {
  return RUN_ID.test(runId);
}

/**
 * Where the journals of emptyings are kept: `~/.sandforge/empty`, or the
 * folder `SANDFORGE_JOURNAL_DIR` names — where the checkpoints and the runs'
 * journals are kept too.
 */
export function defaultEmptyRoot(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['SANDFORGE_JOURNAL_DIR'];
  const home =
    dir !== undefined && dir.trim() !== '' ? resolve(dir) : join(homedir(), '.sandforge');
  return join(home, 'empty');
}

// ─── Lines ───────────────────────────────────────────────────────────────────

const idSchema = z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/, 'Not a record id');
const objectSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Not an API name')
  .max(80);
const instantSchema = z.iso.datetime({ offset: true });
const idsSchema = z.array(idSchema).max(IDS_PER_LINE);
const statusSchema = z.enum(['success', 'partial', 'failure', 'cancelled']);

const headSchema = z.object({
  v: z.literal(1),
  kind: z.literal('head'),
  runId: z.string().regex(RUN_ID),
  organizationId: z.string().min(15).max(18),
  orgName: z.string(),
  startedAt: instantSchema,
  /** When the preview read the org, on its clock. */
  readAt: instantSchema,
  previewId: z.string(),
  mode: z.enum(['objects', 'org']),
  deleteMode: z.enum(['recycle', 'hard']),
  request: z
    .object({
      mode: z.enum(['objects', 'org']),
      objects: z.array(z.string()).optional(),
      excluded: z.array(z.string()).optional(),
      customSettings: z.boolean().optional(),
      files: z.boolean().optional(),
      managedPackages: z.boolean().optional(),
      unrestorable: z.boolean().optional(),
    })
    .strict(),
  passes: z.array(
    z.object({
      objectApiName: objectSchema,
      /** The records the preview counted of it, every pass together; absent when it could not. */
      records: z.number().int().nonnegative().optional(),
      /** Of them, those its own pass sends: what its deletes go by, a job or calls. */
      sent: z.number().int().nonnegative().optional(),
      /**
       * The condition its pass reads its records by, leaving out what it never
       * sends — the standard price book, a person account's contact; absent
       * when it sends every record it finds.
       */
      rows: z.string().max(200).optional(),
    }),
  ),
  /** Of the objects going along, those whose records past Draft are set back to Draft first. */
  toDraftAlong: z.array(
    z.object({ objectApiName: objectSchema, condition: z.string().optional() }),
  ),
  beforeParent: z.array(
    z.object({
      objectApiName: objectSchema,
      field: z.string(),
      parent: objectSchema,
      reason: z.enum(['restricted', 'customPrices']),
    }),
  ),
  /**
   * What the preview said no undo would bring back, as it counted it: its
   * Undo names them. Absent from a journal begun before it was kept.
   */
  undoLost: z
    .array(
      z.object({
        objectApiName: objectSchema,
        field: z.string().optional(),
        parent: objectSchema.optional(),
        reason: z.enum(['restricted', 'unordered', 'notRestorable']),
        /** Absent when the preview could not count them. */
        records: z.number().int().nonnegative().optional(),
        atLeast: z.literal(true).optional(),
      }),
    )
    .optional(),
});

const attemptSchema = z.object({
  kind: z.literal('attempt'),
  at: instantSchema,
  resumed: z.boolean(),
});

const spooledSchema = z.object({
  kind: z.literal('spooled'),
  objectApiName: objectSchema,
  /** The pass's place, which names its folder of ids. */
  place: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  /** Whether its read left out what was made after the preview: an object with no CreatedDate is read whole. */
  sinceRead: z.boolean(),
});

const settledSchema = z.object({
  kind: z.literal('settled'),
  objectApiName: objectSchema,
  deleted: idsSchema,
  gone: idsSchema,
});

const passResultSchema = z.object({
  objectApiName: objectSchema,
  planned: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  gone: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
  notReached: z.number().int().nonnegative().optional(),
  madeSince: z.number().int().nonnegative().optional(),
  reasons: z.array(z.string()),
});

const endSchema = z.object({
  kind: z.literal('end'),
  at: instantSchema,
  status: statusSchema,
  hardRefused: z.string().optional(),
  passes: z.array(passResultSchema),
});

const undoSchema = z.object({ kind: z.literal('undo'), at: instantSchema, status: statusSchema });

const lineSchema = z.discriminatedUnion('kind', [
  headSchema,
  attemptSchema,
  spooledSchema,
  settledSchema,
  endSchema,
  undoSchema,
]);

/** What an emptying was confirmed to do. */
export type EmptyJournalHead = z.infer<typeof headSchema>;
/** One line of the journal. */
export type EmptyJournalLine = z.infer<typeof lineSchema>;
type Line<K extends EmptyJournalLine['kind']> = Extract<EmptyJournalLine, { kind: K }>;

/** A journal that does not read as one: not used. */
export class EmptyJournalDamaged extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyJournalDamaged';
  }
}

/** Where a run stands, as its journal says. */
export interface EmptyRunState {
  head: EmptyJournalHead;
  attempts: number;
  /** The last attempt's end, when it ended. */
  lastEnd?: Line<'end'>;
  /**
   * Whether the run is still to be taken up, or taken back: its last attempt
   * did not end — stopped, its process gone — or failed once it had deleted.
   */
  open: boolean;
  /** Whether its Undo ended through. */
  undone: boolean;
  /** Each pass whose ids were read, by object: its place and how many. */
  spooled: Map<string, Line<'spooled'>>;
  /** Whether any delete of it was answered deleted. */
  deletedAny: boolean;
}

/** Whether a status says an attempt ended through: what it could do, it did. */
function endedThrough(status: z.infer<typeof statusSchema>): boolean {
  return status === 'success' || status === 'partial';
}

/** The journal of one run, in its folder. */
export class EmptyJournal {
  private constructor(
    readonly dir: string,
    readonly head: EmptyJournalHead,
  ) {}

  /** Begin a run's journal: its folder, and its head, flushed. */
  static async begin(
    dir: string,
    head: Omit<EmptyJournalHead, 'v' | 'kind'>,
  ): Promise<EmptyJournal> {
    const line = headSchema.parse({ v: 1, kind: 'head', ...head });
    await makePrivateDir(dir);
    const journal = new EmptyJournal(dir, line);
    await journal.write(line, 'wx');
    return journal;
  }

  /**
   * The journal kept in `dir`.
   *
   * @throws {EmptyJournalDamaged} When it holds no head, or a line that does
   *   not read but the last one.
   */
  static async open(dir: string): Promise<EmptyJournal> {
    let head: EmptyJournalHead | undefined;
    for await (const line of readLines(join(dir, JOURNAL_FILE))) {
      if (line.kind === 'head') head = line;
      break;
    }
    if (head === undefined) {
      throw new EmptyJournalDamaged('The journal of this emptying names nothing it was to do.');
    }
    return new EmptyJournal(dir, head);
  }

  /** The folder a pass's ids are read into. */
  idsDirOf(place: number, objectApiName: string): string {
    return join(this.dir, 'ids', `${place}-${sanitizeSoqlObjectName(objectApiName)}`);
  }

  private async write(line: EmptyJournalLine, flag: 'a' | 'wx' = 'a'): Promise<void> {
    const file = join(this.dir, JOURNAL_FILE);
    const handle = await open(file, flag, CHECKPOINT_FILE_MODE);
    try {
      await handle.appendFile(`${JSON.stringify(line)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** An attempt of the run starting. */
  attempt(resumed: boolean, at: Date): Promise<void> {
    return this.write({ kind: 'attempt', at: at.toISOString(), resumed });
  }

  /** A pass's ids read, before any is deleted. */
  spooled(line: Omit<Line<'spooled'>, 'kind'>): Promise<void> {
    return this.write(spooledSchema.parse({ kind: 'spooled', ...line }));
  }

  /** What the org answered for a delete of `objectApiName`, a line per {@link IDS_PER_LINE} ids. */
  async settled(
    objectApiName: string,
    deleted: readonly string[],
    gone: readonly string[],
  ): Promise<void> {
    for (let at = 0; at < Math.max(deleted.length, gone.length); at += IDS_PER_LINE) {
      await this.write({
        kind: 'settled',
        objectApiName,
        deleted: deleted.slice(at, at + IDS_PER_LINE),
        gone: gone.slice(at, at + IDS_PER_LINE),
      });
    }
  }

  /** An attempt ended. */
  ended(
    status: z.infer<typeof statusSchema>,
    passes: readonly DataOpsEmptyPassResult[],
    at: Date,
    hardRefused?: string,
  ): Promise<void> {
    return this.write(
      endSchema.parse({
        kind: 'end',
        at: at.toISOString(),
        status,
        ...(hardRefused !== undefined ? { hardRefused } : {}),
        passes,
      }),
    );
  }

  /** Its Undo ended. */
  undone(status: z.infer<typeof statusSchema>, at: Date): Promise<void> {
    return this.write({ kind: 'undo', at: at.toISOString(), status });
  }

  /** Every line, the head first, in the order written. */
  lines(): AsyncGenerator<EmptyJournalLine> {
    return readLines(join(this.dir, JOURNAL_FILE));
  }

  /** Where the run stands: see {@link EmptyRunState}. */
  async state(): Promise<EmptyRunState> {
    let attempts = 0;
    let lastEnd: Line<'end'> | undefined;
    let endedLast: Line<'end'> | undefined;
    let undone = false;
    let deletedAny = false;
    const spooled = new Map<string, Line<'spooled'>>();
    for await (const line of this.lines()) {
      switch (line.kind) {
        case 'attempt':
          attempts++;
          endedLast = undefined;
          break;
        case 'spooled':
          spooled.set(line.objectApiName, line);
          break;
        case 'settled':
          if (line.deleted.length > 0) deletedAny = true;
          break;
        case 'end':
          lastEnd = line;
          endedLast = line;
          break;
        case 'undo':
          if (endedThrough(line.status)) undone = true;
          break;
        default:
          break;
      }
    }
    return {
      head: this.head,
      attempts,
      ...(lastEnd ? { lastEnd } : {}),
      open:
        attempts > 0 &&
        !undone &&
        (endedLast === undefined ||
          endedLast.status === 'cancelled' ||
          (endedLast.status === 'failure' && deletedAny)),
      undone,
      spooled,
      deletedAny,
    };
  }

  /**
   * The ids of `objectApiName` the run deleted, and those the org said were
   * gone, as the journal names them, a line at a time.
   */
  async *settledOf(objectApiName: string): AsyncGenerator<Line<'settled'>> {
    for await (const line of this.lines()) {
      if (line.kind === 'settled' && line.objectApiName === objectApiName) yield line;
    }
  }
}

/** The lines of a journal file; one cut short at its end is dropped. */
async function* readLines(file: string): AsyncGenerator<EmptyJournalLine> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let pending: { raw: string; number: number } | undefined;
  let number = 0;
  const parse = (raw: string, at: number): EmptyJournalLine => {
    try {
      return lineSchema.parse(JSON.parse(raw));
    } catch {
      throw new EmptyJournalDamaged(
        `Line ${at} of the journal of this emptying does not read: the journal is not used.`,
      );
    }
  };
  try {
    for await (const raw of lines) {
      number++;
      if (raw.trim() === '') continue;
      if (pending) yield parse(pending.raw, pending.number);
      pending = { raw, number };
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new EmptyJournalDamaged('The journal of this emptying is not on this machine.');
    }
    throw err;
  } finally {
    lines.close();
    stream.destroy();
  }
  if (!pending) return;
  // The last line, alone, may have been cut short by a stop of the process:
  // no write followed it, and it is dropped.
  try {
    yield lineSchema.parse(JSON.parse(pending.raw));
  } catch {
    return;
  }
}

/** A run of an org, as its folder lists it. */
export interface EmptyRunListed {
  runId: string;
  dir: string;
}

/** The journals of the emptyings of each org, under one root. */
export class EmptyJournalStore {
  constructor(readonly root: string) {}

  private orgDir(organizationId: string): string {
    return join(this.root, organizationKey(organizationId));
  }

  /** Begin the journal of a new run of the org. */
  begin(
    organizationId: string,
    head: Omit<EmptyJournalHead, 'v' | 'kind' | 'organizationId'>,
  ): Promise<EmptyJournal> {
    return EmptyJournal.begin(join(this.orgDir(organizationId), head.runId), {
      ...head,
      organizationId,
    });
  }

  /** The runs of the org kept on this machine, the first begun first. */
  async runsOf(organizationId: string): Promise<EmptyRunListed[]> {
    const dir = this.orgDir(organizationId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return names
      .filter(isEmptyRunId)
      .sort()
      .map((runId) => ({ runId, dir: join(dir, runId) }));
  }

  /** The org's last run, when there is one. */
  async lastOf(organizationId: string): Promise<EmptyRunListed | undefined> {
    return (await this.runsOf(organizationId)).at(-1);
  }

  /**
   * The journal of `runId`, of the org.
   *
   * @throws {EmptyJournalDamaged} When no such run is kept, or its journal does not read.
   */
  async open(organizationId: string, runId: string): Promise<EmptyJournal> {
    if (!isEmptyRunId(runId)) throw new EmptyJournalDamaged(`Not an emptying's id: ${runId}`);
    const dir = join(this.orgDir(organizationId), runId);
    try {
      await stat(dir);
    } catch {
      throw new EmptyJournalDamaged(`No journal of the emptying ${runId} is on this machine.`);
    }
    return EmptyJournal.open(dir);
  }

  /** Delete a run's journal and its ids. */
  async remove(organizationId: string, runId: string): Promise<void> {
    if (!isEmptyRunId(runId)) return;
    await rm(join(this.orgDir(organizationId), runId), { recursive: true, force: true });
  }
}
