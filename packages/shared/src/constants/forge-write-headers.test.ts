import { describe, it, expect } from 'vitest';
import { AUTO_ASSIGN_HEADER, forgeWriteHeaders } from './forge-write-headers.js';

describe('forgeWriteHeaders', () => {
  it('waives duplicate rules and keeps the assignment rules off by default', () => {
    expect(forgeWriteHeaders({ applyAssignmentRules: false })).toEqual({
      'Sforce-Duplicate-Rule-Header': 'allowSave=true',
      'Sforce-Auto-Assign': 'FALSE',
    });
  });

  it('asks the target to apply its assignment rules when the run does', () => {
    expect(forgeWriteHeaders({ applyAssignmentRules: true })).toEqual({
      'Sforce-Duplicate-Rule-Header': 'allowSave=true',
      'Sforce-Auto-Assign': 'TRUE',
    });
  });

  it('names the header Salesforce reads', () => {
    expect(AUTO_ASSIGN_HEADER).toBe('Sforce-Auto-Assign');
  });

  it('gives each write headers of its own, which a caller may change without touching another', () => {
    const first = forgeWriteHeaders({ applyAssignmentRules: false });
    first['Sforce-Auto-Assign'] = 'TRUE';
    expect(forgeWriteHeaders({ applyAssignmentRules: false })['Sforce-Auto-Assign']).toBe('FALSE');
  });
});
