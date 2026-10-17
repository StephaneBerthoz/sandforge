/**
 * Which record of the target each source record a saved configuration wrote
 * became, kept across its runs: what a later run points a lookup at.
 *
 * A run links what it writes within itself (`SyncRunLinks`): a contact under
 * an account the same run wrote names the account's copy. A delta run, or any
 * later run of the configuration, wrote no account, and sent its contacts with
 * the source's account id, which names nothing in the target: refused, or held
 * back. Every write of a run now adds here the source id of each record it
 * created, upserted or linked to a record the target held, with its id in the
 * target, and the next run reads them before its first object. A removal of a
 * run forgets the records it deleted: a lookup never names a copy that is gone
 * by the removal's doing.
 *
 * Kept on disk, one file per configuration under `sync-links/` — in the
 * extension's storage directory, or the directory the command line's `--store`
 * names — never in globalState, which VS Code writes whole on every change.
 * Appended to as each object's write answers, a line per write and a line per
 * removal that forgot something, so a window that closes under a run keeps
 * what it wrote so far, and a line cut short by it is left out when the file
 * is read. Ids alone, never a value of a record.
 *
 * Bounded: past {@link SYNC_LINKS_COMPACT_BYTES} the file is written again
 * whole with what it still says, and past {@link SYNC_LINKS_MAX_PAIRS} pairs the
 * oldest go first.
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
import { z } from 'zod';

/** The directory, under the store, that the configurations' files go in. */
export const SYNC_LINKS_DIR = 'sync-links';

/** The most pairs one configuration keeps: what the oldest go past. */
export const SYNC_LINKS_MAX_PAIRS = 200_000;

/** The size of a file, in bytes, past which it is written again whole. */
export const SYNC_LINKS_COMPACT_BYTES = 16 * 1024 * 1024;

/** The two orgs a configuration ran between: its pairs are kept for them alone. */
export interface SyncLinkOrgs {
  sourceOrgId: string;
  targetOrgId: string;
}

/** A source record and its record in the target, by their ids. */
export type SyncLinkPair = readonly [sourceId: string, targetId: string];

/**
 * What a run reads and adds to of the records earlier runs of its
 * configuration wrote: see the module's comment.
 */
export interface SyncIdMapStore {
  /**
   * The records earlier runs wrote between these orgs, by the first fifteen
   * characters of their source id; `null` for a configuration that keeps none.
   */
  load(configId: string, orgs: SyncLinkOrgs): Promise<ReadonlyMap<string, string> | null>;
  /** Add what one write of `objectApiName` wrote or linked. */
  record(
    configId: string,
    orgs: SyncLinkOrgs,
    objectApiName: string,
    pairs: readonly SyncLinkPair[],
  ): Promise<void>;
}

/** What a removal of a run tells the configuration's pairs. */
export interface SyncLinkForgetter {
  /**
   * Forget the pairs whose record in the target is one of `targetIds`.
   *
   * @returns How many were forgotten.
   */
  forget(configId: string, orgs: SyncLinkOrgs, targetIds: readonly string[]): Promise<number>;
}

/** A file of a directory, with its size in bytes. */
interface FileEntry {
  name: string;
  size: number;
}

/** File-system operations the store needs, injected so it stays testable. */
export interface SyncIdMapDeps {
  /** The directory the store's own directory goes in. */
  storagePath: string;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  /** Add to the end of a file, creating it when it is not there. */
  appendFile: (filePath: string, content: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (dirPath: string) => Promise<void>;
  rm: (filePath: string) => Promise<void>;
  /** The files directly in a directory, with their sizes; none when it is not there. */
  listFiles: (dirPath: string) => Promise<FileEntry[]>;
  /** The pairs kept at most; {@link SYNC_LINKS_MAX_PAIRS} unless a test sets another. */
  maxPairs?: number;
  /** The size past which a file is compacted; {@link SYNC_LINKS_COMPACT_BYTES} unless a test sets another. */
  compactBytes?: number;
}

/** A Salesforce id, as every id kept is. */
const idSchema = z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/);
const orgSchema = z.string().min(1).max(200);

/** A line per write: the pairs of one object, between two orgs. */
const pairsSchema = z.object({
  s: orgSchema,
  t: orgSchema,
  o: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/),
  p: z.array(z.tuple([idSchema, idSchema])).max(50_000),
});

/** A line per removal: the records in the target it took. */
const forgetSchema = z.object({
  s: orgSchema,
  t: orgSchema,
  f: z.array(idSchema).max(1_000_000),
});

/** An id by its first fifteen characters: the case-sensitive id both forms share. */
function idKey(id: string): string {
  return id.slice(0, 15);
}

/** A configuration id as it goes into a file name: letters, digits, `_` and `-`, the rest as `_`. */
function fileSegment(configId: string): string {
  return configId.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** A JSON line, or undefined for one that does not parse: a line a closed window cut short. */
function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** One pair as a file holds it once read: its orgs, its object, its ids. */
interface KeptPair {
  s: string;
  t: string;
  o: string;
  target: string;
}

/**
 * What a file says, every org pair's: each source record's last record in the
 * target, by its orgs and source id, oldest first. Forgotten records are left
 * out; a line that does not read is skipped.
 */
function readPairs(text: string): Map<string, KeptPair & { source: string }> {
  const kept = new Map<string, KeptPair & { source: string }>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const value = parseLine(line);
    const pairs = pairsSchema.safeParse(value);
    if (pairs.success) {
      const { s, t, o, p } = pairs.data;
      for (const [source, target] of p) {
        const key = `${s}|${t}|${idKey(source)}`;
        // Taken out and put back: the order is the order last written.
        kept.delete(key);
        kept.set(key, { s, t, o, source, target });
      }
      continue;
    }
    const forget = forgetSchema.safeParse(value);
    if (!forget.success) continue;
    const { s, t, f } = forget.data;
    const gone = new Set(f.map(idKey));
    for (const [key, pair] of kept) {
      if (pair.s === s && pair.t === t && gone.has(idKey(pair.target))) kept.delete(key);
    }
  }
  return kept;
}

/**
 * The store over Node's file system, under `storagePath`: the extension's
 * storage directory, or the command line's `--store`.
 */
export function nodeSyncIdMap(storagePath: string): SyncIdMap {
  return new SyncIdMap({
    storagePath,
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
      const files: FileEntry[] = [];
      for (const name of names) {
        const info = await stat(path.join(dirPath, name)).catch(() => undefined);
        if (info?.isFile()) files.push({ name, size: info.size });
      }
      return files;
    },
  });
}

/**
 * The records each saved configuration's runs wrote, by source id: see the
 * module's comment.
 */
export class SyncIdMap implements SyncIdMapStore, SyncLinkForgetter {
  private readonly dir: string;
  private readonly maxPairs: number;
  private readonly compactBytes: number;
  /** Changes to the files one after the other: two at once would lose one. */
  private queue: Promise<unknown> = Promise.resolve();

  /** @param deps - Injected storage path and file-system operations. */
  constructor(private readonly deps: SyncIdMapDeps) {
    this.dir = path.join(deps.storagePath, SYNC_LINKS_DIR);
    this.maxPairs = deps.maxPairs ?? SYNC_LINKS_MAX_PAIRS;
    this.compactBytes = deps.compactBytes ?? SYNC_LINKS_COMPACT_BYTES;
  }

  private fileOf(configId: string): string {
    return path.join(this.dir, `${fileSegment(configId)}.ndjson`);
  }

  /** Run one change after those before it, whatever they ended on. */
  private inTurn<T>(change: () => Promise<T>): Promise<T> {
    const next = this.queue.then(change);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * What a configuration's file says, or nothing when there is none.
   *
   * @throws When the file is there and cannot be read: taken for empty, a
   *   run would send its lookups with the source's ids and say nothing.
   */
  private async read(configId: string): Promise<Map<string, KeptPair & { source: string }>> {
    let text: string;
    try {
      text = await this.deps.readFile(this.fileOf(configId));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return new Map();
      throw err;
    }
    return readPairs(text);
  }

  /** See {@link SyncIdMapStore.load}. */
  async load(configId: string, orgs: SyncLinkOrgs): Promise<ReadonlyMap<string, string>> {
    await this.queue;
    const map = new Map<string, string>();
    for (const pair of (await this.read(configId)).values()) {
      if (pair.s === orgs.sourceOrgId && pair.t === orgs.targetOrgId) {
        map.set(idKey(pair.source), pair.target);
      }
    }
    return map;
  }

  /** See {@link SyncIdMapStore.record}. A pair whose ids do not read as ids is left out. */
  record(
    configId: string,
    orgs: SyncLinkOrgs,
    objectApiName: string,
    pairs: readonly SyncLinkPair[],
  ): Promise<void> {
    const valid = pairs.filter(
      ([source, target]) =>
        idSchema.safeParse(source).success && idSchema.safeParse(target).success,
    );
    if (valid.length === 0) return Promise.resolve();
    return this.inTurn(async () => {
      await this.deps.mkdir(this.dir);
      const file = this.fileOf(configId);
      for (let at = 0; at < valid.length; at += 50_000) {
        const line = {
          s: orgs.sourceOrgId,
          t: orgs.targetOrgId,
          o: objectApiName,
          p: valid.slice(at, at + 50_000),
        };
        await this.deps.appendFile(file, `${JSON.stringify(line)}\n`);
      }
      await this.keepWithinBounds(configId);
    });
  }

  /** See {@link SyncLinkForgetter.forget}. Nothing is written when none of them is kept. */
  forget(configId: string, orgs: SyncLinkOrgs, targetIds: readonly string[]): Promise<number> {
    const gone = new Set(targetIds.filter((id) => idSchema.safeParse(id).success).map(idKey));
    if (gone.size === 0) return Promise.resolve(0);
    return this.inTurn(async () => {
      let forgotten = 0;
      const named: string[] = [];
      for (const pair of (await this.read(configId)).values()) {
        if (pair.s !== orgs.sourceOrgId || pair.t !== orgs.targetOrgId) continue;
        if (!gone.has(idKey(pair.target))) continue;
        forgotten++;
        named.push(pair.target);
      }
      if (forgotten === 0) return 0;
      const line = { s: orgs.sourceOrgId, t: orgs.targetOrgId, f: [...new Set(named)] };
      await this.deps.appendFile(this.fileOf(configId), `${JSON.stringify(line)}\n`);
      await this.keepWithinBounds(configId);
      return forgotten;
    });
  }

  /** Forget everything a configuration kept: it is no longer saved. */
  delete(configId: string): Promise<void> {
    return this.inTurn(() => this.deps.rm(this.fileOf(configId)));
  }

  /**
   * Write a configuration's file again whole, with what it still says, once
   * it is past its size: the oldest pairs past the most it keeps go. Written
   * beside it and renamed over it, so a window that stops mid-write leaves
   * the file as it was.
   */
  private async keepWithinBounds(configId: string): Promise<void> {
    const file = this.fileOf(configId);
    const name = path.basename(file);
    const size = (await this.deps.listFiles(this.dir)).find((f) => f.name === name)?.size ?? 0;
    if (size <= this.compactBytes) return;
    const kept = [...(await this.read(configId)).values()].slice(-this.maxPairs);
    // One line per run of pairs of the same orgs and object, in their order.
    const lines: Array<z.infer<typeof pairsSchema>> = [];
    for (const pair of kept) {
      const last = lines[lines.length - 1];
      if (last?.s === pair.s && last.t === pair.t && last.o === pair.o && last.p.length < 50_000) {
        last.p.push([pair.source, pair.target]);
        continue;
      }
      lines.push({ s: pair.s, t: pair.t, o: pair.o, p: [[pair.source, pair.target]] });
    }
    const written = `${file}.${process.pid}.tmp`;
    await this.deps.writeFile(written, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
    await this.deps.rename(written, file);
  }
}

/**
 * The store as a run reads it: only for a configuration still saved, as its
 * watermarks are (`SyncConfigStore.deltaStore`). A run of one that is not
 * saved, which nobody runs again, keeps nothing.
 *
 * @param map - Where the pairs are kept.
 * @param isSaved - Whether a configuration is saved under that id.
 */
export function savedConfigIdMap(
  map: SyncIdMapStore,
  isSaved: (configId: string) => boolean,
): SyncIdMapStore {
  return {
    load: async (configId, orgs) => (isSaved(configId) ? map.load(configId, orgs) : null),
    record: async (configId, orgs, objectApiName, pairs) => {
      if (isSaved(configId)) await map.record(configId, orgs, objectApiName, pairs);
    },
  };
}
