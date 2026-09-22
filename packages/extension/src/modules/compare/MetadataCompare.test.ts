import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetadataCompare, planReads, firstDifference } from './MetadataCompare';
import type { FetchMetadataFn } from './MetadataCompare';
import type { ContentReader, ReadContent } from './ContentReader';
import { DiffEngine } from './DiffEngine';
import type { CompareItem, MetadataComponentType } from '@sandforge/shared';

/** A listing entry the way listMetadata serialises one: an id and dates each org sets. */
function listed(fullName: string, id: string, lastModifiedDate = '2026-01-01T00:00:00.000Z') {
  return JSON.stringify({ fullName, id, lastModifiedDate });
}

/** Each org's listing, per type. */
type Listings = Record<string, Partial<Record<MetadataComponentType, Map<string, string>>>>;

function fetchFrom(listings: Listings): FetchMetadataFn {
  return vi.fn<FetchMetadataFn>((orgId, componentType) =>
    Promise.resolve(listings[orgId]?.[componentType] ?? new Map()),
  );
}

/** What each org holds, by fullName: its content, or `null` for one it hides. */
type Held = Record<string, Record<string, string | null>>;

/** A reader of what `held` says; `'unreadable'` for a reader that cannot read the type. */
function readerOf(held: Held, batch: number | 'unreadable' = 10) {
  const read = vi.fn(
    (orgId: string, _type: MetadataComponentType, names: readonly string[]): Promise<ReadContent> =>
      Promise.resolve(
        new Map(
          names
            .filter((name) => name in (held[orgId] ?? {}))
            .map((name) => [name, held[orgId][name]] as const),
        ),
      ),
  );
  const reader: ContentReader = {
    batchSize: () => (batch === 'unreadable' ? undefined : batch),
    read,
  };
  return { reader, read };
}

const byName = (items: CompareItem[]) => new Map(items.map((item) => [item.fullName, item]));

describe('MetadataCompare', () => {
  let diffEngine: DiffEngine;

  beforeEach(() => {
    diffEngine = new DiffEngine();
  });

  it('lists each type in both orgs', async () => {
    const fetchMetadata = fetchFrom({});
    const { reader } = readerOf({});

    await new MetadataCompare(fetchMetadata, diffEngine, reader).compare('src', 'tgt', [
      'ApexClass',
      'Flow',
    ]);

    expect(fetchMetadata).toHaveBeenCalledWith('src', 'ApexClass');
    expect(fetchMetadata).toHaveBeenCalledWith('tgt', 'ApexClass');
    expect(fetchMetadata).toHaveBeenCalledWith('src', 'Flow');
    expect(fetchMetadata).toHaveBeenCalledWith('tgt', 'Flow');
    expect(fetchMetadata).toHaveBeenCalledTimes(4);
  });

  it('calls a component one org alone holds added or removed, without reading it', async () => {
    const fetchMetadata = fetchFrom({
      src: { ApexClass: new Map([['OldClass', listed('OldClass', '01p1')]]) },
      tgt: { ApexClass: new Map([['NewClass', listed('NewClass', '01p2')]]) },
    });
    const { reader, read } = readerOf({});

    const items = await new MetadataCompare(fetchMetadata, diffEngine, reader).compare(
      'src',
      'tgt',
      ['ApexClass'],
    );

    expect(byName(items).get('OldClass')?.status).toBe('removed');
    expect(byName(items).get('NewClass')?.status).toBe('added');
    expect(read).not.toHaveBeenCalled();
  });

  it('calls a component unchanged when both orgs hold the same content, however their listings differ', async () => {
    // What two sandboxes answered: each org its own id, dates and users for a
    // class whose body is the same byte for byte.
    const fetchMetadata = fetchFrom({
      src: { ApexClass: new Map([['Invoicing', listed('Invoicing', '01pA', '2026-01-05')]]) },
      tgt: { ApexClass: new Map([['Invoicing', listed('Invoicing', '01pB', '2026-03-09')]]) },
    });
    const body = 'public class Invoicing {\n  Integer total;\n}';
    const { reader } = readerOf({ src: { Invoicing: body }, tgt: { Invoicing: body } });

    const [item] = await new MetadataCompare(fetchMetadata, diffEngine, reader).compare(
      'src',
      'tgt',
      ['ApexClass'],
    );

    expect(item.status).toBe('unchanged');
    expect(item.sourceValue).toBeUndefined();
    expect(item.targetValue).toBeUndefined();
  });

  it('calls a component modified when its content differs, and shows where', async () => {
    const same = listed('Invoicing', '01pA');
    const fetchMetadata = fetchFrom({
      src: { ApexClass: new Map([['Invoicing', same]]) },
      tgt: { ApexClass: new Map([['Invoicing', same]]) },
    });
    const { reader } = readerOf({
      src: { Invoicing: 'public class Invoicing {\n  Integer total;\n}' },
      tgt: { Invoicing: 'public class Invoicing {\n  Decimal total;\n}' },
    });

    const [item] = await new MetadataCompare(fetchMetadata, diffEngine, reader).compare(
      'src',
      'tgt',
      ['ApexClass'],
    );

    expect(item.status).toBe('modified');
    expect(item.sourceValue).toBe('1│ public class Invoicing {\n2│   Integer total;\n3│ }');
    expect(item.targetValue).toBe('1│ public class Invoicing {\n2│   Decimal total;\n3│ }');
  });

  it('does not compare a component an org hides, and says so', async () => {
    const fetchMetadata = fetchFrom({
      src: { ApexClass: new Map([['pkg__Engine', listed('pkg__Engine', '01pA')]]) },
      tgt: { ApexClass: new Map([['pkg__Engine', listed('pkg__Engine', '01pB')]]) },
    });
    const { reader } = readerOf({ src: { pkg__Engine: null }, tgt: { pkg__Engine: null } });

    const [item] = await new MetadataCompare(fetchMetadata, diffEngine, reader).compare(
      'src',
      'tgt',
      ['ApexClass'],
    );

    expect(item.status).toBe('not_compared');
    expect(item.notComparedReason).toBe('unreadable');
    expect(item.deployable).toBe(false);
  });

  it('does not compare a component whose read failed in one org, and says so', async () => {
    const fetchMetadata = fetchFrom({
      src: { Flow: new Map([['Onboarding', listed('Onboarding', '301A')]]) },
      tgt: { Flow: new Map([['Onboarding', listed('Onboarding', '301B')]]) },
    });
    const read = vi.fn((orgId: string): Promise<ReadContent> => {
      if (orgId === 'tgt') return Promise.reject(new Error('INVALID_SESSION_ID'));
      return Promise.resolve(new Map([['Onboarding', 'status: "Active"']]));
    });

    const [item] = await new MetadataCompare(fetchMetadata, diffEngine, {
      batchSize: () => 10,
      read,
    }).compare('src', 'tgt', ['Flow']);

    expect(item.status).toBe('not_compared');
    expect(item.notComparedReason).toBe('read_failed');
  });

  it('does not compare a component an org did not return', async () => {
    const same = listed('Region__c', '00N1');
    const fetchMetadata = fetchFrom({
      src: { CustomField: new Map([['Account.Region__c', same]]) },
      tgt: { CustomField: new Map([['Account.Region__c', same]]) },
    });
    const { reader } = readerOf({ src: { 'Account.Region__c': 'type: "Text"' }, tgt: {} });

    const [item] = await new MetadataCompare(fetchMetadata, diffEngine, reader).compare(
      'src',
      'tgt',
      ['CustomField'],
    );

    expect(item.status).toBe('not_compared');
    expect(item.notComparedReason).toBe('read_failed');
  });

  it('does not read a type whose content cannot be read, and calls what both hold unreadable', async () => {
    const fetchMetadata = fetchFrom({
      src: { Other: new Map([['Thing', listed('Thing', 'a')]]) },
      tgt: { Other: new Map([['Thing', listed('Thing', 'b')]]) },
    });
    const { reader, read } = readerOf({}, 'unreadable');

    const [item] = await new MetadataCompare(fetchMetadata, diffEngine, reader).compare(
      'src',
      'tgt',
      ['Other'],
    );

    expect(item.status).toBe('not_compared');
    expect(item.notComparedReason).toBe('unreadable');
    expect(read).not.toHaveBeenCalled();
  });

  it('reads no more than its budget from each org, and says the rest was over it', async () => {
    const names = Array.from({ length: 25 }, (_, i) => `Field${String(i).padStart(2, '0')}__c`);
    const fetchMetadata = fetchFrom({
      src: { CustomField: new Map(names.map((n) => [n, listed(n, `a${n}`)])) },
      tgt: { CustomField: new Map(names.map((n) => [n, listed(n, `b${n}`)])) },
    });
    const everything = Object.fromEntries(names.map((n) => [n, 'type: "Text"']));
    const { reader, read } = readerOf({ src: everything, tgt: everything });

    const items = await new MetadataCompare(fetchMetadata, diffEngine, reader, {
      budget: { components: 12, seconds: 90 },
    }).compare('src', 'tgt', ['CustomField']);

    const readFrom = (orgId: string) =>
      read.mock.calls
        .filter(([org]) => org === orgId)
        .reduce((sum, [, , batch]) => sum + batch.length, 0);
    expect(readFrom('src')).toBe(12);
    expect(readFrom('tgt')).toBe(12);
    expect(items.filter((i) => i.status === 'unchanged')).toHaveLength(12);
    const over = items.filter((i) => i.status === 'not_compared');
    expect(over).toHaveLength(13);
    expect(over.every((i) => i.notComparedReason === 'over_budget')).toBe(true);
  });

  it('reads a type in batches of the size its reader takes', async () => {
    const names = Array.from({ length: 23 }, (_, i) => `Label${i}`);
    const listing = new Map(names.map((n) => [n, listed(n, n)]));
    const fetchMetadata = fetchFrom({
      src: { CustomLabel: listing },
      tgt: { CustomLabel: listing },
    });
    const everything = Object.fromEntries(names.map((n) => [n, 'value: "x"']));
    const { reader, read } = readerOf({ src: everything, tgt: everything }, 10);

    await new MetadataCompare(fetchMetadata, diffEngine, reader).compare('src', 'tgt', [
      'CustomLabel',
    ]);

    const sizes = read.mock.calls.filter(([org]) => org === 'src').map(([, , b]) => b.length);
    expect(sizes.sort((a, b) => b - a)).toEqual([10, 10, 3]);
  });

  it('starts no read once its time is up, and calls what it did not reach over the budget', async () => {
    const names = Array.from({ length: 30 }, (_, i) => `Layout-${String(i).padStart(2, '0')}`);
    const listing = new Map(names.map((n) => [n, listed(n, n)]));
    const fetchMetadata = fetchFrom({ src: { Layout: listing }, tgt: { Layout: listing } });
    const everything = Object.fromEntries(names.map((n) => [n, 'x: 1']));
    const { reader, read } = readerOf({ src: everything, tgt: everything }, 10);
    // Each look at the clock is a minute later: the first batch starts in
    // time, the ones after it do not.
    let minute = 0;
    const now = () => minute++ * 60_000;

    const items = await new MetadataCompare(fetchMetadata, diffEngine, reader, {
      budget: { components: 500, seconds: 90 },
      now,
    }).compare('src', 'tgt', ['Layout']);

    expect(read.mock.calls.filter(([org]) => org === 'src')).toHaveLength(1);
    expect(items.filter((i) => i.status === 'unchanged')).toHaveLength(10);
    expect(
      items.filter((i) => i.status === 'not_compared' && i.notComparedReason === 'over_budget'),
    ).toHaveLength(20);
  });

  it('keeps no more than four batches in flight', async () => {
    const names = Array.from({ length: 100 }, (_, i) => `Report-${i}`);
    const listing = new Map(names.map((n) => [n, listed(n, n)]));
    const fetchMetadata = fetchFrom({ src: { Report: listing }, tgt: { Report: listing } });
    let inFlight = 0;
    let most = 0;
    const read = vi.fn(
      async (_org: string, _type: MetadataComponentType, batch: readonly string[]) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return new Map(batch.map((n) => [n, 'x: 1'] as const));
      },
    );

    await new MetadataCompare(fetchMetadata, diffEngine, { batchSize: () => 10, read }).compare(
      'src',
      'tgt',
      ['Report'],
    );

    // Four batches, each read from both orgs at once.
    expect(most).toBe(8);
    expect(read).toHaveBeenCalledTimes(20);
  });

  it('should return empty array when no types are provided', async () => {
    const fetchMetadata = fetchFrom({});
    const { reader } = readerOf({});

    const items = await new MetadataCompare(fetchMetadata, diffEngine, reader).compare(
      'org-1',
      'org-2',
      [],
    );

    expect(items).toEqual([]);
    expect(fetchMetadata).not.toHaveBeenCalled();
  });

  it('should handle fetch failures by propagating the error', async () => {
    const fetchMetadata = vi
      .fn<FetchMetadataFn>()
      .mockRejectedValue(new Error('Connection failed'));
    const { reader } = readerOf({});

    await expect(
      new MetadataCompare(fetchMetadata, diffEngine, reader).compare('org-1', 'org-2', [
        'ApexClass',
      ]),
    ).rejects.toThrow('Connection failed');
  });
});

describe('planReads', () => {
  const both = (names: string[], differing: string[] = []) => ({
    source: new Map(names.map((n) => [n, `listing-${n}`])),
    target: new Map(names.map((n) => [n, differing.includes(n) ? `other-${n}` : `listing-${n}`])),
  });

  it('reads first the components whose listings differ, since an identical listing is one version copied', () => {
    const plan = planReads(
      [{ componentType: 'Flow', ...both(['A', 'B', 'C', 'D', 'E'], ['D', 'E']) }],
      () => 10,
      2,
    );

    expect(plan.toRead.get('Flow')).toEqual(['D', 'E']);
    expect([...(plan.notCompared.get('Flow') ?? new Map()).entries()]).toEqual([
      ['A', 'over_budget'],
      ['B', 'over_budget'],
      ['C', 'over_budget'],
    ]);
  });

  it('shares the budget across types, so a type of thousands cannot crowd out a small one', () => {
    const fields = Array.from({ length: 1000 }, (_, i) => `F${i}`);
    const plan = planReads(
      [
        { componentType: 'CustomField', ...both(fields, fields) },
        { componentType: 'Flow', ...both(['One', 'Two'], ['One', 'Two']) },
      ],
      () => 10,
      10,
    );

    expect(plan.toRead.get('Flow')).toEqual(['One', 'Two']);
    expect(plan.toRead.get('CustomField')).toHaveLength(8);
  });

  it('spends what is left of the budget on components whose listings match', () => {
    const plan = planReads(
      [{ componentType: 'Layout', ...both(['A', 'B', 'C'], ['C']) }],
      () => 10,
      2,
    );

    expect(plan.toRead.get('Layout')).toEqual(['C', 'A']);
    expect(plan.notCompared.get('Layout')?.get('B')).toBe('over_budget');
  });

  it('plans no read of a type it cannot read', () => {
    const plan = planReads([{ componentType: 'Other', ...both(['X']) }], () => undefined, 10);

    expect(plan.toRead.has('Other')).toBe(false);
    expect(plan.notCompared.get('Other')?.get('X')).toBe('unreadable');
  });
});

describe('firstDifference', () => {
  it('starts three lines before the first line that differs, and numbers the lines', () => {
    const source = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
    const target = ['a', 'b', 'c', 'd', 'e', 'F', 'g'].join('\n');

    expect(firstDifference(source, target)).toEqual({
      source: '…\n3│ c\n4│ d\n5│ e\n6│ f\n7│ g',
      target: '…\n3│ c\n4│ d\n5│ e\n6│ F\n7│ g',
    });
  });

  it('shows the lines one copy has past the end of the other', () => {
    const { source, target } = firstDifference('a\nb', 'a\nb\nc');

    expect(source).toBe('1│ a\n2│ b');
    expect(target).toBe('1│ a\n2│ b\n3│ c');
  });

  it('stops after thirty lines, and shortens a long line', () => {
    const long = 'x'.repeat(500);
    const source = [long, ...Array.from({ length: 50 }, (_, i) => `s${i}`)].join('\n');
    const target = [long.replace(/x$/, 'y'), ...Array.from({ length: 50 }, (_, i) => `t${i}`)].join(
      '\n',
    );

    const excerpt = firstDifference(source, target).source.split('\n');

    expect(excerpt).toHaveLength(31);
    expect(excerpt[0]).toBe(` 1│ ${'x'.repeat(240)}…`);
    expect(excerpt[30]).toBe('…');
  });
});
