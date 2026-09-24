import { describe, it, expect, vi, afterEach } from 'vitest';
import { messageLines, parseArgs } from './sandforge-frozen.js';

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
    expect(message).toContain('select, extract, load, verify, status');
  });

  it('refuses a line with no configuration', () => {
    expect(refuse('status').code).toBe(2);
  });

  it('refuses a step without the org it needs', () => {
    expect(refuse('select', '--config', 'f.json').message).toContain('--source');
    expect(refuse('verify', '--config', 'f.json').message).toContain('--target');
  });
});

describe('messageLines', () => {
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
