import { describe, it, expect } from 'vitest';
import type { AuditLogEntry } from '@sandforge/shared';
import { auditTrailCsv, auditTrailJson } from './auditTrailExport';

/** A Forge clone, set up as its entry says, with a skipped object. */
const forgeRun: AuditLogEntry = {
  id: 'aud-forge',
  action: 'forge_execute',
  module: 'forge',
  orgId: '00D000000000001AAA',
  orgAlias: 'target-sandbox',
  sourceOrgId: '00D000000000002AAA',
  sourceOrgAlias: 'source-uat',
  operationId: 'op-1',
  outcome: 'partial',
  guard: 'confirmed',
  userId: 'sha256:0123456789ab',
  objects: [
    { objectApiName: 'Account', created: 3, updated: 0, deleted: 0, failed: 1 },
    {
      objectApiName: 'Contract',
      created: 0,
      updated: 0,
      deleted: 0,
      failed: 0,
      skipped: 'uncounted',
    },
  ],
  context: {
    anonymized: true,
    contactPoints: 'neutralized',
    reviewSkipped: false,
    simulatedMinutesBefore: 6,
    firedOnInsert: { flow: 2, trigger: 1, process: 0, workflowRule: 0, unread: ['processes'] },
    firedOnUpdate: { flow: 1, trigger: 0, process: 0, workflowRule: 1 },
    confirmed: ['automation', 'volume'],
    decisions: [
      { kind: 'map_value', count: 2, rows: 9 },
      { kind: 'ignore', count: 1 },
    ],
  },
  details: { contactPoints: 'neutralized', contactPointFields: 2, contactPointValues: 7 },
  timestamp: '2026-10-06T10:00:00.000Z',
};

/** A run a check stopped, whose alias and details a spreadsheet would read as formulas. */
const hostile: AuditLogEntry = {
  id: 'aud-stop',
  action: 'sync_execute',
  module: 'sync',
  orgId: '00D000000000001AAA',
  orgAlias: '=HYPERLINK("http://x","click")',
  outcome: 'stopped',
  objects: [],
  details: { code: '+SUM(A1)', note: 'a "quoted", comma' },
  timestamp: '2026-10-06T09:00:00.000Z',
};

/** The cells of a CSV line written by `csvCell`: quoted, quotes doubled. */
function cells(line: string): string[] {
  return [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
}

describe('auditTrailCsv', () => {
  it('writes a header and a row per entry, in the order given', () => {
    const lines = auditTrailCsv([forgeRun, hostile]).split('\n');

    expect(lines).toHaveLength(3);
    expect(cells(lines[0]).slice(0, 4)).toEqual(['Timestamp', 'Action', 'Module', 'Outcome']);
    expect(cells(lines[1])[0]).toBe('2026-10-06T10:00:00.000Z');
    expect(cells(lines[2])[0]).toBe('2026-10-06T09:00:00.000Z');
  });

  it('says how the run was set up, a column each, and what it did per object', () => {
    const [header, line] = auditTrailCsv([forgeRun]).split('\n');
    const byColumn = Object.fromEntries(cells(header).map((name, i) => [name, cells(line)[i]]));

    expect(byColumn).toMatchObject({
      Outcome: 'partial',
      Guard: 'confirmed',
      'Target org': 'target-sandbox',
      'Source org': 'source-uat',
      'User (hash)': 'sha256:0123456789ab',
      Anonymized: 'yes',
      'Contact points': 'neutralized',
      'Review skipped': 'no',
      'Simulated (min before)': '6',
      'Rehearsed (min before)': '',
      'Flows on insert': '2',
      'Triggers on insert': '1',
      'Flows on update': '1',
      'Triggers on update': '0',
      'Workflow rules on update': '1',
      'Automation unread': 'processes',
      Confirmed: 'automation; volume',
      Decisions: 'map_value 2 (9 rows); ignore 1',
      Objects: 'Account created=3 failed=1; Contract skipped=uncounted',
      Details: 'contactPoints=neutralized; contactPointFields=2; contactPointValues=7',
    });
  });

  it("gives a verification of a run's records its verdict, in a column of its own", () => {
    const verification = {
      ...forgeRun,
      action: 'forge_verify' as const,
      verdict: 'unstable' as const,
    };
    const [header, line] = auditTrailCsv([verification]).split('\n');
    const byColumn = Object.fromEntries(cells(header).map((name, i) => [name, cells(line)[i]]));

    expect(byColumn).toMatchObject({ Action: 'forge_verify', Verdict: 'unstable' });
  });

  it('quotes every cell, its quotes doubled, so a comma or a quote stays in its cell', () => {
    const line = auditTrailCsv([hostile]).split('\n')[1];

    expect(line.startsWith('"')).toBe(true);
    expect(line).toContain('"note=a ""quoted"", comma"');
  });

  it('writes a cell that begins as a formula after a quote mark, read as text', () => {
    const [header, line] = auditTrailCsv([hostile]).split('\n');
    const byColumn = Object.fromEntries(cells(header).map((name, i) => [name, cells(line)[i]]));

    expect(byColumn['Target org']).toBe(`'=HYPERLINK("http://x","click")`);
    expect(byColumn['Code']).toBe(`'+SUM(A1)`);
  });

  it('leaves the columns of how a run was set up empty for an entry that does not say', () => {
    const [header, line] = auditTrailCsv([hostile]).split('\n');
    const byColumn = Object.fromEntries(cells(header).map((name, i) => [name, cells(line)[i]]));

    expect(byColumn['Anonymized']).toBe('');
    expect(byColumn['Review skipped']).toBe('');
    expect(byColumn['Objects']).toBe('');
  });
});

describe('auditTrailJson', () => {
  it('keeps each entry as the trail holds it, with the filters and the time it was made', () => {
    const file = JSON.parse(
      auditTrailJson(
        [forgeRun],
        { module: 'forge', orgId: undefined, action: 'forge_execute' },
        '2026-10-06T12:00:00.000Z',
      ),
    ) as Record<string, unknown>;

    expect(file).toEqual({
      exportedAt: '2026-10-06T12:00:00.000Z',
      filter: { module: 'forge', action: 'forge_execute' },
      total: 1,
      entries: [forgeRun],
    });
  });
});
