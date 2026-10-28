/**
 * A property of `state recover` on the memory org, over random histories of
 * a seed environment — apply, `--replace`, a count edited, a colleague
 * changing or deleting records of it, a destroy that takes everything back or
 * leaves what was changed since — each history ending with the state lost:
 * `state.json` deleted, every run file left where the scripts wrote it.
 *
 * What holds, whatever the history:
 * - the runs the rebuilt state would take back are exactly those the lost
 *   state would have: every run that created records and that no removal took
 *   back whole, by its rank, its run id and its summary — a removal's own
 *   record marks a run taken back, nothing else does;
 * - the plan after it refuses nothing for want of a state, and replaces or
 *   creates every resource the file has;
 * - a destroy after it leaves no record of the environment, and the org's
 *   own records as they were.
 *
 * Each history runs the command line's own `main`, its seed `sandforge-seed`'s
 * own `main` in this process. The records are counted in the memory org.
 * A fixed seed keeps the histories the same from run to run; fast-check prints
 * it, with the history, when the property fails. `SANDFORGE_PROPERTY_SEED`
 * and `SANDFORGE_PROPERTY_RUNS` run other ones.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  envPlanSchema,
  envRecoverResultSchema,
  envRefusalAnswerSchema,
  type EnvState,
} from '@sandforge/shared';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../sfSession.js', () => ({ loadOrg: vi.fn(), makeConn: vi.fn() }));
vi.mock('../sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('../sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(),
}));
vi.mock('../../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));

import { SEED_RUNS_DIR } from '../../src/modules/seed/SeedRunCreations.js';
import { paced } from '../../src/test/runnerPace.js';
import { main } from '../sandforge-env.js';
import { EnvWorld } from '../testing/envWorld.js';
import { openEnvStore } from './envState.js';

const ORG_ID = '00D000000000003RAA';
const OTHER_USER = '005000000000008AAA';
const ENV = 'props-recover';
const T0 = Date.parse('2026-10-25T09:00:00.000Z');

/** A whole number from the environment, or the default. */
function fromEnv(name: string, otherwise: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : otherwise;
}

const SEED = fromEnv('SANDFORGE_PROPERTY_SEED', 1_418_030_377);
/** Fewer on a Windows runner, whose disk takes the run files several times slower. */
const RUNS = fromEnv('SANDFORGE_PROPERTY_RUNS', process.platform === 'win32' ? 4 : 20);

const ACCOUNT_MARK = 'SFENV recover account';
const CONTACT_MARK = 'SFENV recover contact';

/** The file: accounts, then contacts under the accounts it finds by their name. */
function fileOf(counts: { accounts: number; contacts: number }): Record<string, unknown> {
  const named = (field: string, value: string) => [
    { fieldApiName: field, ruleType: 'static', config: { staticValue: value } },
  ];
  return {
    version: 1,
    name: ENV,
    resources: {
      accounts: {
        kind: 'seed',
        seed: 1,
        objects: [
          { object: 'Account', count: counts.accounts, fields: named('Name', ACCOUNT_MARK) },
        ],
      },
      contacts: {
        kind: 'seed',
        seed: 2,
        dependsOn: ['accounts'],
        objects: [
          { object: 'Contact', count: counts.contacts, fields: named('LastName', CONTACT_MARK) },
        ],
        relations: [
          {
            lookup: 'Contact.AccountId',
            parents: {
              object: 'Account',
              existing: { where: `Name = '${ACCOUNT_MARK}'`, limit: 6 },
            },
            distribution: { mode: 'ratio', ratio: 1 },
          },
        ],
      },
    },
  };
}

type Resource = 'accounts' | 'contacts';

/** What a team does to the environment over weeks. */
type Op =
  | { op: 'apply' }
  | { op: 'replace'; resource: Resource }
  | { op: 'count'; resource: Resource; count: number }
  | { op: 'touch' | 'trash'; object: 'Account' | 'Contact'; at: number }
  | { op: 'destroy' };

const resourceArb = fc.constantFrom<Resource>('accounts', 'contacts');
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<Op>({ op: 'apply' }) },
  { weight: 2, arbitrary: resourceArb.map((resource): Op => ({ op: 'replace', resource })) },
  {
    weight: 2,
    arbitrary: fc
      .tuple(resourceArb, fc.integer({ min: 1, max: 3 }))
      .map(([resource, count]): Op => ({ op: 'count', resource, count })),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(
        fc.constantFrom<'touch' | 'trash'>('touch', 'trash'),
        fc.constantFrom<'Account' | 'Contact'>('Account', 'Contact'),
        fc.nat(9),
      )
      .map(([op, object, at]): Op => ({ op, object, at })),
  },
  { weight: 2, arbitrary: fc.constant<Op>({ op: 'destroy' }) },
);
/** A history begins with an apply: one that never applied keeps nothing to recover. */
const historyArb = fc
  .array(opArb, { minLength: 1, maxLength: 6 })
  .map((ops) => [{ op: 'apply' } as Op, ...ops]);

let dir: string;
let project: string;
let journalDir: string;
let world: EnvWorld;
let counts: { accounts: number; contacts: number };
let own: string;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A new history: an empty journal, a Developer Edition org holding one account of its own. */
function begin(): void {
  vi.setSystemTime(T0);
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-recover-props-'));
  project = join(dir, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  journalDir = join(dir, 'journal');
  counts = { accounts: 2, contacts: 2 };
  writeFileSync(join(project, 'sandforge.yaml'), JSON.stringify(fileOf(counts)));
  world = new EnvWorld({
    organizationId: ORG_ID,
    sandbox: false,
    edition: 'Developer Edition',
    tick: () => vi.setSystemTime(Date.now() + 30_000),
  });
  [own] = world.copyIn('Account', [{ Name: 'The org’s own' }]) as [string];
}

/** Run a command line: its exit code and its `--json` answer. */
async function run(args: string[]): Promise<{ code: number; answer: unknown }> {
  const out: string[] = [];
  vi.mocked(process.stdout.write).mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  let exited: number | undefined;
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exited = code;
    throw new Error(`exit ${code}`);
  }) as never);
  process.exitCode = undefined;
  try {
    await main(
      [
        'node',
        'sandforge-env.ts',
        ...args,
        '--file',
        join(project, 'sandforge.yaml'),
        '--org',
        'TGT',
        '--json',
      ],
      {
        runner: world.runner,
        journalDir,
        locksDir: join(dir, 'locks'),
        onStop: () => () => undefined,
        cwd: project,
      },
    );
  } catch (err: unknown) {
    if (!(err instanceof Error) || !err.message.startsWith('exit ')) throw err;
  } finally {
    exit.mockRestore();
  }
  const code = exited ?? Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  const text = out.join('').trim();
  return { code, answer: text === '' ? undefined : (JSON.parse(text) as unknown) };
}

/** The records of the environment the org holds, by the marks the file writes. */
function marked(): number {
  return (
    world.records('Account').filter((r) => r['Name'] === ACCOUNT_MARK).length +
    world.records('Contact').filter((r) => r['LastName'] === CONTACT_MARK).length
  );
}

async function play(op: Op): Promise<void> {
  if (op.op === 'apply') await run(['apply', '--yes', '--accept-no-state']);
  else if (op.op === 'replace') await run(['apply', '--yes', '--replace', op.resource]);
  else if (op.op === 'destroy') await run(['destroy', '--yes']);
  else if (op.op === 'count') {
    counts = { ...counts, [op.resource]: op.count };
    writeFileSync(join(project, 'sandforge.yaml'), JSON.stringify(fileOf(counts)));
  } else {
    const mark = op.object === 'Account' ? ACCOUNT_MARK : CONTACT_MARK;
    const field = op.object === 'Account' ? 'Name' : 'LastName';
    const rows = world.records(op.object).filter((r) => r[field] === mark);
    const row = rows[op.at % Math.max(rows.length, 1)];
    if (row === undefined) return;
    if (op.op === 'touch') {
      world.org.edit(op.object, String(row['Id']), { [field]: mark }, OTHER_USER);
    } else {
      world.org.trash(op.object, String(row['Id']), OTHER_USER);
    }
  }
  vi.setSystemTime(Date.now() + 60_000);
}

/** The folder of the environment's state. */
function store() {
  const opened = openEnvStore({ journalDir, fileFolder: project });
  if ('refusal' in opened) throw new Error(opened.refusal);
  return opened.store;
}

/**
 * The runs a state would take back: every run that created records, kept
 * on this machine by its summary or its run file, that no removal took back
 * whole — by its resource, its rank, its run id and its summary.
 */
function takenBackNext(state: EnvState): string[] {
  const folder = store().folderOf(ORG_ID, ENV);
  return Object.entries(state.resources)
    .flatMap(([name, resource]) =>
      resource.runs
        .filter(
          (r) =>
            r.takenBack !== true &&
            r.objects.some((object) => object.created > 0) &&
            ((r.summary !== undefined && existsSync(join(folder, r.summary))) ||
              existsSync(join(journalDir, SEED_RUNS_DIR, `${r.runId ?? ''}.ndjson`))),
        )
        .map((r) => `${name}#${r.n} ${r.runId ?? ''} ${r.summary ?? ''}`),
    )
    .sort();
}

/** What the histories came to: so many with runs to take back, with runs taken back, with a run left by a destroy. */
const seen = { live: 0, takenBack: 0, left: 0 };

describe('state recover, over random histories', () => {
  it(
    'rebuilds a state that takes back exactly the runs the lost one would, plans every resource with no --accept-no-state, and a destroy after it leaves no record of the environment and the org’s own as it was',
    async () => {
      await fc.assert(
        fc.asyncProperty(historyArb, async (ops) => {
          begin();
          for (const op of ops) await play(op);
          const lost = await store().read(ORG_ID, ENV);
          if (lost === undefined) return;
          const wouldTakeBack = takenBackNext(lost);
          if (wouldTakeBack.length > 0) seen.live += 1;
          const runs = Object.values(lost.resources).flatMap((resource) => resource.runs);
          if (runs.some((r) => r.takenBack === true)) seen.takenBack += 1;
          if (ops.at(-1)?.op === 'destroy' && wouldTakeBack.length > 0) seen.left += 1;
          rmSync(join(store().folderOf(ORG_ID, ENV), 'state.json'));

          const recovered = await run(['state', 'recover']);
          const history = JSON.stringify(ops);
          expect(recovered.code, history).toBe(0);
          envRecoverResultSchema.parse(recovered.answer);
          const rebuilt = await store().read(ORG_ID, ENV);
          expect(rebuilt?.serial, history).toBe(1);
          expect(takenBackNext(rebuilt as EnvState), history).toEqual(wouldTakeBack);

          const planned = await run(['plan']);
          const plan = envPlanSchema.parse(planned.answer);
          expect(plan.refusal, history).toBeUndefined();
          for (const action of plan.actions) {
            expect(['create', 'replace'], `${history} ${action.resource}`).toContain(action.action);
          }

          const destroyed = await run(['destroy', '--yes', '--include-changed']);
          if (destroyed.code === 1) {
            throw new Error(
              `${history}: ${envRefusalAnswerSchema.safeParse(destroyed.answer).data?.refusal.message ?? JSON.stringify(destroyed.answer)}`,
            );
          }
          expect(marked(), history).toBe(0);
          expect(
            world.records('Account').map((r) => r['Id']),
            history,
          ).toContain(own);
        }),
        { numRuns: RUNS, seed: SEED, endOnFailure: true },
      );
      rmSync(dir, { recursive: true, force: true });
      // Positive control: the histories left runs to take back, runs a
      // removal took back, and a destroy that left records changed since.
      // The four runs a Windows runner gives may draw none of them.
      if (RUNS >= 10) {
        expect(seen.live).toBeGreaterThan(0);
        expect(seen.takenBack).toBeGreaterThan(0);
        expect(seen.left).toBeGreaterThan(0);
      }
    },
    paced(120_000),
  );
});
