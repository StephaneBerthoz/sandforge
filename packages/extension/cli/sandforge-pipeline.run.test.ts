import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { PipelineOrchestrator } from '../src/modules/automation/PipelineOrchestrator.js';

/*
 * A pipeline file run whole: the Automation page's handler in the command
 * line's host, writing to the memory org, then the lines it printed to take
 * itself back run by the seed command's own removal, on the same journal.
 */

let dir: string;
let journalBefore: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-pipeline-run-'));
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  process.env['SANDFORGE_JOURNAL_DIR'] = join(dir, 'journal');
});
afterEach(() => {
  if (journalBefore === undefined) delete process.env['SANDFORGE_JOURNAL_DIR'];
  else process.env['SANDFORGE_JOURNAL_DIR'] = journalBefore;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const UAT = { alias: 'UAT', organizationId: WORLD_TARGET_ID };
const SOURCE = { alias: 'SRC', organizationId: '00D000000000008SRC' };

/** The file's orgs, under the keys the editor's registry gave them. */
const ORGS = {
  'reg-uat': {
    alias: 'UAT',
    organizationId: WORLD_TARGET_ID,
    kind: 'sandbox' as const,
    staging: false,
  },
  'reg-src': {
    alias: 'SRC',
    organizationId: '00D000000000008SRC',
    kind: 'sandbox' as const,
    staging: false,
  },
};

describe('sandforge pipeline run', () => {
  it('runs Delay, Compare, a Condition on its differences and Seed, and its printed removal takes the seed back', async () => {
    const world = new PipelineWorld(dir, [UAT, SOURCE]);
    vi.spyOn(CompareHandler.prototype, 'compareOrgs').mockResolvedValue({
      summary: { added: 2, removed: 0, modified: 1, unchanged: 5, total: 8 },
      items: [],
    } as never);
    const file = world.file({
      orgs: ORGS,
      steps: [
        step('s1', 'Wait', 'delay', { seconds: 0 }),
        step('s2', 'Diff', 'compare', {
          sourceOrgId: 'reg-src',
          targetOrgId: 'reg-uat',
          types: ['ApexClass'],
        }),
        {
          ...step('s3', 'Differs?', 'condition'),
          condition: { field: 'compareDifferenceCount', operator: 'gt', value: 0 },
        },
        step('s4', 'Fill', 'seed', { orgId: 'reg-uat', templateId: ACCOUNTS_TEMPLATE.id }),
      ],
      seedTemplates: { [ACCOUNTS_TEMPLATE.id]: ACCOUNTS_TEMPLATE },
    });

    const run = await world.run(['run', '--file', file, '--json']);

    expect(run.stderr).not.toContain('Refused');
    expect(run.code).toBe(0);
    const answer = JSON.parse(run.stdout) as {
      status: string;
      steps: Array<{ name: string; status: string; takeBack?: string }>;
    };
    expect(answer.status).toBe('completed');
    expect(world.env.records('Account')).toHaveLength(2);
    const takeBack = answer.steps.find((each) => each.name === 'Fill')?.takeBack;
    expect(takeBack).toMatch(/sandforge-seed\.ts --remove [0-9a-f-]+ --target UAT$/);

    // The line as printed, run by the seed command itself.
    const words = (takeBack ?? '').split(' ');
    const removal = await world.env.runner(
      'sandforge-seed',
      words.slice(words.indexOf('--remove')),
      new AbortController().signal,
    );
    expect(removal.stderr).toBe('');
    expect(removal.code).toBe(0);
    expect(world.env.records('Account')).toHaveLength(0);

    // Kept where the editor's History tab lists the command line's runs.
    const history = join(dir, 'journal', 'pipelines', 'pipe-nightly', 'history.json');
    expect(existsSync(history)).toBe(true);
    expect(readFileSync(history, 'utf8')).toContain('"status": "completed"');
  });
  it('stops on Ctrl-C: the step under way is stopped, the run ends cancelled, and it exits 130', async () => {
    const world = new PipelineWorld(dir, [UAT, SOURCE]);
    const file = world.file({
      orgs: ORGS,
      steps: [
        step('s1', 'An hour', 'delay', { seconds: 3600 }),
        step('s2', 'Fill', 'seed', { orgId: 'reg-uat', templateId: ACCOUNTS_TEMPLATE.id }),
      ],
      seedTemplates: { [ACCOUNTS_TEMPLATE.id]: ACCOUNTS_TEMPLATE },
    });
    // Once the run has started, its Delay waiting.
    const execute = PipelineOrchestrator.prototype.execute;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(PipelineOrchestrator.prototype, 'execute').mockImplementation(function (
      this: PipelineOrchestrator,
      ...args: Parameters<PipelineOrchestrator['execute']>
    ) {
      setTimeout(started, 200);
      return execute.apply(this, args);
    });
    const stopping = running.then(() => process.emit('SIGINT', 'SIGINT'));

    const run = await world.run(['run', '--file', file, '--json']);
    await stopping;

    expect(run.code).toBe(130);
    const answer = JSON.parse(run.stdout) as {
      status: string;
      steps: Array<{ name: string; status: string }>;
    };
    expect(answer.status).toBe('cancelled');
    expect(answer.steps[0]).toMatchObject({ name: 'An hour', status: 'stopped' });
    expect(world.env.records('Account')).toHaveLength(0);
  });
});
