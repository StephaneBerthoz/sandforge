import { describe, it, expect, vi, afterEach } from 'vitest';
import { messageLines, parseArgs, removalPlanLines } from './sandforge-frozen.js';

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
});

describe('messageLines', () => {
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
});
