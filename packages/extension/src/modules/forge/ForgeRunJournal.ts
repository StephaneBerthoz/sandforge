import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { forgeRunCreatedRecords, type ForgeRemovalPlan } from '@sandforge/shared';
import type { ForgeStreamPage } from './ForgeExecutor.js';

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
  });
}

/** A file's lines, read a chunk at a time; the file is closed however the reading ends. */
async function* linesOf(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** A Salesforce id, as every id a journal holds is: they end up in deletes. */
const idSchema = z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/);

/** The first line of a journal: the run, and the org it writes to. */
const headSchema = z.object({
  run: z.object({
    journalId: z.string().min(1).max(200),
    targetOrgId: z.string().min(1).max(128),
    startedAt: z.string().min(1).max(40),
  }),
});

/** A line of a page written: the records it created, source id to target id. */
const pageSchema = z.object({
  object: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  created: z.array(z.tuple([idSchema, idSchema])),
});

/** A journal id as it goes into a file name: letters, digits, `_` and `-`. */
function fileSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * What a run read and written page by page has created, kept on disk as it
 * goes: a line for each page that created records, added once the page is
 * written. A run that ends records what it created in the run history, and
 * its journal goes; one whose window closed under it — the extension host
 * stopped, the machine slept for good — leaves its journal, and what it holds
 * is offered for removal the next time the runs are listed, as a run the
 * history dropped is (`leftOver`).
 *
 * Read and written page by page, a run holds a page of rows whatever its
 * tables hold, and keeps what it created until it ends: a run of a million
 * records stopped in its last object lost every one of them from what a
 * removal could find, and the target kept them.
 *
 * Ids alone, never a value of a record, one file per run under the
 * extension's storage (`forge-runs/`).
 */
export class ForgeRunJournal {
  private readonly dir: string;

  constructor(private readonly deps: ForgeRunJournalDeps) {
    this.dir = path.join(deps.storagePath, 'forge-runs');
  }

  private filePath(journalId: string): string {
    return path.join(this.dir, `${fileSegment(journalId)}.ndjson`);
  }

  /** Start the journal of a run about to write to `targetOrgId`. */
  async begin(journalId: string, targetOrgId: string, startedAt: Date): Promise<void> {
    await this.deps.mkdir(this.dir);
    const head = { run: { journalId, targetOrgId, startedAt: startedAt.toISOString() } };
    await this.deps.appendFile(this.filePath(journalId), `${JSON.stringify(head)}\n`);
  }

  /** Keep what a page created, once it is written; a page that created nothing adds nothing. */
  async page(journalId: string, page: ForgeStreamPage): Promise<void> {
    if (page.created.length === 0) return;
    const line = {
      object: page.objectApiName,
      created: page.created.map(({ sourceId, targetId }) => [sourceId, targetId]),
    };
    await this.deps.appendFile(this.filePath(journalId), `${JSON.stringify(line)}\n`);
  }

  /** Drop the journal of a run that ended: the run history holds what it created. */
  end(journalId: string): Promise<void> {
    return this.deps.rm(this.filePath(journalId));
  }

  /**
   * What each journal a run never ended holds, as the removal plan of a run
   * stopped part way: the records it created, per object, in the order a
   * removal takes them. A line that is not what the journal writes is left
   * out — the last one of a window that closed mid-write among them — and the
   * others stand; a journal whose first line is not a run's is left out whole.
   *
   * @param running - The journals of runs under way, which are not left over.
   */
  async leftOver(running: ReadonlySet<string> = new Set()): Promise<ForgeRemovalPlan[]> {
    const plans: ForgeRemovalPlan[] = [];
    for (const name of await this.deps.listFiles(this.dir)) {
      if (!name.endsWith('.ndjson')) continue;
      const plan = await this.planOf(path.join(this.dir, name));
      if (plan && !running.has(plan.forgeId)) plans.push(plan);
    }
    return plans;
  }

  /** Forget the journal `journalId`, once what it held is kept elsewhere. */
  forget(journalId: string): Promise<void> {
    return this.deps.rm(this.filePath(journalId));
  }

  private async planOf(filePath: string): Promise<ForgeRemovalPlan | undefined> {
    let head: z.infer<typeof headSchema>['run'] | undefined;
    const table: Record<string, string> = {};
    const byObject = new Map<string, string[]>();
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
      const page = pageSchema.safeParse(value);
      if (!page.success) continue;
      const ids = byObject.get(page.data.object) ?? [];
      for (const [sourceId, targetId] of page.data.created) {
        table[sourceId] = targetId;
        ids.push(sourceId);
      }
      byObject.set(page.data.object, ids);
    }
    if (!head || byObject.size === 0) return undefined;
    return {
      forgeId: head.journalId,
      targetOrgId: head.targetOrgId,
      timestamp: head.startedAt,
      duration: 0,
      status: 'partial',
      objects: forgeRunCreatedRecords({
        idRemapTable: table,
        idRemapCreated: [...byObject].map(([objectApiName, sourceIds]) => ({
          objectApiName,
          sourceIds,
        })),
      }),
      linked: 0,
    };
  }
}
