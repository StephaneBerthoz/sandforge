import { describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';

import { emptyOrgOf } from './emptyOrg.js';

vi.mock('../../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * A jsforce connection whose Bulk API job is opened, sent and closed, then
 * cannot be read back: the org answers nothing for its state.
 */
function connectionLosingItsJob(): { conn: Connection; states: string[] } {
  const states: string[] = ['InProgress', 'JobComplete'];
  const job = {
    id: '750000000000001AAA',
    open: vi.fn(async () => ({})),
    uploadData: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    check: vi.fn(async () => {
      throw new Error('socket hang up');
    }),
    getAllResults: vi.fn(async () => ({ successfulResults: [], failedResults: [] })),
  };
  const conn = {
    bulk2: {
      createJob: vi.fn(() => job),
      job: vi.fn(() => ({
        check: vi.fn(async () => ({
          id: '750000000000001AAA',
          state: states.shift() ?? 'JobComplete',
        })),
      })),
    },
    query: vi.fn(async (soql: string, options?: { scanAll?: boolean }) => ({
      totalSize: options?.scanAll ? 7 : 5,
      done: true,
      records: soql.includes('COUNT()') ? [] : [{ Id: '003000000000001AAA' }],
    })),
    tooling: {
      describeGlobal: vi.fn(async () => {
        throw new Error('INSUFFICIENT_ACCESS');
      }),
    },
    limitInfo: {},
  } as unknown as Connection;
  return { conn, states };
}

describe('emptyOrgOf', () => {
  it('keeps the id of a delete job closed and not read back, for the run to wait for before it gives back the mute', async () => {
    const { conn } = connectionLosingItsJob();
    const org = emptyOrgOf(conn, 'org-1', 'test');

    await expect(org.bulkDestroy?.('Contact', ['003000000000001AAA'])).rejects.toThrow(
      'socket hang up',
    );

    expect(org.lostJobs?.()).toEqual([
      { orgId: 'org-1', objectApiName: 'Contact', jobId: '750000000000001AAA' },
    ]);
  });

  it('keeps no job the org never took: one refused before its close holds nothing to delete', async () => {
    const { conn } = connectionLosingItsJob();
    const job = (conn.bulk2.createJob as unknown as () => { close: ReturnType<typeof vi.fn> })();
    job.close.mockRejectedValueOnce(new Error('INVALID_SESSION_ID'));
    const org = emptyOrgOf(conn, 'org-1', 'test');

    const answer = await org.bulkHardDestroy?.('Contact', ['003000000000001AAA']);

    expect(answer).toMatchObject({ kind: 'untouched' });
    expect(org.lostJobs?.()).toEqual([]);
  });

  it('counts through queryAll when asked, and takes a Tooling API that will not answer for one that serves nothing', async () => {
    const { conn } = connectionLosingItsJob();
    const org = emptyOrgOf(conn, 'org-1', 'test');

    expect(await org.count('SELECT COUNT() FROM Task')).toBe(5);
    expect(await org.countAll('SELECT COUNT() FROM Task')).toBe(7);
    expect(await org.toolingObjects()).toEqual([]);
  });
});
