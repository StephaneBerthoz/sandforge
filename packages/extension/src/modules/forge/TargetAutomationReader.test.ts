import { describe, it, expect } from 'vitest';
import type {
  ForgeGraph,
  ForgeGraphEdge,
  ForgeGraphNode,
  ForgeTargetAutomation,
} from '@sandforge/shared';
import {
  CONDITIONS_BOUND,
  FLOWS_SOQL,
  TRIGGERS_SOQL,
  TargetAutomationReader,
  answerOf,
  automationLines,
  conditionSoql,
  objectsTheRunWrites,
  permissionsNamed,
  type QueryAnswer,
  type TargetAutomationDeps,
} from './TargetAutomationReader.js';

/** A node of a discovered graph, included unless told. */
function node(objectApiName: string, overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 1,
    fieldCount: 5,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 5,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
    ...overrides,
  };
}

/** A lookup of `child` at `parent`, one the child cannot be written without unless told. */
function edge(parent: string, child: string, required = true): ForgeGraphEdge {
  return {
    sourceObject: parent,
    targetObject: child,
    relationshipName: parent,
    type: 'lookup',
    required,
  };
}

function graph(
  nodes: ForgeGraphNode[],
  edges: ForgeGraphEdge[] = [],
): Pick<ForgeGraph, 'nodes' | 'edges'> {
  return { nodes, edges };
}

const PRICES = [
  'PricebookEntry',
  'Product2',
  'ProductSellingModel',
  'ProductSellingModelOption',
  'Pricebook2',
];

describe('objectsTheRunWrites', () => {
  it('names the objects the graph includes, but the reference data the run matches by name', () => {
    const written = objectsTheRunWrites(
      graph([
        node('Case'),
        node('Contact'),
        node('BusinessHours'),
        node('CaseComment', { included: false, leftOutByUser: true }),
      ]),
    );
    expect(written).toEqual(['Case', 'Contact']);
  });

  it('leaves out an object the run leaves out by name', () => {
    expect(
      objectsTheRunWrites(graph([node('Case'), node('Contact')]), new Set(['Contact'])),
    ).toEqual(['Case']);
  });

  it('adds the catalog past the graph when a line cannot be written without its price', () => {
    // Discovery stopped at its cap before the catalog: the run adds the price
    // a line names, and what that price names, whatever the graph holds.
    const written = objectsTheRunWrites(
      graph(
        [node('Opportunity'), node('OpportunityLineItem')],
        [edge('Opportunity', 'OpportunityLineItem'), edge('PricebookEntry', 'OpportunityLineItem')],
      ),
    );
    expect(written).toEqual(['Opportunity', 'OpportunityLineItem', ...PRICES]);
  });

  it('adds none of the catalog for a lookup a record can be written without', () => {
    // A case's product is optional: the run never follows it past the graph.
    const written = objectsTheRunWrites(graph([node('Case')], [edge('Product2', 'Case', false)]));
    expect(written).toEqual(['Case']);
  });

  it('adds no object of the catalog the graph holds and leaves out', () => {
    const written = objectsTheRunWrites(
      graph(
        [
          node('OpportunityLineItem'),
          node('PricebookEntry', { included: false, leftOutByUser: true }),
        ],
        [edge('PricebookEntry', 'OpportunityLineItem')],
      ),
    );
    expect(written).toEqual(['OpportunityLineItem']);
  });

  it("adds an order's items when discovery stopped before them, and the prices they name", () => {
    expect(objectsTheRunWrites(graph([node('Order')]))).toEqual(['Order', 'OrderItem', ...PRICES]);
  });

  it('adds no item of an order when the run leaves the items out by name', () => {
    expect(objectsTheRunWrites(graph([node('Order')]), new Set(['OrderItem']))).toEqual(['Order']);
  });

  it("adds a product assignment's category, and the catalog that holds it", () => {
    const written = objectsTheRunWrites(
      graph(
        [node('Product2'), node('ProductCategoryProduct')],
        [
          edge('Product2', 'ProductCategoryProduct'),
          edge('ProductCategory', 'ProductCategoryProduct'),
        ],
      ),
    );
    expect(written).toEqual([
      'Product2',
      'ProductCategoryProduct',
      'ProductCategory',
      'ProductCatalog',
    ]);
  });
});

describe('permissionsNamed', () => {
  const withFormula = (filterFormula: string) => ({ filterFormula, filters: [] });

  it('reads a negated permission as one that keeps the flow quiet for its holder', () => {
    expect(permissionsNamed(withFormula('NOT({!$Permission.Case_BypassFlow})'))).toEqual([
      { name: 'Case_BypassFlow', bypass: true },
    ]);
  });

  it('reads a negated permission among the terms the formula requires together', () => {
    expect(
      permissionsNamed(
        withFormula("AND(NOT({!$Permission.Bypass_All}), ISPICKVAL({!$Record.Status}, 'New'))"),
      ),
    ).toEqual([{ name: 'Bypass_All', bypass: true }]);
    expect(
      permissionsNamed(withFormula("NOT({!$Permission.Bypass_All}) && {!$Record.Origin} = 'Web'")),
    ).toEqual([{ name: 'Bypass_All', bypass: true }]);
  });

  it('reads a permission compared with false, or unlike true, as a bypass, and like true as not', () => {
    for (const formula of [
      '{!$Permission.Load_Data} = false',
      'FALSE == {!$Permission.Load_Data}',
      '{!$Permission.Load_Data} <> TRUE',
      'true != {!$Permission.Load_Data}',
    ]) {
      expect(permissionsNamed(withFormula(formula)), formula).toEqual([
        { name: 'Load_Data', bypass: true },
      ]);
    }
    expect(permissionsNamed(withFormula('{!$Permission.Load_Data} = true'))).toEqual([
      { name: 'Load_Data', bypass: false },
    ]);
  });

  it('reads each permission of a negated alternative as a bypass', () => {
    expect(
      permissionsNamed(withFormula('NOT(OR({!$Permission.Bypass_B}, {!$Permission.Bypass_A}))')),
    ).toEqual([
      { name: 'Bypass_A', bypass: true },
      { name: 'Bypass_B', bypass: true },
    ]);
    expect(
      permissionsNamed(withFormula('NOT({!$Permission.Bypass_A} || {!$Permission.Bypass_B})')),
    ).toEqual([
      { name: 'Bypass_A', bypass: true },
      { name: 'Bypass_B', bypass: true },
    ]);
  });

  it('reads no bypass where holding the permission alone does not keep the flow from starting', () => {
    // An alternative: the flow starts on the other branch all the same.
    expect(permissionsNamed(withFormula('OR(NOT({!$Permission.Bypass_A}), ISNEW())'))).toEqual([
      { name: 'Bypass_A', bypass: false },
    ]);
    // Both needed together: one alone keeps nothing quiet.
    expect(
      permissionsNamed(withFormula('NOT(AND({!$Permission.Bypass_A}, {!$Permission.Bypass_B}))')),
    ).toEqual([
      { name: 'Bypass_A', bypass: false },
      { name: 'Bypass_B', bypass: false },
    ]);
    // Held, it is what starts the flow.
    expect(permissionsNamed(withFormula('{!$Permission.Run_Sync}'))).toEqual([
      { name: 'Run_Sync', bypass: false },
    ]);
  });

  it('reads the parentheses of a string as text, not as the formula', () => {
    expect(
      permissionsNamed(
        withFormula('AND(NOT({!$Permission.Bypass_A}), {!$Record.Subject} <> "closed (spam")'),
      ),
    ).toEqual([{ name: 'Bypass_A', bypass: true }]);
  });

  it('reads a NOT quoted without its parentheses for the one permission it names', () => {
    expect(permissionsNamed(withFormula('NOT {!$Permission.Case_BypassFlow}'))).toEqual([
      { name: 'Case_BypassFlow', bypass: true },
    ]);
  });

  it('names a permission a condition compares a field with, as no bypass', () => {
    const start = {
      filterFormula: null,
      filters: [
        {
          field: 'IsEscalated',
          operator: 'EqualTo',
          value: { elementReference: '$Permission.Escalate' },
        },
      ],
    };
    expect(permissionsNamed(start)).toEqual([{ name: 'Escalate', bypass: false }]);
  });

  it('names nothing for a start that names no permission, or no start', () => {
    expect(permissionsNamed(withFormula("ISPICKVAL({!$Record.Status}, 'New')"))).toEqual([]);
    expect(permissionsNamed(undefined)).toEqual([]);
  });
});

/** A row of `FlowDefinitionView`, as the org answers it. */
function flowRow(
  objectApiName: string,
  apiName: string,
  triggerType: string,
  recordTriggerType: string,
  versionId = `301000000000${String(apiName.length).padStart(3, '0')}AAA`,
): Record<string, unknown> {
  return {
    ApiName: apiName,
    Label: apiName.replace(/_/g, ' '),
    TriggerType: triggerType,
    RecordTriggerType: recordTriggerType,
    TriggerObjectOrEvent: { QualifiedApiName: objectApiName },
    ActiveVersionId: versionId,
  };
}

/** A row of the Tooling API's `ApexTrigger`, running on the events given. */
function triggerRow(
  objectApiName: string,
  name: string,
  events: string[],
  namespace: string | null = null,
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    Name: name,
    NamespacePrefix: namespace,
    TableEnumOrId: objectApiName,
    EntityDefinition: { QualifiedApiName: objectApiName },
  };
  for (const flag of [
    'UsageBeforeInsert',
    'UsageAfterInsert',
    'UsageBeforeUpdate',
    'UsageAfterUpdate',
    'UsageBeforeDelete',
    'UsageAfterDelete',
    'UsageAfterUndelete',
  ]) {
    row[flag] = events.includes(flag);
  }
  return row;
}

const answer = (records: Array<Record<string, unknown>>): QueryAnswer => ({ records, requests: 1 });

/**
 * A target answering the read: its flows, its triggers, and the start of each
 * flow version, by id. What it was asked is recorded, and how many condition
 * reads were in flight at most.
 */
function fakeTarget({
  flows = [],
  triggers = [],
  starts = {},
  refuse = {},
}: {
  flows?: Array<Record<string, unknown>>;
  triggers?: Array<Record<string, unknown>>;
  starts?: Record<string, unknown>;
  refuse?: { flows?: Error; triggers?: Error; conditions?: Record<string, Error> };
}) {
  const asked: string[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const deps: TargetAutomationDeps = {
    query: async (_orgId, soql) => {
      asked.push(soql);
      if (soql !== FLOWS_SOQL) throw new Error(`unexpected query ${soql}`);
      if (refuse.flows) throw refuse.flows;
      return answer(flows);
    },
    toolingQuery: async (_orgId, soql) => {
      asked.push(soql);
      if (soql === TRIGGERS_SOQL) {
        if (refuse.triggers) throw refuse.triggers;
        return answer(triggers);
      }
      const id = /WHERE Id = '(\w+)'/.exec(soql)?.[1] ?? '';
      inFlight++;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      const refused = refuse.conditions?.[id];
      if (refused) throw refused;
      return answer([{ Metadata: { start: starts[id] ?? { filterFormula: null, filters: [] } } }]);
    },
  };
  return { deps, asked, mostInFlight: () => mostInFlight };
}

/** An error as jsforce raises one for an org's refusal. */
function refusal(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: code, errorCode: code });
}

describe('TargetAutomationReader', () => {
  it('lists, per object the run writes and in its order, the flows and triggers the target runs there', async () => {
    const target = fakeTarget({
      flows: [
        flowRow('Case', 'Case_Notify_Customer', 'RecordAfterSave', 'Create', '301000000000001AAA'),
        flowRow(
          'Case',
          'Case_Defaults',
          'RecordBeforeSave',
          'CreateAndUpdate',
          '301000000000002AAA',
        ),
        flowRow('Contact', 'Contact_Cleanup', 'RecordBeforeDelete', 'Delete', '301000000000003AAA'),
        // Not an object the run writes.
        flowRow('Lead', 'Lead_Routing', 'RecordAfterSave', 'Create', '301000000000004AAA'),
      ],
      triggers: [
        triggerRow('Contact', 'ContactTrigger', ['UsageBeforeInsert', 'UsageAfterUpdate'], 'pkg'),
        triggerRow('Lead', 'LeadTrigger', ['UsageBeforeInsert']),
      ],
      starts: {
        '301000000000001AAA': { filterFormula: 'NOT({!$Permission.Case_BypassFlow})', filters: [] },
      },
    });

    const automation = await new TargetAutomationReader(target.deps).read('tgt', [
      'Contact',
      'Case',
    ]);

    expect(automation).toEqual<ForgeTargetAutomation>({
      objectsRead: ['Contact', 'Case'],
      objects: [
        {
          objectApiName: 'Contact',
          flows: [
            {
              apiName: 'Contact_Cleanup',
              label: 'Contact Cleanup',
              timing: 'beforeDelete',
              startsOn: 'delete',
              condition: 'read',
              permissions: [],
            },
          ],
          triggers: [{ name: 'pkg.ContactTrigger', events: ['beforeInsert', 'afterUpdate'] }],
        },
        {
          objectApiName: 'Case',
          flows: [
            {
              apiName: 'Case_Defaults',
              label: 'Case Defaults',
              timing: 'beforeSave',
              startsOn: 'createAndUpdate',
              condition: 'read',
              permissions: [],
            },
            {
              apiName: 'Case_Notify_Customer',
              label: 'Case Notify Customer',
              timing: 'afterSave',
              startsOn: 'create',
              condition: 'read',
              permissions: [{ name: 'Case_BypassFlow', bypass: true }],
            },
          ],
          triggers: [],
        },
      ],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: CONDITIONS_BOUND,
      // The flows, the triggers, and one start condition per flow of the run.
      requests: 5,
    });
    // The Lead flow's condition was never asked: Lead is not written.
    expect(target.asked).not.toContain(conditionSoql('301000000000004AAA'));
  });

  it('matches an object the org spells in another case', async () => {
    const target = fakeTarget({
      flows: [flowRow('CASE', 'Case_Flow', 'RecordAfterSave', 'Create')],
    });
    const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);
    expect(automation.objects.map((o) => o.objectApiName)).toEqual(['Case']);
  });

  it('reads the start conditions up to the bound, those of the flows after an insert first, and says how many it left', async () => {
    const flows = [
      ...Array.from({ length: 10 }, (_, i) =>
        flowRow(
          'Case',
          `Update_${i}`,
          'RecordAfterSave',
          'Update',
          `3010000000001${String(i).padStart(2, '0')}AAA`,
        ),
      ),
      ...Array.from({ length: CONDITIONS_BOUND }, (_, i) =>
        flowRow(
          'Case',
          `Insert_${i}`,
          'RecordAfterSave',
          'Create',
          `3010000000002${String(i).padStart(2, '0')}AAA`,
        ),
      ),
    ];
    const target = fakeTarget({ flows });

    const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);

    const read = automation.objects[0].flows.filter((f) => f.condition === 'read');
    const notRead = automation.objects[0].flows.filter((f) => f.condition === 'notRead');
    expect(read).toHaveLength(CONDITIONS_BOUND);
    expect(read.every((f) => f.startsOn === 'create')).toBe(true);
    expect(notRead).toHaveLength(10);
    expect(automation.conditionsNotRead).toBe(10);
    expect(automation.requests).toBe(2 + CONDITIONS_BOUND);
    // Four at a time, beside the two describes of the metadata diff.
    expect(target.mostInFlight()).toBeLessThanOrEqual(4);
    expect(target.mostInFlight()).toBeGreaterThan(1);
  });

  it('says a refused read of the flows, and reads the triggers all the same', async () => {
    const target = fakeTarget({
      triggers: [triggerRow('Case', 'CaseTrigger', ['UsageAfterInsert'])],
      refuse: { flows: refusal('INSUFFICIENT_ACCESS', 'insufficient access rights on object id') },
    });

    const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);

    expect(automation.unread).toEqual([
      { part: 'flows', reason: 'INSUFFICIENT_ACCESS: insufficient access rights on object id' },
    ]);
    expect(automation.objects).toEqual([
      {
        objectApiName: 'Case',
        flows: [],
        triggers: [{ name: 'CaseTrigger', events: ['afterInsert'] }],
      },
    ]);
  });

  it('says a refused read of the triggers, and reads the flows all the same', async () => {
    const target = fakeTarget({
      flows: [flowRow('Case', 'Case_Flow', 'RecordAfterSave', 'Create')],
      refuse: { triggers: refusal('INVALID_TYPE', "sObject type 'ApexTrigger' is not supported.") },
    });

    const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);

    expect(automation.unread).toEqual([
      { part: 'triggers', reason: "INVALID_TYPE: sObject type 'ApexTrigger' is not supported." },
    ]);
    expect(automation.objects[0].flows.map((f) => f.apiName)).toEqual(['Case_Flow']);
  });

  it('marks a start condition the org refused, says why once, and reads the others', async () => {
    const target = fakeTarget({
      flows: [
        flowRow('Case', 'Refused', 'RecordAfterSave', 'Create', '301000000000001AAA'),
        flowRow('Case', 'Readable', 'RecordAfterSave', 'Create', '301000000000002AAA'),
      ],
      starts: { '301000000000002AAA': { filterFormula: 'NOT({!$Permission.Skip})', filters: [] } },
      refuse: { conditions: { '301000000000001AAA': refusal('INSUFFICIENT_ACCESS', 'no access') } },
    });

    const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);

    expect(automation.objects[0].flows.map((f) => [f.apiName, f.condition, f.permissions])).toEqual(
      [
        ['Readable', 'read', [{ name: 'Skip', bypass: true }]],
        ['Refused', 'unreadable', []],
      ],
    );
    expect(automation.unread).toEqual([
      { part: 'conditions', reason: 'INSUFFICIENT_ACCESS: no access' },
    ]);
    expect(automation.requests).toBe(4);
  });

  it('sends no request for a flow version that is not an id, and says its condition unreadable', async () => {
    const target = fakeTarget({
      flows: [flowRow('Case', 'Odd', 'RecordAfterSave', 'Create', "x' OR Id != '")],
    });

    const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);

    expect(automation.objects[0].flows[0].condition).toBe('unreadable');
    expect(target.asked).toEqual([FLOWS_SOQL, TRIGGERS_SOQL]);
  });

  it('leaves out a trigger that runs on an undelete alone, which fires on no write of a run', async () => {
    const target = fakeTarget({
      triggers: [triggerRow('Case', 'CaseRestore', ['UsageAfterUndelete'])],
    });
    const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);
    expect(automation.objects).toEqual([]);
  });

  it('reads, for a graph, the objects a run of it writes', async () => {
    const target = fakeTarget({
      flows: [
        flowRow('PricebookEntry', 'Price_Audit', 'RecordAfterSave', 'Create'),
        flowRow('Account', 'Account_Flow', 'RecordAfterSave', 'Create'),
      ],
    });
    const automation = await new TargetAutomationReader(target.deps).readForGraph(
      'tgt',
      graph(
        [node('OpportunityLineItem'), node('Account', { included: false, leftOutByUser: true })],
        [edge('PricebookEntry', 'OpportunityLineItem')],
      ),
    );
    expect(automation.objectsRead).toEqual(['OpportunityLineItem', ...PRICES]);
    expect(automation.objects.map((o) => o.objectApiName)).toEqual(['PricebookEntry']);
  });

  it('reads the flows over the regular API and the triggers and conditions over the Tooling API', async () => {
    const regular: string[] = [];
    const tooling: string[] = [];
    await new TargetAutomationReader({
      query: async (_orgId, soql) => {
        regular.push(soql);
        return answer([
          flowRow('Case', 'Case_Flow', 'RecordAfterSave', 'Create', '301000000000001AAA'),
        ]);
      },
      toolingQuery: async (_orgId, soql) => {
        tooling.push(soql);
        return answer([]);
      },
    }).read('tgt', ['Case']);
    expect(regular).toEqual([FLOWS_SOQL]);
    expect(tooling).toEqual([TRIGGERS_SOQL, conditionSoql('301000000000001AAA')]);
  });
});

describe('answerOf', () => {
  it('reads every page, and counts a request for each', async () => {
    const pages = [
      { records: [{ Id: '1' }], done: false, nextRecordsUrl: '/next' },
      { records: [{ Id: '2' }], done: true },
    ];
    const result = await answerOf(
      { query: async () => pages[0], queryMore: async () => pages[1] },
      'SELECT Id FROM ApexTrigger',
    );
    expect(result).toEqual({ records: [{ Id: '1' }, { Id: '2' }], requests: 2 });
  });
});

describe('automationLines', () => {
  const automation: ForgeTargetAutomation = {
    objectsRead: ['Case', 'Contact', 'Task'],
    objects: [
      {
        objectApiName: 'Case',
        flows: [
          {
            apiName: 'Case_Notify',
            label: 'Case notify',
            timing: 'afterSave',
            startsOn: 'create',
            condition: 'read',
            permissions: [{ name: 'Case_BypassFlow', bypass: true }],
          },
          {
            apiName: 'Case_Sync',
            label: 'Case sync',
            timing: 'afterSave',
            startsOn: 'update',
            condition: 'notRead',
            permissions: [],
          },
        ],
        triggers: [{ name: 'CaseTrigger', events: ['beforeInsert', 'afterInsert'] }],
      },
    ],
    unread: [{ part: 'conditions', reason: 'INSUFFICIENT_ACCESS: no access' }],
    conditionsNotRead: 1,
    conditionsBound: CONDITIONS_BOUND,
    requests: 27,
  };

  it('says per object what each write fires, the bypass, what was left unread and the cost', () => {
    expect(automationLines(automation, 'TGT')).toEqual([
      'target automation: what TGT runs on the 3 object(s) the run writes',
      '  Case',
      '    on insert: Apex trigger CaseTrigger (before and after save), flow "Case notify" (after save; not for a user with Case_BypassFlow)',
      '    on update: flow "Case sync" (after save; start condition not read)',
      '  bypass: assign Case_BypassFlow to the user the run writes as, and the flows whose start condition excludes them stay quiet',
      `  1 start condition(s) not read: the read takes ${CONDITIONS_BOUND} at most, one request each`,
      '  the start conditions of some flows could not be read: INSUFFICIENT_ACCESS: no access',
      '  read in 27 request(s) to TGT',
    ]);
  });

  it('says nothing fires when it read everything and found nothing', () => {
    const none = { ...automation, objects: [], unread: [], conditionsNotRead: 0, requests: 2 };
    expect(automationLines(none, 'TGT')).toEqual([
      'target automation: what TGT runs on the 3 object(s) the run writes',
      '  no active flow or Apex trigger fires on them',
      '  read in 2 request(s) to TGT',
    ]);
  });

  it('does not say nothing fires when a part could not be read', () => {
    const blind = {
      ...automation,
      objects: [],
      unread: [{ part: 'flows' as const, reason: 'INSUFFICIENT_ACCESS: no access' }],
      conditionsNotRead: 0,
    };
    expect(automationLines(blind, 'TGT')).toContain('  nothing found in what could be read');
    expect(automationLines(blind, 'TGT')).toContain(
      '  the flows could not be read: INSUFFICIENT_ACCESS: no access',
    );
  });

  it("names a permission a flow's start condition names without excluding it", () => {
    const named = {
      ...automation,
      objects: [
        {
          ...automation.objects[0],
          flows: [
            {
              ...automation.objects[0].flows[0],
              permissions: [{ name: 'Run_Sync', bypass: false }],
            },
          ],
          triggers: [],
        },
      ],
    };
    const lines = automationLines(named, 'TGT');
    expect(lines).toContain(
      '    on insert: flow "Case notify" (after save; its start condition names Run_Sync)',
    );
    expect(lines.some((line) => line.includes('bypass:'))).toBe(false);
  });
});
