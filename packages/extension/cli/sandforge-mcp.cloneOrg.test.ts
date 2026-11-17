import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SamplePlan,
  dryRunPlanDirOf,
  keepSamplePlan,
  type WholeOrgSampleDrawn,
} from '../src/modules/forge/sample/samplePlanStore.js';
import { PLAN_ID, openClonePlan, plansDirOf, readClonePlan } from './mcpClonePlans.js';
import { RUN_HANDLE, runsDirOf } from './mcpRuns.js';
import { CLONE_ORG_PLAN_RELAY, CLONE_ORG_RELAY } from './relayWords.js';
import { PROTOCOL_VERSION, cloneOrgPlanLine, serve, type CommandRunner } from './sandforge-mcp.js';
import type { CommandRun, RunOptions } from './scriptRunner.js';

/*
 * The MCP server's clone of a whole org, driven as a client drives it, the
 * clone script stood in for: clone_org_plan runs its dry run and keeps its
 * plan, clone_org runs the line of that plan and nothing else, after the
 * server's own refusals; a call still running past its hold hands its run
 * back, which run_status follows and run_stop stops; once a run has ended,
 * its plan's receipt says so and what it wrote is verified.
 */

type Message = Record<string, unknown> & {
  id?: string | number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

interface CallResult {
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, unknown> & {
    exitCode?: number;
    refusal?: { code: string; message: string };
    plan?: Record<string, unknown> & { id: string };
    running?: Record<string, unknown> & { run: string };
    run?: Record<string, unknown>;
    verification?: Record<string, unknown>;
  };
  isError: boolean;
}

const PER_REQUEST = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
};

const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** What a small sample drew. */
const DRAWN: WholeOrgSampleDrawn = {
  seed: 1,
  draw: 'uniform',
  floor: 1,
  parents: 'all',
  children: 100,
  share: 0.5,
  budget: { bytes: 3_700_000, remainingMB: 5, maxMB: 5, limitedBy: 'storage' },
  rows: 3,
  storageBytes: 6_144,
  objects: [
    { objectApiName: 'Account', sourceRows: 4, kept: 2, roots: 2, below: 0, asParents: 0 },
    { objectApiName: 'Contact', sourceRows: 2, kept: 1, roots: 0, below: 1, asParents: 0 },
  ],
  whole: [],
  heavyRoots: [],
  dropped: [],
  leftEmpty: [],
  noRecordDrawn: [],
  planRequests: { source: 3 },
};

const DRAWN_AT = new Date('2026-11-14T18:40:00.000Z');
const T0 = new Date('2026-11-14T19:00:12.000Z');

let journalDir: string;
let clock: Date;

beforeEach(() => {
  journalDir = mkdtempSync(join(tmpdir(), 'sandforge-mcp-clone-org-'));
  clock = T0;
});

afterEach(() => {
  rmSync(journalDir, { recursive: true, force: true });
});

/** A plan of ids a dry run drew, where a dry run keeps it. */
async function drawnPlan(): Promise<SamplePlan> {
  return keepSamplePlan(dryRunPlanDirOf(journalDir, 'f00d'), {
    sourceOrgId: 'SRC',
    fingerprint: 'f00d',
    drawnAt: DRAWN_AT,
    drawnBy: 'dryRun',
    sample: DRAWN,
    ids: [
      { objectApiName: 'Account', ids: [fakeId('001', 2), fakeId('001', 1)] },
      { objectApiName: 'Contact', ids: [fakeId('003', 1)] },
    ],
  });
}

/** The --json answer of a dry run of the whole org that would go, as the clone script prints it. */
function dryRunAnswer(over: { sample?: SamplePlan; totalRows?: number } = {}) {
  const totalRows = over.totalRows ?? (over.sample ? 3 : 420);
  return {
    tool: 'sandforge-clone',
    version: 1,
    source: 'SRC',
    target: 'TGT',
    dryRun: true,
    anonymize: true,
    writePlan: { totalRows, storageBytes: 6_144, objects: [] },
    wholeOrg: {
      ...(over.sample
        ? {
            sample: {
              seed: 1,
              draw: 'uniform',
              share: 0.5,
              budget: { limitedBy: 'storage' },
              plan: { ...over.sample.place },
            },
          }
        : {}),
      wouldInsert: [
        { objectApiName: 'Account', rows: 2, jobs: 0, byRest: 2 },
        { objectApiName: 'Contact', rows: 1, jobs: 0, byRest: 1 },
      ],
      totalRows,
      requests: {
        target: { verdict: 'fits', estimate: 12, max: 15_000, remaining: 14_000 },
        source: { verdict: 'fits', estimate: 4, max: 15_000, remaining: 14_000 },
      },
      storage: { verdict: 'fits', estimateMB: 0.4, maxMB: 5, remainingMB: 4 },
      durationSeconds: 75,
      question: `Write ${totalRows} record(s) of 2 object(s) of SRC into TGT?`,
    },
    elapsedMs: 49_848,
  };
}

/** The value given after `flag` on a line. */
const valueAfter = (args: readonly string[], flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

interface Ran {
  script: string;
  args: string[];
  relayedBy?: string;
}

/**
 * A stand-in for the clone script: what each run was given, and what it
 * answers — a dry run of the whole org that would go, a run that went
 * through and kept a journal, a verification that found it all there —
 * unless `answer` says otherwise.
 */
function cloneScript(
  answer: (
    args: readonly string[],
    signal: AbortSignal,
  ) => Partial<CommandRun> | Promise<Partial<CommandRun>> = () => ({}),
) {
  const ran: Ran[] = [];
  const run: CommandRunner = async (script, args, signal, options?: RunOptions) => {
    ran.push({
      script,
      args: [...args],
      ...(options?.relayedBy !== undefined ? { relayedBy: options.relayedBy } : {}),
    });
    const given = await answer(args, signal);
    if (given.code !== undefined || given.stdout !== undefined) {
      return { code: 0, stdout: '', stderr: '', ...given };
    }
    if (args[0] === '--verify') {
      return {
        code: 0,
        stdout: JSON.stringify({
          result: { verdict: 'verified', objects: [{ expected: 3, present: 3, deleted: 0 }] },
        }),
        stderr: '',
      };
    }
    if (args.includes('--dry-run')) {
      return { code: 0, stdout: JSON.stringify(dryRunAnswer()), stderr: '', ...given };
    }
    return { code: 0, stdout: JSON.stringify(wroteAnswer()), stderr: '', ...given };
  };
  return { ran, run };
}

/** A journal a run kept, on disk: a run that wrote. */
function journalOnDisk(name = 'sandforge-clone-run.jsonl'): string {
  const dir = join(journalDir, 'forge-runs');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '{}\n');
  return path;
}

/** The --json answer of a run that went through. */
function wroteAnswer(over: Record<string, unknown> = {}) {
  return {
    tool: 'sandforge-clone',
    dryRun: false,
    result: { status: 'success', successCount: 3, failedCount: 0 },
    journal: journalOnDisk(),
    ...over,
  };
}

/** A client of a server it stands up. */
function client(runCommand: CommandRunner, holdMs = 45_000) {
  const input = new PassThrough();
  const received: Message[] = [];
  const waiting: Array<{ id: string | number; resolve: (m: Message) => void }> = [];
  const serving = serve({
    input,
    send: (line) => {
      const message = JSON.parse(line) as Message;
      received.push(message);
      for (const waiter of waiting.splice(0)) {
        if (waiter.id === message.id) waiter.resolve(message);
        else waiting.push(waiter);
      }
    },
    runCommand,
    log: () => undefined,
    journalDir,
    holdMs,
    now: () => clock,
  });
  let next = 1;
  const request = (method: string, params: Record<string, unknown>, id: string | number = next++) =>
    new Promise<Message>((resolve) => {
      waiting.push({ id, resolve });
      input.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: PER_REQUEST } })}\n`,
      );
    });
  const call = async (name: string, args: Record<string, unknown>): Promise<CallResult> => {
    const answer = await request('tools/call', { name, arguments: args });
    expect(answer.error, JSON.stringify(answer.error)).toBeUndefined();
    return answer.result as unknown as CallResult;
  };
  return {
    input,
    received,
    call,
    close: async () => {
      input.end();
      await serving.done;
    },
  };
}

const textOf = (result: CallResult): string => result.content[0]?.text ?? '';

/** Plan a clone of the whole org of SRC into TGT, and return the plan the server kept. */
async function planned(
  c: ReturnType<typeof client>,
  args: Record<string, unknown> = {},
): Promise<{ id: string; result: CallResult }> {
  const result = await c.call('clone_org_plan', { source: 'SRC', target: 'TGT', ...args });
  expect(result.isError, textOf(result)).toBe(false);
  const id = result.structuredContent.plan?.id;
  if (id === undefined) throw new Error(`no plan kept: ${textOf(result)}`);
  return { id, result };
}

describe('clone_org_plan', () => {
  it('runs the dry run of the whole org, anonymized, with what narrows, fits and accepts it, told who relays it', async () => {
    const { ran, run } = cloneScript();
    const c = client(run);

    await c.call('clone_org_plan', {
      source: 'SRC',
      target: 'TGT',
      fit: 'share',
      fitWithinMB: 1.5,
      fitSeed: 7,
      fitDraw: 'recent',
      fitParents: 'required',
      fitChildren: 'all',
      fitWhole: ['Product2'],
      fitFloor: 2,
      maxTotal: 5000,
      excludedObjects: ['Task'],
      excludedFields: ['Account.Description'],
      filters: [{ objectApiName: 'Case', where: "Status = 'New'" }],
      acceptAutomation: true,
      acceptEmails: true,
      muteAutomation: true,
      checkpointFirst: { keepDays: 3 },
    });

    expect(ran).toEqual([
      {
        script: 'sandforge-clone',
        args: [
          '--depth',
          'all',
          '--source',
          'SRC',
          '--target',
          'TGT',
          '--fit',
          'share',
          '--fit-within',
          '1.5',
          '--fit-seed',
          '7',
          '--fit-draw',
          'recent',
          '--fit-parents',
          'required',
          '--fit-children',
          'all',
          '--fit-whole',
          'Product2',
          '--fit-floor',
          '2',
          '--max-total',
          '5000',
          '--exclude-object',
          'Task',
          '--exclude',
          'Account.Description',
          '--filter',
          "Case=Status = 'New'",
          '--anonymize',
          '--accept-automation',
          '--accept-emails',
          '--mute-automation',
          '--checkpoint-first',
          '--checkpoint-keep-days',
          '3',
          '--skip-preflight',
          '--dry-run',
          '--json',
        ],
        relayedBy: CLONE_ORG_PLAN_RELAY,
      },
    ]);
    // Asked of no flag: anonymized all the same, and nothing of it left to the agent.
    expect(cloneOrgPlanLine({ source: 'SRC', target: 'TGT' })).toEqual([
      '--depth',
      'all',
      '--source',
      'SRC',
      '--target',
      'TGT',
      '--anonymize',
      '--skip-preflight',
      '--dry-run',
      '--json',
    ]);
    await c.close();
  });

  it('keeps the plan of a sample that would go: a receipt and a copy of its ids held to its SHA-256, its owner’s alone, and says its question and the call that writes it', async () => {
    const drawn = await drawnPlan();
    const { run } = cloneScript((args) =>
      args.includes('--dry-run') ? { stdout: JSON.stringify(dryRunAnswer({ sample: drawn })) } : {},
    );
    const c = client(run);

    const { id, result } = await planned(c, { fit: 'share', acceptAutomation: true });

    expect(id).toMatch(PLAN_ID);
    expect(result.structuredContent.plan).toMatchObject({
      id,
      mode: 'sample',
      source: 'SRC',
      target: 'TGT',
      records: 3,
      objects: 2,
      storageMB: { estimate: 0.4, remaining: 4 },
      requests: { target: 12, source: 4 },
      durationSeconds: 75,
      question: 'Write 3 record(s) of 2 object(s) of SRC into TGT?',
      anonymize: true,
      accepted: ['acceptAutomation'],
      sample: { share: 0.5, seed: 1, draw: 'uniform', limitedBy: 'storage' },
    });
    const receipt = await readClonePlan(journalDir, id);
    expect(receipt?.sample?.sha256).toBe(drawn.sha256);
    expect(
      (await SamplePlan.open(String(receipt?.sample?.dir), { sha256: drawn.sha256 })).count,
    ).toBe(3);
    if (process.platform !== 'win32') {
      expect(statSync(join(plansDirOf(journalDir), `${id}.json`)).mode & 0o777).toBe(0o600);
      expect(statSync(plansDirOf(journalDir)).mode & 0o777).toBe(0o700);
    }
    const said = textOf(result);
    expect(said).toContain(
      'Its question, which a terminal would ask before the first write: Write 3 record(s) of 2 object(s) of SRC into TGT?',
    );
    expect(said).toContain(
      `clone_org with plan "${id}" and confirm "TGT" writes it and nothing else, once they have said yes`,
    );
    await c.close();
  });

  it('keeps no plan of a dry run that would be refused, and names the parameter that lifts each refusal', async () => {
    const { run } = cloneScript((args) =>
      args.includes('--dry-run')
        ? {
            code: 1,
            stdout: JSON.stringify({
              ...dryRunAnswer(),
              wouldBeRefused: ['the run would write 420 records, more than the 100 of --max-total'],
              wouldBeRefusedCodes: ['MAX_TOTAL_EXCEEDED', 'AUTOMATION_NOT_ACCEPTED'],
            }),
            stderr:
              'a real run would be refused (MAX_TOTAL_EXCEEDED): raise --max-total\n' +
              'a real run would be refused (AUTOMATION_NOT_ACCEPTED): give --accept-automation\n' +
              'a real run would be refused (STORAGE_EXCEEDED): --fit share copies a sample\n',
          }
        : {},
    );
    const c = client(run);

    const result = await c.call('clone_org_plan', { source: 'SRC', target: 'TGT', maxTotal: 100 });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.plan).toBeUndefined();
    const said = textOf(result);
    expect(said).toContain('exit 1: refused, or a run of this plan would be');
    expect(said).toContain("--max-total, named above, is this tool's maxTotal");
    expect(said).toContain(
      "--accept-automation, named above, is this tool's acceptAutomation: true",
    );
    expect(said).toContain('--fit, named above, is this tool\'s fit: "share"');
    expect(existsSync(plansDirOf(journalDir)) ? readdirSync(plansDirOf(journalDir)) : []).toEqual(
      [],
    );
    await c.close();
  });

  it('refuses a personal field copied as it is, naming the terminal and the file that do it, and a fit* without fit, before any script runs', async () => {
    const { ran, run } = cloneScript();
    const c = client(run);

    for (const asked of [{ anonymize: false }, { acceptRealData: true }, { noAnonymize: true }]) {
      const refused = await c.call('clone_org_plan', { source: 'SRC', target: 'TGT', ...asked });
      expect(refused.structuredContent.refusal?.code, JSON.stringify(asked)).toBe('ARGUMENTS');
      expect(textOf(refused)).toContain('always anonymizes its personal fields');
      expect(textOf(refused)).toContain(
        'pnpm exec tsx packages/extension/cli/sandforge-clone.ts --depth all --source <alias> --target <alias> --no-anonymize',
      );
      expect(textOf(refused)).toContain('accept: { realData: true }');
    }
    const fitted = await c.call('clone_org_plan', { source: 'SRC', target: 'TGT', fitWithinMB: 2 });
    expect(fitted.structuredContent.refusal?.code).toBe('ARGUMENTS');
    expect(textOf(fitted)).toContain('the fit* parameters go with fit: "share"');
    // Said true, it is what is done anyway.
    await c.call('clone_org_plan', { source: 'SRC', target: 'TGT', anonymize: true });

    expect(ran).toHaveLength(1);
    expect(ran[0]?.args).toContain('--anonymize');
    expect(ran[0]?.args).not.toContain('--no-anonymize');
    await c.close();
  });
});

describe('clone_org', () => {
  it('runs the line of its plan and nothing else: of a sample, its copy and the dry run’s count; then --yes and its summary under the server’s runs', async () => {
    const drawn = await drawnPlan();
    const { ran, run } = cloneScript((args) =>
      args.includes('--dry-run') ? { stdout: JSON.stringify(dryRunAnswer({ sample: drawn })) } : {},
    );
    const c = client(run);
    const { id } = await planned(c, { fit: 'share', maxTotal: 60 });
    const receipt = await readClonePlan(journalDir, id);

    const result = await c.call('clone_org', { plan: id, confirm: 'TGT' });

    expect(result.isError, textOf(result)).toBe(false);
    const line = ran[1];
    expect(line?.script).toBe('sandforge-clone');
    expect(line?.relayedBy).toBe(CLONE_ORG_RELAY);
    const summary = valueAfter(line?.args ?? [], '--summary') ?? '';
    expect(line?.args).toEqual([
      '--depth',
      'all',
      '--source',
      'SRC',
      '--target',
      'TGT',
      '--fit',
      'share',
      '--max-total',
      '60',
      '--anonymize',
      '--skip-preflight',
      '--fit-plan',
      String(receipt?.sample?.dir),
      '--yes',
      '--summary',
      summary,
      '--json',
    ]);
    expect(summary.startsWith(join(runsDirOf(journalDir), 'mr-'))).toBe(true);
    expect(line?.args).not.toContain('--dry-run');
    await c.close();
  });

  it('holds a run of every record to the count its dry run gave, in place of the count asked', async () => {
    const { ran, run } = cloneScript();
    const c = client(run);
    const { id } = await planned(c, { maxTotal: 5000 });

    await c.call('clone_org', { plan: id, confirm: 'TGT' });

    expect(valueAfter(ran[1]?.args ?? [], '--max-total')).toBe('420');
    expect(ran[1]?.args.filter((arg) => arg === '--max-total')).toHaveLength(1);
    expect(ran[1]?.args).not.toContain('--fit-plan');
    await c.close();
  });

  it('refuses before any script runs: without confirm or with another alias, a plan unknown or past its day, a scope given, a resume of nothing', async () => {
    const { ran, run } = cloneScript();
    const c = client(run);
    const { id } = await planned(c);
    const before = ran.length;

    const unconfirmed = await c.call('clone_org', { plan: id });
    expect(unconfirmed.structuredContent.refusal?.code).toBe('CONFIRM');
    expect(textOf(unconfirmed)).toContain('clone_org writes to TGT');
    expect(textOf(unconfirmed)).toContain('clone_org_plan says what it would write');
    const other = await c.call('clone_org', { plan: id, confirm: 'SRC' });
    expect(other.structuredContent.refusal?.code).toBe('CONFIRM');

    const unknown = await c.call('clone_org', { plan: 'co-20260101-000000-zzzz', confirm: 'TGT' });
    expect(unknown.structuredContent.refusal?.code).toBe('PLAN_GONE');
    expect(textOf(unknown)).toContain('plan "co-20260101-000000-zzzz" is not on this machine');
    expect(textOf(unknown)).toContain('clone_org_plan again with the same parameters');

    const scoped = await c.call('clone_org', {
      plan: id,
      confirm: 'TGT',
      fit: 'share',
      maxTotal: 9,
    });
    expect(scoped.structuredContent.refusal?.code).toBe('ARGUMENTS');
    expect(textOf(scoped)).toContain(
      "clone_org takes a plan, not its scope: fit, maxTotal are clone_org_plan's to give",
    );

    const resumed = await c.call('clone_org', { plan: id, confirm: 'TGT', resume: true });
    expect(resumed.structuredContent.refusal?.code).toBe('NOTHING_TO_RESUME');

    clock = new Date(T0.getTime() + 24 * 60 * 60_000 + 1000);
    const late = await c.call('clone_org', { plan: id, confirm: 'TGT' });
    expect(late.structuredContent.refusal?.code).toBe('PLAN_GONE');
    expect(textOf(late)).toContain(`plan "${id}" held until`);

    expect(ran).toHaveLength(before);
    await c.close();
  });

  it('refuses a plan already written, naming its run and its journal, and takes it up with resume', async () => {
    const { ran, run } = cloneScript();
    const c = client(run);
    const { id } = await planned(c);
    const first = await c.call('clone_org', { plan: id, confirm: 'TGT' });
    const journal = String(
      (first.structuredContent as { answer?: { journal?: string } }).answer?.journal,
    );

    const again = await c.call('clone_org', { plan: id, confirm: 'TGT' });

    expect(again.structuredContent.refusal?.code).toBe('PLAN_USED');
    expect(textOf(again)).toContain(`whose journal is ${journal}`);
    expect(textOf(again)).toContain(
      `run_remove with module "forge", org "TGT" and run "${journal}" (preview: true first)`,
    );
    const runs = ran.filter(
      (each) => !each.args.includes('--dry-run') && each.args[0] !== '--verify',
    );
    expect(runs).toHaveLength(1);

    await c.call('clone_org', { plan: id, confirm: 'TGT', resume: true });
    const resume = ran.filter((each) => each.args.includes('--resume'));
    expect(resume).toHaveLength(1);
    expect(valueAfter(resume[0]?.args ?? [], '--resume')).toBe(journal);
    expect(resume[0]?.args).not.toContain('--fit-plan');
    await c.close();
  });

  it('verifies what a run that went through wrote, and says the verification first when it is not VERIFIED', async () => {
    const { ran, run } = cloneScript((args) =>
      args[0] === '--verify'
        ? {
            code: 3,
            stdout: JSON.stringify({
              result: {
                verdict: 'partial',
                objects: [
                  {
                    objectApiName: 'Account',
                    expected: 2,
                    present: 1,
                    deleted: 1,
                    notVisible: 0,
                    linksBroken: 0,
                  },
                  {
                    objectApiName: 'Contact',
                    expected: 1,
                    present: 1,
                    deleted: 0,
                    notVisible: 0,
                    linksBroken: 1,
                  },
                  {
                    objectApiName: 'Ticket__c',
                    expected: 4,
                    present: 4,
                    deleted: 0,
                    notVisible: 0,
                    linksBroken: 0,
                  },
                ],
              },
            }),
          }
        : {},
    );
    const c = client(run);
    const { id } = await planned(c);

    const result = await c.call('clone_org', { plan: id, confirm: 'TGT' });

    const verify = ran.find((each) => each.args[0] === '--verify');
    const journal = String(
      (result.structuredContent as { answer?: { journal?: string } }).answer?.journal,
    );
    expect(verify?.args).toEqual([
      '--verify',
      journal,
      '--source',
      'SRC',
      '--target',
      'TGT',
      '--json',
    ]);
    expect(verify?.relayedBy).toBe(CLONE_ORG_RELAY);
    expect(result.isError).toBe(false);
    expect(result.structuredContent.verification).toEqual({
      exitCode: 3,
      status: 'PARTIAL',
      expected: 7,
      present: 6,
      deleted: 1,
      notVisible: 0,
      linksBroken: 1,
      unchecked: 0,
      // The objects it found short, and none it found whole.
      objects: [
        {
          objectApiName: 'Account',
          expected: 2,
          present: 1,
          deleted: 1,
          notVisible: 0,
          linksBroken: 0,
        },
        {
          objectApiName: 'Contact',
          expected: 1,
          present: 1,
          deleted: 0,
          notVisible: 0,
          linksBroken: 1,
        },
      ],
    });
    expect(textOf(result).split('\n')[0]).toBe(
      'Verification: PARTIAL — the clone ended, and TGT does not hold all of it as it was ' +
        'written: 6 of the 7 records the run created read back from TGT, 1 in its recycle bin; 1 ' +
        'lookups not where the run set them. verification.objects names the objects, each with ' +
        'what it found.',
    );
    expect(textOf(result)).toContain('It created 3 records of the 420 its plan counted.');
    expect(textOf(result)).toContain(
      `This run: run_remove with module "forge", org "TGT" and run "${journal}" takes it back`,
    );
    expect(await openClonePlan(journalDir, id, clock)).toMatchObject({ state: 'written', journal });
    await c.close();
  });

  it('names the object and the records more than the run wrote when that is what made its verification PARTIAL', async () => {
    // Run for real after a resume, every record read back, and the answer
    // said "what it wrote could not all be checked" with no object: the
    // verification had counted 1400 relations more than the run said wrote.
    const { run } = cloneScript((args) =>
      args[0] === '--verify'
        ? {
            code: 3,
            stdout: JSON.stringify({
              result: {
                verdict: 'partial',
                objects: [
                  {
                    objectApiName: 'AccountContactRelation',
                    expected: 1,
                    present: 1,
                    deleted: 0,
                    notVisible: 0,
                    linksBroken: 0,
                    withTheirRecord: 2072,
                    moreInTheWindow: 1400,
                  },
                  {
                    objectApiName: 'Contact',
                    expected: 2,
                    present: 2,
                    deleted: 0,
                    notVisible: 0,
                    linksBroken: 0,
                  },
                ],
              },
            }),
          }
        : {},
    );
    const c = client(run);
    const { id } = await planned(c);

    const result = await c.call('clone_org', { plan: id, confirm: 'TGT' });

    expect(result.structuredContent.verification).toMatchObject({
      status: 'PARTIAL',
      moreInTheWindow: 1400,
      objects: [
        {
          objectApiName: 'AccountContactRelation',
          expected: 1,
          present: 1,
          withTheirRecord: 2072,
          moreInTheWindow: 1400,
        },
      ],
    });
    expect(textOf(result).split('\n')[0]).toBe(
      'Verification: PARTIAL — the clone ended, and TGT holds 1400 records more of ' +
        'AccountContactRelation, created during the run by the user it wrote as, than the run ' +
        'wrote and the platform wrote with its records: 3 of the 3 records the run created ' +
        'read back from TGT. verification.objects names the objects, each with what it found.',
    );
    expect(textOf(result)).not.toContain('could not all be checked');
    await c.close();
  });

  it('says a VERIFIED run after its own lines, and verifies nothing of a run refused', async () => {
    const { ran, run } = cloneScript();
    const c = client(run);
    const { id } = await planned(c);

    const result = await c.call('clone_org', { plan: id, confirm: 'TGT' });

    expect(textOf(result).startsWith('ran: ')).toBe(true);
    expect(textOf(result)).toContain('Verification: VERIFIED — 3 of the 3 records');
    expect(ran.filter((each) => each.args[0] === '--verify')).toHaveLength(1);
    await c.close();
  });

  it('marks its plan dead on a refusal only a new plan answers, and keeps it on a day’s requests spent', async () => {
    let refusal = 'SAMPLE_PLAN_MISMATCH';
    const { run } = cloneScript((args) =>
      !args.includes('--dry-run') && args[0] !== '--verify'
        ? {
            code: refusal === 'SAMPLE_PLAN_MISMATCH' ? 2 : 1,
            stdout: JSON.stringify({
              tool: 'sandforge-clone',
              refused: { code: refusal, message: '…' },
            }),
          }
        : {},
    );
    const c = client(run);
    const dead = (await planned(c)).id;

    const mismatch = await c.call('clone_org', { plan: dead, confirm: 'TGT' });
    expect(textOf(mismatch)).toContain('The plan no longer holds (SAMPLE_PLAN_MISMATCH)');
    const after = await c.call('clone_org', { plan: dead, confirm: 'TGT' });
    expect(after.structuredContent.refusal?.code).toBe('PLAN_GONE');
    expect(textOf(after)).toContain('was refused (SAMPLE_PLAN_MISMATCH) for what changed since');

    refusal = 'API_BUDGET_EXCEEDED';
    const kept = (await planned(c)).id;
    const budget = await c.call('clone_org', { plan: kept, confirm: 'TGT' });
    expect(textOf(budget)).toContain(`Plan "${kept}" still holds until`);
    expect(await openClonePlan(journalDir, kept, clock)).toMatchObject({ state: 'ready' });
    await c.close();
  });

  it('never starts the run of a call cancelled while its plan is read, keeps no run in the plan, and answers nothing for it', async () => {
    // Heard only once the script ran, the cancel of a call still reading its
    // plan was dropped, and the clone started for a client that had gone.
    const { ran, run } = cloneScript();
    const c = client(run);
    const { id } = await planned(c);
    const before = ran.length;

    c.input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'gone',
        method: 'tools/call',
        params: {
          name: 'clone_org',
          arguments: { plan: id, confirm: 'TGT' },
          _meta: PER_REQUEST,
        },
      })}\n${JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'gone', reason: 'the person stopped it' },
      })}\n`,
    );
    // The plan answered again after it: the cancelled call has had its turn.
    await c.call('run_status', { run: 'mr-20260101-000000-zzzz' });
    await c.close();

    expect(ran).toHaveLength(before);
    expect(c.received.some((message) => message.id === 'gone')).toBe(false);
    expect(await openClonePlan(journalDir, id, clock)).toMatchObject({
      state: 'ready',
      receipt: { runs: [] },
    });
  });

  it('says when a resume refused for the calls left under way may go again', async () => {
    const retryAt = '2026-11-14T20:10:00.000Z';
    const { run } = cloneScript((args) =>
      args.includes('--resume')
        ? {
            code: 1,
            stdout: JSON.stringify({
              refused: { code: 'RESUME_UNCERTAIN', message: '…', retryAt },
            }),
          }
        : args.includes('--dry-run') || args[0] === '--verify'
          ? {}
          : { code: 130, stdout: JSON.stringify(wroteAnswer({ interrupted: true })) },
    );
    const c = client(run);
    const { id } = await planned(c);
    const stopped = await c.call('clone_org', { plan: id, confirm: 'TGT' });
    expect(textOf(stopped)).toContain(
      `clone_org with plan "${id}", resume: true and confirm "TGT" takes it up, writing nothing twice`,
    );

    const result = await c.call('clone_org', { plan: id, confirm: 'TGT', resume: true });

    expect(textOf(result)).toContain(
      `clone_org with plan "${id}", resume: true and confirm "TGT" again from ${retryAt}`,
    );
    await c.close();
  });
});

describe('a call still running after its hold', () => {
  /**
   * A hold long enough for what ends at once — a dry run stood in for, a run
   * stopped, and what the server does after them on disk — and short enough
   * for a test: a run that never ends unless told is handed back past it.
   */
  const HELD_BRIEFLY_MS = 400;

  /** A clone that runs until told to end, writing its summary as it goes. */
  function longClone() {
    let end: ((run: Partial<CommandRun>) => void) | undefined;
    const signals: AbortSignal[] = [];
    const script = cloneScript(async (args, signal) => {
      if (args.includes('--dry-run') || args[0] === '--verify') return {};
      signals.push(signal);
      const summary = valueAfter(args, '--summary');
      const journal = journalOnDisk();
      if (summary !== undefined) {
        writeFileSync(
          summary,
          JSON.stringify({
            running: true,
            journal,
            result: { successCount: 2, createdByObject: [{}] },
          }),
        );
      }
      return new Promise<Partial<CommandRun>>((resolve) => {
        end = resolve;
        signal.addEventListener('abort', () =>
          resolve({
            code: 130,
            stdout: JSON.stringify(wroteAnswer({ interrupted: true })),
            stderr: 'interrupted: the clone stops after the call under way\n',
          }),
        );
      });
    });
    return {
      ...script,
      signals,
      end: (run: Partial<CommandRun>) => end?.(run),
    };
  }

  it('answers with the handle of its run, which run_status follows and gives the answer of once it has ended', async () => {
    const clone = longClone();
    const c = client(clone.run, HELD_BRIEFLY_MS);
    const { id } = await planned(c);

    const handed = await c.call('clone_org', { plan: id, confirm: 'TGT' });

    expect(handed.isError).toBe(false);
    const handle = handed.structuredContent.running?.run ?? '';
    expect(handle).toMatch(RUN_HANDLE);
    expect(handed.structuredContent.running).toMatchObject({
      tool: 'clone_org',
      plan: id,
      expectedSeconds: 75,
    });
    expect(textOf(handed)).toContain(`run_status with run "${handle}" follows it`);
    expect(existsSync(join(runsDirOf(journalDir), `${handle}.meta.json`))).toBe(true);

    const going = await c.call('run_status', { run: handle, waitSeconds: 0 });
    expect(going.structuredContent.running).toMatchObject({
      run: handle,
      state: 'running',
      plan: { id, records: 420 },
      summary: { state: 'running', written: 2 },
    });
    expect(textOf(going)).toContain('So far: 2 records written of the 420 its plan counted');

    clone.end({ code: 0, stdout: JSON.stringify(wroteAnswer()) });
    const ended = await c.call('run_status', { run: handle, waitSeconds: 5 });

    expect(ended.structuredContent).toMatchObject({
      exitCode: 0,
      run: { run: handle, state: 'ended' },
      verification: { status: 'VERIFIED' },
    });
    expect(await openClonePlan(journalDir, id, clock)).toMatchObject({ state: 'written' });
    // A second call answers the same, the verification run once.
    await c.call('run_status', { run: handle, waitSeconds: 0 });
    expect(clone.ran.filter((each) => each.args[0] === '--verify')).toHaveLength(1);
    await c.close();
  });

  it('refuses another clone of the same target while it runs, and a removal of what it writes', async () => {
    const clone = longClone();
    const c = client(clone.run, HELD_BRIEFLY_MS);
    const { id } = await planned(c);
    const second = (await planned(c)).id;
    const handed = await c.call('clone_org', { plan: id, confirm: 'TGT' });
    const handle = handed.structuredContent.running?.run ?? '';

    const busy = await c.call('clone_org', { plan: second, confirm: 'TGT' });
    expect(busy.structuredContent.refusal?.code).toBe('TARGET_BUSY');
    expect(textOf(busy)).toContain(`TGT is being written by run "${handle}" of clone_org`);

    const summary = String(handed.structuredContent.running?.summary);
    const removal = await c.call('run_remove', {
      module: 'forge',
      org: 'TGT',
      run: summary,
      confirm: 'TGT',
    });
    expect(removal.structuredContent.refusal?.code).toBe('RUN_UNDER_WAY');
    expect(textOf(removal)).toContain(`run_stop with run "${handle}" stops it`);
    expect(clone.ran.filter((each) => each.args[0] === '--remove')).toHaveLength(0);
    await c.close();
  });

  it('is stopped by run_stop as Ctrl-C would, and answers with the lines that take it up and back', async () => {
    const clone = longClone();
    const c = client(clone.run, HELD_BRIEFLY_MS);
    const { id } = await planned(c);
    const handle =
      (await c.call('clone_org', { plan: id, confirm: 'TGT' })).structuredContent.running?.run ??
      '';

    const stopped = await c.call('run_stop', { run: handle });

    expect(clone.signals[0]?.aborted).toBe(true);
    expect(stopped.structuredContent).toMatchObject({
      exitCode: 130,
      run: { run: handle, state: 'ended' },
    });
    expect(textOf(stopped)).toContain(
      `clone_org with plan "${id}", resume: true and confirm "TGT" takes it up, writing nothing twice`,
    );
    expect(textOf(stopped)).toContain('run_remove with module "forge", org "TGT" and run "');
    expect(clone.ran.filter((each) => each.args[0] === '--verify')).toHaveLength(0);
    await c.close();
  });

  it('is stopped as its server ends, and read off the disk by the next server, with the calls that take it up and back', async () => {
    const clone = longClone();
    const c = client(clone.run, HELD_BRIEFLY_MS);
    const { id } = await planned(c);
    const handle =
      (await c.call('clone_org', { plan: id, confirm: 'TGT' })).structuredContent.running?.run ??
      '';

    await c.close();
    expect(clone.signals[0]?.aborted).toBe(true);

    const next = client(cloneScript().run, HELD_BRIEFLY_MS);
    const read = await next.call('run_status', { run: handle });
    expect(read.isError).toBe(false);
    expect(read.structuredContent.run).toMatchObject({
      run: handle,
      state: 'gone',
      tool: 'clone_org',
      plan: id,
      target: 'TGT',
    });
    expect(textOf(read)).toContain("is not one of this server's");
    expect(textOf(read)).toContain(
      `clone_org with plan "${id}", resume: true and confirm "TGT" takes it up`,
    );
    const unknown = await next.call('run_status', { run: 'mr-20260101-000000-zzzz' });
    expect(unknown.structuredContent.refusal?.code).toBe('RUN_UNKNOWN');
    await next.close();
  });

  it('hands back a run of any tool, whose answer run_status then gives as the call would have', async () => {
    let finish: ((run: CommandRun) => void) | undefined;
    const run: CommandRunner = () =>
      new Promise<CommandRun>((resolve) => {
        finish = resolve;
      });
    const c = client(run, HELD_BRIEFLY_MS);

    const handed = await c.call('checkpoint_take', { org: 'DEV' });
    const handle = handed.structuredContent.running?.run ?? '';
    expect(handed.structuredContent.running).toMatchObject({ tool: 'checkpoint_take' });

    finish?.({ code: 0, stdout: '{"checkpointId":"cp-1"}', stderr: 'kept\n' });
    const ended = await c.call('run_status', { run: handle, waitSeconds: 5 });

    expect(ended.structuredContent).toEqual({
      exitCode: 0,
      answer: { checkpointId: 'cp-1' },
      run: { run: handle, state: 'ended' },
    });
    expect(textOf(ended)).toContain('kept');
    await c.close();
  });
});
