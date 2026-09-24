import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import '../../i18n';
import { ForgePreviewCard } from './ForgePreviewCard';

function node(objectApiName: string, overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 12,
    fieldCount: 20,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 1,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 15,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
    ...overrides,
  };
}

/** A table discovery counted and found empty, left out as "Skip empty objects" asks. */
function emptyTable(objectApiName: string): ForgeGraphNode {
  return node(objectApiName, { recordCount: 0, included: false });
}

function graphOf(nodes: ForgeGraphNode[]): ForgeGraph {
  return {
    nodes,
    edges: [],
    totalRecords: nodes.reduce((sum, n) => sum + n.recordCount, 0),
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 1,
  };
}

/** What a tile says: its label, its count, and the objects it names. */
function tile(testId: string): string {
  return screen.getByTestId(testId).textContent ?? '';
}

function renderCard(nodes: ForgeGraphNode[]): void {
  render(<ForgePreviewCard graph={graphOf(nodes)} plan={null} cycleCount={0} truncated={false} />);
}

describe('ForgePreviewCard', () => {
  it('counts the empty tables discovery left out as empty, and only what the user left out as excluded', () => {
    // With "Skip empty objects" on, discovery leaves every empty table out,
    // and the tile counted each as excluded: a clone of one opportunity read
    // hundreds of objects "Skipped (excluded)" that nobody had unchecked, and
    // none "Skipped (empty)".
    renderCard([
      node('Opportunity', { level: 0 }),
      node('OpportunityLineItem', { recordCount: 30 }),
      emptyTable('Quote'),
      emptyTable('Case'),
      emptyTable('Contract'),
      node('Contact', { recordCount: 8, included: false, leftOutByUser: true }),
    ]);

    expect(tile('forge-preview-skipped-excluded')).toBe('Skipped (excluded)1Contact');
    expect(tile('forge-preview-skipped-empty')).toBe('Skipped (empty)3Quote, Case, Contract');
    expect(tile('forge-preview-clone')).toBe(
      'Will clone2 objects · 42 recordsOpportunity, OpportunityLineItem',
    );
  });

  it('counts an empty table the user left out as the user’s', () => {
    // Without "Skip empty objects", discovery keeps the empty tables in: one
    // unchecked then is left out by the user, whatever it counts.
    renderCard([
      node('Opportunity', { level: 0 }),
      node('Quote', { recordCount: 0, included: false, leftOutByUser: true }),
    ]);

    expect(tile('forge-preview-skipped-excluded')).toBe('Skipped (excluded)1Quote');
    expect(tile('forge-preview-skipped-empty')).toBe('Skipped (empty)0');
  });

  it('keeps an object discovery could not count among the excluded, never among the empty tables', () => {
    // Its count failed, so it may hold records: the run cannot read it either.
    renderCard([
      node('Opportunity', { level: 0 }),
      node('Invoice__c', {
        recordCount: 0,
        included: false,
        status: 'error',
        errors: ['Record count unavailable: INVALID_TYPE_FOR_OPERATION'],
      }),
      emptyTable('Quote'),
    ]);

    expect(tile('forge-preview-skipped-excluded')).toBe('Skipped (excluded)1Invoice__c');
    expect(tile('forge-preview-skipped-empty')).toBe('Skipped (empty)1Quote');
  });

  it('still counts an object left in with no record as empty, and the reference data as mapped', () => {
    renderCard([
      node('Opportunity', { level: 0 }),
      node('Quote', { recordCount: 0 }),
      node('BusinessHours', { included: false }),
    ]);

    expect(tile('forge-preview-skipped-empty')).toBe('Skipped (empty)1Quote');
    expect(tile('forge-preview-map')).toBe('Will map1BusinessHours');
    expect(tile('forge-preview-skipped-excluded')).toBe('Skipped (excluded)0');
  });
});
