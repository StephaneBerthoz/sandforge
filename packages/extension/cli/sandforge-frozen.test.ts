import { describe, it, expect, vi, afterEach } from 'vitest';
import type { RecordTypeGiven } from '@sandforge/shared';
import {
  discoveryLine,
  frozenInterruptedLine,
  frozenRecordTypeLines,
  FROZEN_PREVIEW_UNREAD,
  messageLines,
  parseArgs,
  refusedFirstOf,
  removalAsks,
  removalPlanLines,
  removalPreviewLines,
  typeOrg,
} from './sandforge-frozen.js';

/** A command line, as `process.argv` hands it over. */
function argv(...args: string[]): string[] {
  return ['node', 'sandforge-frozen.ts', ...args];
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
  it('reads a step, its configuration and the org it works on', () => {
    const args = parseArgs(argv('extract', '--config', 'frozen.json', '--source', 'SRC'));
    expect(args).toMatchObject({ step: 'extract', configPath: 'frozen.json', source: 'SRC' });
  });

  it('reads the file the salt is kept in, for a shell that sets no SANDFORGE_FROZEN_SALT', () => {
    const args = parseArgs(
      argv('extract', '--config', 'f.json', '--source', 'SRC', '--salt-file', 'team.salt'),
    );
    expect(args.saltFile).toBe('team.salt');
  });

  it('reads a load and its modes', () => {
    const args = parseArgs(
      argv('load', '--config', 'f.json', '--target', 'TGT', '--pilot', '--reload', '--yes'),
    );
    expect(args).toMatchObject({
      step: 'load',
      target: 'TGT',
      pilot: true,
      reload: true,
      yes: true,
    });
  });

  it('reads a dry run of a load, which writes nothing', () => {
    expect(
      parseArgs(argv('load', '--config', 'f.json', '--target', 'TGT', '--dry-run', '--reload')),
    ).toMatchObject({ step: 'load', dryRun: true, reload: true });
    expect(parseArgs(argv('load', '--config', 'f.json', '--target', 'TGT')).dryRun).toBe(false);
  });

  it('does not write without being told to, unless --yes says so', () => {
    expect(parseArgs(argv('load', '--config', 'f.json', '--target', 'TGT')).yes).toBe(false);
  });

  it('refuses a first word that is not a step', () => {
    const { code, message } = refuse('freeze', '--config', 'f.json');
    expect(code).toBe(2);
    expect(message).toContain('select, extract, load, verify, remove, status');
  });

  it('refuses a line with no configuration', () => {
    expect(refuse('status').code).toBe(2);
  });

  it('refuses a step without the org it needs', () => {
    expect(refuse('select', '--config', 'f.json').message).toContain('--source');
    expect(refuse('verify', '--config', 'f.json').message).toContain('--target');
    expect(refuse('remove', '--config', 'f.json').message).toContain('--target');
  });

  it('reads a removal, which keeps what changed since the load unless told otherwise', () => {
    expect(parseArgs(argv('remove', '--config', 'f.json', '--target', 'TGT'))).toMatchObject({
      step: 'remove',
      target: 'TGT',
      includeChanged: false,
      yes: false,
    });
    expect(
      parseArgs(argv('remove', '--config', 'f.json', '--target', 'TGT', '--include-changed'))
        .includeChanged,
    ).toBe(true);
  });

  it('reads a removal with a sweep, or the listing of one, and sweeps nothing unasked', () => {
    expect(parseArgs(argv('remove', '--config', 'f.json', '--target', 'TGT'))).toMatchObject({
      sweep: false,
      sweepList: false,
    });
    expect(
      parseArgs(argv('remove', '--config', 'f.json', '--target', 'TGT', '--sweep')).sweep,
    ).toBe(true);
    expect(
      parseArgs(argv('remove', '--config', 'f.json', '--target', 'TGT', '--sweep-list')).sweepList,
    ).toBe(true);
  });

  it('reads a load told to write the fields the target encrypts as the dataset holds them, and refuses that with another step', () => {
    expect(parseArgs(argv('load', '--config', 'f.json', '--target', 'TGT')).writeEncrypted).toBe(
      false,
    );
    expect(
      parseArgs(argv('load', '--config', 'f.json', '--target', 'TGT', '--write-encrypted'))
        .writeEncrypted,
    ).toBe(true);
    expect(
      refuse('remove', '--config', 'f.json', '--target', 'TGT', '--write-encrypted'),
    ).toMatchObject({ code: 2, message: expect.stringContaining('goes with load') });
  });

  it('refuses a sweep and its listing together, and a sweep with another step', () => {
    expect(
      refuse('remove', '--config', 'f.json', '--target', 'TGT', '--sweep', '--sweep-list'),
    ).toMatchObject({ code: 2, message: expect.stringContaining('give one of them') });
    expect(refuse('load', '--config', 'f.json', '--target', 'TGT', '--sweep')).toMatchObject({
      code: 2,
      message: expect.stringContaining('--sweep goes with remove or load --reload'),
    });
    expect(
      refuse('load', '--config', 'f.json', '--target', 'TGT', '--reload', '--pilot', '--sweep'),
    ).toMatchObject({ code: 2, message: expect.stringContaining('a pilot purges nothing') });
    expect(
      refuse('load', '--config', 'f.json', '--target', 'TGT', '--reload', '--sweep-list'),
    ).toMatchObject({
      code: 2,
      message: expect.stringContaining(
        'a reload lists what its sweep would take with --dry-run --sweep',
      ),
    });
  });

  it('reads a reload told to sweep what the automation made for the loads it replaces, and what it takes beside', () => {
    expect(
      parseArgs(
        argv(
          'load',
          '--config',
          'f.json',
          '--target',
          'TGT',
          '--reload',
          '--sweep',
          '--sweep-untied',
        ),
      ),
    ).toMatchObject({ step: 'load', reload: true, sweep: true, sweepUntied: true });
    expect(
      parseArgs(argv('load', '--config', 'f.json', '--target', 'TGT', '--reload')),
    ).toMatchObject({ sweep: false });
  });

  it('reads --accept-emails with load, and refuses it with any other step', () => {
    expect(
      parseArgs(argv('load', '--config', 'f.json', '--target', 'TGT', '--accept-emails')),
    ).toMatchObject({ acceptEmails: true });
    expect(parseArgs(argv('load', '--config', 'f.json', '--target', 'TGT'))).toMatchObject({
      acceptEmails: false,
    });
    expect(
      refuse('remove', '--config', 'f.json', '--target', 'TGT', '--accept-emails'),
    ).toMatchObject({
      code: 2,
      message: expect.stringContaining('--accept-emails goes with load'),
    });
  });

  it('reads --include-changed for the sweep of a reload, and refuses it where nothing takes it', () => {
    // Given with a load, it was dropped without a word: what a reload's sweep
    // kept as changed since was kept by every reload after.
    expect(
      parseArgs(
        argv(
          'load',
          '--config',
          'f.json',
          '--target',
          'TGT',
          '--reload',
          '--sweep',
          '--include-changed',
        ),
      ),
    ).toMatchObject({ reload: true, sweep: true, includeChanged: true });
    for (const step of [['load', '--reload'], ['load'], ['verify']]) {
      expect(
        refuse(...step, '--config', 'f.json', '--target', 'TGT', '--include-changed'),
      ).toMatchObject({
        code: 2,
        message: expect.stringContaining(
          '--include-changed goes with remove, or with load --reload --sweep',
        ),
      });
    }
  });

  it('reads a removal told only to say what it would do, which removes nothing unasked', () => {
    expect(parseArgs(argv('remove', '--config', 'f.json', '--target', 'TGT')).preview).toBe(false);
    expect(
      parseArgs(argv('remove', '--config', 'f.json', '--target', 'TGT', '--preview', '--json')),
    ).toMatchObject({ step: 'remove', preview: true, json: true });
  });

  it('refuses a preview of another step than remove, pointing a load at its dry run, and a preview with a sweep list', () => {
    expect(refuse('load', '--config', 'f.json', '--target', 'TGT', '--preview')).toMatchObject({
      code: 2,
      message: expect.stringContaining('a load says what it would do with --dry-run'),
    });
    expect(
      refuse('remove', '--config', 'f.json', '--target', 'TGT', '--preview', '--sweep-list'),
    ).toMatchObject({ code: 2, message: expect.stringContaining('--preview deletes nothing') });
  });

  it('reads a preview with a sweep, which lists what the sweep would take and reads what fires on it', () => {
    expect(
      parseArgs(
        argv(
          'remove',
          '--config',
          'f.json',
          '--target',
          'TGT',
          '--preview',
          '--sweep',
          '--sweep-late',
        ),
      ),
    ).toMatchObject({ step: 'remove', preview: true, sweep: true, sweepLate: true });
  });

  it('reads the most records a load may insert, a whole number, with load alone', () => {
    expect(
      parseArgs(argv('load', '--config', 'f.json', '--target', 'TGT', '--max-total', '120')),
    ).toMatchObject({ step: 'load', maxTotal: 120 });
    expect(parseArgs(argv('load', '--config', 'f.json', '--target', 'TGT'))).not.toHaveProperty(
      'maxTotal',
    );
    for (const bad of ['0', '1.5', '-3', 'many', '1000001']) {
      expect(
        refuse('load', '--config', 'f.json', '--target', 'TGT', '--max-total', bad),
      ).toMatchObject({ code: 2, message: expect.stringContaining('--max-total takes') });
    }
    expect(
      refuse('remove', '--config', 'f.json', '--target', 'TGT', '--max-total', '3'),
    ).toMatchObject({ code: 2, message: expect.stringContaining('--max-total goes with load') });
  });
});

describe('removalPreviewLines', () => {
  it('says per object what a removal would delete, keep and find gone, who changed what, what it would be refused for, and what it cannot read', () => {
    expect(
      removalPreviewLines({
        loadedAt: '2026-10-20T10:05:00.000Z',
        includeChanged: false,
        planned: 4,
        objects: [
          {
            objectApiName: 'Contact',
            planned: 3,
            toDelete: 1,
            alreadyGone: 1,
            changedSince: 1,
            keptChanged: 1,
            changedBy: { '005000000000002AAA': 1 },
            undeletable: 0,
            notVisible: 0,
            unread: 0,
            reasons: [],
          },
          {
            objectApiName: 'Account',
            planned: 1,
            toDelete: 1,
            alreadyGone: 0,
            changedSince: 0,
            keptChanged: 0,
            changedBy: {},
            undeletable: 0,
            notVisible: 0,
            unread: 0,
            reasons: [],
          },
        ],
        userNames: { '005000000000002AAA': 'A Tester' },
        keptByThePlatform: [{ objectApiName: 'BusinessHours', count: 1 }],
        refusals: ['Operation blocked by Production Guard: delete is not allowed'],
        refusalCodes: ['GUARD_BLOCKED'],
      }),
    ).toEqual([
      'preview: what a removal would do; nothing was deleted',
      '  Contact: 1 to delete, 1 gone already, 1 kept, changed since the load of 3',
      '      last changed by: A Tester 1',
      '  Account: 1 to delete of 1',
      'kept: the platform does not delete them — BusinessHours (1)',
      'a removal would be refused (GUARD_BLOCKED): Operation blocked by Production Guard: ' +
        'delete is not allowed',
      FROZEN_PREVIEW_UNREAD,
    ]);
  });
});

describe('typeOrg', () => {
  /** A connection whose Organization record answers `row`, and whose edition query answers `edition`. */
  function orgAnswering(row: { Id: string; IsSandbox: boolean }, edition: () => unknown) {
    const query = vi.fn(async (soql: string) =>
      soql.includes('OrganizationType') ? { records: [edition()] } : { records: [row] },
    );
    return { query, conn: { query } as never };
  }

  it('types a Developer Edition org as one, with its edition, which the guards of the load read', async () => {
    // Typed from IsSandbox alone, it was registered as a production org with
    // no edition, and every guard of the load refused it.
    const { conn } = orgAnswering({ Id: '00D000000000001AAA', IsSandbox: false }, () => ({
      OrganizationType: 'Developer Edition',
    }));

    await expect(typeOrg(conn)).resolves.toEqual({
      id: '00D000000000001AAA',
      orgType: 'Developer',
      edition: 'Developer Edition',
    });
  });

  it('keeps an org that is no sandbox and says another edition a production org', async () => {
    const { conn } = orgAnswering({ Id: '00D000000000004AAA', IsSandbox: false }, () => ({
      OrganizationType: 'Enterprise Edition',
    }));

    await expect(typeOrg(conn)).resolves.toEqual({
      id: '00D000000000004AAA',
      orgType: 'Production',
      edition: 'Enterprise Edition',
    });
  });

  it('types a sandbox from IsSandbox, without asking its edition', async () => {
    const { conn, query } = orgAnswering({ Id: '00D000000000002AAA', IsSandbox: true }, () => ({
      OrganizationType: 'Enterprise Edition',
    }));

    await expect(typeOrg(conn)).resolves.toEqual({
      id: '00D000000000002AAA',
      orgType: 'Sandbox',
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('leaves an org whose edition cannot be read a production org without one', async () => {
    const { conn } = orgAnswering({ Id: '00D000000000003AAA', IsSandbox: false }, () => {
      throw new Error('INVALID_FIELD');
    });

    await expect(typeOrg(conn)).resolves.toEqual({
      id: '00D000000000003AAA',
      orgType: 'Production',
    });
  });
});

describe('removalPlanLines', () => {
  it('names the org, what the removal takes per object in its order, and what stays', () => {
    expect(
      removalPlanLines(
        {
          orgId: '00D000000000001AAA',
          loadedAt: '2026-09-24T10:05:00.000Z',
          created: [
            { objectApiName: 'Contact', count: 2 },
            { objectApiName: 'Account', count: 1 },
          ],
          linked: 4,
          recorded: true,
        },
        'TGT',
      ),
    ).toEqual([
      'the last load wrote to TGT at 2026-09-24T10:05:00.000Z; a removal deletes the 3 record(s) it created, children first:',
      '  Contact: 2',
      '  Account: 1',
      '4 record(s) it linked to or reused stay',
    ]);
  });

  it('says when the load it takes is one before the last', () => {
    expect(
      removalPlanLines(
        {
          orgId: '00D000000000001AAA',
          loadedAt: '2026-09-23T10:05:00.000Z',
          created: [{ objectApiName: 'Account', count: 1 }],
          linked: 0,
          recorded: true,
          earlier: true,
        },
        'TGT',
      )[0],
    ).toBe(
      'a load before the last one, whose records the loads after it left in place, wrote to TGT at 2026-09-23T10:05:00.000Z; a removal deletes the 1 record(s) it created, children first:',
    );
  });
});

describe('removalPlanLines, once a removal left records in the org', () => {
  /** The last load, after a removal that kept its two orders and what hangs from them. */
  const left = {
    orgId: '00D000000000001AAA',
    loadedAt: '2026-09-29T15:49:35.673Z',
    created: [
      { objectApiName: 'OrderItem', count: 6 },
      { objectApiName: 'Order', count: 2 },
      { objectApiName: 'Account', count: 1 },
    ],
    linked: 4,
    recorded: true,
    removed: { removedAt: '2026-09-29T15:51:27.295Z' },
  };

  it('names what the removal left as what the next one deletes', () => {
    expect(removalPlanLines(left, 'TGT')).toEqual([
      'the last load wrote to TGT at 2026-09-29T15:49:35.673Z; the removal of 2026-09-29T15:51:27.295Z left 9 of the records it created, and a removal deletes those, children first:',
      '  OrderItem: 6',
      '  Order: 2',
      '  Account: 1',
      '4 record(s) it linked to or reused stay',
    ]);
  });

  it('says none is left once the removal took them all', () => {
    expect(removalPlanLines({ ...left, created: [] }, 'TGT')[0]).toBe(
      'the last load wrote to TGT at 2026-09-29T15:49:35.673Z; its records were removed on 2026-09-29T15:51:27.295Z, and none is left to remove',
    );
  });

  it('says it keeps what the load created that the platform does not delete', () => {
    expect(
      removalPlanLines(
        {
          ...left,
          created: [],
          keptByThePlatform: [{ objectApiName: 'BusinessHours', count: 1 }],
        },
        'TGT',
      ).at(-1),
    ).toBe('kept: the platform does not delete them — BusinessHours (1)');
  });

  it('says a load whose only records the platform keeps has none a removal takes', () => {
    expect(
      removalPlanLines(
        {
          ...left,
          removed: undefined,
          created: [],
          keptByThePlatform: [{ objectApiName: 'BusinessHours', count: 1 }],
        },
        'TGT',
      ),
    ).toEqual([
      'the last load wrote to TGT at 2026-09-29T15:49:35.673Z; it created no record a removal takes',
      '4 record(s) it linked to or reused stay',
      'kept: the platform does not delete them — BusinessHours (1)',
    ]);
  });
});

describe('removalAsks', () => {
  const loaded = {
    orgId: '00D000000000001AAA',
    loadedAt: '2026-09-29T15:49:35.673Z',
    created: [{ objectApiName: 'Account', count: 1 }],
    linked: 0,
    recorded: true,
  };

  it('asks before deleting what the load created, or what a removal left of it', () => {
    expect(removalAsks(loaded)).toBe(true);
    expect(removalAsks({ ...loaded, removed: { removedAt: '2026-09-29T15:51:27.295Z' } })).toBe(
      true,
    );
  });

  it('does not ask when the handler will refuse: nothing left, or nothing recorded', () => {
    expect(
      removalAsks({
        ...loaded,
        created: [],
        removed: { removedAt: '2026-09-29T15:51:27.295Z' },
      }),
    ).toBe(false);
    expect(removalAsks({ ...loaded, created: [], recorded: false })).toBe(false);
  });

  it('asks before a sweep alone deletes what it found, and of nothing it did not', () => {
    const removed = {
      ...loaded,
      created: [],
      removed: { removedAt: '2026-09-29T15:51:27.295Z' },
    };

    expect(removalAsks(removed, { delete: ['Asset'] })).toBe(true);
    expect(removalAsks(removed, { delete: [] })).toBe(false);
  });
});

describe('messageLines — a selection as it runs', () => {
  it('prints each step of a selection as it starts', () => {
    // Run for real on a large org, select printed nothing for ten minutes.
    const step = (payload: Record<string, unknown>) =>
      messageLines({ type: 'frozen:select:progress', payload });

    expect(step({ phase: 'discovery', objects: 40 })).toEqual([
      '  discovery: 40 object(s) reached',
    ]);
    expect(step({ phase: 'combination', combinationKey: 'origin=Web', index: 2, of: 4 })).toEqual([
      '  combination 2/4: origin=Web',
    ]);
    expect(
      step({ phase: 'candidate', combinationKey: 'origin=Web', candidate: 1, candidates: 3 }),
    ).toEqual(['    candidate 1/3 of origin=Web: measuring its own records…']);
    expect(step({ phase: 'measure', roots: 3 })).toEqual([
      '  measuring the 3 root(s) kept, together…',
    ]);
  });

  it('says where a selection stopped, that what it decided is kept, and what it never reached', () => {
    const lines = messageLines({
      type: 'frozen:select:response',
      payload: {
        selection: {
          combinations: [{ combinationKey: 'origin=Chat' }],
          uncovered: [],
          volumetry: { total: 12, budgetMax: 400, measured: { Case: 1 }, summed: true },
          stopped: {
            reason: 'timeout',
            during: 'combination',
            combinationKey: 'origin=Email',
            candidate: 2,
            candidates: 3,
            notProbed: ['origin=Phone', 'origin=Web'],
          },
        },
      },
    });

    expect(lines).toEqual([
      'selected 1 root(s): origin=Chat',
      'STOPPED: its time ran out while it probed origin=Email, candidate 2 of 3; the combinations decided before are kept',
      '  never probed: origin=Phone, origin=Web',
      "volumetry 12 / 400 record(s) — each kept root's own records added up: they were not measured together",
      '  Case: 1',
    ]);
  });
});

describe('messageLines — where the graph of a step came from', () => {
  it('says a selection rediscovered the graph, and why', () => {
    const lines = messageLines({
      type: 'frozen:select:response',
      payload: {
        selection: {
          combinations: [{ combinationKey: 'stage=Won' }],
          uncovered: [],
          volumetry: { total: 3, budgetMax: 2500, measured: { Opportunity: 1 } },
          graph: { objects: 19, truncated: false, maxNodes: 50 },
          discovery: { rediscovered: 'no graph kept in the sas' },
        },
      },
    });

    expect(lines.slice(1, 3)).toEqual([
      'rediscovered: no graph kept in the sas',
      'graph: 19 object(s) at a cap of 50',
    ]);
  });

  it('says an extraction reused the graph the selection kept', () => {
    const lines = messageLines({
      type: 'frozen:extract:response',
      payload: {
        recordCount: 76,
        datasetDir: '/sas/dataset',
        discovery: { reusedFrom: 'select', discoveredAt: '2026-10-17T08:00:00.000Z' },
        manifest: { version: '0.1.0', volumetry: { measured: {} } },
      },
    });

    expect(lines[1]).toBe(
      "graph reused from select (discovered 2026-10-17T08:00:00.000Z): the source's schema has not changed since",
    );
    expect(discoveryLine({ rediscovered: "the source's schema changed since" })).toBe(
      "rediscovered: the source's schema changed since",
    );
  });
});

describe('what the command says of the record type the target gave', () => {
  const PREDICTED: RecordTypeGiven = {
    objectApiName: 'Opportunity',
    rows: 3,
    why: { masterInSource: 2, dropped: 1 },
    predicted: { developerName: 'SFX_Retail', label: 'SFX Retail', basis: 'onlyOneOpen' },
  };
  const READ_BACK: RecordTypeGiven = {
    ...PREDICTED,
    readBack: {
      read: 3,
      types: [{ developerName: 'SFX_Retail', label: 'SFX Retail', rows: 3 }],
    },
  };
  const report = (recordTypesGiven?: RecordTypeGiven[]) => ({
    type: 'frozen:load:response',
    payload: {
      report: {
        status: 'completed',
        durationMs: 1,
        alignment: { excludedObjects: [], removals: [], recordTypeIssues: [] },
        placeholders: [],
        perObject: [],
        pass2: { resolved: 0, unresolved: [] },
        purge: { deleted: {}, failures: [] },
        ...(recordTypesGiven ? { recordTypesGiven } : {}),
      },
    },
  });

  it('says of a load what the first records were read back holding, and why they went without one', () => {
    const lines = messageLines(report([READ_BACK]));

    expect(lines).toContain(
      'record types the target gave the records created without one (1 object(s)):',
    );
    const line = lines.find((said) => said.startsWith('  Opportunity  3 record(s)'));
    expect(line).toContain('2 on Master in the source');
    expect(line).toContain('1 whose record type the target lacks or keeps from the user');
    expect(line).toContain('SFX_Retail');
  });

  it('says what the describe gave, and why the read failed, when the read back was refused', () => {
    const lines = messageLines(
      report([
        { ...PREDICTED, readBack: { read: 0, types: [], unread: 'REQUEST_LIMIT_EXCEEDED' } },
      ]),
    );

    expect(lines.join('\n')).toContain('could not be read back: REQUEST_LIMIT_EXCEEDED');
  });

  it('says nothing of a load with nothing to say', () => {
    expect(messageLines(report()).join('\n')).not.toContain('record types the target');
  });

  it('says of a dry run what the describe gives, and what a real load’s mute may open', () => {
    const quiet = frozenRecordTypeLines([PREDICTED], true);
    const muted = frozenRecordTypeLines([PREDICTED], true, true);

    expect(quiet[0]).toBe(
      'record types the target would give the records created without one (1 object(s)):',
    );
    expect(quiet.join('\n')).toContain('would go in as SFX_Retail');
    expect(quiet.join('\n')).not.toContain('may open other record types');
    expect(muted.join('\n')).toContain('may open other record types');
    expect(frozenRecordTypeLines(undefined, true, true)).toEqual([]);
  });
});

describe('messageLines', () => {
  it('names the fields the target encrypts that a load leaves out, or would, as maybe masks, and how to write them', () => {
    const removals = [
      { objectApiName: 'Contact', field: 'Legacy__c', reason: 'not-in-target', affectedRecords: 1 },
      { objectApiName: 'Contact', field: 'SSN__c', reason: 'may-hold-masks', affectedRecords: 2 },
    ];
    const said =
      "out, encrypted in the target: Contact.SSN__c (2) — the dataset's manifest does not say its " +
      'extraction left out what it read masked, so they may hold masks such as ****1234; ' +
      '--write-encrypted writes them as the dataset holds them';
    const plan = messageLines({
      type: 'frozen:load:preview:response',
      payload: {
        plan: {
          mode: { pilot: false, reload: false },
          perObject: [],
          excludedObjects: [],
          removals,
          placeholders: [],
          requiredDefaults: [],
          personContacts: 0,
          earlierLoads: 0,
        },
      },
    });
    const load = messageLines({
      type: 'frozen:load:response',
      payload: {
        report: {
          status: 'completed',
          durationMs: 10,
          alignment: { excludedObjects: [], removals, adjustments: [], recordTypeIssues: [] },
          placeholders: [],
          perObject: [],
          pass2: { resolved: 0, unresolved: [] },
          purge: { deleted: {}, failures: [] },
        },
      },
    });

    expect(plan).toContain(`would leave ${said}`);
    expect(load).toContain(`left ${said}`);
  });

  it('says what a dry run of a load found, per object, and that nothing was written', () => {
    const lines = messageLines({
      type: 'frozen:load:preview:response',
      payload: {
        plan: {
          orgId: 'org-dev',
          mode: { pilot: false, reload: true },
          plannedAt: '2026-10-09T10:00:00.000Z',
          perObject: [
            {
              objectApiName: 'Account',
              fromFiles: 3,
              toInsert: 1,
              reusedByKeys: 2,
              reusedFromCatalog: 0,
              fieldsDropped: 1,
              picklistsRewritten: 0,
              notSent: 0,
              toPurge: 4,
              toDeactivate: 0,
            },
            {
              objectApiName: 'Pricebook2',
              fromFiles: 1,
              toInsert: 0,
              reusedByKeys: 0,
              reusedFromCatalog: 1,
              fieldsDropped: 0,
              picklistsRewritten: 2,
              notSent: 0,
              toPurge: 0,
              toDeactivate: 0,
            },
          ],
          excludedObjects: [
            { objectApiName: 'ErrorLog__c', reason: 'Not createable in target org' },
          ],
          removals: [],
          placeholders: [
            {
              objectApiName: 'Contact',
              field: 'Owner__c',
              placeholderObjectApiName: 'User__c',
              placeholderName: 'SANDFORGE-PLACEHOLDER',
              affectedRecords: 2,
            },
          ],
          requiredDefaults: [],
          recordTypeIssues: 0,
          personContacts: 1,
          earlierLoads: 2,
        },
      },
    });

    expect(lines).toEqual([
      'dry run (reload): 1 record(s) to insert, 3 to link, 0 not sent, 4 to purge and 0 to deactivate of 2 earlier load(s) — nothing written',
      '  Account: 1 to insert, 2 found by identity keys, 1 field(s) dropped, 4 to purge of 3',
      '  Pricebook2: 0 to insert, 1 found in the catalog, 2 picklist value(s) rewritten of 1',
      '  ErrorLog__c: not loaded — Not createable in target org',
      'placeholder for Contact.Owner__c: 2 record(s)',
      '1 person account contact(s) go in with their account, not counted above',
    ]);
  });

  it('says what the mute of a load stopped under its lease assigned and took back', () => {
    // Run on the trap org, a reload stopped in its sweep said nothing of its
    // mute, while the org had assigned the bypass set and taken it back.
    const lines = messageLines({
      type: 'frozen:load:error',
      payload: {
        code: 'LOAD_CANCELLED',
        message:
          'The load was cancelled before it created or purged a record: the mapping is left as it was.',
        written: 0,
        mutedAutomation: {
          state: 'muted',
          assigned: ['Trap_Bypass'],
          held: [],
          permissions: ['Trap_Bypass_Flow'],
          silenced: [],
          stillRan: [],
          released: true,
        },
      },
    });

    expect(lines).toContain(
      'mute: assigned Trap_Bypass to the user the run writes as in the target, for the run alone',
    );
    expect(lines).toContain('  taken back: Trap_Bypass, as the run ended');
  });

  it('ends a load stopped before it wrote on a line that says its sas is as it was', () => {
    expect(frozenInterruptedLine('load', false)).toBe(
      'interrupted: the load stopped before it created or purged a record: the sas is as it ' +
        'was, and `remove` has nothing of this load to take back',
    );
    expect(frozenInterruptedLine('load')).toContain('`remove` takes it back');
  });

  it('names in a dry run the lookup filters of what the load inserts, which it cannot check', () => {
    // Run on the trap org, a dry run said 76 to insert, and the filter of the
    // contacts' preferred account refused six: nothing named it.
    const lines = messageLines({
      type: 'frozen:load:preview:response',
      payload: {
        plan: {
          mode: { pilot: false, reload: false },
          perObject: [
            {
              objectApiName: 'Contact',
              fromFiles: 72,
              toInsert: 72,
              reusedByKeys: 0,
              reusedFromCatalog: 0,
              fieldsDropped: 0,
              picklistsRewritten: 0,
              notSent: 0,
              toPurge: 0,
              toDeactivate: 0,
              lookupFilters: [
                { field: 'Preferred_Account__c', referenceTo: ['Account'], records: 72 },
              ],
            },
          ],
          excludedObjects: [],
          removals: [],
          placeholders: [],
          requiredDefaults: [],
          personContacts: 0,
          earlierLoads: 0,
        },
      },
    });

    expect(lines).toContain(
      'Contact: 1 lookup filter(s) of the target, which a preview cannot check — a record whose ' +
        'lookup it refuses is refused, and what hangs from it: Preferred_Account__c (Account, ' +
        '72 record(s))',
    );
  });

  it('counts the contact role the platform writes with its opportunity among what a dry run links, never to insert', () => {
    // The plan of a scratch org's load, the role counted as its load then
    // took it: linked to the one the platform wrote, given its role.
    const object = (objectApiName: string, counts: Record<string, number>) => ({
      objectApiName,
      fromFiles: 1,
      toInsert: 1,
      reusedByKeys: 0,
      reusedFromCatalog: 0,
      fieldsDropped: 0,
      picklistsRewritten: 0,
      notSent: 0,
      toPurge: 0,
      toDeactivate: 0,
      ...counts,
    });
    const lines = messageLines({
      type: 'frozen:load:preview:response',
      payload: {
        plan: {
          mode: { pilot: false, reload: false },
          perObject: [
            object('Contact', {}),
            object('Opportunity', {}),
            object('OpportunityContactRole', { toInsert: 0, writtenByThePlatform: 1 }),
            object('AccountContactRelation', { toInsert: 0, writtenByThePlatform: 1 }),
            object('EmailMessage', {}),
            object('Task', { toInsert: 0, writtenByThePlatform: 1 }),
          ],
          excludedObjects: [],
          removals: [],
          placeholders: [],
          requiredDefaults: [],
          personContacts: 0,
          earlierLoads: 0,
        },
      },
    });

    expect(lines.slice(0, 7)).toEqual([
      'dry run: 3 record(s) to insert, 3 to link, 0 not sent — nothing written',
      '  Contact: 1 to insert of 1',
      '  Opportunity: 1 to insert of 1',
      '  OpportunityContactRole: 0 to insert, 1 to link (written by the platform with their opportunity, for its contact) of 1',
      // A contact's direct relation and an email's task, which the load
      // links as it links the role: its dry run counted them to insert.
      '  AccountContactRelation: 0 to insert, 1 to link (written by the platform with their contact) of 1',
      '  EmailMessage: 1 to insert of 1',
      '  Task: 0 to insert, 1 to link (written by the platform with their email) of 1',
    ]);
  });

  it("says how each record gets a default of its own, what the purge keeps, and the target's validation rules", () => {
    const lines = messageLines({
      type: 'frozen:load:preview:response',
      payload: {
        plan: {
          orgId: 'org-dev',
          mode: { pilot: false, reload: true },
          plannedAt: '2026-10-16T10:00:00.000Z',
          perObject: [
            {
              objectApiName: 'Contact',
              fromFiles: 2,
              toInsert: 2,
              reusedByKeys: 0,
              reusedFromCatalog: 0,
              fieldsDropped: 0,
              picklistsRewritten: 0,
              notSent: 0,
              toPurge: 0,
              toDeactivate: 0,
              validationRules: [
                {
                  name: 'Trap_Email_Required',
                  message: 'An email is required.',
                  field: 'Email',
                },
                { name: 'Trap_Phone_Format', message: '' },
              ],
            },
          ],
          excludedObjects: [],
          removals: [],
          placeholders: [],
          requiredDefaults: [
            {
              objectApiName: 'ServiceTerritory',
              field: 'Name',
              affectedRecords: 2,
              perRecord: 'name',
              example: 'Frozen territory 1',
            },
          ],
          recordTypeIssues: 0,
          personContacts: 0,
          earlierLoads: 1,
          keptByThePlatform: { BusinessHours: 1 },
        },
      },
    });

    expect(lines.slice(2)).toEqual([
      'default for ServiceTerritory.Name: 2 record(s), each record its own, its rank appended: the field is the record name (first: "Frozen territory 1")',
      'left in place by the purge, the platform does not delete them:',
      '  BusinessHours: 1',
      'Contact: 2 active validation rule(s) of the target, which a preview cannot evaluate — a record one of them refuses is counted to insert:',
      '  Trap_Email_Required (Email) — An email is required.',
      '  Trap_Phone_Format',
    ]);
  });

  it('names the rules a preview leaves out of an insert, and lists those of a placeholder', () => {
    const lines = messageLines({
      type: 'frozen:load:preview:response',
      payload: {
        plan: {
          orgId: 'org-dev',
          mode: { pilot: false, reload: false },
          plannedAt: '2026-10-17T10:00:00.000Z',
          perObject: [
            {
              objectApiName: 'Invoice__c',
              fromFiles: 3,
              toInsert: 3,
              reusedByKeys: 0,
              reusedFromCatalog: 0,
              fieldsDropped: 0,
              picklistsRewritten: 0,
              notSent: 0,
              toPurge: 0,
              toDeactivate: 0,
              validationRules: [{ name: 'Amount_Required', message: 'An amount is required.' }],
              validationRulesOnChange: ['NoChangeFromStatusApproved', 'Locked_After_Send'],
            },
          ],
          excludedObjects: [],
          removals: [],
          placeholders: [
            {
              objectApiName: 'Invoice__c',
              field: 'Owner__c',
              placeholderObjectApiName: 'Owner__c',
              placeholderName: 'SANDFORGE-OWNER',
              affectedRecords: 3,
              validationRules: [
                { name: 'Code_Required', message: 'A code is required.', field: 'Code__c' },
              ],
            },
          ],
          requiredDefaults: [],
          recordTypeIssues: 0,
          personContacts: 0,
          earlierLoads: 0,
        },
      },
    });

    expect(lines.slice(2)).toEqual([
      'placeholder for Invoice__c.Owner__c: 3 record(s)',
      'Invoice__c: 1 active validation rule(s) of the target, which a preview cannot evaluate — a record one of them refuses is counted to insert:',
      '  Amount_Required — An amount is required.',
      'Invoice__c: 2 rule(s) left out — their formula holds only on a change of a record (ISCHANGED, PRIORVALUE, NOT(ISNEW())), which an insert never is: NoChangeFromStatusApproved, Locked_After_Send',
      'placeholder of Owner__c: 1 active validation rule(s) of the target, which a preview cannot evaluate — a placeholder one of them refuses stops the load:',
      '  Code_Required (Code__c) — A code is required.',
    ]);
  });

  it("says when the target's validation rules could not be listed", () => {
    const lines = messageLines({
      type: 'frozen:load:preview:response',
      payload: {
        plan: {
          orgId: 'org-dev',
          mode: { pilot: false, reload: false },
          plannedAt: '2026-10-16T10:00:00.000Z',
          perObject: [],
          excludedObjects: [],
          removals: [],
          placeholders: [],
          requiredDefaults: [],
          recordTypeIssues: 0,
          personContacts: 0,
          earlierLoads: 0,
          validationRulesUnread: 'INSUFFICIENT_ACCESS',
        },
      },
    });

    expect(lines.at(-1)).toBe(
      "the target's validation rules could not be listed (INSUFFICIENT_ACCESS): any of them may refuse a record counted to insert",
    );
  });

  it('says a removal kept what the platform does not delete, and a purge too', () => {
    const removal = messageLines({
      type: 'frozen:remove:response',
      payload: {
        operationId: 'frozen-remove-3',
        result: {
          status: 'success',
          includeChanged: false,
          finishedAt: '2026-10-16T16:10:00.000Z',
          objects: [],
          keptByThePlatform: [{ objectApiName: 'BusinessHours', count: 1 }],
        },
      },
    });
    expect(removal.at(-1)).toBe('kept: the platform does not delete them — BusinessHours (1)');

    const load = messageLines({
      type: 'frozen:load:response',
      payload: {
        report: {
          status: 'completed',
          orgId: 'org-dev',
          mode: { pilot: false, reload: true },
          startedAt: '2026-10-16T16:00:00.000Z',
          durationMs: 10,
          alignment: { excludedObjects: [], removals: [], adjustments: [], recordTypeIssues: [] },
          placeholders: [],
          requiredDefaults: [],
          perObject: [],
          pass2: { resolved: 0, unresolved: [] },
          purge: { deleted: { Case: 1 }, failures: [], keptByThePlatform: { BusinessHours: 1 } },
          mappingPath: '',
          contractPath: '',
        },
      },
    });
    expect(load.slice(-2)).toEqual([
      'kept by the purge, the platform does not delete them:',
      '  BusinessHours: 1',
    ]);
  });

  it('names, for a removal stopped part way, the object it never reached and how many records it left', () => {
    // Live: stopped once its contacts were gone, it printed the contacts and
    // nothing of the account it left in the org.
    const counts = { alreadyGone: 0, keptChanged: 0, keptDependents: 0, refused: 0 };
    const lists = { heldBy: [], unchecked: [], reasons: [] };
    const lines = messageLines({
      type: 'frozen:remove:response',
      payload: {
        operationId: 'frozen-remove-4',
        result: {
          status: 'cancelled',
          includeChanged: false,
          finishedAt: '2026-10-23T13:16:27.275Z',
          objects: [
            { objectApiName: 'Contact', planned: 12, deleted: 12, ...counts, ...lists },
            {
              objectApiName: 'Account',
              planned: 1,
              deleted: 0,
              notReached: 1,
              ...counts,
              ...lists,
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      'removal: CANCELLED',
      '  Contact: 12 deleted of 12',
      '  Account: 1 not reached of 1',
    ]);
  });

  it('says a removal took up what an earlier one left', () => {
    const lines = messageLines({
      type: 'frozen:remove:response',
      payload: {
        operationId: 'frozen-remove-2',
        result: {
          status: 'success',
          includeChanged: true,
          finishedAt: '2026-09-29T16:10:00.000Z',
          leftBy: '2026-09-29T15:51:27.295Z',
          objects: [
            {
              objectApiName: 'Order',
              planned: 2,
              deleted: 2,
              alreadyGone: 0,
              keptChanged: 0,
              keptDependents: 0,
              refused: 0,
              heldBy: [],
              unchecked: [],
              reasons: [],
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      'removal: SUCCESS — of what the removal of 2026-09-29T15:51:27.295Z left',
      '  Order: 2 deleted of 2',
    ]);
  });

  it('says what a removal did per object, with the reasons the org gave', () => {
    const outcome = {
      planned: 0,
      deleted: 0,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
      unchecked: [],
      reasons: [],
    };
    const lines = messageLines({
      type: 'frozen:remove:response',
      payload: {
        operationId: 'frozen-remove-1',
        result: {
          status: 'partial',
          includeChanged: false,
          finishedAt: '2026-09-24T11:00:00.000Z',
          objects: [
            { ...outcome, objectApiName: 'Contact', planned: 3, deleted: 2, alreadyGone: 1 },
            {
              ...outcome,
              objectApiName: 'Account',
              planned: 1,
              keptDependents: 1,
              heldBy: ['Case'],
              unchecked: ['ActionableListMember'],
            },
            {
              ...outcome,
              objectApiName: 'Order',
              planned: 1,
              refused: 1,
              reasons: ['DELETE_FAILED: activated order'],
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      'removal: PARTIAL',
      '  Contact: 2 deleted, 1 already gone of 3',
      '  Account: 1 kept for records that stay (Case) of 1',
      '  Order: 1 refused of 1',
      '      DELETE_FAILED: activated order',
      'not checked, deleted with their parent: ActionableListMember',
    ]);
  });

  it('says what the sweep asked with a removal did, before what the removal did', () => {
    const lines = messageLines({
      type: 'frozen:remove:response',
      payload: {
        operationId: 'frozen-remove-1',
        result: {
          status: 'success',
          includeChanged: false,
          finishedAt: '2026-10-16T11:00:00.000Z',
          sweep: {
            status: 'success',
            objects: [
              {
                objectApiName: 'Task',
                found: 3,
                deleted: 3,
                alreadyGone: 0,
                keptChanged: 0,
                refused: 0,
                reasons: [],
              },
            ],
            unread: [],
            handWork: [],
          },
          objects: [
            {
              objectApiName: 'Contact',
              planned: 3,
              deleted: 3,
              alreadyGone: 0,
              keptChanged: 0,
              keptDependents: 0,
              refused: 0,
              heldBy: [],
              unchecked: [],
              reasons: [],
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      'sweep: SUCCESS',
      '  Task: 3 deleted of 3',
      'removal: SUCCESS',
      '  Contact: 3 deleted of 3',
    ]);
  });

  it('lists what a sweep would delete, per object', () => {
    const lines = messageLines({
      type: 'frozen:remove:sweep:response',
      payload: {
        loadedAt: '2026-10-16T10:05:00.000Z',
        listing: {
          window: { from: '2026-10-16T09:59:59Z', to: '2026-10-16T10:06:01Z' },
          looked: ['Contact', 'Task'],
          found: [
            {
              objectApiName: 'Task',
              count: 3,
              names: ['Call'],
              classes: { made: 3, madeOver: 0, late: 0, untied: 0 },
            },
          ],
          unread: [],
          handWork: [],
        },
      },
    });

    expect(lines).toContain(
      'it found 3 record(s) and would delete 3 of them, children first; per object, all it found:',
    );
    expect(lines).toContain('  Task: 3 — 3 made for the run (Call, …)');
  });

  it('lists for a removal asked what is tied to nothing what --sweep-untied would take, and names it no more as kept', () => {
    // Run for real on the trap org, the line refused (exit 2): the list could
    // not show what a removal with --sweep-untied would take.
    const lines = messageLines(
      {
        type: 'frozen:remove:sweep:response',
        payload: {
          loadedAt: '2026-10-16T10:05:00.000Z',
          listing: {
            window: { from: '2026-10-16T09:59:59Z', to: '2026-10-16T10:06:01Z' },
            looked: ['Contact', 'Task'],
            found: [
              {
                objectApiName: 'Task',
                count: 30,
                names: [],
                classes: { made: 0, madeOver: 0, late: 0, untied: 30 },
              },
            ],
            untied: { objects: [{ objectApiName: 'Task', count: 30 }] },
            unread: [],
            handWork: [],
          },
        },
      },
      { sweepUntied: true },
    );

    expect(lines).toContain(
      'it found 30 record(s) and would delete 30 of them, children first; per object, all it found:',
    );
    expect(lines).toContain(
      'with --sweep-untied, it would delete too what is tied to nothing of the run: Task: 30',
    );
    expect(lines.join('\n')).not.toContain('(--sweep-untied takes them)');
  });

  it('counts with a reload’s dry run what --sweep-untied takes, and names it no more as what would take it', () => {
    // Run for real on the trap org: "would delete 1 of them" and "Task: 30
    // (--sweep-untied takes them)", the flag given, and the reload then
    // deleted the 30 tasks.
    const listed = {
      type: 'frozen:remove:sweep:response',
      payload: {
        loadedAt: '2026-10-16T10:05:00.000Z',
        reload: true,
        loads: [
          {
            loadedAt: '2026-10-16T10:05:00.000Z',
            listing: {
              window: { from: '2026-10-16T09:59:59Z', to: '2026-10-16T10:06:01Z' },
              looked: ['Contact', 'Task', 'FeedItem'],
              found: [
                {
                  objectApiName: 'Task',
                  count: 30,
                  names: [],
                  classes: { made: 0, madeOver: 0, late: 0, untied: 30 },
                },
                {
                  objectApiName: 'FeedItem',
                  count: 1,
                  names: [],
                  classes: { made: 1, madeOver: 0, late: 0, untied: 0 },
                },
              ],
              untied: { objects: [{ objectApiName: 'Task', count: 30 }] },
              late: [],
              unread: [],
              handWork: [],
            },
          },
        ],
      },
    };

    const taken = messageLines(listed, { sweepUntied: true });
    expect(taken).toContain(
      'it found 31 record(s) and would delete 31 of them, children first; per object, all it found:',
    );
    expect(taken.join('\n')).not.toContain('--sweep-untied takes them');

    const kept = messageLines(listed);
    expect(kept).toContain(
      'it found 31 record(s) and would delete 1 of them, children first; per object, all it found:',
    );
    expect(kept.join('\n')).toContain('Task: 30 (--sweep-untied takes them)');
  });

  it('counts out of a reload’s list what changed since the load, which the reload keeps unless told to include it', () => {
    // Run for real on the trap org: "would delete 31 of them" above "1 changed
    // since by someone else" — the load's own user had edited it — and the
    // reload then said "Task: 29 deleted, 1 kept, changed since the run of 30".
    const listed = {
      type: 'frozen:remove:sweep:response',
      payload: {
        loadedAt: '2026-11-04T09:27:50.691Z',
        reload: true,
        loads: [
          {
            loadedAt: '2026-11-04T09:27:50.691Z',
            listing: {
              window: { from: '2026-11-04T09:27:44Z', to: '2026-11-04T09:28:47Z' },
              looked: ['Contact', 'Task', 'FeedItem'],
              found: [
                {
                  objectApiName: 'Task',
                  count: 30,
                  names: [],
                  classes: {
                    made: 0,
                    madeOver: 0,
                    late: 0,
                    untied: 30,
                    changed: 1,
                    changedIn: { untied: 1 },
                  },
                },
                {
                  objectApiName: 'FeedItem',
                  count: 1,
                  names: [],
                  classes: { made: 1, madeOver: 0, late: 0, untied: 0, sameSave: 1 },
                },
              ],
              untied: { objects: [{ objectApiName: 'Task', count: 30 }] },
              late: [],
              unread: [],
              handWork: [],
            },
          },
        ],
      },
    };
    const command = (...more: string[]) =>
      parseArgs(
        argv('load', '--config', 'frozen.json', '--target', 'TGT', '--reload', '--sweep', ...more),
      );

    const lines = messageLines(listed, command('--sweep-untied'));
    expect(lines).toContain(
      'it found 31 record(s) and would delete 30 of them, children first; per object, all it found:',
    );
    expect(lines).toContain(
      '  Task: 30 — 30 tied to nothing of the run, 1 of them changed since the run, kept',
    );
    expect(messageLines(listed, command('--sweep-untied', '--include-changed'))).toContain(
      'it found 31 record(s) and would delete 31 of them, children first; per object, all it found:',
    );
  });

  it('says with a reload’s list, read before anything is deleted, what --sweep-untied takes and what it cannot tell from the automation’s', () => {
    // Run for real on the trap org: the dry run of a reload with --sweep-untied
    // counted thirty follow-up tasks among what it deletes, one of them edited
    // by the load's user 48 seconds after the load, and said nothing of hand
    // work, where a --sweep-list of the same load warns of it.
    const lines = messageLines(
      {
        type: 'frozen:remove:sweep:response',
        payload: {
          loadedAt: '2026-11-04T12:01:33.704Z',
          reload: true,
          loads: [
            {
              loadedAt: '2026-11-04T12:01:33.704Z',
              listing: {
                window: { from: '2026-11-04T12:01:29Z', to: '2026-11-04T12:02:31Z' },
                looked: ['Contact', 'Task', 'FeedItem'],
                found: [
                  {
                    objectApiName: 'Task',
                    count: 30,
                    names: [],
                    classes: { made: 0, madeOver: 0, late: 0, untied: 30 },
                  },
                ],
                untied: { objects: [{ objectApiName: 'Task', count: 30 }] },
                late: [],
                unread: [],
                handWork: [],
              },
            },
          ],
        },
      },
      { sweepUntied: true },
    );

    expect(lines).toContain(
      'with --sweep-untied, it would delete too what is tied to nothing of the run: Task: 30',
    );
    expect(lines.at(-1)).toBe(
      "a record made by hand as the run's user anywhere in the run's window with " +
        "--sweep-untied reads as the automation's, and one changed by hand before the run's " +
        'last write as unchanged: check the names before a --sweep',
    );
  });

  it('says beside the error of a reload what its sweep had taken before the load ended', () => {
    // Said in the audit trail alone, under a message that nothing was purged.
    const lines = messageLines({
      type: 'frozen:load:error',
      payload: {
        message:
          'The load was cancelled before it created or purged a record: the mapping is left as it was.',
        code: 'LOAD_CANCELLED',
        sweeps: [
          {
            loadedAt: '2026-10-16T10:05:00.000Z',
            result: {
              status: 'cancelled',
              objects: [
                {
                  objectApiName: 'Task',
                  found: 230,
                  deleted: 200,
                  alreadyGone: 0,
                  keptChanged: 0,
                  refused: 0,
                  reasons: [],
                },
              ],
              unread: [],
              handWork: [],
            },
          },
        ],
      },
    });

    expect(lines[0]).toBe(
      '! frozen:load:error: The load was cancelled before it created or purged a record: the mapping is left as it was. [LOAD_CANCELLED]',
    );
    expect(lines.slice(1, 3)).toEqual([
      'before the load ended, its sweep had already done this:',
      'sweep of the load of 2026-10-16T10:05:00.000Z:',
    ]);
    expect(lines.join('\n')).toContain('Task: 200 deleted of 230');
  });

  it('ends a load refused for its emails on the line a refused run ends on, not on its error', () => {
    const message =
      "The target's automation would make TGT send about 108 single emails, 15 of 15 left today. Nothing was written.";

    expect(
      messageLines({
        type: 'frozen:load:error',
        payload: { message, code: 'FROZEN_EMAILS_EXCEEDED' },
      }),
    ).toEqual([`refused (FROZEN_EMAILS_EXCEEDED): ${message}`]);
  });

  it('says a removal stopped before its first delete as refused, with its code', () => {
    const message =
      'TGT runs automation on the records this removal deletes. Nothing was written or deleted.';

    expect(
      messageLines({
        type: 'frozen:remove:error',
        payload: { message, code: 'AUTOMATION_NOT_ACCEPTED' },
      }),
    ).toEqual([`refused (AUTOMATION_NOT_ACCEPTED): ${message}`]);
  });

  it('says a removal that failed part way as an error, never as refused', () => {
    expect(
      messageLines({
        type: 'frozen:remove:error',
        payload: { message: 'INVALID_SESSION_ID', code: 'REMOVE_ERROR' },
      }),
    ).toEqual(['! frozen:remove:error: INVALID_SESSION_ID [REMOVE_ERROR]']);
  });

  it('says a verification that found the load wrote part of the dataset partial', () => {
    const lines = messageLines({
      type: 'frozen:verify:result',
      payload: {
        verdict: {
          status: 'partial',
          attempts: 2,
          measuredAt: '2026-10-16T11:00:00.000Z',
          checks: [
            {
              name: 'load',
              passed: false,
              detail: '1 record(s) not loaded: 1 refused by the target org.',
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      'verification: PARTIAL',
      '  FAIL load: 1 record(s) not loaded: 1 refused by the target org.',
    ]);
  });

  it('names the files attached to the records a removal deleted, which stay in the org', () => {
    const lines = messageLines({
      type: 'frozen:remove:response',
      payload: {
        operationId: 'frozen-remove-1',
        result: {
          status: 'success',
          includeChanged: true,
          finishedAt: '2026-09-24T11:00:00.000Z',
          objects: [
            {
              objectApiName: 'Order',
              planned: 2,
              deleted: 2,
              alreadyGone: 0,
              keptChanged: 0,
              keptDependents: 0,
              refused: 0,
              heldBy: [],
              unchecked: [],
              reasons: [],
              filesLeft: { count: 2, names: ['Confirmation-0001.pdf', 'Confirmation-0002.pdf'] },
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      'removal: SUCCESS',
      '  Order: 2 deleted of 2',
      '      2 file(s) attached to them stay in the org, as the load did not create them: Confirmation-0001.pdf, Confirmation-0002.pdf',
    ]);
  });

  it('names what a load left to the platform after the objects it wrote', () => {
    const lines = messageLines({
      type: 'frozen:load:response',
      payload: {
        report: {
          status: 'completed',
          durationMs: 5,
          alignment: { excludedObjects: [], removals: [], recordTypeIssues: [] },
          placeholders: [],
          perObject: [
            {
              objectApiName: 'FeedItem',
              fromFiles: 2,
              inserted: 1,
              reused: 0,
              skippedDuplicates: [],
              failed: [],
            },
          ],
          pass2: { resolved: 0, unresolved: [] },
          purge: { deleted: {}, failures: [] },
          leftToThePlatform: [
            {
              objectApiName: 'FeedItem',
              note: '1 tracked change left out: the platform writes them itself',
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      'load: completed in 5ms — 0 object(s) excluded, 0 field removal(s), 0 record type issue(s), 0 placeholder(s)',
      '  FeedItem: 1 inserted, 0 reused, 0 duplicate(s), 0 failed of 2',
      '  FeedItem: 1 tracked change left out: the platform writes them itself',
      'pass 2: 0 resolved, 0 unresolved',
    ]);
  });

  it('says of the contact roles it reused those the platform wrote with their opportunity', () => {
    // Inserted beside the platform's, the source's role left the opportunity
    // two of one contact; linked, the line said "1 reused" and no more.
    const lines = messageLines({
      type: 'frozen:load:response',
      payload: {
        report: {
          status: 'completed',
          durationMs: 5,
          alignment: { excludedObjects: [], removals: [], recordTypeIssues: [] },
          placeholders: [],
          perObject: [
            {
              objectApiName: 'OpportunityContactRole',
              fromFiles: 2,
              inserted: 1,
              reused: 1,
              writtenByThePlatform: 1,
              skippedDuplicates: [],
              failed: [],
            },
          ],
          pass2: { resolved: 0, unresolved: [] },
          purge: { deleted: {}, failures: [] },
        },
      },
    });

    expect(lines[1]).toBe(
      '  OpportunityContactRole: 1 inserted, 1 reused (1 written by the platform with their ' +
        'opportunity, for its contact), 0 duplicate(s), 0 failed of 2',
    );
  });

  it('names each field the target refused records on that went in written again, with what refused it', () => {
    // The Load tab said them, and the command said none: a record in the
    // target short of a value the dataset held read as one written whole.
    const lines = messageLines({
      type: 'frozen:load:response',
      payload: {
        report: {
          status: 'completed',
          durationMs: 5,
          alignment: { excludedObjects: [], removals: [], recordTypeIssues: [] },
          placeholders: [],
          perObject: [
            {
              objectApiName: 'Account',
              fromFiles: 3,
              inserted: 3,
              reused: 0,
              skippedDuplicates: [],
              failed: [],
              writtenWithoutFields: {
                rows: 2,
                fields: [
                  {
                    field: 'Tier__c',
                    refusedBy: 'restricted-picklist',
                    reason: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value: Gold',
                    rows: 1,
                    replacedWith: 'Silver',
                  },
                  {
                    field: 'Phone',
                    refusedBy: 'validation-rule',
                    reason: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33…',
                    rows: 1,
                  },
                ],
              },
            },
          ],
          pass2: { resolved: 0, unresolved: [] },
          purge: { deleted: {}, failures: [] },
        },
      },
    });

    expect(lines).toEqual([
      'load: completed in 5ms — 0 object(s) excluded, 0 field removal(s), 0 record type issue(s), 0 placeholder(s)',
      '  Account: 3 inserted, 0 reused, 0 duplicate(s), 0 failed of 3',
      'written again without a field a validation rule or a restricted picklist refused (1 object(s)):',
      '  Account.Tier__c  1 record(s) — a restricted picklist refused its value — written with ' +
        '"Silver", as its picklist rule declares — INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value: Gold',
      '  Account.Phone  1 record(s) — a validation rule refused it — ' +
        'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33…',
      'pass 2: 0 resolved, 0 unresolved',
    ]);
  });

  it('names each object a load did not send, with why, and the feed items it could not type', () => {
    const lines = messageLines({
      type: 'frozen:load:response',
      payload: {
        report: {
          status: 'completed-with-errors',
          durationMs: 5,
          alignment: {
            excludedObjects: [
              {
                objectApiName: 'RevenueTransactionErrorLog',
                reason: 'Not createable in target org: 1 record of the dataset not loaded',
              },
            ],
            removals: [],
            recordTypeIssues: [],
          },
          placeholders: [],
          perObject: [],
          pass2: { resolved: 0, unresolved: [] },
          purge: { deleted: {}, failures: [] },
          untypedFeedItems: [
            {
              objectApiName: 'FeedItem',
              note: '1 feed item left out: the dataset does not carry its type',
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      'load: completed-with-errors in 5ms — 1 object(s) excluded, 0 field removal(s), 0 record type issue(s), 0 placeholder(s)',
      '  RevenueTransactionErrorLog: not loaded — Not createable in target org: 1 record of the dataset not loaded',
      '  FeedItem: 1 feed item left out: the dataset does not carry its type',
      'pass 2: 0 resolved, 0 unresolved',
    ]);
  });

  it('names the records a load left out for a parent excludedObjects leaves out', () => {
    const lines = messageLines({
      type: 'frozen:load:response',
      payload: {
        report: {
          status: 'completed',
          durationMs: 5,
          alignment: { excludedObjects: [], removals: [], recordTypeIssues: [] },
          placeholders: [],
          perObject: [],
          pass2: { resolved: 0, unresolved: [] },
          purge: { deleted: {}, failures: [] },
          heldForExcludedParents: [
            {
              objectApiName: 'FeedComment',
              note: '2 left out: FeedItemId names a FeedItem record, which excludedObjects leaves out',
            },
          ],
        },
      },
    });

    expect(lines).toContain(
      '  FeedComment: 2 left out: FeedItemId names a FeedItem record, which excludedObjects leaves out',
    );
  });

  it('says which opportunities a load and its dry run leave unsynced with their quote, and why', () => {
    // Synced with a quote whose lines the dataset left out, the opportunity
    // lost the two products the load had just written, and no line said so.
    const note =
      "1 left unsynced with its quote: the load wrote 2 of its products and none of the quote's lines, " +
      'which excludedObjects leaves out — synced, the platform replaces an opportunity’s products';
    const loaded = messageLines({
      type: 'frozen:load:response',
      payload: {
        report: {
          status: 'completed',
          durationMs: 5,
          alignment: { excludedObjects: [], removals: [], recordTypeIssues: [] },
          placeholders: [],
          perObject: [],
          pass2: { resolved: 0, unresolved: [] },
          purge: { deleted: {}, failures: [] },
          quotesLeftUnsynced: [{ objectApiName: 'Opportunity', count: 1, note }],
        },
      },
    });
    const planned = messageLines({
      type: 'frozen:load:preview:response',
      payload: {
        plan: {
          mode: { pilot: false, reload: false },
          perObject: [],
          excludedObjects: [],
          removals: [],
          placeholders: [],
          requiredDefaults: [],
          personContacts: 0,
          earlierLoads: 0,
          quotesLeftUnsynced: [
            { objectApiName: 'Opportunity', count: 1, note: `1 would be ${note.slice(2)}` },
          ],
        },
      },
    });

    expect(loaded).toContain(`  Opportunity: ${note}`);
    expect(planned).toContain(`  Opportunity: 1 would be ${note.slice(2)}`);
  });

  it('says what a reload purged, and what it left of a load that did not say what it created', () => {
    const lines = messageLines({
      type: 'frozen:load:response',
      payload: {
        report: {
          status: 'completed',
          durationMs: 5,
          alignment: { excludedObjects: [], removals: [], recordTypeIssues: [] },
          placeholders: [],
          perObject: [],
          pass2: { resolved: 0, unresolved: [] },
          purge: {
            deleted: { Contact: 2, Account: 1 },
            failures: [],
            leftUnrecorded: { Product2: 3, ProductSellingModel: 1 },
          },
        },
      },
    });

    expect(lines.slice(-4)).toEqual([
      'purge of earlier loads: 3 deleted, 0 deactivated, 0 failed',
      'left in place, of a load recorded before loads kept what they created — it may have linked them:',
      '  Product2: 3',
      '  ProductSellingModel: 1',
    ]);
  });

  it('counts what a reload deactivated beside what it deleted, and a purge that only deactivated', () => {
    // What the target lets no one delete, the purge deactivates: counted as
    // deleted only, a purge that took nothing else printed no line at all.
    const purgeLines = (purge: Record<string, unknown>): string[] =>
      messageLines({
        type: 'frozen:load:response',
        payload: {
          report: {
            status: 'completed',
            durationMs: 5,
            alignment: { excludedObjects: [], removals: [], recordTypeIssues: [] },
            placeholders: [],
            perObject: [],
            pass2: { resolved: 0, unresolved: [] },
            purge,
          },
        },
      }).filter((line) => line.startsWith('purge of earlier loads'));

    expect(
      purgeLines({
        deleted: { Contact: 2 },
        deactivated: { Product2: 1, ProductSellingModel: 2 },
        failures: [],
      }),
    ).toEqual(['purge of earlier loads: 2 deleted, 3 deactivated, 0 failed']);
    expect(purgeLines({ deleted: {}, deactivated: { Product2: 1 }, failures: [] })).toEqual([
      'purge of earlier loads: 0 deleted, 1 deactivated, 0 failed',
    ]);
    expect(purgeLines({ deleted: {}, deactivated: {}, failures: [] })).toEqual([]);
  });

  it("says how many person accounts' contacts a load linked to the platform's, and why it linked none of the others", () => {
    // The Load tab says both; the command said neither.
    const personContactLines = (personContact: Record<string, unknown>): string[] =>
      messageLines({
        type: 'frozen:load:response',
        payload: {
          report: {
            status: 'completed-with-errors',
            durationMs: 5,
            alignment: { excludedObjects: [], removals: [], recordTypeIssues: [] },
            placeholders: [],
            perObject: [],
            pass2: { resolved: 0, unresolved: [] },
            personContact,
            purge: { deleted: {}, failures: [] },
          },
        },
      }).filter((line) => !line.startsWith('load: ') && !line.startsWith('pass 2: '));

    expect(
      personContactLines({
        restored: 2,
        sent: [
          {
            accountReferenceId: 'Account-000004',
            contactReferenceId: 'Contact-000004',
            detail:
              "the target holds the account as a business account, which takes the contact as one of its own: its record type there is no person account's",
          },
        ],
        unresolved: [
          {
            accountReferenceId: 'Account-000003',
            contactReferenceId: 'Contact-000003',
            cause: 'record-not-loaded',
            detail: 'person account was not loaded (see perObject failures/skips)',
          },
        ],
      }),
    ).toEqual([
      'person contacts: 2 linked, 1 sent as contacts of their own, 1 not linked',
      "  Contact-000004 sent: the target holds the account as a business account, which takes the contact as one of its own: its record type there is no person account's",
      '  Contact-000003: person account was not loaded (see perObject failures/skips)',
    ]);
    // A dataset with no person account has no contact to link.
    expect(personContactLines({ restored: 0, unresolved: [] })).toEqual([]);
  });

  it('names what an extraction left to the platform, object by object', () => {
    const lines = messageLines({
      type: 'frozen:extract:response',
      payload: {
        recordCount: 3,
        datasetDir: '/sas/dataset',
        manifest: {
          version: '1.0.0',
          volumetry: { measured: { Opportunity: 1, FeedItem: 1, FeedComment: 1 } },
          coverage: {
            objects: 3,
            truncated: false,
            maxNodes: 50,
            unboundedObjects: [],
            filesLeftOut: [],
            leftToThePlatform: [
              {
                objectApiName: 'FeedItem',
                count: 1,
                note: '1 tracked change left out: the platform writes them itself',
              },
              {
                objectApiName: 'FeedComment',
                count: 1,
                note: '1 left out: FeedItemId names a tracked change, which the platform writes itself',
              },
            ],
          },
        },
      },
    });

    expect(lines).toEqual([
      'frozen 3 record(s) as version 1.0.0 in /sas/dataset',
      'graph: 3 object(s) at a cap of 50',
      'FeedItem: 1 tracked change left out: the platform writes them itself',
      'FeedComment: 1 left out: FeedItemId names a tracked change, which the platform writes itself',
      '  Opportunity: 1',
      '  FeedItem: 1',
      '  FeedComment: 1',
    ]);
  });

  it('says the cap was raised when discovery reached more objects than it', () => {
    // Twice the cap: the parents their records cannot be written without took
    // discovery past it, and the bare count read as the cap not holding.
    const lines = messageLines({
      type: 'frozen:extract:response',
      payload: {
        recordCount: 1,
        datasetDir: '/sas/dataset',
        manifest: {
          version: '1.0.0',
          volumetry: { measured: { Opportunity: 1 } },
          coverage: {
            objects: 100,
            truncated: true,
            maxNodes: 50,
            unboundedObjects: [],
            filesLeftOut: [],
          },
        },
      },
    });

    expect(lines).toContain(
      'graph: 100 object(s) at a cap of 50 (raised for the parents their records cannot be ' +
        'written without) — TRUNCATED: objects further out were not read',
    );
  });

  it('names what the objects excludedObjects leaves out cost the records the dataset holds', () => {
    const lines = messageLines({
      type: 'frozen:extract:response',
      payload: {
        recordCount: 5,
        datasetDir: '/sas/dataset',
        manifest: {
          version: '1.0.0',
          volumetry: { measured: { Opportunity: 1, OpportunityLineItem: 3, Order: 1 } },
          coverage: {
            objects: 50,
            truncated: true,
            maxNodes: 50,
            unboundedObjects: [],
            filesLeftOut: [],
            exclusionCosts: [
              {
                objectApiName: 'OpportunityLineItem',
                excludedObject: 'PricebookEntry',
                count: 3,
                note:
                  '3 OpportunityLineItem records cannot be loaded without the PricebookEntry ' +
                  'their PricebookEntryId names, which excludedObjects leaves out',
              },
            ],
          },
        },
      },
    });

    expect(lines).toContain(
      'OpportunityLineItem: 3 OpportunityLineItem records cannot be loaded without the ' +
        'PricebookEntry their PricebookEntryId names, which excludedObjects leaves out',
    );
  });

  it('names at extraction the required fields the rules leave empty, and what it kept without a rule', () => {
    const lines = messageLines({
      type: 'frozen:extract:response',
      payload: {
        recordCount: 2,
        datasetDir: '/sas/dataset',
        manifest: {
          version: '1.0.0',
          volumetry: { measured: { BusinessHours: 1, OperatingHours: 1 } },
          coverage: {
            objects: 2,
            truncated: false,
            maxNodes: 50,
            unboundedObjects: [],
            filesLeftOut: [],
            requiredLeftEmpty: ['BusinessHours.Name', 'OperatingHours.Name'],
            keptWithoutARule: ['BusinessHours.TimeZoneSidKey', 'OperatingHours.TimeZone'],
          },
        },
      },
    });

    expect(lines).toContain(
      'required in the source and left empty by the rules — a load will ask a value for each: ' +
        'BusinessHours.Name, OperatingHours.Name',
    );
    expect(lines).toContain(
      "kept without a rule, the platform's own words: BusinessHours.TimeZoneSidKey, " +
        'OperatingHours.TimeZone',
    );
  });

  it('names at extraction the encrypted fields it did not keep, read masked', () => {
    const lines = messageLines({
      type: 'frozen:extract:response',
      payload: {
        recordCount: 2,
        datasetDir: '/sas/dataset',
        manifest: {
          version: '1.0.0',
          volumetry: { measured: { Contact: 2 } },
          coverage: {
            objects: 1,
            truncated: false,
            maxNodes: 50,
            unboundedObjects: [],
            filesLeftOut: [],
            encryptedNotKept: ['Contact.SSN__c'],
          },
        },
      },
    });

    expect(lines).toContain(
      'not kept, encrypted and read masked: the user the source is read as lacks View ' +
        'Encrypted Data, and the masks are not copied: Contact.SSN__c',
    );
  });
});

describe('refusedFirstOf', () => {
  const error = (type: string, code: string) => ({
    type,
    payload: { message: `${code} words`, code },
  });

  it('takes the codes the handler refuses a load with before its first write', () => {
    for (const code of [
      'EMAILS_NOT_ACCEPTED',
      'FROZEN_EMAILS_EXCEEDED',
      'AUTOMATION_NOT_ACCEPTED',
      'MUTE_NO_RIGHT',
      'MUTE_PRODUCTION',
      'MUTE_FAILED',
    ]) {
      expect(refusedFirstOf(error('frozen:load:error', code))).toEqual({
        code,
        message: `${code} words`,
      });
    }
  });

  it('takes the codes the handler refuses a removal with before its first delete', () => {
    for (const code of [
      'AUTOMATION_NOT_ACCEPTED',
      'GUARD_BLOCKED',
      // Its question answered no, as the removal's preview says it.
      'GUARD_DECLINED',
      'MUTE_NO_RIGHT',
      'MUTE_FAILED',
    ]) {
      expect(refusedFirstOf(error('frozen:remove:error', code))?.code).toBe(code);
    }
  });

  it('takes the code the handler sends a load or a removal with no Production Guard, and says it as a refusal', () => {
    // The handler sends NOT_INITIALIZED (`PRODUCTION_GUARD_MISSING.code`):
    // looked up by the constant's name, the code was never met, and the step
    // ended on a bare error line with no "refused" for a pipeline to read.
    const load = error('frozen:load:error', 'NOT_INITIALIZED');
    expect(refusedFirstOf(load)).toEqual({
      code: 'NOT_INITIALIZED',
      message: 'NOT_INITIALIZED words',
    });
    expect(refusedFirstOf(error('frozen:remove:error', 'NOT_INITIALIZED'))?.code).toBe(
      'NOT_INITIALIZED',
    );
    expect(messageLines(load)).toEqual(['refused (NOT_INITIALIZED): NOT_INITIALIZED words']);
    expect(refusedFirstOf(error('frozen:load:error', 'PRODUCTION_GUARD_MISSING'))).toBeUndefined();
  });

  it('takes none that may come once records were written or deleted, nor one with nothing to do', () => {
    // Production Guard refusing a batch once others went is a failure with
    // records written; a removal that threw part way posts REMOVE_ERROR.
    expect(refusedFirstOf(error('frozen:load:error', 'GUARD_REFUSED'))).toBeUndefined();
    expect(refusedFirstOf(error('frozen:load:error', 'LOAD_CANCELLED'))).toBeUndefined();
    expect(refusedFirstOf(error('frozen:remove:error', 'REMOVE_ERROR'))).toBeUndefined();
    expect(refusedFirstOf(error('frozen:remove:error', 'NO_LOAD'))).toBeUndefined();
    expect(refusedFirstOf(error('frozen:remove:error', 'REMOVAL_DECLINED'))).toBeUndefined();
    expect(refusedFirstOf(error('frozen:remove:preview:error', 'GUARD_BLOCKED'))).toBeUndefined();
    expect(refusedFirstOf(error('constructor', 'AUTOMATION_NOT_ACCEPTED'))).toBeUndefined();
  });
});
