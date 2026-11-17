import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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

import { main as backupMain } from './sandforge-backup.js';
import { takeBacksOf } from './sandforge-pipeline.js';
import { runInProcess } from './testing/envWorld.js';
import {
  ACCOUNTS_TEMPLATE,
  PipelineWorld,
  WORLD_TARGET_ID,
  step,
} from './testing/pipelineWorld.js';

/*
 * What a pipeline run prints to take itself back, run as it was printed by
 * the commands it names, in the same world: the masking of an Anonymize step
 * given back from the snapshot the run took, and that snapshot listed and
 * deleted by the backup command, under the alias the run reached its org by.
 */

let dir: string;
let journalBefore: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-pipeline-takeback-'));
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  process.env['SANDFORGE_JOURNAL_DIR'] = join(dir, 'journal');
});
afterEach(() => {
  if (journalBefore === undefined) delete process.env['SANDFORGE_JOURNAL_DIR'];
  else process.env['SANDFORGE_JOURNAL_DIR'] = journalBefore;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const ORGS = {
  'reg-uat': {
    alias: 'UAT',
    organizationId: WORLD_TARGET_ID,
    kind: 'sandbox' as const,
    staging: false,
  },
};

/** A masking template as the editor saves one: the email made up again, the phone masked. */
const CONTACT_POINTS = {
  id: 'mask-contact-points',
  name: 'Contact points',
  description: '',
  complianceFramework: 'custom',
  rules: [
    { fieldPattern: 'Contact.Email', ruleType: 'fake', description: '' },
    {
      fieldPattern: 'Contact.Phone',
      ruleType: 'mask',
      config: { maskKeepLast: 2 },
      description: '',
    },
  ],
  saved: true,
  createdAt: '2026-11-01T00:00:00.000Z',
};

interface RunAnswer {
  status: string;
  steps: Array<{ name: string; status: string; takeBack?: string }>;
}

/** The words of a printed line after the command: what its script is given. */
function argsOf(line: string, from: string): string[] {
  const words = line.split(' ');
  return words.slice(words.indexOf(from));
}

describe('sandforge pipeline run, the take-back of an Anonymize step', () => {
  it('gives the masked values back by the line it prints, and the snapshot is listed and deleted under the alias', async () => {
    const world = new PipelineWorld(dir, [{ alias: 'UAT', organizationId: WORLD_TARGET_ID }]);
    const ids = world.env.copyIn('Contact', [
      { LastName: 'Copied', Email: 'ada@example.com', Phone: '+33 1 00 00 00 01' },
      { LastName: 'Copied', Email: 'grace@example.com', Phone: '+33 1 00 00 00 02' },
    ]);
    const before = world.env.records('Contact').map((row) => ({ ...row }));
    const file = world.file({
      orgs: ORGS,
      steps: [
        step('s1', 'Mask', 'anonymize', {
          orgId: 'reg-uat',
          templateId: CONTACT_POINTS.id,
          object: 'Contact',
        }),
      ],
      maskingTemplates: { [CONTACT_POINTS.id]: CONTACT_POINTS },
    });

    const run = await world.run(['run', '--file', file, '--json']);

    expect(run.code).toBe(0);
    const answer = JSON.parse(run.stdout) as RunAnswer;
    expect(answer.status).toBe('completed');
    const masked = world.env.records('Contact');
    expect(masked.map((row) => row['Email'])).not.toContain('ada@example.com');
    const takeBack = answer.steps[0]?.takeBack ?? '';
    expect(takeBack).toMatch(/sandforge-dataops\.ts anonymize --org UAT --restore \S+$/);
    const snapshot = takeBack.split(' ').at(-1) ?? '';

    // The line as printed, answered yes as a person at a terminal would.
    const restore = await world.env.runner(
      'sandforge-dataops',
      [...argsOf(takeBack, 'anonymize'), '--yes'],
      new AbortController().signal,
    );

    expect(restore.stderr).not.toContain('cannot be restored');
    expect(restore.code).toBe(0);
    const back = world.env.records('Contact');
    for (const id of ids) {
      const was = before.find((row) => row['Id'] === id);
      const is = back.find((row) => row['Id'] === id);
      expect({ Email: is?.['Email'], Phone: is?.['Phone'] }).toEqual({
        Email: was?.['Email'],
        Phone: was?.['Phone'],
      });
    }

    // Listed under the alias the run printed, and deleted by the product.
    const listed = await runInProcess(() =>
      backupMain(['node', 'sandforge-backup.ts', '--list', '--org', 'UAT']),
    );
    expect(listed.stdout).toContain(snapshot);
    expect(listed.stdout).not.toContain('No snapshot of UAT');
    // The line the run printed to delete it, as printed.
    const deleteLine =
      run.stderr.split('\n').find((line) => line.includes('sandforge-backup.ts --delete')) ?? '';
    expect(deleteLine).toContain(`sandforge-backup.ts --delete ${snapshot} --org UAT deletes it.`);
    const deleteWords = deleteLine.replace(/ deletes it\.$/, '').split(' ');
    const deleted = await runInProcess(() =>
      backupMain([
        'node',
        'sandforge-backup.ts',
        ...deleteWords.slice(deleteWords.indexOf('--delete')),
      ]),
    );
    expect(deleted.code).toBe(0);
    expect(deleted.stdout).toContain(`deleted ${snapshot}`);
    const after = await runInProcess(() =>
      backupMain(['node', 'sandforge-backup.ts', '--list', '--org', 'UAT']),
    );
    expect(after.stdout).toContain('No snapshot of UAT');
  });
});

describe('sandforge pipeline run, the take-back of a Seed a later Rewind deleted', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("brings the org back as it was before the run when its lines are run in the order printed, the undo's records taken by the seed's removal", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-20T02:00:00.000Z'));
    const world = new PipelineWorld(dir, [{ alias: 'UAT', organizationId: WORLD_TARGET_ID }]);
    const file = world.file({
      orgs: ORGS,
      steps: [step('s1', 'Fill', 'seed', { orgId: 'reg-uat', templateId: ACCOUNTS_TEMPLATE.id })],
      seedTemplates: { [ACCOUNTS_TEMPLATE.id]: ACCOUNTS_TEMPLATE },
    });
    const run = await world.run(['run', '--file', file, '--json']);
    expect(run.code).toBe(0);
    const [seeded] = (
      JSON.parse(run.stdout) as {
        steps: Array<{ type: string; status: string; output?: Record<string, unknown> }>;
      }
    ).steps;
    const ids = world.env.records('Account').map((row) => String(row['Id']));
    expect(ids).toHaveLength(2);

    // What the Rewind step after it does to the seed's records, a minute
    // on, and what the undo its line names does to them: deleted, then
    // brought back from the recycle bin, which dates them anew.
    vi.setSystemTime(Date.now() + 60_000);
    await world.env.org.destroy('Account', ids);
    vi.setSystemTime(Date.now() + 60_000);
    await world.env.org.undelete(ids);
    expect(world.env.records('Account')).toHaveLength(2);
    const lines = takeBacksOf(
      [
        { stepType: 'seed', status: 'completed', output: seeded?.output ?? {} },
        {
          stepType: 'rewind',
          status: 'completed',
          output: {
            orgId: seeded?.output?.['orgId'],
            checkpointId: 'ck-20261120-015900-abcd',
            deleted: 2,
            undoUntil: '2026-11-27T02:01:00.000Z',
          },
        },
      ],
      (orgId) => (orgId === WORLD_TARGET_ID ? 'UAT' : undefined),
      join(dir, 'store'),
      () => undefined,
    );
    const seedLine = lines[0] ?? '';
    const removal = (line: string) => {
      const words = line.split(' ');
      return world.env.runner(
        'sandforge-seed',
        words.slice(words.indexOf('--remove')),
        new AbortController().signal,
      );
    };

    // The line as it was printed before: both accounts kept, changed since.
    const kept = await removal(seedLine.replace(' --include-changed', ''));
    expect(kept.code).not.toBe(0);
    expect(world.env.records('Account')).toHaveLength(2);

    // The line as it is printed now.
    expect(seedLine).toMatch(/--target UAT --include-changed$/);
    const taken = await removal(seedLine);
    expect(taken.code).toBe(0);
    expect(world.env.records('Account')).toHaveLength(0);
  });
});

describe('sandforge pipeline run, the take-back of a Seed then an Anonymize of what it wrote', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives the masked values back, then removes the seed, each line run as printed, in its order', async () => {
    // Run for real: the restore given back, the seed's removal still kept the
    // contacts the masking had written over, "changed since the run".
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-20T02:00:00.000Z'));
    const world = new PipelineWorld(dir, [{ alias: 'UAT', organizationId: WORLD_TARGET_ID }]);
    // Each write over a record a few seconds on, as an org dates them.
    world.env.onUpdate = () => vi.setSystemTime(Date.now() + 5_000);
    const names = {
      id: 'mask-account-names',
      name: 'Account names',
      description: '',
      complianceFramework: 'custom',
      rules: [
        {
          fieldPattern: 'Account.Name',
          ruleType: 'mask',
          config: { maskKeepLast: 2 },
          description: '',
        },
      ],
      saved: true,
      createdAt: '2026-11-01T00:00:00.000Z',
    };
    const file = world.file({
      orgs: ORGS,
      steps: [
        step('s1', 'Fill', 'seed', { orgId: 'reg-uat', templateId: ACCOUNTS_TEMPLATE.id }),
        step('s2', 'Mask', 'anonymize', {
          orgId: 'reg-uat',
          templateId: names.id,
          object: 'Account',
        }),
      ],
      seedTemplates: { [ACCOUNTS_TEMPLATE.id]: ACCOUNTS_TEMPLATE },
      maskingTemplates: { [names.id]: names },
    });

    const run = await world.run(['run', '--file', file, '--json']);

    expect(run.code).toBe(0);
    expect(world.env.records('Account').map((row) => row['Name'])).not.toContain('PIPE account');
    const block = run.stderr.split('\n');
    const from = block.indexOf('To take this run back, in this order:');
    const [restoreLine, seedLine] = block.slice(from + 1, from + 3).map((line) => line.trim());
    expect(restoreLine).toMatch(/sandforge-dataops\.ts anonymize --org UAT --restore \S+$/);
    expect(seedLine).toMatch(/sandforge-seed\.ts --remove \S+ --target UAT --include-changed$/);

    const restore = await world.env.runner(
      'sandforge-dataops',
      [...argsOf(restoreLine ?? '', 'anonymize'), '--yes'],
      new AbortController().signal,
    );
    expect(restore.code).toBe(0);
    expect(world.env.records('Account').map((row) => row['Name'])).toEqual([
      'PIPE account',
      'PIPE account',
    ]);
    // Without the flag, as the line was printed before: both kept.
    const kept = await world.env.runner(
      'sandforge-seed',
      argsOf((seedLine ?? '').replace(' --include-changed', ''), '--remove'),
      new AbortController().signal,
    );
    expect(kept.code).not.toBe(0);
    expect(world.env.records('Account')).toHaveLength(2);
    const removal = await world.env.runner(
      'sandforge-seed',
      argsOf(seedLine ?? '', '--remove'),
      new AbortController().signal,
    );
    expect(removal.code).toBe(0);
    expect(world.env.records('Account')).toHaveLength(0);
  });
});
