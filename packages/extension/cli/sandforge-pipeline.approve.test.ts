import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

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
import type { PlanRefusal } from './sandforge-pipeline.js';

/*
 * An Approval step from the command line: asked at the terminal when there
 * is one, answered ahead by --approve when there is none, and never ahead
 * when it stands before a write to a sandbox marked Staging. Where it was
 * answered goes to the history and the audit.
 */

let dir: string;
let journalBefore: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-pipeline-approve-'));
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  process.env['SANDFORGE_JOURNAL_DIR'] = join(dir, 'journal');
});
afterEach(() => {
  if (journalBefore === undefined) delete process.env['SANDFORGE_JOURNAL_DIR'];
  else process.env['SANDFORGE_JOURNAL_DIR'] = journalBefore;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A pipeline whose Approval step "Gate" stands before a Seed into UAT. */
function gated(world: PipelineWorld, staging = false): string {
  return world.file({
    orgs: {
      'reg-uat': { alias: 'UAT', organizationId: WORLD_TARGET_ID, kind: 'sandbox', staging },
    },
    steps: [
      step('s1', 'Gate', 'approval', { timeoutMinutes: 5 }),
      step('s2', 'Fill', 'seed', { orgId: 'reg-uat', templateId: ACCOUNTS_TEMPLATE.id }),
    ],
    seedTemplates: { [ACCOUNTS_TEMPLATE.id]: ACCOUNTS_TEMPLATE },
  });
}

const UAT = { alias: 'UAT', organizationId: WORLD_TARGET_ID };

/** The JSON of a run. */
function answerOf(stdout: string): {
  status: string;
  refusals?: PlanRefusal[];
  approvals: Array<{ step: string; decision: string; via: string }>;
} {
  return JSON.parse(stdout) as never;
}

describe('an Approval step run from the command line', () => {
  it('is refused before the first step with no terminal and no --approve, naming the step and the flag', async () => {
    const world = new PipelineWorld(dir, [UAT]);

    const run = await world.run(['run', '--file', gated(world), '--json']);

    expect(run.code).toBe(2);
    expect(answerOf(run.stdout).refusals).toEqual([
      expect.objectContaining({
        code: 'APPROVAL_NO_TERMINAL',
        step: 'Gate',
        wayOut: 'run it in a terminal, or add --approve "Gate".',
      }),
    ]);
    expect(world.env.records('Account')).toHaveLength(0);
  });

  it('is answered ahead by --approve, and the history and the audit say it was', async () => {
    const world = new PipelineWorld(dir, [UAT]);

    const run = await world.run(['run', '--file', gated(world), '--approve', 'Gate', '--json']);

    expect(run.code).toBe(0);
    expect(answerOf(run.stdout).approvals).toEqual([
      expect.objectContaining({ step: 'Gate', decision: 'approved', via: 'commandLine' }),
    ]);
    expect(world.env.records('Account')).toHaveLength(2);
    const history = readFileSync(
      join(dir, 'journal', 'pipelines', 'pipe-nightly', 'history.json'),
      'utf8',
    );
    expect(history).toContain('"via": "commandLine"');
    const store = JSON.parse(
      readFileSync(
        join(dir, 'journal', 'pipelines', 'pipe-nightly', 'store', 'configStore.json'),
        'utf8',
      ),
    ) as Record<string, { value: string }>;
    const audited = Object.values(store)
      .map((entry) => JSON.parse(entry.value) as unknown)
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter(
        (value): value is { action: string; details: { via?: string } } =>
          typeof value === 'object' && value !== null && 'action' in value,
      )
      .filter((value) => value.action === 'pipeline_approval');
    expect(audited).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({ via: 'commandLine', step: 'Gate' }),
      }),
    ]);
  });

  it('is asked at the terminal when there is one, and the answer typed there is kept as the terminal’s', async () => {
    const world = new PipelineWorld(dir, [UAT]);
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    input.write('y\n');

    const run = await world.run(['run', '--file', gated(world), '--json'], {
      isTTY: true,
      terminal: { input, output },
    });

    expect(run.code).toBe(0);
    expect(String(output.read())).toContain('Approval step "Gate" of pipeline "Nightly reset"');
    expect(answerOf(run.stdout).approvals).toEqual([
      expect.objectContaining({ step: 'Gate', decision: 'approved', via: 'terminal' }),
    ]);
  });

  it('is never answered ahead before a write to a sandbox marked Staging, nor left without a terminal', async () => {
    const world = new PipelineWorld(dir, [UAT]);
    const file = gated(world, true);

    const ahead = await world.run(['run', '--file', file, '--approve', 'Gate', '--json']);
    expect(ahead.code).toBe(2);
    expect(answerOf(ahead.stdout).refusals).toEqual([
      expect.objectContaining({
        code: 'STAGING_NEEDS_PERSON',
        step: 'Gate',
        message: expect.stringContaining('never --approve'),
      }),
    ]);

    const alone = await world.run(['run', '--file', file, '--json']);
    expect(alone.code).toBe(2);
    expect(answerOf(alone.stdout).refusals).toEqual([
      expect.objectContaining({ code: 'STAGING_NEEDS_PERSON', step: 'Gate' }),
    ]);
    expect(world.env.records('Account')).toHaveLength(0);
  });

  it('refuses an --approve that names no Approval step of the pipeline', async () => {
    const world = new PipelineWorld(dir, [UAT]);

    const run = await world.run(['plan', '--file', gated(world), '--approve', 'Gat', '--json']);

    expect(run.code).toBe(2);
    expect((JSON.parse(run.stdout) as { refusals: PlanRefusal[] }).refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'APPROVE_UNKNOWN_STEP', wayOut: 'name one of "Gate".' }),
      ]),
    );
  });
});
