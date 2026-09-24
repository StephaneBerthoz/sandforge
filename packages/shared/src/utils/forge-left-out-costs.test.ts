import { describe, it, expect } from 'vitest';

import type { ForgeGraphEdge, ForgeGraphNode } from '../types/forge.types.js';
import { leftOutCosts } from './forge-left-out-costs.js';

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

/** A node the user unchecked on the Forge page. */
function unchecked(objectApiName: string): ForgeGraphNode {
  return node(objectApiName, { included: false, leftOutByUser: true });
}

function edge(sourceObject: string, targetObject: string, required: boolean): ForgeGraphEdge {
  return {
    sourceObject,
    targetObject,
    relationshipName: `${sourceObject}To${targetObject}`,
    type: 'lookup',
    required,
  };
}

/** An opportunity, its line items, and the prices they cannot be written without. */
const LINES = [
  edge('Opportunity', 'OpportunityLineItem', true),
  edge('PricebookEntry', 'OpportunityLineItem', true),
];

describe('leftOutCosts', () => {
  it('costs nothing when the user left nothing out', () => {
    const nodes = [node('Opportunity'), node('OpportunityLineItem'), node('PricebookEntry')];
    expect(leftOutCosts({ nodes, edges: LINES })).toEqual([]);
  });

  it('says which object cannot be written without a record of the object the user left out', () => {
    const nodes = [node('Opportunity'), node('OpportunityLineItem'), unchecked('PricebookEntry')];
    expect(leftOutCosts({ nodes, edges: LINES })).toEqual([
      { leftOut: 'PricebookEntry', object: 'OpportunityLineItem', kind: 'lookup' },
    ]);
  });

  it('costs nothing for a lookup the records may leave empty', () => {
    const nodes = [node('Account'), unchecked('Campaign'), node('Opportunity')];
    expect(
      leftOutCosts({
        nodes,
        edges: [edge('Account', 'Opportunity', false), edge('Campaign', 'Opportunity', false)],
      }),
    ).toEqual([]);
  });

  it('costs nothing for an object the run does not write either', () => {
    const nodes = [
      node('Opportunity'),
      unchecked('OpportunityLineItem'),
      unchecked('PricebookEntry'),
    ];
    expect(leftOutCosts({ nodes, edges: LINES })).toEqual([]);
  });

  it('costs nothing for the objects discovery left out: an empty table, or one it could not read', () => {
    const nodes = [
      node('Opportunity'),
      node('OpportunityLineItem'),
      node('PricebookEntry', { included: false, recordCount: 0 }),
    ];
    expect(leftOutCosts({ nodes, edges: LINES })).toEqual([]);
    const unreadable = node('PricebookEntry', {
      included: false,
      leftOutByUser: true,
      status: 'error',
      errors: ['Describe unavailable: INSUFFICIENT_ACCESS'],
    });
    expect(
      leftOutCosts({
        nodes: [node('Opportunity'), node('OpportunityLineItem'), unreadable],
        edges: LINES,
      }),
    ).toEqual([]);
  });

  it('says the orders past Draft stay drafts when the user left their items out', () => {
    const nodes = [node('Opportunity'), node('Order'), unchecked('OrderItem')];
    expect(
      leftOutCosts({
        nodes,
        edges: [edge('Opportunity', 'Order', false), edge('Order', 'OrderItem', true)],
      }),
    ).toEqual([{ leftOut: 'OrderItem', object: 'Order', kind: 'status' }]);
  });

  it('says the prices sold under a selling model go unwritten without their options, when the run carries the models', () => {
    const withModels = [
      node('Product2'),
      node('ProductSellingModel'),
      node('PricebookEntry'),
      unchecked('ProductSellingModelOption'),
    ];
    expect(leftOutCosts({ nodes: withModels, edges: [] })).toEqual([
      { leftOut: 'ProductSellingModelOption', object: 'PricebookEntry', kind: 'sellingModel' },
    ]);
    // Without the models, no price is written under one.
    const withoutModels = withModels.filter((n) => n.objectApiName !== 'ProductSellingModel');
    expect(leftOutCosts({ nodes: withoutModels, edges: [] })).toEqual([]);
  });

  it('lists every cost, object by object', () => {
    const nodes = [
      node('Opportunity'),
      node('OpportunityLineItem'),
      unchecked('PricebookEntry'),
      node('Order'),
      node('OrderItem'),
      node('Quote'),
      node('QuoteLineItem'),
    ];
    expect(
      leftOutCosts({
        nodes,
        edges: [
          ...LINES,
          edge('PricebookEntry', 'QuoteLineItem', true),
          edge('PricebookEntry', 'OrderItem', true),
          edge('Order', 'OrderItem', true),
        ],
      }).map((cost) => cost.object),
    ).toEqual(['OpportunityLineItem', 'OrderItem', 'QuoteLineItem']);
  });
});
