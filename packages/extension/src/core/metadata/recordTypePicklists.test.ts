import { describe, it, expect } from 'vitest';
import {
  parsePicklistFieldValues,
  parseRecordTypePicklists,
  readPicklistFieldValues,
  readRecordTypePicklists,
  type UiApiConnection,
} from './recordTypePicklists.js';

/** A fake record type id. */
const RETAIL = '012000000000001AAA';

/** One value as the UI API lists it, with the fields it always carries. */
const value = (v: string, validFor: number[] = []) => ({
  attributes: null,
  label: `${v} label`,
  validFor,
  value: v,
});

/** A field's entry as the UI API gives it. */
const entry = (
  values: ReturnType<typeof value>[],
  extra: { controllerValues?: Record<string, number>; defaultValue?: unknown } = {},
) => ({
  controllerValues: extra.controllerValues ?? {},
  defaultValue: extra.defaultValue ?? null,
  eTag: 'etag',
  url: '/services/data/v66.0/ui-api/object-info/Order__c/picklist-values/x/y',
  values,
});

/** A connection that answers every request with `answer`, and keeps what it was asked. */
function connection(answer: unknown): UiApiConnection & { asked: string[] } {
  const asked: string[] = [];
  return {
    version: '66.0',
    asked,
    request: async <T>(url: string): Promise<T> => {
      asked.push(url);
      return answer as T;
    },
  };
}

describe('parseRecordTypePicklists', () => {
  it('reads, per field, the values the record type keeps in the order given, and its default', () => {
    const picklists = parseRecordTypePicklists({
      eTag: 'etag',
      picklistFieldValues: {
        Status__c: entry([value('New'), value('Open')], { defaultValue: value('New') }),
        Channel__c: entry([value('Web')]),
      },
    });

    expect(picklists.get('Status__c')).toEqual({ values: ['New', 'Open'], defaultValue: 'New' });
    expect(picklists.get('Channel__c')).toEqual({ values: ['Web'], defaultValue: null });
  });

  it('reads which values each value of the controlling field allows, for a dependent picklist', () => {
    const picklists = parseRecordTypePicklists({
      picklistFieldValues: {
        Reason__c: entry([value('Late', [0]), value('Broken', [0, 1]), value('Other', [1])], {
          controllerValues: { Open: 0, Closed: 1 },
        }),
        // A checkbox controls by `true` and `false`.
        Detail__c: entry([value('Yes', [1])], { controllerValues: { false: 0, true: 1 } }),
      },
    });

    const reason = picklists.get('Reason__c');
    expect(reason?.allowedByControllingValue?.get('Open')).toEqual(new Set(['Late', 'Broken']));
    expect(reason?.allowedByControllingValue?.get('Closed')).toEqual(new Set(['Broken', 'Other']));
    const detail = picklists.get('Detail__c');
    expect(detail?.allowedByControllingValue?.get('true')).toEqual(new Set(['Yes']));
    expect(detail?.allowedByControllingValue?.get('false')).toEqual(new Set());
  });

  it('says no controlling values of a field that depends on none', () => {
    const picklists = parseRecordTypePicklists({
      picklistFieldValues: { Status__c: entry([value('New')]) },
    });

    expect(picklists.get('Status__c')?.allowedByControllingValue).toBeUndefined();
  });

  it('leaves out a field whose entry is not the shape the UI API gives, and keeps the others', () => {
    const picklists = parseRecordTypePicklists({
      picklistFieldValues: {
        Status__c: entry([value('New')]),
        Broken__c: { values: [{ label: 'no value' }] },
      },
    });

    expect([...picklists.keys()]).toEqual(['Status__c']);
  });

  it('refuses an answer that is not a collection of picklist values', () => {
    expect(() => parseRecordTypePicklists({})).toThrow();
    expect(() => parseRecordTypePicklists([{ errorCode: 'NOT_FOUND' }])).toThrow();
  });
});

describe('parsePicklistFieldValues', () => {
  it("reads the values of one field's answer", () => {
    expect(parsePicklistFieldValues(entry([value('New'), value('Open')]))).toEqual(['New', 'Open']);
  });

  it('refuses an answer with no values', () => {
    expect(() => parsePicklistFieldValues({ message: 'denied' })).toThrow();
  });
});

describe('readRecordTypePicklists', () => {
  it('reads every picklist field of a record type in one request', async () => {
    const conn = connection({
      picklistFieldValues: {
        Status__c: entry([value('New')]),
        Channel__c: entry([value('Web')]),
      },
    });

    const picklists = await readRecordTypePicklists(conn, 'Order__c', RETAIL);

    expect(conn.asked).toEqual([
      `/services/data/v66.0/ui-api/object-info/Order__c/picklist-values/${RETAIL}`,
    ]);
    expect([...picklists.keys()]).toEqual(['Status__c', 'Channel__c']);
  });

  it('refuses a name or an id that is not one before anything is sent', async () => {
    const conn = connection({ picklistFieldValues: {} });

    await expect(readRecordTypePicklists(conn, 'Order__c/../x', RETAIL)).rejects.toThrow(
      'Not an API name',
    );
    await expect(readRecordTypePicklists(conn, 'Order__c', '001000000000001AAA')).rejects.toThrow(
      'Not a record type id',
    );
    expect(conn.asked).toEqual([]);
  });
});

describe('readPicklistFieldValues', () => {
  it('reads the values of one field of a record type', async () => {
    const conn = connection(entry([value('New'), value('Open')]));

    expect(await readPicklistFieldValues(conn, 'Order__c', RETAIL, 'Status__c')).toEqual([
      'New',
      'Open',
    ]);
    expect(conn.asked).toEqual([
      `/services/data/v66.0/ui-api/object-info/Order__c/picklist-values/${RETAIL}/Status__c`,
    ]);
  });
});
