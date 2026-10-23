import { existsSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getJsforceConnection } from '../core/connection/ConnectionHelper.js';
import {
  COLLEAGUE,
  LONG_AGO,
  ORG_ID,
  PICKED,
  REWOUND,
  RewindTestOrg,
  SINCE,
  T0,
  account,
  automationOf,
  changedSince,
  clock,
  contact,
  liveIds,
  previewed,
  removeTaken,
  resultOf,
  rewound,
  spent,
  stateOf,
  stoppedAfter,
  taken,
  undone,
} from './rewindTestOrg.js';

vi.mock('../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  clock.now = T0;
});

afterEach(() => {
  removeTaken();
  vi.mocked(getJsforceConnection).mockReset();
});

describe('RewindTestOrg', () => {
  it('lists the objects it was given fields of, answers the day’s limits, and dates by the clock, a second a read while ticking', async () => {
    const org = new RewindTestOrg();
    expect(clock.now).toBe(LONG_AGO);

    const global = (await org.describeGlobal()) as { sobjects: Array<{ name: string }> };
    const limits = await org.request({ method: 'GET', url: '/services/data/v66.0/limits' });
    clock.now = T0;
    const still = await org.serverTime();
    org.ticking = true;
    const later = await org.serverTime();

    expect(global.sobjects.map(({ name }) => name)).toEqual([...PICKED, 'Order']);
    expect(limits).toEqual({ DailyApiRequests: { Max: 15_000, Remaining: 14_000 } });
    expect(Date.parse(later) - Date.parse(still)).toBe(1_000);
    expect(spent(org)).toBe(2 + 2);
  });

  it('makes a person account’s name of its person’s as an update gives it a name', async () => {
    const org = new RewindTestOrg();
    org.addPersonAccount({ Id: account(9), FirstName: 'Ada', LastName: 'Lovelace' }, contact(9));

    await org.update('Account', [{ Id: account(9), LastName: 'Byron' }]);

    expect(org.all('Account')[0]).toMatchObject({ Name: 'Ada Byron' });
  });
});

describe('the steps of a rewind’s life', () => {
  it('takes a checkpoint of what it was given before T0, previews what changed since, rewinds the org back and undoes it', async () => {
    const t = await taken();
    expect(t.checkpoint.org.organizationId).toBe(ORG_ID);
    expect(t.checkpoint.readFrom).toBe(new Date(T0).toISOString());
    expect(t.atCheckpoint.live.Account).toHaveLength(3);
    changedSince(t.org);
    expect(clock.now).toBe(SINCE);
    const before = stateOf(t.org);

    const diff = await previewed(t);
    const result = resultOf(await rewound(t, diff.previewId));

    expect(clock.now).toBeGreaterThan(REWOUND);
    expect(t.org.ticking).toBe(false);
    expect(result.status).toBe('success');
    expect(stateOf(t.org).live).toEqual(t.atCheckpoint.live);
    const undo = await undone(t, result.rewindId);
    expect(undo.status).toBe('success');
    expect(stateOf(t.org)).toEqual(before);
    expect(liveIds(t.org, 'Account')).toContain(account(4));
  });

  it('stops an org once it has answered as many calls as asked', async () => {
    const controller = new AbortController();
    const org = stoppedAfter(new RewindTestOrg(), 2, controller);

    await org.serverTime();
    expect(controller.signal.aborted).toBe(false);
    await org.userId();
    expect(controller.signal.aborted).toBe(true);
  });

  it('reads automation that sends nothing, and removes the folders of the checkpoints taken', async () => {
    const t = await taken();
    t.org.edit('Account', account(1), { Name: 'Renamed' }, COLLEAGUE);
    const found = await automationOf({ requests: 3 })();

    removeTaken();

    expect(found).toMatchObject({ requests: 3, objects: [], unread: [] });
    expect(existsSync(t.folder.dir)).toBe(false);
  });
});
