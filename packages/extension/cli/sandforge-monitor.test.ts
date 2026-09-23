import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseArgs, pageRequest, describeAnswer } from './sandforge-monitor.js';

/** A command line, as `process.argv` hands it over. */
function argv(...args: string[]): string[] {
  return ['node', 'sandforge-monitor.ts', ...args];
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Run a parse that is meant to be refused, and report the exit. */
function refuse(...args: string[]): { code: number | undefined; message: string } {
  let code: number | undefined;
  let message = '';
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error('exit');
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    message += chunk;
    return true;
  }) as never);
  try {
    parseArgs(argv(...args));
  } catch {
    // `process.exit` is stubbed to throw so the parse stops where it would.
  }
  return { code, message };
}

describe('parseArgs', () => {
  it('reads every request the page sends when none is named', () => {
    const args = parseArgs(argv('--org', 'TGT'));
    expect(args.orgs).toEqual(['TGT']);
    expect(args.operations).toHaveLength(10);
    expect(args.operations).not.toContain('open-apex-jobs');
    expect(args.repeat).toBe(1);
  });

  it('reads several orgs, to be read in turn from one host', () => {
    expect(parseArgs(argv('--org', 'SRC', '--org', 'TGT')).orgs).toEqual(['SRC', 'TGT']);
  });

  it('reads the requests asked for and how many passes', () => {
    const args = parseArgs(
      argv('--org', 'T', '--op', 'refresh', '--op', 'alerts', '--repeat', '3'),
    );
    expect(args.operations).toEqual(['refresh', 'alerts']);
    expect(args.repeat).toBe(3);
  });

  it('acts on an alert and does nothing else when that is all it is given', () => {
    const args = parseArgs(argv('--org', 'T', '--acknowledge', 'alert-9'));
    expect(args.acknowledge).toEqual(['alert-9']);
    expect(args.operations).toEqual([]);
  });

  it('refuses to open a browser', () => {
    const { code, message } = refuse('--org', 'T', '--op', 'open-apex-jobs');
    expect(code).toBe(2);
    expect(message).toContain('browser');
  });

  it('refuses a request the page does not send', () => {
    expect(refuse('--org', 'T', '--op', 'deploy').code).toBe(2);
  });

  it('refuses a line with no org', () => {
    expect(refuse('--op', 'refresh').code).toBe(2);
  });

  it('refuses a repeat that is not a whole number from one', () => {
    expect(refuse('--org', 'T', '--repeat', '0').code).toBe(2);
  });
});

describe('pageRequest', () => {
  it('asks for a refresh the way the page does, answered on monitor:data', () => {
    expect(pageRequest('refresh', 'org-1')).toEqual({
      type: 'monitor:refresh',
      payload: { orgId: 'org-1' },
      responseType: 'monitor:data',
    });
  });

  it('sends the alerts and live operations requests with no payload, as the page does', () => {
    expect(pageRequest('alerts', 'org-1')).toEqual({
      type: 'monitor:alerts',
      responseType: 'monitor:alerts:result',
    });
    expect(pageRequest('live-operations', 'org-1')).toEqual({ type: 'monitor:live-operations' });
  });
});

describe('describeAnswer', () => {
  it('tells the alerts of the org on screen from the ones of another org', () => {
    const lines = describeAnswer(
      'monitor:alerts',
      'alerts',
      {
        outcome: 'answered',
        elapsedMs: 5,
        late: false,
        message: {
          id: 'r1',
          type: 'monitor:alerts:result',
          timestamp: 0,
          payload: {
            alerts: [
              { id: 'a1', status: 'active', orgId: 'org-1', message: 'mine' },
              { id: 'a2', status: 'active', orgId: 'org-2', message: 'theirs' },
            ],
            history: [],
          },
        },
      },
      'org-1',
    );
    expect(lines[1]).toContain('2 active alert(s), 1 of this org');
    expect(lines).toContain('    a2 active another org: theirs');
  });

  /** An answered request whose payload is `payload`. */
  function answered(type: string, payload: Record<string, unknown>) {
    return {
      outcome: 'answered' as const,
      elapsedMs: 5,
      late: false,
      message: { id: 'r1', type, timestamp: 0, payload },
    };
  }

  it('says where a list stops when its read came back full, as the page does', () => {
    const sessions = Array.from({ length: 3 }, (_, i) => ({
      sessionType: 'UI',
      sessionId: `s${i}`,
    }));
    const [, full] = describeAnswer(
      'monitor:sessions',
      'sessions',
      answered('monitor:sessions:response', { sessions, activeUserCount: 2, truncated: true }),
    );
    const [, complete] = describeAnswer(
      'monitor:sessions',
      'sessions',
      answered('monitor:sessions:response', { sessions, activeUserCount: 2, truncated: false }),
    );

    expect(full).toBe('  3 session(s), 2 active user(s); the list stops at 3');
    expect(complete).toBe('  3 session(s), 2 active user(s)');
  });

  it('says how many of the latest jobs the failed ones were counted among, as the page does', () => {
    const lines = describeAnswer(
      'monitor:refresh',
      'refresh',
      answered('monitor:data', {
        healthScore: 90,
        limits: [],
        jobs: [],
        orgHealthStatus: {
          overall: 'healthy',
          apiLimitsStatus: 'ok',
          storageStatus: 'ok',
          failedJobs: 2,
          failedJobsOutOf: 50,
          recentErrorLogs: 0,
        },
      }),
    );

    expect(lines.find((line) => line.includes('health check'))).toContain(
      'failed jobs 2 of the 50 latest, recent error logs 0',
    );
  });

  it('says how many counted objects the storage list stops short of', () => {
    const [, head] = describeAnswer(
      'monitor:storage',
      'storage',
      answered('monitor:storage:response', {
        objects: [{ objectName: 'ObjectPermissions', recordCount: 37000 }],
        totalRecords: 133989,
        objectCount: 216,
      }),
    );

    expect(head).toBe('  1 of 216 object(s) holding records listed, total 133989 record(s)');
  });

  it('says an answer past the page timeout was dropped by the page', () => {
    const [head] = describeAnswer('monitor:refresh', 'refresh', {
      outcome: 'answered',
      elapsedMs: 31_000,
      late: true,
    });
    expect(head).toContain('the page dropped it');
  });
});
