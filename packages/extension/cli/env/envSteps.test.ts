import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../sfSession.js', () => ({
  loadOrg: vi.fn(async (alias: string) => ({ alias })),
  makeConn: vi.fn(),
}));
vi.mock('../sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('../sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(() => ({
    read: async () => ({
      objectsRead: [],
      objects: [],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 25,
      requests: 0,
    }),
  })),
}));
vi.mock('../../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));

import { makeConn } from '../sfSession.js';
import { removalOrg } from '../../src/modules/forge/ForgeRunRemoval.js';
import { MemoryRemovalOrg } from '../../src/test/memoryRemovalOrg.js';
import { main, parseArgs, parseRemoveArgs } from '../sandforge-seed.js';
import {
  ANSWER_EXCERPT_CHARS,
  SEED_SCRIPT,
  StepAnswerError,
  readSeedDryRun,
  readSeedPreview,
  readSeedRun,
  seedApplyLine,
  seedDryRunLine,
  seedPreviewLine,
  seedRemoveLine,
} from './envSteps.js';

/*
 * A seed resource's lines are read by the seed's own parsers, and its
 * answers are read off what the seed itself prints: each reader here is fed
 * the output of `sandforge-seed`'s `main`, run in this process against an org
 * in memory, so a field the script renames or drops fails here first.
 */

const ORG_ID = '00D000000000002AAA';
const RUN_ID = 'env-demo-assets-1-00000000-0000-4000-8000-000000000001';

const seedLine = (args: readonly string[]): string[] => ['node', 'sandforge-seed.ts', ...args];

/** Asset, as the fake org describes it: a name to fill, nothing else required. */
const ASSET = {
  name: 'Asset',
  createable: true,
  recordTypeInfos: [],
  fields: [
    { name: 'Id', type: 'id', createable: false, nillable: false, length: 18 },
    { name: 'Name', type: 'string', createable: true, nillable: false, length: 80 },
  ].map((f) => ({ referenceTo: [], defaultedOnCreate: false, picklistValues: [], ...f })),
};

/** A sandbox that takes every Asset it is sent through REST and runs nothing as they go in. */
function fakeOrg(): void {
  let made = 0;
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  const conn = {
    sobject: () => ({
      describe: async () => ASSET,
      create: async (records: unknown[]) =>
        records.map(() => ({ success: true, id: `02i${String(made++).padStart(12, '0')}AAA` })),
    }),
    describe: async () => ASSET,
    describeGlobal: async () => ({ sobjects: [{ name: 'Asset', createable: true }] }),
    query: async (soql: string) =>
      soql.includes('FROM Organization') ? page([{ Id: ORG_ID, IsSandbox: true }]) : page([]),
    tooling: { query: async () => page([]) },
    request: async () => ({
      DataStorageMB: { Max: 200, Remaining: 150 },
      SingleEmail: { Max: 5_000, Remaining: 5_000 },
    }),
  };
  vi.mocked(makeConn).mockReturnValue(conn as unknown as Connection);
}

let dir: string;
let templateFile: string;
let stdout: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-steps-'));
  templateFile = join(dir, 'assets.template.json');
  writeFileSync(
    templateFile,
    JSON.stringify({
      name: 'SFENV assets',
      strategy: 'faker',
      objects: [
        {
          objectApiName: 'Asset',
          recordCount: 3,
          fieldRules: [
            { fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'SFENV asset' } },
          ],
          excludedFields: [],
          insertOrder: 0,
        },
      ],
    }),
  );
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('a seed resource’s lines', () => {
  it('gives a run the template file, the run id and the seed, its summary on stdout and a partial run failed', () => {
    const line = seedApplyLine({ target: 'TGT', templateFile, runId: RUN_ID, seed: 7 });

    expect(parseArgs(seedLine(line))).toMatchObject({
      target: 'TGT',
      templateFile,
      runId: RUN_ID,
      seed: 7,
      json: true,
      failOnPartial: true,
      dryRun: false,
    });
    expect(line).not.toContain('--accept-automation');
    expect(
      seedApplyLine({ target: 'TGT', templateFile, runId: RUN_ID, acceptAutomation: true }),
    ).toContain('--accept-automation');
  });

  it('gives a dry run the same template and id, and --dry-run', () => {
    expect(
      parseArgs(seedLine(seedDryRunLine({ target: 'TGT', templateFile, runId: RUN_ID, seed: 7 }))),
    ).toMatchObject({ templateFile, runId: RUN_ID, seed: 7, dryRun: true, json: true });
  });

  it('gives the removal and its preview the summary, the target and only the switches asked for', () => {
    const removal = { target: 'TGT', summary: join(dir, 'run.json') };

    expect(parseRemoveArgs(seedLine(seedRemoveLine(removal)))).toEqual({
      summaryPath: removal.summary,
      target: 'TGT',
      includeChanged: false,
      sweep: false,
      sweepList: false,
      json: true,
      leaveUndeletable: false,
      acceptAutomation: false,
    });
    expect(
      parseRemoveArgs(
        seedLine(
          seedPreviewLine({
            ...removal,
            includeChanged: true,
            acceptAutomation: true,
            leaveUndeletable: true,
          }),
        ),
      ),
    ).toEqual({
      summaryPath: removal.summary,
      target: 'TGT',
      includeChanged: true,
      sweep: false,
      sweepList: false,
      json: true,
      leaveUndeletable: true,
      acceptAutomation: true,
      preview: true,
    });
    expect(seedRemoveLine({ ...removal, sweep: true })).toContain('--sweep');
  });

  it('refuses a value a script would read as a flag', () => {
    expect(() => seedApplyLine({ target: '--dry-run', templateFile, runId: RUN_ID })).toThrow(
      '--target cannot be "--dry-run"',
    );
    expect(() => seedPreviewLine({ target: 'TGT', summary: '-' })).toThrow('--remove cannot be');
  });
});

describe('a seed resource’s answers, read off what the seed prints', () => {
  it('reads a dry run: the records it would create per object, the emails, nothing in the org', async () => {
    fakeOrg();

    await main(seedLine(seedDryRunLine({ target: 'TGT', templateFile, runId: RUN_ID, seed: 7 })));

    const answer = readSeedDryRun(stdout.join(''));
    expect(answer).toMatchObject({
      tool: SEED_SCRIPT,
      dryRun: true,
      seed: 7,
      emails: { checks: [] },
      result: { operationId: RUN_ID, status: 'success', totalRecordsCreated: 3 },
    });
    expect(answer.result.objectResults).toEqual([
      expect.objectContaining({ objectApiName: 'Asset', recordsCreated: 3, recordsFailed: 0 }),
    ]);
    // A dry run is not a run: read as one, it is refused.
    expect(() => readSeedRun(stdout.join(''))).toThrow(StepAnswerError);
  });

  it('reads a run, then the preview of its removal, from the summary it printed', async () => {
    fakeOrg();
    await main(seedLine(seedApplyLine({ target: 'TGT', templateFile, runId: RUN_ID, seed: 7 })));
    const run = readSeedRun(stdout.join(''));
    expect(run).toMatchObject({
      dryRun: false,
      targetOrgId: ORG_ID,
      result: { operationId: RUN_ID, status: 'success', totalRecordsCreated: 3 },
    });
    expect(run.runFile).toMatch(new RegExp(`${RUN_ID}\\.ndjson$`));
    const created = run.result.objectResults[0]?.createdIds ?? [];
    expect(created).toHaveLength(3);
    // The same summary saying it was a dry run names no record of the org.
    const printed = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(() => readSeedRun(JSON.stringify({ ...printed, dryRun: true }))).toThrow(
      /did not answer the summary of a run \(dryRun: /,
    );

    // The environment keeps the summary, and previews the run's removal from it.
    const summary = join(dir, 'run.summary.json');
    writeFileSync(summary, stdout.join(''));
    const org = new MemoryRemovalOrg();
    for (const id of created) org.add('Asset', { Id: id }, run.finishedAt);
    vi.mocked(removalOrg).mockReturnValue(org);
    stdout.length = 0;

    await main(seedLine(seedPreviewLine({ target: 'TGT', summary })));

    const preview = readSeedPreview(stdout.join(''));
    expect(preview).toMatchObject({
      tool: SEED_SCRIPT,
      action: 'remove-preview',
      summary,
      target: 'TGT',
      refusals: [],
      preview: {
        planned: 3,
        objects: [{ objectApiName: 'Asset', planned: 3, toDelete: 3, changedSince: 0 }],
      },
    });
    expect(org.deletes).toEqual([]);
  });
});

describe('an answer that does not read', () => {
  it('names the script and quotes the first 200 characters of what it printed', () => {
    const printed = `not json ${'x'.repeat(400)}`;

    let error: unknown;
    try {
      readSeedPreview(printed);
    } catch (err: unknown) {
      error = err;
    }

    expect(error).toBeInstanceOf(StepAnswerError);
    const said = error as StepAnswerError;
    expect(said.script).toBe('sandforge-seed');
    expect(said.excerpt).toBe(printed.slice(0, ANSWER_EXCERPT_CHARS));
    expect(said.message).toBe(
      `sandforge-seed did not answer the preview of a removal (not JSON): it printed ` +
        `${JSON.stringify(printed.slice(0, 200))}`,
    );
  });

  it('says where a JSON answer departs from the shape, never filling it in', () => {
    const answer = JSON.stringify({ tool: 'sandforge-seed', action: 'remove', result: {} });

    expect(() => readSeedPreview(answer)).toThrow(
      /^sandforge-seed did not answer the preview of a removal \(action: /,
    );
  });

  it('says a script printed nothing, as one refused before its first write does with --json', () => {
    expect(() => readSeedRun('')).toThrow(
      'sandforge-seed did not answer the summary of a run (not JSON): it printed nothing on stdout',
    );
  });
});
