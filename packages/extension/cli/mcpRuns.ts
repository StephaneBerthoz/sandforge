/**
 * The runs of the MCP server's tools that go on past their call.
 *
 * A call waits for its script to end, and a client gives a call so long
 * before it gives up on it and cancels it, which stops the script as Ctrl-C
 * does: a clone of a whole org, or a removal of one, cut part way. So a
 * script still running once its call has held it {@link holdMsOf} is handed
 * back: the call answers with a handle (`mr-…`), the run goes on under an
 * abort of its own, no longer the call's, and the handle follows it, stops
 * it, and reads its answer once it has ended.
 *
 * The registry lives as long as the server: closing the agent's session
 * stops its runs as Ctrl-C would, and nothing writes on unseen. What a later
 * server can still read of a run is on disk, in `mcp-runs/` under the
 * journal folder: what the run was (`<handle>.meta.json`), and, for a clone,
 * the summary its script rewrites as it goes (`<handle>.json`, its
 * `--summary`), which names its journal. The folder is its owner's alone:
 * a summary holds the source ids of what was written.
 */

import { randomBytes } from 'node:crypto';
import { open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as z from 'zod';
import {
  CHECKPOINT_FILE_MODE,
  makePrivateDir,
} from '../src/modules/checkpoint/OrgCheckpointStore.js';
import { FAILED_EXIT } from './exitCodes.js';
import type { CommandRun } from './scriptRunner.js';

/** The variable that sets how long a call holds its script before it hands the run back, in seconds. */
export const HOLD_SECONDS_VARIABLE = 'SANDFORGE_MCP_HOLD_SECONDS';

/**
 * How long a call holds its script unless told, in seconds: under the minute
 * a client is taken to give a call before it cancels it.
 */
export const HOLD_SECONDS_DEFAULT = 45;

/** The most a call may be told to hold its script, in seconds. */
export const HOLD_SECONDS_MOST = 55;

/** The most `run_status` waits for a run to end before it says how far it is, in seconds. */
export const WAIT_SECONDS_MOST = 50;

/** The lines of what a script said that a run under way gives with its progress. */
export const TAIL_LINES = 20;

/** The folder of the runs handed back, under the journal folder. */
const RUNS_DIR = 'mcp-runs';

/** How long the files of a run whose journal is gone, or that named none, are kept. */
const RUN_FILES_KEPT_MS = 24 * 60 * 60_000;

/** A handle of a run: `mr-` and when it started, as a plan's id is made. */
export const RUN_HANDLE = /^mr-\d{8}-\d{6}-[a-z0-9]{4}$/;

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A new id of a run (`mr`) or of a plan (`co`): `mr-20261114-190012-a1b2`,
 * from this machine's clock in UTC and four random characters, as a
 * checkpoint's id is made. Ids of one kind sort in the order they were made.
 */
export function stampedId(prefix: 'mr' | 'co', now: Date = new Date()): string {
  const iso = now.toISOString();
  const day = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`;
  const time = `${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  const tail = Array.from(randomBytes(4), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join(
    '',
  );
  return `${prefix}-${day}-${time}-${tail}`;
}

/**
 * How long a call holds its script before it hands the run back, in
 * milliseconds: `SANDFORGE_MCP_HOLD_SECONDS`, 0 to {@link HOLD_SECONDS_MOST},
 * or {@link HOLD_SECONDS_DEFAULT} when unset or not such a number.
 */
export function holdMsOf(env: NodeJS.ProcessEnv = process.env): number {
  const said = env[HOLD_SECONDS_VARIABLE]?.trim();
  const seconds = said !== undefined && /^\d+(\.\d+)?$/.test(said) ? Number(said) : Number.NaN;
  return Number.isFinite(seconds) && seconds <= HOLD_SECONDS_MOST
    ? Math.round(seconds * 1000)
    : HOLD_SECONDS_DEFAULT * 1000;
}

/** The folder of the runs handed back, under `journalDir`. */
export function runsDirOf(journalDir: string): string {
  return join(journalDir, RUNS_DIR);
}

/** Whether `handle` is one of a run, and nothing that would make a path of it. */
export function isRunHandle(handle: string): boolean {
  return RUN_HANDLE.test(handle);
}

/** The file a clone's script writes its summary to as it goes (`--summary`). */
export function summaryPathOf(dir: string, handle: string): string {
  if (!isRunHandle(handle)) throw new Error(`Not the handle of a run: ${handle}`);
  return join(dir, `${handle}.json`);
}

/** The file that says what a run handed back was. */
function metaPathOf(dir: string, handle: string): string {
  return join(dir, `${handle}.meta.json`);
}

// ─── The last lines a script said ────────────────────────────────────────────

/**
 * The last lines of what a script said, kept as it says them, a piece at a
 * time: the line it is still saying, with no end yet, among them.
 */
export class LineTail {
  private readonly kept: string[] = [];
  private open = '';

  constructor(private readonly most: number = TAIL_LINES) {}

  /** Take what the script said next. */
  push(text: string): void {
    const parts = `${this.open}${text}`.split(/\r?\n/);
    this.open = parts.pop() ?? '';
    for (const line of parts) {
      this.kept.push(line);
      if (this.kept.length > this.most) this.kept.shift();
    }
  }

  /** The last lines, oldest first, the one still being said last. */
  lines(): string[] {
    const all = this.open === '' ? [...this.kept] : [...this.kept, this.open];
    return all.slice(-this.most);
  }
}

// ─── A run's summary, as it goes ─────────────────────────────────────────────

/** How far a clone is, as the summary its script rewrites after each object says it. */
export interface RunSummaryRead {
  /** Writing still; ended; stopped part way by a signal; or ended on an error. */
  state: 'running' | 'ended' | 'interrupted' | 'failed';
  /** The journal the run writes, which `--resume` and `--remove` take. */
  journal?: string;
  /** Records created, written over and linked to so far. */
  written: number;
  /** Records the target refused so far. */
  failed: number;
  /** The objects the run has created records of so far. */
  objectsWritten: number;
  /** When it ended, for a run that did. */
  finishedAt?: string;
}

const count = z.number().int().nonnegative().catch(0);
const summarySchema = z.object({
  running: z.literal(true).optional().catch(undefined),
  interrupted: z.literal(true).optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  journal: z.string().min(1).optional().catch(undefined),
  finishedAt: z.string().optional().catch(undefined),
  result: z
    .object({
      successCount: count,
      updatedCount: count,
      linkedCount: count,
      failedCount: count,
      createdByObject: z.array(z.unknown()).catch([]),
    })
    .partial()
    .catch({}),
});

/** What the summary file at `path` says of its run; nothing when it is not there, or does not read as one. */
export async function readRunSummary(path: string): Promise<RunSummaryRead | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
  const parsed = summarySchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const summary = parsed.data;
  const result = summary.result;
  return {
    state:
      summary.running === true
        ? 'running'
        : summary.interrupted === true
          ? 'interrupted'
          : summary.error !== undefined
            ? 'failed'
            : 'ended',
    ...(summary.journal !== undefined ? { journal: summary.journal } : {}),
    written: (result.successCount ?? 0) + (result.updatedCount ?? 0) + (result.linkedCount ?? 0),
    failed: result.failedCount ?? 0,
    objectsWritten: (result.createdByObject ?? []).length,
    ...(summary.finishedAt !== undefined ? { finishedAt: summary.finishedAt } : {}),
  };
}

// ─── A run, and the registry ─────────────────────────────────────────────────

/** What a run of a tool is, kept on disk once it is handed back. */
export interface RunMeta {
  /** Its handle. */
  handle: string;
  /** The tool that started it. */
  tool: string;
  /** The org it writes to, for a run that writes. */
  target?: string;
  /** The plan it writes (`clone_org`). */
  plan?: string;
  /** When it started, an ISO date. */
  startedAt: string;
  /** The summary its script rewrites as it goes, for a clone. */
  summary?: string;
  /** How long its plan said it takes, in seconds. */
  expectedSeconds?: number;
}

const metaSchema = z.object({
  handle: z.string().regex(RUN_HANDLE),
  tool: z.string().min(1),
  target: z.string().min(1).optional(),
  plan: z.string().min(1).optional(),
  startedAt: z.iso.datetime(),
  summary: z.string().min(1).optional(),
  expectedSeconds: z.number().nonnegative().optional(),
}) satisfies z.ZodType<RunMeta>;

/** What starts a run's script: told its own abort, and what hears its stderr as it goes. */
export type RunLauncher = (run: {
  signal: AbortSignal;
  onStderr: (text: string) => void;
}) => Promise<CommandRun>;

/** A run of a tool's script, from its start to the answer its tool gives of it. */
export class McpRun<Final = unknown> {
  private readonly controller = new AbortController();
  private readonly said = new LineTail();
  private ran: CommandRun | undefined;
  private final: Promise<Final> | undefined;
  /** Settles once the script has ended, with what it came to. */
  readonly ended: Promise<CommandRun>;
  /** Whether its call answered with its handle, and the registry keeps it. */
  handedBack = false;

  constructor(
    readonly meta: RunMeta,
    launch: RunLauncher,
    onEnd: (run: McpRun<Final>) => void,
  ) {
    // Started on the next turn: a launcher that throws at once fails the run,
    // not whoever started it.
    this.ended = Promise.resolve()
      .then(() =>
        launch({ signal: this.controller.signal, onStderr: (text) => this.said.push(text) }),
      )
      .catch((err: unknown): CommandRun => ({
        code: FAILED_EXIT,
        stdout: '',
        stderr: `The script could not be started: ${err instanceof Error ? err.message : String(err)}`,
      }))
      .then((ran) => {
        this.ran = ran;
        onEnd(this);
        return ran;
      });
  }

  get handle(): string {
    return this.meta.handle;
  }

  /** What the script came to, once it has ended. */
  get result(): CommandRun | undefined {
    return this.ran;
  }

  /** Whether its script is still running. */
  get running(): boolean {
    return this.ran === undefined;
  }

  /** The last lines its script said. */
  tail(): string[] {
    return this.said.lines();
  }

  /** Stop its script as Ctrl-C stops it: it stops between two calls, and says what it wrote. */
  stop(): void {
    this.controller.abort();
  }

  /**
   * The answer its tool gives of it, made once from what the script came to
   * and given again to whoever asks after: what the tool adds once a run
   * has ended — a verification run, a plan marked written — is done once.
   */
  settled(make: (ran: CommandRun) => Promise<Final>): Promise<Final> {
    this.final ??= this.ended.then(make);
    return this.final;
  }
}

/** Where the registry keeps what a later server reads, and its clocks. */
export interface McpRunsOptions {
  /** The folder of the runs handed back: {@link runsDirOf} the journal folder. */
  dir: string;
  /** How long a call holds its script before it hands it back: {@link holdMsOf}. */
  holdMs: number;
  /** This machine's clock. */
  now?: () => Date;
}

/** How far a run under way is, as `run_status` says it. */
export interface RunProgress {
  elapsedSeconds: number;
  expectedSeconds?: number;
  /** What its summary says so far, for a clone that has written one. */
  summary?: RunSummaryRead;
  /** The last lines its script said. */
  tail: string[];
}

/** What a server reads of a run another server started: what it was, and its summary. */
export interface RunOnDisk {
  meta: RunMeta;
  summary?: RunSummaryRead;
}

/** The runs of the tools of one server: see the module's comment. */
export class McpRuns<Final = unknown> {
  private readonly runs = new Map<string, McpRun<Final>>();
  private readonly now: () => Date;

  constructor(private readonly options: McpRunsOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** How long a call holds its script before it hands the run back, in milliseconds. */
  get holdMs(): number {
    return this.options.holdMs;
  }

  /** A handle for the next run, made before it starts: its summary's file is named by it. */
  newHandle(): string {
    return stampedId('mr', this.now());
  }

  /** The file a clone of the run `handle` writes its summary to. */
  summaryPathOf(handle: string): string {
    return summaryPathOf(this.options.dir, handle);
  }

  /**
   * Start a run of a tool's script under an abort of its own. The registry
   * holds it while it runs, and once it has ended only if it was handed back.
   */
  start(meta: Omit<RunMeta, 'startedAt'>, launch: RunLauncher): McpRun<Final> {
    if (!isRunHandle(meta.handle)) throw new Error(`Not the handle of a run: ${meta.handle}`);
    const run = new McpRun<Final>(
      { ...meta, startedAt: this.now().toISOString() },
      launch,
      (ended) => {
        if (!ended.handedBack) this.runs.delete(ended.handle);
      },
    );
    // Ended before it was kept, as a script that cannot start does: not kept.
    if (run.running) this.runs.set(run.handle, run);
    return run;
  }

  /**
   * Wait for `run` to end, `ms` at most: what its script came to, or nothing
   * when it is still running then.
   */
  async hold(
    run: McpRun<Final>,
    ms: number = this.options.holdMs,
  ): Promise<CommandRun | undefined> {
    if (!run.running) return run.result;
    let timer: NodeJS.Timeout | undefined;
    const elapsed = new Promise<undefined>((done) => {
      timer = setTimeout(() => done(undefined), Math.max(0, ms));
    });
    try {
      return await Promise.race([run.ended, elapsed]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Wait for `run` to end as `run_status` waits, `seconds` at most, held to 0
   * to {@link WAIT_SECONDS_MOST}: under the minute a client gives the call
   * that waits, which would otherwise be cancelled in turn.
   */
  waitFor(run: McpRun<Final>, seconds: number): Promise<CommandRun | undefined> {
    const held = Number.isFinite(seconds) ? Math.min(Math.max(0, seconds), WAIT_SECONDS_MOST) : 0;
    return this.hold(run, held * 1000);
  }

  /**
   * Hand `run` back to its caller: kept by the registry until the server
   * ends, what it is written beside its summary for a later server, its
   * owner's alone.
   */
  async handBack(run: McpRun<Final>): Promise<void> {
    run.handedBack = true;
    this.runs.set(run.handle, run);
    await makePrivateDir(this.options.dir);
    await writePrivate(metaPathOf(this.options.dir, run.handle), `${JSON.stringify(run.meta)}\n`);
  }

  /** The run of `handle` this server holds: running, or handed back and ended. */
  get(handle: string): McpRun<Final> | undefined {
    return isRunHandle(handle) ? this.runs.get(handle) : undefined;
  }

  /** The runs this server holds. */
  all(): Array<McpRun<Final>> {
    return [...this.runs.values()];
  }

  /** A run of this server still writing to `target`. */
  busyWith(target: string): McpRun<Final> | undefined {
    return this.all().find((run) => run.running && run.meta.target === target);
  }

  /** A run of this server still running whose summary names the journal `journal`. */
  async underWayWith(journal: string): Promise<McpRun<Final> | undefined> {
    const asked = resolve(journal);
    for (const run of this.all()) {
      if (!run.running || run.meta.summary === undefined) continue;
      const said = (await readRunSummary(run.meta.summary))?.journal;
      if (said !== undefined && resolve(said) === asked) return run;
    }
    return undefined;
  }

  /** How far `run` is: its time, the time its plan gave it, its summary so far, its last lines. */
  async progress(run: McpRun<Final>): Promise<RunProgress> {
    const summary =
      run.meta.summary !== undefined ? await readRunSummary(run.meta.summary) : undefined;
    return {
      elapsedSeconds: Math.max(
        0,
        Math.round((this.now().getTime() - Date.parse(run.meta.startedAt)) / 1000),
      ),
      ...(run.meta.expectedSeconds !== undefined
        ? { expectedSeconds: run.meta.expectedSeconds }
        : {}),
      ...(summary ? { summary } : {}),
      tail: run.tail(),
    };
  }

  /**
   * What is on disk of the run `handle` a server handed back, this one or
   * one before it: nothing when no server did, or the handle is not one.
   */
  async readOnDisk(handle: string): Promise<RunOnDisk | undefined> {
    if (!isRunHandle(handle)) return undefined;
    let meta: RunMeta;
    try {
      meta = metaSchema.parse(
        JSON.parse(await readFile(metaPathOf(this.options.dir, handle), 'utf8')),
      );
    } catch {
      return undefined;
    }
    if (meta.handle !== handle) return undefined;
    const summary = meta.summary !== undefined ? await readRunSummary(meta.summary) : undefined;
    return { meta, ...(summary ? { summary } : {}) };
  }

  /** Stop every run still running, as Ctrl-C stops it, and settle once each has ended. */
  async stopAll(): Promise<void> {
    const running = this.all().filter((run) => run.running);
    for (const run of running) run.stop();
    await Promise.allSettled(running.map((run) => run.ended));
  }

  /**
   * Remove the files of the runs handed back a day ago or more whose
   * journal is gone, or that named none: what a later server could still
   * say of them is said by nothing on disk any more. A run this server
   * holds is kept.
   *
   * @returns How many runs' files were removed.
   */
  async sweep(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.options.dir);
    } catch {
      return 0;
    }
    const now = this.now().getTime();
    let removed = 0;
    for (const name of names) {
      const handle = name.replace(/\.meta\.json$/, '');
      if (handle === name || !isRunHandle(handle) || this.runs.has(handle)) continue;
      const meta = metaPathOf(this.options.dir, handle);
      const kept = await stat(meta).catch(() => undefined);
      if (!kept || now - kept.mtimeMs < RUN_FILES_KEPT_MS) continue;
      const read = await this.readOnDisk(handle);
      const journal = read?.summary?.journal;
      if (journal !== undefined && (await stat(journal).catch(() => undefined))) continue;
      await rm(summaryPathOf(this.options.dir, handle), { force: true });
      await rm(meta, { force: true });
      removed++;
    }
    return removed;
  }
}

/** Write `content` to `file` in place of what it held, its owner's alone, never half written. */
export async function writePrivate(file: string, content: string): Promise<void> {
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', CHECKPOINT_FILE_MODE);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, file);
  } catch (error: unknown) {
    await rm(temp, { force: true });
    throw error;
  }
}
