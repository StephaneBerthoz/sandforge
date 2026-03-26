import { describe, it, expect } from 'vitest';
import type {
  QuickSyncConfig,
  QuickSyncPreview,
  QuickSyncObjectPreview,
  SmartObjectSuggestion,
  RelationshipSuggestion,
} from './quickSync.types.js';

describe('quickSync.types', () => {
  it('should support QuickSyncConfig creation', () => {
    const config: QuickSyncConfig = {
      sourceOrgId: 'org-src-001',
      targetOrgId: 'org-tgt-002',
      selectedObjects: ['Account', 'Contact'],
      parentObjects: [],
    };
    expect(config.selectedObjects).toHaveLength(2);
    expect(config.parentObjects).toHaveLength(0);
  });

  it('should support QuickSyncPreview with object previews', () => {
    const objectPreview: QuickSyncObjectPreview = {
      objectApiName: 'Account',
      recordCount: 500,
      estimatedApiCalls: 3,
      isParentDependency: false,
    };
    const preview: QuickSyncPreview = {
      objects: [objectPreview],
      totalRecords: 500,
      totalApiCalls: 3,
      estimatedDurationSec: 6,
    };
    expect(preview.objects).toHaveLength(1);
    expect(preview.totalRecords).toBe(500);
  });

  it('should support SmartObjectSuggestion with availability flags', () => {
    const suggestion: SmartObjectSuggestion = {
      objectApiName: 'Account',
      label: 'Account',
      isAvailable: true,
      isAlreadySelected: false,
    };
    expect(suggestion.isAvailable).toBe(true);
    expect(suggestion.isAlreadySelected).toBe(false);
  });

  it('should support RelationshipSuggestion with both relationship types', () => {
    const lookup: RelationshipSuggestion = {
      childObject: 'Opportunity',
      parentObject: 'Account',
      lookupField: 'AccountId',
      relationshipType: 'lookup',
      suggestedInsertOrder: 0,
    };
    const masterDetail: RelationshipSuggestion = {
      childObject: 'OpportunityLineItem',
      parentObject: 'Opportunity',
      lookupField: 'OpportunityId',
      relationshipType: 'masterDetail',
      suggestedInsertOrder: 1,
    };
    expect(lookup.relationshipType).toBe('lookup');
    expect(masterDetail.relationshipType).toBe('masterDetail');
  });
});
