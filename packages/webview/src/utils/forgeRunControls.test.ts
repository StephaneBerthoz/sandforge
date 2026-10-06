import { describe, expect, it } from 'vitest';
import type { ForgeConfig, ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import {
  branchOf,
  controlRefused,
  filterAllowed,
  withFieldRename,
  withObjectFilter,
  withOwnerMapping,
  withRecordCap,
} from './forgeRunControls';

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: '001000000000001AAA',
  depth: 'direct',
  sourceOrgId: 'org-source',
  targetOrgId: 'org-target',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

const OWNER = '005000000000001AAA';
const NEW_OWNER = '005000000000101AAA';

describe('the controls, written and taken back', () => {
  it('holds an object’s read to a filter, and to none once it is cleared or blank', () => {
    const filtered = withObjectFilter(CONFIG, 'Case', "  Status = 'Open' ");

    expect(filtered.objectSoqlFilters).toEqual({ Case: "Status = 'Open'" });
    expect(withObjectFilter(filtered, 'Case', null)).toEqual(CONFIG);
    expect(withObjectFilter(filtered, 'Case', '   ')).toEqual(CONFIG);
  });

  it('caps every object’s records, and lifts the cap', () => {
    const capped = withRecordCap(CONFIG, 25);

    expect(capped.maxRecordsPerObject).toBe(25);
    expect(withRecordCap(capped, undefined)).toEqual(CONFIG);
  });

  it('gives a source user’s records to a target user, and takes the mapping back', () => {
    const mapped = withOwnerMapping(CONFIG, OWNER, NEW_OWNER);

    expect(mapped.ownerMappings).toEqual({ [OWNER]: NEW_OWNER });
    expect(withOwnerMapping(mapped, OWNER, null)).toEqual(CONFIG);
  });

  it('writes a field under another name, and under its own again', () => {
    const renamed = withFieldRename(CONFIG, 'Account', 'Region__c', 'Area__c');
    const twice = withFieldRename(renamed, 'Account', 'Code__c', 'Ref__c');

    expect(twice.fieldMappings).toEqual({ Account: { Region__c: 'Area__c', Code__c: 'Ref__c' } });
    expect(
      withFieldRename(
        withFieldRename(twice, 'Account', 'Code__c', null),
        'Account',
        'Region__c',
        null,
      ),
    ).toEqual(CONFIG);
  });
});

describe('what the schema refuses', () => {
  it('refuses a filter with a comment marker or a trailing semicolon, as the run is refused', () => {
    expect(filterAllowed("Status = 'Open'")).toBe(true);
    expect(filterAllowed("Status = 'Open' -- all")).toBe(false);
    expect(filterAllowed('Amount > 0;')).toBe(false);
    expect(filterAllowed('x'.repeat(513))).toBe(false);
  });

  it('refuses a part of the config the run would be refused for', () => {
    expect(controlRefused(withOwnerMapping(CONFIG, OWNER, NEW_OWNER), 'ownerMappings')).toBe(false);
    expect(controlRefused(withOwnerMapping(CONFIG, 'not-an-id', NEW_OWNER), 'ownerMappings')).toBe(
      true,
    );
    expect(controlRefused(withRecordCap(CONFIG, 0), 'maxRecordsPerObject')).toBe(true);
    expect(
      controlRefused(withFieldRename(CONFIG, 'Account', 'Region__c', 'Bad name'), 'fieldMappings'),
    ).toBe(true);
    const fiftyOne = Array.from({ length: 51 }, (_, i) => `Object_${String(i)}__c`).reduce(
      (config, object) => withObjectFilter(config, object, 'Name != null'),
      CONFIG,
    );
    expect(controlRefused(fiftyOne, 'objectSoqlFilters')).toBe(true);
  });
});

describe('branchOf', () => {
  const node = (objectApiName: string, level: number): ForgeGraphNode => ({
    objectApiName,
    recordCount: 1,
    fieldCount: 1,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 1,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
  });
  const edge = (sourceObject: string, targetObject: string): ForgeGraphEdge => ({
    sourceObject,
    targetObject,
    relationshipName: `${targetObject}s`,
    type: 'lookup',
  });
  /*
   * An account with its contacts and opportunities; a contact's cases; an
   * opportunity's lines, and the contact roles both a contact and an
   * opportunity reach; the account's owner's parent above it.
   */
  const GRAPH: ForgeGraph = {
    nodes: [
      node('Account', 0),
      node('Contact', 1),
      node('Opportunity', 1),
      node('Case', 2),
      node('OpportunityLineItem', 2),
      node('OpportunityContactRole', 2),
      node('Parent__c', 1),
    ],
    edges: [
      edge('Account', 'Contact'),
      edge('Account', 'Opportunity'),
      edge('Contact', 'Case'),
      edge('Opportunity', 'OpportunityLineItem'),
      edge('Opportunity', 'OpportunityContactRole'),
      edge('Contact', 'OpportunityContactRole'),
      edge('Parent__c', 'Account'),
    ],
    totalRecords: 7,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };

  it('takes the object and what only it reaches, and leaves what another way reaches', () => {
    expect(branchOf(GRAPH, 'Opportunity').sort()).toEqual(['Opportunity', 'OpportunityLineItem']);
    expect(branchOf(GRAPH, 'Contact').sort()).toEqual(['Case', 'Contact']);
  });

  it('takes a leaf alone, and a parent above the root without the root', () => {
    expect(branchOf(GRAPH, 'Case')).toEqual(['Case']);
    expect(branchOf(GRAPH, 'Parent__c')).toEqual(['Parent__c']);
  });
});
