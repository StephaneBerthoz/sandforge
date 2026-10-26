import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvAction, EnvPlan, EnvSavedPlan, EnvState } from '@sandforge/shared';
import type { EnvTarget } from './envGuards.js';
import type { EnvDryRun } from './envPlan.js';
import { newEnvState } from './envState.js';
import {
  SAVED_PLAN_KEEP_MS,
  outRefusal,
  planDifferences,
  planDiffersRefusal,
  readSavedPlan,
  savedPlanHeldLine,
  savedPlanLine,
  savedPlanMoved,
  savedPlanOf,
  savedPlanRefusal,
  writeSavedPlan,
} from './envSavedPlan.js';
import type { EnvDryRunAnswer } from './envKinds.js';

/*
 * Saved plans, as functions of what they are given: what a plan kept holds,
 * where it may be kept, and what refuses it — each refusal with the plan it
 * refuses and the plan it lets by.
 */

const ORG_ID = '00D000000000009EAA';
const MADE = '2026-10-25T09:00:00.000Z';
const TARGET: EnvTarget = {
  alias: 'pool-1',
  organizationId: ORG_ID,
  kind: 'scratch',
  username: 'ci@example.com',
};

const accounts: EnvAction = {
  resource: 'accounts',
  kind: 'seed',
  action: 'create',
  why: 'not applied to this org yet',
  objects: [{ object: 'Account', wouldCreate: 3 }],
  gates: { apiRequests: 1, storageBytes: 6_144, emails: [] },
};

const contacts: EnvAction = {
  resource: 'contacts',
  kind: 'seed',
  action: 'create',
  why: 'not applied to this org yet',
  objects: [{ object: 'Contact', wouldCreate: 6, atMost: true }],
  draws: [{ lookup: 'Contact.AccountId', from: 'accounts', object: 'Account' }],
};

function planOf(over: Partial<EnvPlan> = {}): EnvPlan {
  return {
    env: 'case-flow',
    org: { organizationId: ORG_ID, kind: 'scratch', alias: 'pool-1' },
    state: { found: false },
    actions: [accounts, contacts],
    totals: { create: 2, keep: 0, replace: 0, delete: 0, drifted: 0, blocked: 0 },
    gates: {
      apiRequests: { estimate: 2, leftToday: 14_000, partial: false },
      storage: { bytes: 6_144, left: 5_000_000 },
      emails: [],
    },
    ...over,
  };
}

function savedOf(over: Partial<EnvSavedPlan> = {}): EnvSavedPlan {
  return {
    savedPlan: 1,
    sandforgeVersion: '1.69.0',
    madeAt: MADE,
    file: { digest: 'a'.repeat(64) },
    state: { found: false },
    line: { replace: [], replaceDrifted: false, acceptAutomation: false, acceptNoState: false },
    seeds: {},
    plan: planOf(),
    ...over,
  };
}

function stateOf(serial = 4): EnvState {
  return {
    ...newEnvState({
      env: 'case-flow',
      org: { organizationId: ORG_ID, kind: 'scratch', username: 'ci@example.com' },
      fileDigest: 'a'.repeat(64),
      sandforgeVersion: '1.69.0',
    }),
    serial,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-saved-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('what a saved plan holds', () => {
  it('holds the plan, the state it was made against by serial and lineage, the line, and the seeds of the seed dry runs alone', () => {
    const state = stateOf(7);
    const seedDry = {
      answer: { tool: 'sandforge-seed', seed: 4242 } as unknown as EnvDryRunAnswer,
    };
    const cloneDry = { answer: { tool: 'sandforge-clone' } as unknown as EnvDryRunAnswer };
    const dryRuns: Record<string, EnvDryRun> = {
      accounts: seedDry,
      cloned: cloneDry,
      contacts: { failed: 'exit 2: refused' },
    };

    const saved = savedPlanOf({
      plan: planOf({ state: { found: true, serial: 7 } }),
      state,
      digest: 'b'.repeat(64),
      line: {
        replace: ['accounts'],
        replaceDrifted: false,
        acceptAutomation: true,
        acceptNoState: false,
      },
      dryRuns,
      sandforgeVersion: '1.69.0',
      madeAt: MADE,
    });

    expect(saved.state).toEqual({ found: true, serial: 7, lineage: state.lineage });
    expect(saved.seeds).toEqual({ accounts: 4242 });
    expect(saved.file).toEqual({ digest: 'b'.repeat(64) });
    expect(saved.line.acceptAutomation).toBe(true);
  });

  it('is checked by its schema before it is written: a date that is none is refused', () => {
    expect(() =>
      savedPlanOf({
        plan: planOf(),
        state: undefined,
        digest: 'b'.repeat(64),
        line: savedOf().line,
        dryRuns: {},
        sandforgeVersion: '1.69.0',
        madeAt: 'today',
      }),
    ).toThrow();
  });

  it('is written whole, its owner’s alone, over the one it replaces, and reads back as written', async () => {
    const path = join(dir, 'case-flow.plan.json');
    writeFileSync(path, 'an older plan');

    await writeSavedPlan(path, savedOf());

    const read = readSavedPlan(path);
    expect(read).toEqual({ saved: savedOf() });
    expect(readdirSync(dir)).toEqual(['case-flow.plan.json']);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8').endsWith('}\n')).toBe(true);
  });

  it('says where it is kept, and until when apply --plan takes it', () => {
    expect(savedPlanLine('/work/p.json', savedOf())).toBe(
      'plan kept in /work/p.json, for apply --plan until 2026-10-26T09:00:00.000Z',
    );
    expect(savedPlanHeldLine('/work/p.json', savedOf())).toBe(
      'the plan kept in /work/p.json at 2026-10-25T09:00:00.000Z holds: the org, its state, the ' +
        'file and every count are as it planned them',
    );
  });
});

describe('a file read for one', () => {
  it('refuses a file not there, one that is not JSON, and one that is no saved plan, exit 2', () => {
    const path = join(dir, 'p.json');
    const missing = readSavedPlan(path);
    expect(missing).toMatchObject({ refusal: { code: 'PLAN_UNREAD', exit: 2 } });

    writeFileSync(path, 'version: 1\n');
    expect(readSavedPlan(path)).toMatchObject({
      refusal: {
        message: `--plan ${path} is not JSON: it is no plan plan --out kept. Nothing was read or written.`,
      },
    });

    writeFileSync(path, JSON.stringify({ ...savedOf(), savedPlan: 2 }));
    expect(readSavedPlan(path)).toMatchObject({
      refusal: {
        code: 'PLAN_UNREAD',
        message: expect.stringContaining('is no plan plan --out kept (savedPlan:'),
      },
    });
  });
});

describe('where a plan may be kept', () => {
  let project: string;
  beforeEach(() => {
    project = join(dir, 'project');
    mkdirSync(join(project, '.git'), { recursive: true });
    mkdirSync(join(project, 'out'));
  });

  it('outside the repository that holds the file', () => {
    expect(outRefusal(project, join(dir, 'p.json'), false)).toBeUndefined();
  });

  it('refuses inside it, exit 2, unless the line says so', () => {
    const inside = join(project, 'out', 'p.json');
    expect(outRefusal(project, inside, false)).toMatchObject({
      code: 'PLAN_IN_REPOSITORY',
      exit: 2,
      // The repository by where its links lead: on Windows, a temporary folder's long name.
      message: expect.stringMatching(
        / is inside the repository .+ that holds the file: a plan names/,
      ),
    });
    expect(outRefusal(project, inside, true)).toBeUndefined();
  });

  it('refuses a folder that is not there, or is a file, exit 2', () => {
    expect(outRefusal(project, join(dir, 'nope', 'p.json'), true)).toMatchObject({
      code: 'BAD_LINE',
      exit: 2,
    });
    writeFileSync(join(dir, 'a-file'), '');
    expect(outRefusal(project, join(dir, 'a-file', 'p.json'), true)).toMatchObject({
      code: 'BAD_LINE',
    });
  });
});

describe('a plan kept, refused before any org is reached', () => {
  const now = Date.parse(MADE);
  const context = { now, sandforgeVersion: '1.69.0' };

  it('lets by a plan of this SandForge made less than a day ago', () => {
    expect(savedPlanRefusal(savedOf(), '/p.json', context)).toBeUndefined();
    expect(
      savedPlanRefusal(savedOf(), '/p.json', { ...context, now: now + SAVED_PLAN_KEEP_MS }),
    ).toBeUndefined();
  });

  it('refuses one a day old, one another SandForge made, one made quick, and one refused when made', () => {
    expect(
      savedPlanRefusal(savedOf(), '/p.json', { ...context, now: now + SAVED_PLAN_KEEP_MS + 1 }),
    ).toEqual({
      code: 'PLAN_STALE',
      message: `The plan kept in /p.json was made at ${MADE}, more than a day ago. Nothing was written: plan again.`,
      exit: 1,
    });
    expect(
      savedPlanRefusal(savedOf({ sandforgeVersion: '1.68.0' }), '/p.json', context)?.message,
    ).toContain('was made by SandForge 1.68.0, and this one is 1.69.0');
    expect(
      savedPlanRefusal(savedOf({ plan: planOf({ quick: true }) }), '/p.json', context)?.message,
    ).toContain('was made with --quick');
    expect(
      savedPlanRefusal(
        savedOf({ plan: planOf({ refusal: 'A resource is blocked.' }) }),
        '/p.json',
        context,
      ),
    ).toEqual({
      code: 'PLAN_REFUSED',
      message:
        'The plan kept in /p.json was refused when it was made: A resource is blocked. Nothing ' +
        'was written: plan again.',
      exit: 1,
    });
  });
});

describe('a plan kept, held to what the command reached', () => {
  const digest = 'a'.repeat(64);

  it('lets by the org it was made for, by either form of its Id, from the same file, against the same state', () => {
    const state = stateOf(4);
    const saved = savedOf({ state: { found: true, serial: 4, lineage: state.lineage } });
    expect(savedPlanMoved(saved, '/p.json', { target: TARGET, digest, state })).toBeUndefined();
    expect(
      savedPlanMoved(saved, '/p.json', {
        target: { ...TARGET, organizationId: ORG_ID.slice(0, 15) },
        digest,
        state,
      }),
    ).toBeUndefined();
    expect(
      savedPlanMoved(savedOf(), '/p.json', { target: TARGET, digest, state: undefined }),
    ).toBeUndefined();
  });

  it('refuses another org, another file, and another state: one made since, one moved on, one made again', () => {
    const state = stateOf(4);
    const saved = savedOf({ state: { found: true, serial: 4, lineage: state.lineage } });

    expect(
      savedPlanMoved(saved, '/p.json', {
        target: { ...TARGET, alias: 'pool-2', organizationId: '00D000000000008EAA' },
        digest,
        state,
      }),
    ).toMatchObject({
      code: 'PLAN_OTHER_ORG',
      message: `The plan kept in /p.json was made for pool-1 (${ORG_ID}), and pool-2 is 00D000000000008EAA: a plan is applied to the org it was made for. Nothing was written.`,
    });
    expect(
      savedPlanMoved(saved, '/p.json', { target: TARGET, digest: 'c'.repeat(64), state })?.message,
    ).toContain('was made from another file');
    expect(
      savedPlanMoved(savedOf(), '/p.json', { target: TARGET, digest, state })?.message,
    ).toContain('was made against no state, and the state is now at serial 4');
    expect(
      savedPlanMoved(saved, '/p.json', { target: TARGET, digest, state: undefined })?.message,
    ).toContain('was made against the state at serial 4, and the state is now none');
    expect(
      savedPlanMoved(saved, '/p.json', { target: TARGET, digest, state: stateOf(5) })?.message,
    ).toContain('the state at serial 4, and the state is now at serial 5, made again since');
    expect(
      savedPlanMoved(saved, '/p.json', {
        target: TARGET,
        digest,
        state: { ...state, serial: 6 },
      })?.message,
    ).toContain(
      'the state at serial 4, and the state is now at serial 6: an apply or a destroy ran since',
    );
  });
});

describe('a plan kept against the plan made again', () => {
  it('holds when the actions and every count are the same, whatever the words and what the org has left', () => {
    const again = planOf({
      actions: [{ ...accounts, why: 'said otherwise' }, contacts],
      gates: {
        apiRequests: { estimate: 2, leftToday: 13_000, partial: false },
        storage: { bytes: 6_144, left: 4_000_000 },
        emails: [],
      },
      warnings: ['an apply of case-flow is under way'],
    });

    expect(planDifferences(planOf(), again)).toEqual([]);
  });

  it('names each resource whose action, counts or parents moved, what it was planned to, and what it comes to now', () => {
    const again = planOf({
      actions: [
        { ...accounts, action: 'blocked', refusal: 'storage' },
        {
          ...contacts,
          objects: [{ object: 'Contact', wouldCreate: 6 }],
          draws: [{ lookup: 'Contact.AccountId', from: 'accounts', object: 'Account', parents: 3 }],
        },
        { resource: 'assets', kind: 'seed', action: 'create', why: 'new', objects: [] },
      ],
    });

    expect(planDifferences(planOf(), again)).toEqual([
      'accounts: planned create (Account 3 to write), now blocked (Account 3 to write)',
      'contacts: planned create (Contact at most 6 to write; Contact.AccountId under the Account ' +
        'records accounts creates first), now create (Contact 6 to write; Contact.AccountId under 3 ' +
        'Account record(s) of accounts)',
      'assets: planned nothing of it, now create',
    ]);
  });

  it('names a count of what the org holds that moved, the action the same', () => {
    const kept = planOf({
      actions: [{ ...accounts, action: 'keep', objects: [{ object: 'Account', present: 3 }] }],
    });
    const again = planOf({
      actions: [
        { ...accounts, action: 'keep', objects: [{ object: 'Account', present: 3, changed: 1 }] },
      ],
    });

    expect(planDifferences(kept, again)).toEqual([
      'accounts: planned keep (Account 3 in the org), now keep (Account 3 in the org, 1 changed)',
    ]);
  });

  it('names an order that moved, the checkpoints it takes, and the whole org against the checkpoint after the last apply', () => {
    const again = planOf({
      actions: [contacts, accounts],
      checkpoints: [{ step: 'after', name: 'baseline' }],
      drift: {
        checkpoint: 'ck-20261025-090000-a1b2',
        differs: true,
        toDelete: 1,
        toGiveBack: 0,
        toBringBack: 0,
      },
    });
    const kept = planOf({ drift: { checkpoint: 'ck-20261025-090000-a1b2', differs: false } });

    expect(planDifferences(kept, again)).toEqual([
      'the order of the resources: planned accounts, contacts, now contacts, accounts',
      "the checkpoints it takes: planned none, now once applied 'baseline'",
      'the whole org against the checkpoint after the last apply: planned nothing differs, now differs, 1 to delete · 0 to give back · 0 to bring back',
    ]);
  });

  it('refuses the plan kept with the differences, exit 1', () => {
    expect(planDiffersRefusal('/p.json', ['a', 'b'])).toEqual({
      code: 'PLAN_STALE',
      message:
        'The plan kept in /p.json is not what the org holds now, read again: a; b. Nothing was ' +
        'written: plan again.',
      exit: 1,
    });
  });
});
