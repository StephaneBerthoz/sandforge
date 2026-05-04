import { describe, it, expect, beforeEach } from 'vitest';
import type { AutopilotEdge } from '@sandforge/shared';
import { RecordIdRemapper } from './RecordIdRemapper';

describe('RecordIdRemapper', () => {
  let remapper: RecordIdRemapper;

  beforeEach(() => {
    remapper = new RecordIdRemapper();
  });

  it('should return correct target ID after registering mappings', () => {
    remapper.registerMappings('Account', [
      ['001xx0001', '001yy0001'],
      ['001xx0002', '001yy0002'],
    ]);

    expect(remapper.getTargetId('Account', '001xx0001')).toBe('001yy0001');
    expect(remapper.getTargetId('Account', '001xx0002')).toBe('001yy0002');
    expect(remapper.getTargetId('Account', '001xx9999')).toBeUndefined();
  });

  it('should maintain separate mapping spaces per object', () => {
    remapper.registerMappings('Account', [['001xx0001', '001yy0001']]);
    remapper.registerMappings('Contact', [['003xx0001', '003yy0001']]);

    expect(remapper.getTargetId('Account', '001xx0001')).toBe('001yy0001');
    expect(remapper.getTargetId('Contact', '003xx0001')).toBe('003yy0001');
    expect(remapper.getTargetId('Account', '003xx0001')).toBeUndefined();
    expect(remapper.getTargetId('Contact', '001xx0001')).toBeUndefined();
  });

  it('should remap a simple lookup (Contact.AccountId)', () => {
    remapper.registerMappings('Account', [
      ['001xx0001', '001yy0001'],
      ['001xx0002', '001yy0002'],
    ]);

    const edges: AutopilotEdge[] = [
      {
        from: 'Account',
        to: 'Contact',
        fieldApiName: 'AccountId',
        relationshipType: 'lookup',
        required: false,
      },
    ];

    const records: Record<string, unknown>[] = [
      { Id: '003xx0001', AccountId: '001xx0001', LastName: 'Smith' },
      { Id: '003xx0002', AccountId: '001xx0002', LastName: 'Jones' },
    ];

    const result = remapper.remapRecords(records, edges, 'Contact');

    expect(result.remapped).toBe(2);
    expect(result.missing).toBe(0);
    expect(result.skipped).toBe(0);
    expect(records[0]['AccountId']).toBe('001yy0001');
    expect(records[1]['AccountId']).toBe('001yy0002');
  });

  it('should increment missing count when source ID has no target mapping', () => {
    remapper.registerMappings('Account', [['001xx0001', '001yy0001']]);

    const edges: AutopilotEdge[] = [
      {
        from: 'Account',
        to: 'Contact',
        fieldApiName: 'AccountId',
        relationshipType: 'lookup',
        required: false,
      },
    ];

    const records: Record<string, unknown>[] = [{ Id: '003xx0001', AccountId: '001xx9999' }];

    const result = remapper.remapRecords(records, edges, 'Contact');

    expect(result.remapped).toBe(0);
    expect(result.missing).toBe(1);
    expect(result.skipped).toBe(0);
    expect(records[0]['AccountId']).toBe('001xx9999');
  });

  it('should skip null and empty field values', () => {
    remapper.registerMappings('Account', [['001xx0001', '001yy0001']]);

    const edges: AutopilotEdge[] = [
      {
        from: 'Account',
        to: 'Contact',
        fieldApiName: 'AccountId',
        relationshipType: 'lookup',
        required: false,
      },
    ];

    const records: Record<string, unknown>[] = [
      { Id: '003xx0001', AccountId: null },
      { Id: '003xx0002', AccountId: undefined },
      { Id: '003xx0003', AccountId: '' },
    ];

    const result = remapper.remapRecords(records, edges, 'Contact');

    expect(result.remapped).toBe(0);
    expect(result.missing).toBe(0);
    expect(result.skipped).toBe(3);
  });

  it('should handle polymorphic lookup (Task.WhatId referencing multiple parent types)', () => {
    remapper.registerMappings('Account', [['001xx0001', '001yy0001']]);
    remapper.registerMappings('Opportunity', [['006xx0001', '006yy0001']]);

    const edges: AutopilotEdge[] = [
      {
        from: 'Account',
        to: 'Task',
        fieldApiName: 'WhatId',
        relationshipType: 'polymorphic',
        required: false,
      },
      {
        from: 'Opportunity',
        to: 'Task',
        fieldApiName: 'WhatId',
        relationshipType: 'polymorphic',
        required: false,
      },
    ];

    const records: Record<string, unknown>[] = [
      { Id: '00Txx0001', WhatId: '001xx0001', Subject: 'Call Account' },
      { Id: '00Txx0002', WhatId: '006xx0001', Subject: 'Call Opp' },
    ];

    const result = remapper.remapRecords(records, edges, 'Task');

    // First record: Account edge matches (001xx0001 found in Account map)
    // Second record: Account edge misses (006xx0001 not in Account map) -> missing++
    //                Opportunity edge matches (006xx0001 found in Opportunity map) -> remapped++
    // The first record also tries Opportunity edge but 001xx0001 not in Opp map -> missing++
    expect(result.remapped).toBe(2);
    expect(result.missing).toBe(2);
    expect(records[0]['WhatId']).toBe('001yy0001');
    expect(records[1]['WhatId']).toBe('006yy0001');
  });

  it('should track missing count for required edges with no target mapping', () => {
    const edges: AutopilotEdge[] = [
      {
        from: 'Account',
        to: 'Contact',
        fieldApiName: 'AccountId',
        relationshipType: 'master_detail',
        required: true,
      },
    ];

    const records: Record<string, unknown>[] = [{ Id: '003xx0001', AccountId: '001xx9999' }];

    const result = remapper.remapRecords(records, edges, 'Contact');

    expect(result.missing).toBe(1);
    expect(result.remapped).toBe(0);
  });

  it('should return correct mapping count per object', () => {
    remapper.registerMappings('Account', [
      ['001xx0001', '001yy0001'],
      ['001xx0002', '001yy0002'],
      ['001xx0003', '001yy0003'],
    ]);
    remapper.registerMappings('Contact', [['003xx0001', '003yy0001']]);

    expect(remapper.getMappingCount('Account')).toBe(3);
    expect(remapper.getMappingCount('Contact')).toBe(1);
    expect(remapper.getMappingCount('Opportunity')).toBe(0);
  });

  it('should return total mappings across all objects', () => {
    remapper.registerMappings('Account', [
      ['001xx0001', '001yy0001'],
      ['001xx0002', '001yy0002'],
    ]);
    remapper.registerMappings('Contact', [['003xx0001', '003yy0001']]);

    expect(remapper.totalMappings).toBe(3);
  });

  it('should clear all mappings', () => {
    remapper.registerMappings('Account', [['001xx0001', '001yy0001']]);
    remapper.registerMappings('Contact', [['003xx0001', '003yy0001']]);

    remapper.clear();

    expect(remapper.totalMappings).toBe(0);
    expect(remapper.hasObject('Account')).toBe(false);
    expect(remapper.hasObject('Contact')).toBe(false);
    expect(remapper.getTargetId('Account', '001xx0001')).toBeUndefined();
  });

  it('should remap a batch of 100 records efficiently', () => {
    const mappings: Array<[string, string]> = [];
    for (let i = 0; i < 100; i++) {
      mappings.push([`001xx${String(i).padStart(4, '0')}`, `001yy${String(i).padStart(4, '0')}`]);
    }
    remapper.registerMappings('Account', mappings);

    const edges: AutopilotEdge[] = [
      {
        from: 'Account',
        to: 'Contact',
        fieldApiName: 'AccountId',
        relationshipType: 'lookup',
        required: false,
      },
    ];

    const records: Record<string, unknown>[] = mappings.map(([sourceId], idx) => ({
      Id: `003xx${String(idx).padStart(4, '0')}`,
      AccountId: sourceId,
      LastName: `Contact_${idx}`,
    }));

    const start = performance.now();
    const result = remapper.remapRecords(records, edges, 'Contact');
    const elapsed = performance.now() - start;

    expect(result.remapped).toBe(100);
    expect(result.missing).toBe(0);
    expect(result.skipped).toBe(0);
    expect(elapsed).toBeLessThan(100);

    for (let i = 0; i < 100; i++) {
      expect(records[i]['AccountId']).toBe(`001yy${String(i).padStart(4, '0')}`);
    }
  });

  it('should handle multiple edges on the same child object (Contact.AccountId + Contact.ReportsToId)', () => {
    remapper.registerMappings('Account', [['001xx0001', '001yy0001']]);
    remapper.registerMappings('Contact', [['003xx0010', '003yy0010']]);

    const edges: AutopilotEdge[] = [
      {
        from: 'Account',
        to: 'Contact',
        fieldApiName: 'AccountId',
        relationshipType: 'lookup',
        required: false,
      },
      {
        from: 'Contact',
        to: 'Contact',
        fieldApiName: 'ReportsToId',
        relationshipType: 'hierarchical',
        required: false,
      },
    ];

    const records: Record<string, unknown>[] = [
      { Id: '003xx0001', AccountId: '001xx0001', ReportsToId: '003xx0010', LastName: 'Smith' },
      { Id: '003xx0002', AccountId: '001xx0001', ReportsToId: null, LastName: 'Jones' },
    ];

    const result = remapper.remapRecords(records, edges, 'Contact');

    expect(result.remapped).toBe(3);
    expect(result.missing).toBe(0);
    expect(result.skipped).toBe(1);
    expect(records[0]['AccountId']).toBe('001yy0001');
    expect(records[0]['ReportsToId']).toBe('003yy0010');
    expect(records[1]['AccountId']).toBe('001yy0001');
    expect(records[1]['ReportsToId']).toBeNull();
  });
});
