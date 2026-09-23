import { describe, it, expect } from 'vitest';
import {
  changeEventChannel,
  compoundPartField,
  isOwnWrite,
  objectOfChangeEntity,
  parseChangeEvent,
  REALTIME_CLIENT_ID,
} from './changeEvent';

/** A change event as a live sandbox delivered it over CometD, ids replaced. */
function message(header: Record<string, unknown>, fields: Record<string, unknown> = {}) {
  return {
    schema: 'schema-id',
    payload: {
      ChangeEventHeader: {
        commitNumber: 1,
        commitUser: '005000000000001AAA',
        sequenceNumber: 1,
        entityName: 'Lead',
        changeType: 'UPDATE',
        changedFields: [],
        changeOrigin: 'com/salesforce/api/rest/66.0',
        transactionKey: 'txn-1',
        commitTimestamp: 1_790_124_540_000,
        recordIds: ['00Q000000000001AAA'],
        ...header,
      },
      ...fields,
    },
    event: { replayId: 42 },
  };
}

describe('parseChangeEvent', () => {
  it('reads the header of a change and the values it carries', () => {
    const event = parseChangeEvent(
      '/data/LeadChangeEvent',
      message(
        { changedFields: ['Title', 'LastModifiedDate'] },
        { LastModifiedDate: '2026-09-23T00:49:00.000Z', Title: 'probe-updated' },
      ),
    );

    expect(event).toEqual({
      channel: '/data/LeadChangeEvent',
      replayId: 42,
      objectApiName: 'Lead',
      changeType: 'UPDATE',
      recordIds: ['00Q000000000001AAA'],
      commitTimestamp: 1_790_124_540_000,
      commitUser: '005000000000001AAA',
      transactionKey: 'txn-1',
      changeOrigin: 'com/salesforce/api/rest/66.0',
      changedFieldNames: ['Title', 'LastModifiedDate'],
      values: { LastModifiedDate: '2026-09-23T00:49:00.000Z', Title: 'probe-updated' },
    });
  });

  it('writes the parts of a compound field to the fields they stand for', () => {
    // A creation sends `Name: { FirstName, LastName }` and a Lead's plain
    // `Address: { City }`; an update names the parts with a dot.
    const created = parseChangeEvent(
      '/data/LeadChangeEvent',
      message(
        { changeType: 'CREATE' },
        {
          Name: { FirstName: 'Probe', LastName: 'SandForge CDC probe' },
          Address: { City: 'Testville' },
          Company: 'Acme',
        },
      ),
    );
    expect(created.values).toEqual({
      FirstName: 'Probe',
      LastName: 'SandForge CDC probe',
      City: 'Testville',
      Company: 'Acme',
    });

    const updated = parseChangeEvent(
      '/data/LeadChangeEvent',
      message(
        { changedFields: ['Title', 'Name.FirstName', 'Address.Street'] },
        { Name: { FirstName: 'Probe2' }, Address: { Street: '1 Test Street' }, Title: null },
      ),
    );
    expect(updated.changedFieldNames).toEqual(['Title', 'FirstName', 'Street']);
    expect(updated.values).toEqual({ FirstName: 'Probe2', Street: '1 Test Street', Title: null });
  });

  it('keeps a cleared field as null, whether the value or a nulled list says so', () => {
    const inline = parseChangeEvent('/data/LeadChangeEvent', message({}, { Title: null }));
    expect(inline.values).toEqual({ Title: null });

    const listed = parseChangeEvent(
      '/data/AccountChangeEvent',
      message({ entityName: 'Account', nulledFields: ['Phone', 'BillingAddress.City'] }),
    );
    expect(listed.values).toEqual({ Phone: null, BillingCity: null });
  });

  it('reads a deletion, which carries no field', () => {
    const event = parseChangeEvent('/data/LeadChangeEvent', message({ changeType: 'DELETE' }));
    expect(event.changeType).toBe('DELETE');
    expect(event.values).toEqual({});
  });

  it('names what is missing when a message is not a change event', () => {
    expect(() =>
      parseChangeEvent('/data/LeadChangeEvent', { event: { replayId: 1 }, payload: {} }),
    ).toThrow(/not a change event \(payload\.ChangeEventHeader:/);
    expect(() => parseChangeEvent('/data/LeadChangeEvent', 'hello')).toThrow(/not a change event/);
  });
});

describe('change event channels', () => {
  it('names the channel of a standard and of a custom object', () => {
    expect(changeEventChannel('Lead')).toBe('/data/LeadChangeEvent');
    expect(changeEventChannel('Invoice__c')).toBe('/data/Invoice__ChangeEvent');
    expect(changeEventChannel('ns__Invoice__c')).toBe('/data/ns__Invoice__ChangeEvent');
  });

  it('reads the object back from a selected entity, and nothing from another name', () => {
    expect(objectOfChangeEntity('LeadChangeEvent')).toBe('Lead');
    expect(objectOfChangeEntity('Invoice__ChangeEvent')).toBe('Invoice__c');
    expect(objectOfChangeEntity('Invoice__e')).toBeNull();
    expect(objectOfChangeEntity('ChangeEvent')).toBeNull();
  });

  it('writes an address part with the prefix of its compound field', () => {
    expect(compoundPartField('BillingAddress', 'City')).toBe('BillingCity');
    expect(compoundPartField('Address', 'Street')).toBe('Street');
    expect(compoundPartField('Name', 'LastName')).toBe('LastName');
    expect(compoundPartField('Site__c', 'City')).toBe('Site__City__s');
  });
});

describe('isOwnWrite', () => {
  it('knows a change the real-time client made, and only that one', () => {
    expect(
      isOwnWrite({ changeOrigin: `com/salesforce/api/rest/66.0;client=${REALTIME_CLIENT_ID}` }),
    ).toBe(true);
    expect(isOwnWrite({ changeOrigin: 'com/salesforce/api/rest/66.0;client=SomeoneElse' })).toBe(
      false,
    );
    expect(isOwnWrite({ changeOrigin: 'com/salesforce/api/rest/66.0' })).toBe(false);
    expect(isOwnWrite({ changeOrigin: '' })).toBe(false);
  });
});
