import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', async (original) => ({
  ...(await original<typeof import('./sfSession.js')>()),
  loadOrg: vi.fn(),
  makeConn: vi.fn(),
}));
vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(),
}));
vi.mock('../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));
vi.mock('../src/core/connection/ConnectionHelper.js', async (original) => ({
  ...(await original<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));

import {
  ACCOUNTS_TEMPLATE,
  PipelineWorld,
  WORLD_TARGET_ID,
  step,
} from './testing/pipelineWorld.js';
import { CompareHandler } from '../src/bridge/handlers/CompareHandler.js';

/*
 * A dry run from the command line: the steps that read run, the steps that
 * write say what they would do, and the org takes no write, no Delay waits,
 * no Approval is asked, and neither the history nor the audit keeps it.
 */

let dir: string;
let journalBefore: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-pipeline-dry-'));
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  process.env['SANDFORGE_JOURNAL_DIR'] = join(dir, 'journal');
});
afterEach(() => {
  if (journalBefore === undefined) delete process.env['SANDFORGE_JOURNAL_DIR'];
  else process.env['SANDFORGE_JOURNAL_DIR'] = journalBefore;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('sandforge pipeline run --dry-run', () => {
  it('runs the Compare, seeds nothing, waits for no Delay, and keeps no history', async () => {
    const world = new PipelineWorld(dir, [
      { alias: 'UAT', organizationId: WORLD_TARGET_ID },
      { alias: 'SRC', organizationId: '00D000000000008SRC' },
    ]);
    const compared = vi.spyOn(CompareHandler.prototype, 'compareOrgs').mockResolvedValue({
      summary: { added: 1, removed: 0, modified: 0, unchanged: 3, total: 4 },
      items: [],
    } as never);
    let writes = 0;
    world.env.onCreate = () => {
      writes += 1;
    };
    const file = world.file({
      orgs: {
        'reg-uat': {
          alias: 'UAT',
          organizationId: WORLD_TARGET_ID,
          kind: 'sandbox',
          staging: false,
        },
        'reg-src': {
          alias: 'SRC',
          organizationId: '00D000000000008SRC',
          kind: 'sandbox',
          staging: false,
        },
      },
      steps: [
        step('s1', 'Diff', 'compare', {
          sourceOrgId: 'reg-src',
          targetOrgId: 'reg-uat',
          types: ['ApexClass'],
        }),
        step('s2', 'An hour', 'delay', { seconds: 3600 }),
        step('s3', 'Gate', 'approval', { timeoutMinutes: 5 }),
        step('s4', 'Fill', 'seed', { orgId: 'reg-uat', templateId: ACCOUNTS_TEMPLATE.id }),
      ],
      seedTemplates: { [ACCOUNTS_TEMPLATE.id]: ACCOUNTS_TEMPLATE },
    });
    const startedAt = Date.now();

    const run = await world.run([
      'run',
      '--file',
      file,
      '--dry-run',
      '--approve',
      'Gate',
      '--json',
    ]);

    expect(run.code).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(30_000);
    const answer = JSON.parse(run.stdout) as {
      dryRun: boolean;
      status: string;
      steps: Array<{
        name: string;
        summary?: string;
        takeBack?: string;
        output?: { dryRun?: boolean };
      }>;
      approvals: unknown[];
    };
    expect(answer.dryRun).toBe(true);
    expect(answer.status).toBe('completed');
    expect(compared).toHaveBeenCalledTimes(1);
    expect(writes).toBe(0);
    expect(world.env.records('Account')).toHaveLength(0);
    expect(answer.steps.find((each) => each.name === 'Fill')).toMatchObject({
      summary: expect.stringMatching(
        /^Would seed "Two accounts" into UAT: 2 records of 1 object, as its template asks; data storage: about [\d.]+ MB to write, UAT has 5 MB left of 5 MB; about \d+ API requests? of the 14000 UAT has left today\. Nothing was written\.$/,
      ),
      output: expect.objectContaining({ dryRun: true }),
    });
    expect(answer.steps.some((each) => each.takeBack !== undefined)).toBe(false);
    expect(answer.approvals).toEqual([]);
    expect(run.stderr).toContain('Dry run: the steps that write say what they would do.');
    expect(existsSync(join(dir, 'journal', 'pipelines', 'pipe-nightly', 'history.json'))).toBe(
      false,
    );
  });

  it("refuses the dry run of a Seed whose records do not fit the org's data storage, in the words its run is refused with", async () => {
    // 3 000 accounts into a Developer Edition with 5 MB left. The
    // dry run said "Seed has no dry run of its own" and ended completed; the
    // run alone refused it.
    const world = new PipelineWorld(dir, [
      { alias: 'DEVED', organizationId: WORLD_TARGET_ID, sandbox: false },
    ]);
    let writes = 0;
    world.env.onCreate = () => {
      writes += 1;
    };
    const tooBig = {
      ...ACCOUNTS_TEMPLATE,
      id: 'seed-too-big',
      name: 'Too big for DEVED',
      objects: [
        {
          objectApiName: 'Account',
          recordCount: 3000,
          fieldRules: [
            { fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'PIPE account' } },
          ],
          excludedFields: [],
          insertOrder: 0,
        },
      ],
    };
    const file = world.file({
      orgs: {
        'reg-deved': {
          alias: 'DEVED',
          organizationId: WORLD_TARGET_ID,
          kind: 'developer',
          staging: false,
        },
      },
      steps: [step('s1', 'Fill DEVED', 'seed', { orgId: 'reg-deved', templateId: tooBig.id })],
      seedTemplates: { [tooBig.id]: tooBig },
    });

    const dry = await world.run(['run', '--file', file, '--dry-run', '--json']);

    expect(dry.code).toBe(1);
    const answer = JSON.parse(dry.stdout) as {
      status: string;
      steps: Array<{ status: string; error?: string; output?: Record<string, unknown> }>;
    };
    expect(answer.status).toBe('failed');
    const [seeded] = answer.steps;
    expect(seeded?.status).toBe('failed');
    expect(seeded?.output).toMatchObject({ code: 'SEED_STORAGE_EXCEEDED', dryRun: true });
    expect(seeded?.error).toMatch(
      /^Seed step "Fill DEVED" would be refused: The records to write take about 5\.\d+ MB of data storage, and DEVED has 5 MB left of 5 MB: leave objects out, lower the records per object, or free data storage in DEVED\. Nothing was written\.$/,
    );
    expect(dry.stderr).toContain('Dry run failed');
    expect(writes).toBe(0);
    expect(world.env.records('Account')).toHaveLength(0);

    // The run is refused in the same words, and writes nothing either.
    const run = await world.run(['run', '--file', file, '--json']);

    expect(run.code).toBe(1);
    const ran = JSON.parse(run.stdout) as { steps: Array<{ error?: string }> };
    expect(ran.steps[0]?.error?.replace(/^Seed step "Fill DEVED": /, '')).toBe(
      seeded?.error?.replace(/^Seed step "Fill DEVED" would be refused: /, ''),
    );
    expect(world.env.records('Account')).toHaveLength(0);
  });
});
