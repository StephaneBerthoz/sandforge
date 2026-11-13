import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DataOpsEmptyRunResult,
  DataOpsEmptyUndoResult,
  ForgeTargetAutomation,
} from '@sandforge/shared';

import { fileConfigStore } from './fileConfigStore.js';
import { createPanelHost, orgFromIdentity } from './panelHost.js';
import type { PanelHost, PanelHostOptions, PanelHostWiring, PanelRequest } from './panelHost.js';
import { emptyExitCode, main, parseArgs, refusalWords, runIdOf } from './sandforge-empty.js';
import type { DataOpsEmptyHandler } from '../src/bridge/handlers/DataOpsEmptyHandler.js';
import { getJsforceConnection } from '../src/core/connection/ConnectionHelper.js';
import { AuditTrailStore } from '../src/modules/audit/auditTrail.js';
import {
  EMPTY_ORG_ID,
  MemoryEmptyOrg,
  SALES,
  emptySalesSpecs,
  fakeId,
} from '../src/test/memoryEmptyOrg.js';

vi.mock('../src/core/connection/ConnectionHelper.js', async (original) => ({
  ...(await original<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The command line of an emptying run whole, through the extension's own host
 * (`panelHost.ts`): DataOps Cleanup's handler answers it, with its journals
 * and the org's lock in folders of the test's own, on the memory org that
 * deletes, cascades and keeps a recycle bin as the platform does. Only what
 * reaches past this machine is stood in for: the `sf` CLI's session and the
 * identity query of a connection (the host's `connect`), the org itself, and
 * the read of what it runs.
 */

/** What the org runs as records go: nothing, unless a test says otherwise. */
function nothingFires(objects: readonly string[]): ForgeTargetAutomation {
  return {
    objectsRead: [...objects],
    objects: [],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 0,
    requests: 0,
  };
}

interface Harness {
  org: MemoryEmptyOrg;
  dir: string;
  journalRoot: string;
  /** The aliases the command connected, in order: what reached past this machine. */
  connected: string[];
  /** The requests the command sent the handler, in order. */
  sent: PanelRequest[];
  run: (...args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}

const dirs: string[] = [];

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.mocked(getJsforceConnection).mockReset();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function harness(
  options: {
    org?: MemoryEmptyOrg;
    /** The registry has the org as a production one, as connecting an Enterprise Edition registers it. */
    registeredProduction?: boolean;
    automation?: (objects: readonly string[]) => ForgeTargetAutomation;
    /** What a request becomes on its way to the handler. */
    sending?: (request: PanelRequest) => PanelRequest;
  } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-empty-cli-'));
  dirs.push(dir);
  const journalRoot = join(dir, 'empty');
  const org = options.org ?? new MemoryEmptyOrg(emptySalesSpecs());
  const connected: string[] = [];
  const sent: PanelRequest[] = [];
  vi.mocked(getJsforceConnection).mockResolvedValue({} as never);

  // The product's host, but for its `connect` and the org its handler reaches.
  const createHost = (hostOptions: PanelHostOptions): PanelHost => {
    let wiring: PanelHostWiring | undefined;
    const host = createPanelHost({
      ...hostOptions,
      compose: (built) => {
        hostOptions.compose?.(built);
        wiring = built;
        const empty = (built.handlers as unknown as { emptyHandler: DataOpsEmptyHandler })
          .emptyHandler;
        empty.setOrgOf(() => org);
        const reads = options.automation ?? nothingFires;
        empty.setTargetAutomation({
          read: (_orgId: string, objects: readonly string[]) => Promise.resolve(reads(objects)),
        });
        empty.setMuteLeases({ dir: join(dir, 'leases') });
      },
    });
    return {
      get posted() {
        return host.posted;
      },
      request: (request) => {
        const sending = options.sending?.(request) ?? request;
        sent.push(sending);
        return host.request(sending);
      },
      connect: async (alias) => {
        connected.push(alias);
        const session = {
          alias,
          username: 'tester@example.com',
          instanceUrl: 'https://example.my.salesforce.com',
          accessToken: 'not-a-token',
        };
        const registered = orgFromIdentity(session, {
          userId: fakeId('005', 1),
          username: session.username,
          displayName: 'Tester',
          orgId: EMPTY_ORG_ID,
          orgName: 'Example',
          orgType: options.registeredProduction ? 'Enterprise Edition' : 'Developer Edition',
          isSandbox: false,
        });
        if (!wiring) throw new Error('The host built no handlers.');
        await wiring.orgRegistry.saveOrg(registered, {
          loginUrl: session.instanceUrl,
          instanceUrl: session.instanceUrl,
          accessToken: session.accessToken,
          username: session.username,
        });
        return registered;
      },
    };
  };

  const run = async (...args: string[]) => {
    let stdout = '';
    let stderr = '';
    let exited: number | undefined;
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      stdout += chunk;
      return true;
    }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderr += chunk;
      return true;
    }) as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exited = code;
      throw new Error(`exit ${code}`);
    }) as never);
    process.exitCode = undefined;
    try {
      await main(['node', 'sandforge-empty.ts', ...args], {
        createHost,
        locksDir: join(dir, 'locks'),
        journalRoot,
        checkpointRoot: join(dir, 'checkpoints'),
      });
    } catch (thrown: unknown) {
      if (exited === undefined) throw thrown;
    } finally {
      out.mockRestore();
      err.mockRestore();
      exit.mockRestore();
    }
    const code = exited ?? Number(process.exitCode ?? 0);
    process.exitCode = undefined;
    return { code, stdout, stderr };
  };

  return { org, dir, journalRoot, connected, sent, run };
}

/**
 * The sales org with objects that hold no record beside it, as most of a
 * whole org's are, and a contact under no account the org refuses to delete.
 */
function withEmptyObjects(): MemoryEmptyOrg {
  const org = new MemoryEmptyOrg([
    ...emptySalesSpecs(),
    { name: 'Idea' },
    { name: 'Macro' },
    { name: 'QuickText' },
  ]);
  org.memory.refuse.set(SALES.contactAlone, 'held for good');
  return org;
}

/** The runs whose journals the command kept, by id. */
function journals(h: Harness): string[] {
  if (!existsSync(h.journalRoot)) return [];
  return readdirSync(h.journalRoot).flatMap((org) => readdirSync(join(h.journalRoot, org)));
}

describe('sandforge-empty: the line', () => {
  it('refuses, exit 1, a line with neither --dry-run nor --yes, before any org is reached', async () => {
    const h = harness();

    const { code, stdout, stderr } = await h.run(
      '--target',
      'DEV',
      '--objects',
      'Contact',
      '--json',
    );

    expect(code).toBe(1);
    expect(stderr).toContain('refused (NOT_CONFIRMED)');
    expect(stderr).toContain('add --dry-run to read what it would delete, or --yes');
    expect(JSON.parse(stdout)).toMatchObject({ refused: { code: 'NOT_CONFIRMED' } });
    expect(h.connected).toEqual([]);
  });

  it('refuses, exit 1, an undo with no --yes, before any org is reached', async () => {
    const h = harness();

    const { code, stderr } = await h.run('--target', 'DEV', '--undo', 'em-20261113-101500-ab12');

    expect(code).toBe(1);
    expect(stderr).toContain('add --yes to undo the emptying');
    expect(h.connected).toEqual([]);
  });

  it.each([
    [['--objects', 'Contact', '--org', '--dry-run'], '--objects and --org go apart'],
    [['--dry-run'], 'Name the objects to empty with --objects'],
    [['--objects', 'Contact', '--exclude-object', 'Case', '--dry-run'], 'goes with --org alone'],
    [['--objects', 'Contact', '--files', '--dry-run'], 'goes with --org alone'],
    [['--objects', 'Contact', '--unrestorable', '--dry-run'], 'goes with --org alone'],
    [['--objects', 'Contact', '--dry-run', '--yes'], '--dry-run and --yes go apart'],
    [['--objects', 'Contact; DROP', '--dry-run'], 'is not an object API name'],
    [['--undo', 'last', '--yes'], 'names no emptying'],
    [['--undo', 'em-20261113-101500-ab12', '--objects', 'Contact', '--yes'], 'does not go with'],
    [['--org', '--dry-run', '--audit', 'trail.json'], 'a dry run adds no entry'],
    [['--org', '--dry-run=true'], 'takes no value'],
  ])('refuses, exit 2, the bad line %j', async (line, said) => {
    const h = harness();

    const { code, stderr } = await h.run('--target', 'DEV', ...line);

    expect(code).toBe(2);
    expect(stderr).toContain(said);
    expect(h.connected).toEqual([]);
  });

  it('reads a run by its id or by the folder of its journal', () => {
    expect(runIdOf('em-20261113-101500-ab12')).toBe('em-20261113-101500-ab12');
    expect(runIdOf('/home/me/.sandforge/empty/00D/em-20261113-101500-ab12/')).toBe(
      'em-20261113-101500-ab12',
    );
    expect(runIdOf('latest')).toBeUndefined();
  });

  it('asks the whole org with its options, and the objects named once each', () => {
    expect(
      parseArgs([
        'node',
        'x',
        '--target',
        'DEV',
        '--org',
        '--exclude-object',
        'Case',
        '--exclude-object',
        'Lead',
        '--files',
        '--unrestorable',
        '--dry-run',
      ]),
    ).toMatchObject({
      act: 'empty',
      request: { mode: 'org', excluded: ['Case', 'Lead'], files: true, unrestorable: true },
      dryRun: true,
    });
    expect(
      parseArgs(['node', 'x', '--target', 'DEV', '--objects', 'Contact, Case,Contact', '--yes']),
    ).toMatchObject({ request: { mode: 'objects', objects: ['Contact', 'Case'] }, dryRun: false });
  });

  it('names the flag that accepts a refusal, and only where one does', () => {
    expect(refusalWords({ code: 'NO_UNDO', message: 'Accept it.' }).message).toBe(
      'Accept it. (--accept-no-undo accepts it)',
    );
    expect(refusalWords({ code: 'PEOPLE_ACTIVE', message: 'Wait.' }).message).toBe('Wait.');
  });

  it('ends a run 0 done, 3 partial, 1 failed, and with the stop’s code when one stopped it', () => {
    expect(emptyExitCode('success')).toBe(0);
    expect(emptyExitCode('partial')).toBe(3);
    expect(emptyExitCode('failure')).toBe(1);
    expect(emptyExitCode('cancelled', 'SIGINT')).toBe(130);
    expect(emptyExitCode('cancelled', 'SIGTERM')).toBe(143);
  });
});

describe('sandforge-empty: the dry run', () => {
  it('says what it would delete and what goes along, deletes nothing and keeps no journal', async () => {
    const h = harness();

    const { code, stdout, stderr } = await h.run(
      '--target',
      'DEV',
      '--objects',
      'Account',
      '--dry-run',
      '--accept-no-undo',
      '--json',
    );

    expect(code).toBe(0);
    const answer = JSON.parse(stdout) as {
      tool: string;
      dryRun: boolean;
      preview: {
        passes: Array<{ objectApiName: string }>;
        along: Array<{ objectApiName: string }>;
      };
      wouldBeRefusedCodes?: string[];
    };
    expect(answer).toMatchObject({ tool: 'sandforge-empty', action: 'empty', dryRun: true });
    expect(answer.preview.passes.map((pass) => pass.objectApiName)).toContain('Account');
    expect(answer.preview.along.map((along) => along.objectApiName)).toContain('Contact');
    expect(answer.wouldBeRefusedCodes).toBeUndefined();
    expect(stderr).toContain('Emptied, in the order the run takes them:');
    expect(stderr).toContain('Going along, deleted by the org with a record emptied:');
    expect(stderr).toContain('a real run would not be refused');
    expect(h.org.sent).toEqual([]);
    expect(journals(h)).toEqual([]);
  });

  it('exits 1 when a run would be refused, every refusal named with its code', async () => {
    const h = harness();

    const { code, stdout, stderr } = await h.run(
      '--target',
      'DEV',
      '--objects',
      'Account,Case',
      '--hard-delete',
      '--dry-run',
      '--json',
    );

    expect(code).toBe(1);
    const answer = JSON.parse(stdout) as { wouldBeRefusedCodes: string[] };
    expect(answer.wouldBeRefusedCodes).toContain('HARD_DELETE_NOT_PERMITTED');
    expect(stderr).toContain('a real run would be refused (HARD_DELETE_NOT_PERMITTED)');
    expect(stderr).toContain('the user does not hold Bulk API Hard Delete');
    expect(h.org.sent).toEqual([]);
    // It names no one, and says what it did: it read, it deleted nothing.
    expect(`${stdout}${stderr}`).not.toContain('tester@example.com');
    expect(stderr).toContain('the user SandForge deletes as');
    expect(stderr).not.toContain('No record was read or deleted');
  });

  it('gives in --json the requests its estimate priced and those the dry run sent, counted as sent', async () => {
    const h = harness();

    const { code, stdout } = await h.run('--target', 'DEV', '--org', '--dry-run', '--json');

    expect(code).toBe(1);
    const answer = JSON.parse(stdout) as { apiRequests: { estimate: number; sent: number } };
    expect(answer.apiRequests.sent).toBe(h.org.requestsSent());
    expect(answer.apiRequests.estimate).toBeGreaterThan(2 * answer.apiRequests.sent);
  });

  it('lists the objects that hold records, and how many hold none, the JSON keeping every one', async () => {
    const h = harness({ org: withEmptyObjects() });

    const { stdout, stderr } = await h.run('--target', 'DEV', '--org', '--dry-run', '--json');

    const emptied = stderr.slice(
      stderr.indexOf('Emptied, in the order'),
      stderr.indexOf('\n\n', stderr.indexOf('Emptied, in the order')),
    );
    const answer = JSON.parse(stdout) as {
      preview: { passes: Array<{ objectApiName: string; records: { records?: number } }> };
    };
    const holding = answer.preview.passes.filter((pass) => pass.records.records !== 0);
    const empty = answer.preview.passes.length - holding.length;
    expect(empty).toBeGreaterThan(0);
    for (const pass of holding) expect(emptied).toContain(pass.objectApiName);
    for (const pass of answer.preview.passes.filter((each) => each.records.records === 0)) {
      expect(emptied).not.toMatch(new RegExp(`^  ${pass.objectApiName} `, 'm'));
    }
    expect(emptied).toContain(`and ${empty} object(s) holding no record (--json lists them)`);
  });
});

describe('sandforge-empty: production', () => {
  it('refuses an org the registry has as production, exit 1, whatever is given, and reads none of its records', async () => {
    const h = harness({ registeredProduction: true });

    const { code, stdout, stderr } = await h.run(
      '--target',
      'PROD',
      '--objects',
      'Contact',
      '--yes',
      '--accept-automation',
      '--accept-emails',
      '--accept-no-undo',
      '--json',
    );

    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ refused: { code: 'PRODUCTION' } });
    expect(stderr).toContain('nothing lifts this');
    expect(h.sent.map((request) => request.type)).toEqual(['dataops:empty:preview']);
    expect(h.org.sent).toEqual([]);
    expect(h.org.live('Contact')).toHaveLength(3);
  });

  it('refuses an org that says it is production though its alias was registered otherwise, exit 1', async () => {
    const h = harness({
      org: new MemoryEmptyOrg(emptySalesSpecs(), { production: { edition: 'Enterprise Edition' } }),
    });

    const { code, stdout } = await h.run('--target', 'DEV', '--org', '--dry-run', '--json');

    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ refused: { code: 'PRODUCTION' } });
    expect(h.org.sent).toEqual([]);
  });
});

describe('sandforge-empty: a run', () => {
  it('empties as its dry run said, through the page’s handler, keeps a journal and adds the panel’s audit entry', async () => {
    const h = harness();
    const audit = join(h.dir, 'trail.json');

    const { code, stdout, stderr } = await h.run(
      '--target',
      'DEV',
      '--objects',
      'Contact',
      '--yes',
      '--audit',
      audit,
      '--json',
    );

    expect(code).toBe(0);
    const answer = JSON.parse(stdout) as { dryRun: boolean; result: DataOpsEmptyRunResult };
    expect(answer.dryRun).toBe(false);
    expect(answer.result).toMatchObject({ status: 'success', undo: { offered: true } });
    expect(answer.result.totals.deleted).toBe(3);
    expect(h.org.live('Contact')).toEqual([]);
    expect(h.sent.map((request) => request.type)).toEqual([
      'dataops:empty:preview',
      'dataops:empty:run',
    ]);
    expect(journals(h)).toEqual([answer.result.runId]);
    expect(stderr).toContain(`--undo ${answer.result.runId} --yes brings them back`);
    // The panel's own entry, as its handler recorded it in the host's trail.
    expect(new AuditTrailStore(fileConfigStore(audit)).list().entries).toEqual([
      expect.objectContaining({
        action: 'cleanup_delete',
        module: 'dataops',
        orgAlias: 'DEV',
        outcome: 'success',
        objects: [expect.objectContaining({ objectApiName: 'Contact', deleted: 3 })],
        details: expect.objectContaining({ empty: 'run', runId: answer.result.runId }),
      }),
    ]);
  });

  it('gives in --json every request its dry run and its run sent, under what the estimate priced', async () => {
    const h = harness({ org: withEmptyObjects() });

    const { code, stdout } = await h.run(
      '--target',
      'DEV',
      '--org',
      '--yes',
      '--accept-no-undo',
      '--json',
    );

    expect(code).toBe(3);
    const answer = JSON.parse(stdout) as {
      apiRequests: { estimate: number; sent: number };
      result: DataOpsEmptyRunResult;
    };
    expect(answer.apiRequests.sent).toBe(h.org.requestsSent());
    expect(answer.apiRequests.sent).toBeLessThanOrEqual(answer.apiRequests.estimate);
    expect(answer.result.requestsSent).toBeLessThan(answer.apiRequests.sent);
  });

  it('prints the passes that moved or met a refusal, and how many found nothing, the JSON keeping every one', async () => {
    const h = harness({ org: withEmptyObjects() });

    const { stdout, stderr } = await h.run(
      '--target',
      'DEV',
      '--org',
      '--yes',
      '--accept-no-undo',
      '--json',
    );

    const answer = JSON.parse(stdout) as { result: DataOpsEmptyRunResult };
    const still = answer.result.passes.filter(
      (pass) => pass.deleted + pass.gone + pass.refused + (pass.notReached ?? 0) === 0,
    );
    expect(still.length).toBeGreaterThan(0);
    expect(stderr).not.toMatch(/deleted 0\n/);
    expect(stderr).toContain(
      `and ${still.length} object(s) whose pass found nothing to delete (--json lists them)`,
    );
    const refused = answer.result.passes.find((pass) => pass.refused > 0);
    expect(refused).toBeDefined();
    expect(stderr).toMatch(new RegExp(`^  ${refused?.objectApiName} +deleted`, 'm'));
  });

  it('refuses, exit 1, records no undo would bring back until --accept-no-undo, the flag named', async () => {
    const h = harness();

    const refused = await h.run('--target', 'DEV', '--objects', 'Account,Case', '--yes', '--json');

    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ refused: { code: 'NO_UNDO' } });
    expect(refused.stderr).toContain('(--accept-no-undo accepts it)');
    expect(h.org.sent).toEqual([]);
    expect(h.sent.map((request) => request.type)).toEqual(['dataops:empty:preview']);
  });

  it('refuses, exit 1, a delete for good the user has no Bulk API Hard Delete for, and sends nothing', async () => {
    const h = harness();

    const { code, stdout } = await h.run(
      '--target',
      'DEV',
      '--objects',
      'Contact',
      '--hard-delete',
      '--yes',
      '--json',
    );

    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ refused: { code: 'HARD_DELETE_NOT_PERMITTED' } });
    expect(h.org.sent).toEqual([]);
    expect(h.org.live('Contact')).toHaveLength(3);
  });

  it('deletes for good with the right, and offers no undo', async () => {
    const h = harness({ org: new MemoryEmptyOrg(emptySalesSpecs(), { hardDelete: true }) });

    const { code, stdout, stderr } = await h.run(
      '--target',
      'DEV',
      '--objects',
      'Contact',
      '--hard-delete',
      '--yes',
      '--json',
    );

    expect(code).toBe(0);
    const { result } = JSON.parse(stdout) as { result: DataOpsEmptyRunResult };
    expect(result).toMatchObject({ hard: true, undo: { offered: false, why: 'hard' } });
    expect(h.org.sent.map((sent) => sent.via)).toEqual(['hardDelete']);
    expect(stderr).toContain('no undo: it deleted for good');

    const undo = await h.run('--target', 'DEV', '--undo', result.runId, '--yes', '--json');
    expect(undo.code).toBe(1);
    expect(JSON.parse(undo.stdout)).toMatchObject({ refused: { code: 'UNDO_UNAVAILABLE' } });
  });

  it('refuses what fires unaccepted, exit 1, every refusal said', async () => {
    const h = harness({
      automation: (objects) => ({
        ...nothingFires(objects),
        objects: [
          {
            objectApiName: 'Contact',
            flows: [
              {
                apiName: 'Guard_Delete',
                label: 'Guard Delete',
                timing: 'beforeSave' as const,
                startsOn: 'delete' as const,
                condition: 'read' as const,
                permissions: [],
              },
            ],
            triggers: [],
          },
        ],
      }),
    });

    const { code, stdout } = await h.run(
      '--target',
      'DEV',
      '--objects',
      'Contact',
      '--yes',
      '--json',
    );

    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ refused: { code: 'AUTOMATION_NOT_ACCEPTED' } });
    expect(h.org.sent).toEqual([]);
  });
});

describe('sandforge-empty: a stop, its resume and its undo', () => {
  it('stops at Ctrl-C before its next call, exits 130, and --resume takes it up', async () => {
    const h = harness();
    h.org.beforeDelete = (_via, objectApiName) => {
      if (objectApiName === 'Contact') {
        h.org.beforeDelete = undefined;
        process.emit('SIGINT');
      }
    };

    const stopped = await h.run(
      '--target',
      'DEV',
      '--objects',
      'Contact,Opportunity',
      '--yes',
      '--json',
    );

    expect(stopped.code).toBe(130);
    const { result } = JSON.parse(stopped.stdout) as { result: DataOpsEmptyRunResult };
    expect(result.status).toBe('cancelled');
    expect(stopped.stderr).toContain('interrupted: the run stops before its next call or job');
    expect(stopped.stderr).toContain(`--resume ${result.runId} --yes takes it up`);
    expect(h.org.live('Contact')).toEqual([]);
    expect(h.org.live('Opportunity')).toContain(SALES.opportunityAlone);

    // A new emptying is refused while it is open.
    const blocked = await h.run('--target', 'DEV', '--objects', 'Case', '--yes', '--json');
    expect(blocked.code).toBe(1);
    expect(JSON.parse(blocked.stdout)).toMatchObject({ refused: { code: 'OPEN_RUN' } });

    const resumed = await h.run('--target', 'DEV', '--resume', result.runId, '--yes', '--json');

    expect(resumed.code).toBe(0);
    const taken = JSON.parse(resumed.stdout) as { result: DataOpsEmptyRunResult };
    expect(taken.result).toMatchObject({ runId: result.runId, resumed: true, status: 'success' });
    expect(h.org.live('Opportunity')).toEqual([]);
  });

  it('brings back with --undo what the run deleted, named by its journal’s folder', async () => {
    const h = harness();
    const ran = await h.run('--target', 'DEV', '--objects', 'Contact', '--yes', '--json');
    const { result } = JSON.parse(ran.stdout) as { result: DataOpsEmptyRunResult };
    const [orgKey] = readdirSync(h.journalRoot);
    const folder = join(h.journalRoot, orgKey ?? '', result.runId);

    const { code, stdout, stderr } = await h.run(
      '--target',
      'DEV',
      '--undo',
      folder,
      '--yes',
      '--json',
    );

    expect(code).toBe(0);
    const undone = JSON.parse(stdout) as { action: string; result: DataOpsEmptyUndoResult };
    expect(undone.action).toBe('undo');
    expect(undone.result.status).toBe('success');
    expect(h.org.live('Contact')).toHaveLength(3);
    expect(stderr).toContain(`undid the emptying ${result.runId} of DEV: success`);
  });

  it('refuses, exit 1, a resume of a run that is not the org’s last one stopped part way', async () => {
    const h = harness();

    const { code, stdout } = await h.run(
      '--target',
      'DEV',
      '--resume',
      'em-20261113-101500-ab12',
      '--yes',
      '--json',
    );

    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ refused: { code: 'RUN_GONE' } });
    expect(h.org.sent).toEqual([]);
  });
});
