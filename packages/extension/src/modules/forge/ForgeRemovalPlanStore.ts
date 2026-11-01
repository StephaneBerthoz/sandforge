import * as path from 'node:path';
import * as z from 'zod';
import type { ForgeRemovalPlan } from '@sandforge/shared';

/**
 * The most the removal plans take on disk, in bytes of JSON: about 200 000
 * record ids, twenty runs at the command line's default `--max-total`, and
 * hundreds of the record-scoped clones people run. Past it the plans of runs
 * already removed go first, oldest first; the newest is kept whatever its size.
 */
export const REMOVAL_PLANS_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The most the plans take once every run already removed is dropped: a run
 * not removed yet stays removable up to it. Since 1.50 one run streams whole
 * tables past the default ceiling, and its plan alone can fill the first
 * bound; dropping the run before it on the next write left that run with
 * nothing to remove it by.
 */
export const REMOVAL_PLANS_HARD_MAX_BYTES = 64 * 1024 * 1024;

/** The file the plans are kept in, under the extension's own storage. */
export const REMOVAL_PLANS_FILE = 'forge-removal-plans.json';

/**
 * The file, beside the plans, that keeps what the sweeps of each run's
 * removals found made for it (`SweepParts.made`), by run.
 */
export const SWEEP_MADE_FILE = 'forge-sweep-made.json';

/** Runs whose sweeps' finds are kept at most: the newest, as a run's removals come soon after it. */
export const SWEEP_MADE_RUNS_KEPT = 50;

/**
 * Ids kept per object of one run's finds at most: past what a sweep takes of
 * an object (`SWEEP_OBJECT_BOUND`), nothing of it was swept.
 */
export const SWEEP_MADE_PER_OBJECT = 10_000;

/** File-system operations the store needs, injected so it stays testable. */
export interface ForgeRemovalPlanStoreDeps {
  /** Directory the extension owns for persistent data (globalStorageUri). */
  storagePath: string;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (dirPath: string) => Promise<void>;
  /** The bound on bytes; {@link REMOVAL_PLANS_MAX_BYTES} unless a test sets another. */
  maxBytes?: number;
  /** The bound for runs not removed yet; {@link REMOVAL_PLANS_HARD_MAX_BYTES} unless a test sets another. */
  hardMaxBytes?: number;
}

/** A Salesforce id, as every id of a plan is: its ids end up in queries and deletes. */
const idSchema = z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/);
const dateSchema = z.string().min(1).max(40);

/** One plan as the file holds it: external input, checked before it is used. */
const planSchema = z.object({
  forgeId: z.string().min(1).max(200),
  targetOrgId: z.string().min(1).max(128),
  timestamp: dateSchema,
  duration: z.number().nonnegative(),
  status: z.enum(['success', 'partial', 'failure']),
  cancelled: z.literal(true).optional(),
  writtenBetween: z.object({ first: dateSchema, last: dateSchema }).optional(),
  retryOf: z.string().min(1).max(200).optional(),
  objects: z.array(
    z.object({
      objectApiName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
      ids: z.array(idSchema),
    }),
  ),
  linked: z.number().int().nonnegative(),
  mayHaveBeenWritten: z.number().int().nonnegative().optional(),
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
  // What the sweeps of its removals did: dropped with every read of a kept
  // plan, as a key the schema does not name is, a run removed from its plan
  // lost what its sweeps had done.
  sweep: z
    .object({
      sweptAt: dateSchema,
      deleted: z.number().int().nonnegative(),
      keptChanged: z.number().int().nonnegative(),
      refused: z.number().int().nonnegative(),
    })
    .optional(),
  inJournal: z
    .object({
      journalId: z.string().min(1).max(200),
      part: z.number().int().nonnegative(),
      left: z.array(
        z.object({
          objectApiName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
          count: z.number().int().nonnegative(),
        }),
      ),
    })
    .optional(),
});

const fileSchema = z.object({ version: z.literal(1), plans: z.array(z.unknown()) });

/** The finds of the sweeps of each run, as their file holds them: external input, checked. */
const madeFileSchema = z.object({
  version: z.literal(1),
  runs: z.array(z.object({ forgeId: z.string().min(1).max(300), ids: z.array(idSchema) })),
});

/**
 * The removal plans of past runs, kept in a file of the extension's own
 * storage, so a run stays removable once the run history — the last twenty
 * runs — has dropped it.
 *
 * Ids, dates and counts alone (`ForgeRemovalPlan`): never a value of a record.
 * Kept out of globalState, which VS Code writes whole on every change, and
 * bounded on bytes rather than on runs: a run of ten thousand records weighs
 * what a hundred small ones do. Each change reads the file afresh and writes
 * it whole, through a file beside it renamed over it, so a window that stops
 * mid-write leaves the last whole file. A plan the file holds that is not
 * what a plan should be is left out, and the others stand.
 */
export class ForgeRemovalPlanStore {
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly hardMaxBytes: number;
  /** Changes one after the other: two read-modify-writes at once would lose one. */
  private queue: Promise<unknown> = Promise.resolve();

  /** @param deps - Injected storage path and file-system operations. */
  constructor(private readonly deps: ForgeRemovalPlanStoreDeps) {
    this.file = path.join(deps.storagePath, REMOVAL_PLANS_FILE);
    this.maxBytes = deps.maxBytes ?? REMOVAL_PLANS_MAX_BYTES;
    this.hardMaxBytes = Math.max(this.maxBytes, deps.hardMaxBytes ?? REMOVAL_PLANS_HARD_MAX_BYTES);
  }

  /** The plans kept, newest first. */
  list(): Promise<ForgeRemovalPlan[]> {
    return this.enqueue(() => this.read());
  }

  /** The plan of one run, or undefined when none is kept. */
  async get(forgeId: string): Promise<ForgeRemovalPlan | undefined> {
    return (await this.list()).find((plan) => plan.forgeId === forgeId);
  }

  /** Keep a run's plan first, in place of one kept for the same run. */
  put(plan: ForgeRemovalPlan): Promise<void> {
    return this.enqueue(async () => {
      const plans = (await this.read()).filter((kept) => kept.forgeId !== plan.forgeId);
      await this.write([plan, ...plans]);
    });
  }

  /**
   * Keep a run's plan when none is kept for it yet, in the order of the runs'
   * dates: a plan kept already is the one every removal of the run updated.
   */
  putIfAbsent(plan: ForgeRemovalPlan): Promise<void> {
    return this.enqueue(async () => {
      const plans = await this.read();
      if (plans.some((kept) => kept.forgeId === plan.forgeId)) return;
      await this.write([...plans, plan]);
    });
  }

  /**
   * Change the plan of one run where it stands: `change` returns the plan to
   * keep, or undefined to drop it — a run whose records are all gone has
   * nothing left to remove. Nothing happens when no plan is kept for it.
   */
  update(
    forgeId: string,
    change: (plan: ForgeRemovalPlan) => ForgeRemovalPlan | undefined,
  ): Promise<void> {
    return this.enqueue(async () => {
      const plans = await this.read();
      const at = plans.findIndex((plan) => plan.forgeId === forgeId);
      if (at < 0) return;
      const changed = change(plans[at]);
      const next = changed
        ? [...plans.slice(0, at), changed, ...plans.slice(at + 1)]
        : [...plans.slice(0, at), ...plans.slice(at + 1)];
      await this.write(next);
    });
  }

  /**
   * The records the sweeps of the run's removals found made for it, by id
   * (`SweepTies.madeEarlier`): `made` still for the next sweep, once a
   * removal deleted the record they were tied to and the org cleared the
   * lookup that told it — a task's account, an email's record. None when no
   * sweep of the run kept any, or the file is not one.
   */
  madeOf(forgeId: string): Promise<string[]> {
    return this.enqueue(async () => {
      const runs = await this.readMade();
      return runs.find((run) => run.forgeId === forgeId)?.ids ?? [];
    });
  }

  /**
   * Keep what a sweep of the run's removal found made for it, beside what
   * earlier sweeps found: read before its first delete, it is the only word
   * left on a record whose tie the removal cleared. Each object's at most
   * {@link SWEEP_MADE_PER_OBJECT}, the newest {@link SWEEP_MADE_RUNS_KEPT}
   * runs' at most.
   */
  keepMade(forgeId: string, ids: Iterable<string>): Promise<void> {
    return this.enqueue(async () => {
      const runs = await this.readMade();
      const before = runs.find((run) => run.forgeId === forgeId)?.ids ?? [];
      const perObject = new Map<string, number>();
      const seen = new Set<string>();
      const kept: string[] = [];
      for (const id of [...before, ...ids]) {
        const key = id.slice(0, 15);
        if (!idSchema.safeParse(id).success || seen.has(key)) continue;
        const object = key.slice(0, 3);
        const count = perObject.get(object) ?? 0;
        if (count >= SWEEP_MADE_PER_OBJECT) continue;
        seen.add(key);
        perObject.set(object, count + 1);
        kept.push(id);
      }
      if (kept.length === before.length) return;
      const next = [{ forgeId, ids: kept }, ...runs.filter((run) => run.forgeId !== forgeId)].slice(
        0,
        SWEEP_MADE_RUNS_KEPT,
      );
      await this.deps.mkdir(this.deps.storagePath).catch(() => undefined);
      const file = path.join(this.deps.storagePath, SWEEP_MADE_FILE);
      const written = `${file}.${process.pid}.tmp`;
      await this.deps.writeFile(written, JSON.stringify({ version: 1, runs: next }));
      await this.deps.rename(written, file);
    });
  }

  /** The finds the file holds, newest run first; none when there is no file, or it is not one. */
  private async readMade(): Promise<Array<{ forgeId: string; ids: string[] }>> {
    try {
      const raw: unknown = JSON.parse(
        await this.deps.readFile(path.join(this.deps.storagePath, SWEEP_MADE_FILE)),
      );
      const file = madeFileSchema.safeParse(raw);
      return file.success ? file.data.runs : [];
    } catch {
      return [];
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** The plans the file holds, newest first; none when there is no file, or it is not one. */
  private async read(): Promise<ForgeRemovalPlan[]> {
    let raw: unknown;
    try {
      raw = JSON.parse(await this.deps.readFile(this.file));
    } catch {
      return [];
    }
    const file = fileSchema.safeParse(raw);
    if (!file.success) return [];
    return file.data.plans.flatMap((plan) => {
      const parsed = planSchema.safeParse(plan);
      return parsed.success ? [parsed.data] : [];
    });
  }

  /**
   * Write the plans, newest run first. Past the bound, the runs already removed
   * with nothing left go first, oldest first: they have nothing more to remove.
   * A run not removed yet goes only past the hard bound, oldest first. The
   * newest stays whatever its size, so the run that just ended is always
   * removable.
   */
  private async write(plans: ForgeRemovalPlan[]): Promise<void> {
    const kept = [...plans].sort((a, b) => dateOf(b) - dateOf(a) || 0);
    const bytes = (): number => Buffer.byteLength(serialize(kept), 'utf8');
    for (let i = kept.length - 1; i > 0 && bytes() > this.maxBytes; i -= 1) {
      if (settled(kept[i])) kept.splice(i, 1);
    }
    while (kept.length > 1 && bytes() > this.hardMaxBytes) kept.pop();
    const content = serialize(kept);
    await this.deps.mkdir(this.deps.storagePath).catch(() => undefined);
    const written = `${this.file}.${process.pid}.tmp`;
    await this.deps.writeFile(written, content);
    await this.deps.rename(written, this.file);
  }
}

/** A run removed with nothing left behind: its plan has nothing more to remove. */
function settled(plan: ForgeRemovalPlan): boolean {
  return (
    plan.undo !== undefined &&
    (plan.removalLeft?.length ?? 0) === 0 &&
    (plan.inJournal?.left ?? []).every(({ count }) => count === 0)
  );
}

/** When a run was recorded, in epoch milliseconds; a date that cannot be read is the oldest. */
function dateOf(plan: ForgeRemovalPlan): number {
  const at = Date.parse(plan.timestamp);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

function serialize(plans: readonly ForgeRemovalPlan[]): string {
  return JSON.stringify({ version: 1, plans });
}
