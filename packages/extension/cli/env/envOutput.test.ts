import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvResourceState, EnvState } from '@sandforge/shared';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  OUTPUT_DESTROYED_WHY,
  OUTPUT_MASK_DESTROYED_WHY,
  OUTPUT_MASK_WHY,
  outputLines,
  outputOf,
  outputStateOf,
} from './envOutput.js';
import { newEnvState, openEnvStore, type EnvStateListing, type EnvStore } from './envState.js';

/*
 * What `output` reads back of an apply, from a state and its runs' files on
 * this machine alone: the records each resource's last run created, by
 * object, or why it names none; and which state of the environment the
 * line's org names.
 */

const ORG_ID = '00D000000000009EAA';
const OTHER_ORG = '00D000000000008EAA';
const ENV = 'case-flow';
const AT = '2026-10-25T09:00:00.000Z';
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

let dir: string;
let journalDir: string;
let store: EnvStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-output-'));
  mkdirSync(join(dir, 'project', '.git'), { recursive: true });
  journalDir = join(dir, 'journal');
  const opened = openEnvStore({ journalDir, fileFolder: join(dir, 'project') });
  if (!('store' in opened)) throw new Error(opened.refusal);
  store = opened.store;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A seed's summary, as its run printed it, of the ids given. */
function seedSummary(object: string, ids: string[]): string {
  return JSON.stringify({
    tool: 'sandforge-seed',
    target: 'pool-1',
    seed: 1,
    startedAt: AT,
    finishedAt: AT,
    emails: { checks: [] },
    elapsedMs: 1,
    dryRun: false,
    result: {
      operationId: 'op',
      status: 'success',
      objectResults: [
        {
          objectApiName: object,
          recordsCreated: ids.length,
          recordsFailed: 0,
          createdIds: ids,
          errors: [],
        },
      ],
      totalRecordsCreated: ids.length,
      totalRecordsFailed: 0,
    },
  });
}

type Kept = Pick<EnvResourceState, 'kind' | 'status'> &
  Partial<Pick<EnvResourceState, 'dependsOn'>> & { runs: EnvResourceState['runs'] };

/** A state of the resources given, applied to the org under `alias`. */
function stateOf(resources: Record<string, Kept>, alias = 'pool-1', org = ORG_ID): EnvState {
  const state = newEnvState({
    env: ENV,
    org: { organizationId: org, kind: 'scratch', username: 'ci@example.com', alias },
    fileDigest: 'a'.repeat(64),
    sandforgeVersion: '1.69.0',
  });
  return {
    ...state,
    serial: 4,
    resources: Object.fromEntries(
      Object.entries(resources).map(([name, kept]) => [
        name,
        { fingerprint: 'b'.repeat(64), dependsOn: [], ...kept },
      ]),
    ),
  };
}

/** A seed's run, its summary beside the state. */
const seedRun = (resource: string, n = 1): EnvResourceState['runs'][number] => ({
  n,
  script: 'sandforge-seed',
  summary: `runs/${resource}/${n}.summary.json`,
  startedAt: AT,
  objects: [],
});

const deps = () => ({ store, journalDir });

describe('what an apply created, read back', () => {
  it('names each resource applied whole by the records its last run created, in the order apply runs them', async () => {
    await store.writeFile(
      ORG_ID,
      ENV,
      'runs/accounts/2.summary.json',
      seedSummary('Account', [id('001', 2), id('001', 3)]),
    );
    await store.writeFile(
      ORG_ID,
      ENV,
      'runs/contacts/1.summary.json',
      seedSummary('Contact', [id('003', 4)]),
    );
    // Listed after what depends on it: the output names it first.
    const state = stateOf({
      contacts: {
        kind: 'seed',
        status: 'applied',
        dependsOn: ['accounts'],
        runs: [seedRun('contacts')],
      },
      accounts: {
        kind: 'seed',
        status: 'applied',
        runs: [{ ...seedRun('accounts', 1), takenBack: true }, seedRun('accounts', 2)],
      },
    });

    const { output, whole } = await outputOf(state, deps());

    expect(whole).toBe(true);
    expect(Object.keys(output.resources)).toEqual(['accounts', 'contacts']);
    expect(output.resources['accounts']).toEqual({
      kind: 'seed',
      status: 'applied',
      run: 2,
      records: { Account: [id('001', 2), id('001', 3)] },
    });
    expect(output).toMatchObject({
      env: ENV,
      org: { organizationId: ORG_ID, kind: 'scratch', alias: 'pool-1' },
      state: { serial: 4, updatedAt: state.updatedAt },
    });
  });

  it('names no record of a resource taken back, nor of a mask resource, each saying why, and is whole', async () => {
    const state = stateOf({
      gone: { kind: 'seed', status: 'destroyed', runs: [{ ...seedRun('gone'), takenBack: true }] },
      customers: {
        kind: 'mask',
        status: 'applied',
        runs: [
          {
            n: 1,
            script: 'sandforge-dataops',
            snapshotId: 'cli-dataops-anonymize-1-x-snapshot',
            startedAt: AT,
            objects: [{ objectApiName: 'Contact', created: 0, refused: 0, masked: 3 }],
          },
        ],
      },
      masked: { kind: 'mask', status: 'destroyed', runs: [] },
    });

    const { output, whole } = await outputOf(state, deps());

    expect(whole).toBe(true);
    expect(output.resources['gone']).toEqual({
      kind: 'seed',
      status: 'destroyed',
      run: 1,
      records: {},
      why: OUTPUT_DESTROYED_WHY,
    });
    expect(output.resources['customers']).toEqual({
      kind: 'mask',
      status: 'applied',
      run: 1,
      records: {},
      masked: { Contact: 3 },
      snapshotId: 'cli-dataops-anonymize-1-x-snapshot',
      why: OUTPUT_MASK_WHY,
    });
    expect(output.resources['masked']).toEqual({
      kind: 'mask',
      status: 'destroyed',
      records: {},
      why: OUTPUT_MASK_DESTROYED_WHY,
    });
  });

  it('names no record of a resource not applied whole, nor of one whose run keeps none, and is partial', async () => {
    const state = stateOf({
      stopped: { kind: 'seed', status: 'applying', runs: [seedRun('stopped')] },
      refused: { kind: 'seed', status: 'partial', runs: [seedRun('refused')] },
      lost: { kind: 'seed', status: 'applied', runs: [seedRun('lost')] },
    });

    const { output, whole } = await outputOf(state, deps());

    expect(whole).toBe(false);
    expect(output.resources['stopped']?.why).toBe(
      'its last run was stopped part way: it names no record until it is applied whole — apply again',
    );
    expect(output.resources['refused']).toMatchObject({
      records: {},
      why: expect.stringMatching(/^its last run was partial/),
    });
    expect(output.resources['lost']).toEqual({
      kind: 'seed',
      status: 'applied',
      run: 1,
      records: {},
      why: 'its run keeps no record of what it created',
    });
  });

  it('says it on a terminal: each resource, its records by object, what a masking masked, and why it names none', async () => {
    await store.writeFile(
      ORG_ID,
      ENV,
      'runs/accounts/1.summary.json',
      seedSummary('Account', [id('001', 1), id('001', 2)]),
    );
    const state = stateOf({
      accounts: { kind: 'seed', status: 'applied', runs: [seedRun('accounts')] },
      customers: {
        kind: 'mask',
        status: 'applied',
        runs: [
          {
            n: 1,
            script: 'sandforge-dataops',
            snapshotId: 'snap-1',
            startedAt: AT,
            objects: [{ objectApiName: 'Contact', created: 0, refused: 0, masked: 3 }],
          },
        ],
      },
    });

    const { output } = await outputOf(state, deps());

    expect(outputLines(output)).toEqual([
      `case-flow on pool-1 (scratch, ${ORG_ID}): state serial 4, written ${state.updatedAt}`,
      '  accounts  seed, applied, run 1',
      `    Account  ${id('001', 1)} ${id('001', 2)}`,
      '  customers  mask, applied, run 1',
      '    Contact  3 masked',
      '    snapshot snap-1, taken first',
      `    ${OUTPUT_MASK_WHY}`,
    ]);
  });
});

describe('the state the line names', () => {
  const listing = (state: EnvState): EnvStateListing => ({
    organizationId: state.org.organizationId,
    env: state.env,
    folder: '/x',
    state,
  });

  it('is found by the alias it was applied by, or by its Organization Id in either form', () => {
    const state = stateOf({});
    const listings = [listing(state), listing({ ...stateOf({}), env: 'other' })];

    expect(outputStateOf(listings, ENV, 'pool-1')).toEqual({ state });
    expect(outputStateOf(listings, ENV, ORG_ID)).toEqual({ state });
    expect(outputStateOf(listings, ENV, ORG_ID.slice(0, 15))).toEqual({ state });
  });

  it('refuses none, two under one alias, naming both, and one that does not read, exit 1', () => {
    const one = stateOf({});
    const two = stateOf({}, 'pool-1', OTHER_ORG);

    expect(outputStateOf([listing(one)], ENV, 'pool-2')).toMatchObject({
      refusal: { code: 'NO_STATE', exit: 1 },
    });
    const both = outputStateOf([listing(one), listing(two)], ENV, 'pool-1');
    expect(both).toMatchObject({ refusal: { code: 'TWO_STATES', exit: 1 } });
    expect('refusal' in both && both.refusal.message).toContain(`${ORG_ID}, written`);
    expect('refusal' in both && both.refusal.message).toContain(`${OTHER_ORG}, written`);
    expect(outputStateOf([listing(one), listing(two)], ENV, OTHER_ORG)).toEqual({ state: two });
    expect(
      outputStateOf(
        [{ organizationId: ORG_ID, env: ENV, folder: '/x', damaged: 'It does not parse.' }],
        ENV,
        ORG_ID,
      ),
    ).toEqual({
      refusal: { code: 'STATE_DAMAGED', message: 'It does not parse. Nothing was read.', exit: 1 },
    });
  });
});
