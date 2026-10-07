import { describe, it, expect } from 'vitest';
import type {
  ForgeGraph,
  ForgeGraphEdge,
  ForgeGraphNode,
  ForgeTargetAutomation,
  ForgeTargetFlow,
  ForgeTargetObjectAutomation,
} from '@sandforge/shared';
import {
  ASSIGNMENT_RULES_SOQL,
  CONDITIONS_BOUND,
  DEFINITIONS_BOUND,
  DUPLICATE_RULES_SOQL,
  FLOWS_SOQL,
  PROCESSES_SOQL,
  TRIGGERS_SOQL,
  TargetAutomationReader,
  USER_PERMISSIONS_SOQL,
  WORKFLOW_RULES_SOQL,
  answerOf,
  automationLines,
  conditionSoql,
  customObjectIdsSoql,
  decisionChecks,
  messagesOf,
  objectsTheRunWrites,
  pathsOf,
  permissionsNamed,
  processObjectsSoql,
  ruleDefinitionSoql,
  switchesNamed,
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

  it('reads a permission negated beside an alternative of another kind as a bypass all the same', () => {
    // Held, the permission makes the OR true and the NOT false, whatever the
    // record: the flow does not start.
    expect(permissionsNamed(withFormula('NOT(OR({!$Permission.Bypass_A}, ISNEW()))'))).toEqual([
      { name: 'Bypass_A', bypass: true },
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

  it('names no permission for a custom setting, a user field or a profile', () => {
    expect(
      permissionsNamed(
        withFormula('AND(NOT({!$Setup.Bypass__c.Flows__c}), NOT({!$User.Skip__c}))'),
      ),
    ).toEqual([]);
  });
});

describe('switchesNamed', () => {
  it('reads a custom setting, a user field and custom metadata negated in the start as bypasses', () => {
    expect(
      switchesNamed(
        'AND(NOT({!$Setup.Bypass_Settings__c.Disable_Flows__c}), {!$User.Bypass_Flows__c} = false, ' +
          "NOT($CustomMetadata.Switch__mdt.Default.Off__c), ISPICKVAL({!$Record.Status}, 'New'))",
      ),
    ).toEqual([
      { reference: '$Setup.Bypass_Settings__c.Disable_Flows__c', where: 'start', bypass: true },
      { reference: '$User.Bypass_Flows__c', where: 'start', bypass: true },
      { reference: '$CustomMetadata.Switch__mdt.Default.Off__c', where: 'start', bypass: true },
    ]);
  });

  it('reads a profile the start requires unlike a name as a bypass for that name', () => {
    expect(switchesNamed("AND({!$Profile.Name} <> 'Integration User', ISNEW())")).toEqual([
      { reference: '$Profile.Name', value: 'Integration User', where: 'start', bypass: true },
    ]);
    expect(switchesNamed('NOT({!$User.Username} = "loader@example.invalid")')).toEqual([
      {
        reference: '$User.Username',
        value: 'loader@example.invalid',
        where: 'start',
        bypass: true,
      },
    ]);
  });

  it('reads nothing where the global is what starts the flow, or one alternative among others', () => {
    expect(switchesNamed("{!$Profile.Name} = 'System Administrator'")).toEqual([]);
    expect(switchesNamed('OR(NOT({!$User.Bypass_Flows__c}), ISNEW())')).toEqual([]);
    expect(switchesNamed(null)).toEqual([]);
  });

  it('leaves the custom permissions to permissionsNamed', () => {
    expect(switchesNamed('NOT({!$Permission.Load_Data})')).toEqual([]);
  });
});

/** A record-triggered flow's metadata whose first element is `first`, with `decisions`. */
function flowMetadata(
  first: string | null,
  decisions: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    start: {
      connector: first ? { targetReference: first } : null,
      scheduledPaths: [],
      ...((extra.start as Record<string, unknown> | undefined) ?? {}),
    },
    decisions,
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'start')),
  };
}

/** A condition comparing `left` with a value. */
function condition(left: string, operator: string, rightValue: Record<string, unknown>) {
  return { leftValueReference: left, operator, rightValue };
}

describe('decisionChecks', () => {
  it('reads an outcome of the first decision that ends the flow for a permission as a bypass', () => {
    const metadata = flowMetadata('Bypass_Check', [
      {
        name: 'Bypass_Check',
        rules: [
          {
            name: 'Bypassed',
            conditionLogic: 'and',
            conditions: [condition('$Permission.Load_Data', 'EqualTo', { booleanValue: true })],
            connector: null,
          },
        ],
        defaultConnector: { targetReference: 'Send_SMS' },
      },
    ]);
    expect(decisionChecks(metadata)).toEqual({
      permissions: [{ name: 'Load_Data', bypass: true, where: 'decision' }],
      switches: [],
    });
  });

  it('reads a first decision whose every way on requires the permission not held, and whose default ends, as a bypass', () => {
    const metadata = flowMetadata('Gate', [
      {
        name: 'Gate',
        rules: [
          {
            name: 'Go',
            conditionLogic: 'and',
            conditions: [
              condition('$Record.Status', 'EqualTo', { stringValue: 'New' }),
              condition('$Permission.Load_Data', 'EqualTo', { booleanValue: false }),
            ],
            connector: { targetReference: 'Send_Email' },
          },
        ],
        defaultConnector: null,
      },
    ]);
    expect(decisionChecks(metadata).permissions).toEqual([
      { name: 'Load_Data', bypass: true, where: 'decision' },
    ]);
  });

  it('reads a custom setting, a user field and a profile the first decision ends the flow on', () => {
    const metadata = flowMetadata('Gate', [
      {
        name: 'Gate',
        rules: [
          {
            name: 'Skip',
            conditionLogic: 'or',
            conditions: [
              condition('$Setup.Bypass__c.Flows__c', 'EqualTo', { booleanValue: true }),
              condition('$User.Bypass_Flows__c', 'NotEqualTo', { booleanValue: false }),
              condition('$Profile.Name', 'EqualTo', { stringValue: 'Integration User' }),
            ],
            connector: null,
          },
        ],
        defaultConnector: { targetReference: 'Notify' },
      },
    ]);
    expect(decisionChecks(metadata).switches).toEqual([
      { reference: '$Profile.Name', value: 'Integration User', where: 'decision', bypass: true },
      { reference: '$Setup.Bypass__c.Flows__c', where: 'decision', bypass: true },
      { reference: '$User.Bypass_Flows__c', where: 'decision', bypass: true },
    ]);
  });

  it("reads a process's criteria formula, whose default outcome ends it, for the permission it requires not held", () => {
    // How Process Builder writes a criterion: a formula the outcome requires
    // true, and the process's start element the decision.
    const metadata = {
      startElementReference: 'myDecision',
      decisions: [
        {
          name: 'myDecision',
          rules: [
            {
              name: 'myRule_1',
              conditionLogic: 'and',
              conditions: [condition('formula_myRule_1', 'EqualTo', { booleanValue: true })],
              connector: { targetReference: 'myRule_1_A1' },
            },
          ],
          defaultConnector: null,
        },
      ],
      formulas: [
        {
          name: 'formula_myRule_1',
          dataType: 'Boolean',
          expression:
            "AND(NOT({!$Permission.Skip_Processes}), ISPICKVAL({!myVariable_current.Status}, 'New'))",
        },
      ],
    };
    expect(decisionChecks(metadata).permissions).toEqual([
      { name: 'Skip_Processes', bypass: true, where: 'decision' },
    ]);
  });

  it('names, without a bypass, what a decision further on tests', () => {
    const metadata = flowMetadata('Update_Case', [
      {
        name: 'Later',
        rules: [
          {
            name: 'Bypassed',
            conditionLogic: 'and',
            conditions: [condition('$Permission.Load_Data', 'EqualTo', { booleanValue: true })],
            connector: null,
          },
        ],
        defaultConnector: { targetReference: 'Send_SMS' },
      },
    ]);
    expect(decisionChecks(metadata)).toEqual({
      permissions: [{ name: 'Load_Data', bypass: false, where: 'decision' }],
      switches: [],
    });
  });

  it('names, without a bypass, what the first decision tests when a scheduled path starts elsewhere', () => {
    // The decision ends the immediate path; the scheduled path runs all the same.
    const metadata = flowMetadata(
      'Bypass_Check',
      [
        {
          name: 'Bypass_Check',
          rules: [
            {
              name: 'Bypassed',
              conditionLogic: 'and',
              conditions: [condition('$User.Bypass_Flows__c', 'EqualTo', { booleanValue: true })],
              connector: null,
            },
          ],
          defaultConnector: { targetReference: 'Notify' },
        },
      ],
      { start: { scheduledPaths: [{ name: 'Later', connector: { targetReference: 'Remind' } }] } },
    );
    expect(decisionChecks(metadata).switches).toEqual([
      { reference: '$User.Bypass_Flows__c', where: 'decision', bypass: false },
    ]);
  });

  it('reads no bypass when an earlier outcome may take the record somewhere first', () => {
    const metadata = flowMetadata('Gate', [
      {
        name: 'Gate',
        rules: [
          {
            name: 'New_Case',
            conditionLogic: 'and',
            conditions: [condition('$Record.Status', 'EqualTo', { stringValue: 'New' })],
            connector: { targetReference: 'Send_Email' },
          },
          {
            name: 'Bypassed',
            conditionLogic: 'and',
            conditions: [condition('$Permission.Load_Data', 'EqualTo', { booleanValue: true })],
            connector: null,
          },
        ],
        defaultConnector: { targetReference: 'Send_SMS' },
      },
    ]);
    expect(decisionChecks(metadata).permissions).toEqual([
      { name: 'Load_Data', bypass: false, where: 'decision' },
    ]);
  });

  it('reads no bypass through a logic of its own, and names nothing for decisions on the record alone', () => {
    const custom = flowMetadata('Gate', [
      {
        name: 'Gate',
        rules: [
          {
            name: 'Bypassed',
            conditionLogic: '1 OR (2 AND 3)',
            conditions: [
              condition('$Permission.Load_Data', 'EqualTo', { booleanValue: true }),
              condition('$Record.Status', 'EqualTo', { stringValue: 'New' }),
              condition('$Record.Origin', 'EqualTo', { stringValue: 'Web' }),
            ],
            connector: null,
          },
        ],
        defaultConnector: { targetReference: 'Notify' },
      },
    ]);
    expect(decisionChecks(custom).permissions).toEqual([
      { name: 'Load_Data', bypass: false, where: 'decision' },
    ]);
    const plain = flowMetadata('Gate', [
      {
        name: 'Gate',
        rules: [
          {
            name: 'New',
            conditions: [condition('$Record.Status', 'EqualTo', { stringValue: 'New' })],
            connector: null,
          },
        ],
      },
    ]);
    expect(decisionChecks(plain)).toEqual({ permissions: [], switches: [] });
    expect(decisionChecks(undefined)).toEqual({ permissions: [], switches: [] });
  });
});

describe('messagesOf', () => {
  it('reads email alerts, Send Email, custom notifications and outbound messages', () => {
    expect(
      messagesOf({
        actionCalls: [
          { name: 'Alert_Customer', label: 'Alert customer', actionType: 'emailAlert' },
          { name: 'Send_Welcome', label: 'Send welcome', actionType: 'emailSimple' },
          { name: 'Notify_Owner', label: 'Notify owner', actionType: 'customNotificationAction' },
          { name: 'Push_To_ERP', label: 'Push to ERP', actionType: 'outboundMessage' },
          { name: 'Post', label: 'Post to Chatter', actionType: 'chatterPost' },
        ],
      }),
    ).toEqual([
      { kind: 'email', name: 'Alert customer' },
      { kind: 'email', name: 'Send welcome' },
      { kind: 'notification', name: 'Notify owner' },
      { kind: 'outbound', name: 'Push to ERP' },
    ]);
  });

  it('guesses a text message from the name of an Apex action, and says it is a guess', () => {
    expect(
      messagesOf({
        actionCalls: [
          {
            name: 'Send_Text',
            label: 'Send text',
            actionName: 'SendSMSInvocable',
            actionType: 'apex',
          },
          { name: 'Twilio_Call', label: 'Call Twilio', actionName: 'Notifier', actionType: 'apex' },
          {
            name: 'Text_Customer',
            label: 'Send a text message',
            actionName: 'Outreach',
            actionType: 'apex',
          },
        ],
      }),
    ).toEqual([
      { kind: 'sms', name: 'Send text', guessed: true },
      { kind: 'sms', name: 'Call Twilio', guessed: true },
      { kind: 'sms', name: 'Send a text message', guessed: true },
    ]);
  });

  it('reads no text message in an Apex action whose name only holds the letters', () => {
    expect(
      messagesOf({
        actionCalls: [
          {
            name: 'Organisms',
            label: 'Sync organisms',
            actionName: 'OrganismsSync',
            actionType: 'apex',
          },
          { name: 'Recalc', label: 'Recalculate', actionName: 'Recalculate', actionType: 'apex' },
        ],
      }),
    ).toEqual([]);
  });
});

describe('pathsOf', () => {
  it('reads the asynchronous path and each scheduled path, with its offset and what it is timed from', () => {
    expect(
      pathsOf({
        start: {
          scheduledPaths: [
            { name: 'Async', label: 'Run Asynchronously', pathType: 'AsyncAfterCommit' },
            {
              name: 'Reminder',
              label: 'Reminder',
              offsetNumber: 2,
              offsetUnit: 'Days',
              timeSource: 'RecordTriggerEvent',
            },
            {
              name: 'Before_End',
              label: 'Before end',
              offsetNumber: -1,
              offsetUnit: 'Days',
              timeSource: 'RecordField',
              recordField: 'EndDate',
            },
          ],
        },
      }),
    ).toEqual([
      { kind: 'async', label: 'Run Asynchronously' },
      { kind: 'scheduled', label: 'Reminder', offset: 2, unit: 'Days' },
      { kind: 'scheduled', label: 'Before end', offset: -1, unit: 'Days', field: 'EndDate' },
    ]);
  });

  it('reads none for a flow that runs on its immediate path alone', () => {
    expect(pathsOf({ start: { scheduledPaths: [] } })).toEqual([]);
    expect(pathsOf(undefined)).toEqual([]);
  });
});

/** A row of `FlowDefinitionView`, as the org answers it. */
function flowRow(
  objectApiName: string,
  apiName: string,
  triggerType: string,
  recordTriggerType: string,
  versionId = `301000000000${String(apiName.length).padStart(3, '0')}AAA`,
  hasAsyncPath = false,
): Record<string, unknown> {
  return {
    ApiName: apiName,
    Label: apiName.replace(/_/g, ' '),
    TriggerType: triggerType,
    RecordTriggerType: recordTriggerType,
    TriggerObjectOrEvent: { QualifiedApiName: objectApiName },
    ActiveVersionId: versionId,
    HasAsyncAfterCommitPath: hasAsyncPath,
  };
}

/** A row of `FlowDefinitionView` for a process, its object named or not. */
function processRow(
  apiName: string,
  versionId: string,
  objectApiName: string | null = null,
): Record<string, unknown> {
  return {
    ApiName: apiName,
    Label: apiName.replace(/_/g, ' '),
    TriggerObjectOrEvent: objectApiName ? { QualifiedApiName: objectApiName } : null,
    ActiveVersionId: versionId,
  };
}

/** A row of the Tooling API's `WorkflowRule`, on a table named or by id. */
function ruleRow(id: string, name: string, table: string): Record<string, unknown> {
  return { Id: id, Name: name, NamespacePrefix: null, TableEnumOrId: table };
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

/** The parts of the read a fake target can refuse. */
type Refusals = {
  flows?: Error;
  triggers?: Error;
  processes?: Error;
  workflowRules?: Error;
  assignmentRules?: Error;
  duplicateRules?: Error;
  userPermissions?: Error;
  permissionSets?: Error;
  conditions?: Record<string, Error>;
};

/**
 * A target answering the read: its flows, triggers, processes, workflow rules,
 * assignment and duplicate rules, the custom permissions of the user the read
 * runs as, and the metadata of each flow version or rule, by id — a start
 * alone in `starts`, a whole definition in `metadata`. What it was asked is
 * recorded, and how many requests were in flight at most.
 */
function fakeTarget({
  flows = [],
  triggers = [],
  processes = [],
  rules = [],
  assignmentRules = [],
  duplicateRules = [],
  userPermissions = [],
  customPermissions = [],
  holdings = [],
  sizes = {},
  variables = [],
  entities = [],
  starts = {},
  metadata = {},
  refuse = {},
}: {
  flows?: Array<Record<string, unknown>>;
  triggers?: Array<Record<string, unknown>>;
  processes?: Array<Record<string, unknown>>;
  rules?: Array<Record<string, unknown>>;
  assignmentRules?: Array<Record<string, unknown>>;
  duplicateRules?: Array<Record<string, unknown>>;
  userPermissions?: Array<Record<string, unknown>>;
  /** The custom permissions of the org, as `CustomPermission` gives them. */
  customPermissions?: Array<Record<string, unknown>>;
  /** The permission sets that include them, as `SetupEntityAccess` gives them. */
  holdings?: Array<Record<string, unknown>>;
  /** What each permission set grants, by its id: setup entities, then objects. */
  sizes?: Record<string, [number, number]>;
  variables?: Array<Record<string, unknown>>;
  entities?: Array<Record<string, unknown>>;
  starts?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  refuse?: Refusals;
}) {
  const asked: string[] = [];
  const regular: string[] = [];
  const tooling: string[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const answering = async (respond: () => QueryAnswer): Promise<QueryAnswer> => {
    inFlight++;
    mostInFlight = Math.max(mostInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight--;
    return respond();
  };
  const part = (refusal: Error | undefined, records: Array<Record<string, unknown>>) => () => {
    if (refusal) throw refusal;
    return answer(records);
  };
  const deps: TargetAutomationDeps = {
    query: async (_orgId, soql) => {
      asked.push(soql);
      regular.push(soql);
      if (soql === FLOWS_SOQL) return answering(part(refuse.flows, flows));
      if (soql === PROCESSES_SOQL) return answering(part(refuse.processes, processes));
      if (soql === ASSIGNMENT_RULES_SOQL) {
        return answering(part(refuse.assignmentRules, assignmentRules));
      }
      if (soql === DUPLICATE_RULES_SOQL) {
        return answering(part(refuse.duplicateRules, duplicateRules));
      }
      if (soql === USER_PERMISSIONS_SOQL) {
        return answering(part(refuse.userPermissions, userPermissions));
      }
      if (soql.includes(' FROM CustomPermission ')) {
        return answering(part(refuse.permissionSets, customPermissions));
      }
      if (soql.includes(" WHERE SetupEntityType = 'CustomPermission' ")) {
        return answering(part(refuse.permissionSets, holdings));
      }
      const counted = / FROM (SetupEntityAccess|ObjectPermissions) WHERE ParentId IN /.exec(soql);
      if (counted) {
        const at = counted[1] === 'SetupEntityAccess' ? 0 : 1;
        return answering(
          part(
            refuse.permissionSets,
            Object.entries(sizes).map(([ParentId, n]) => ({ ParentId, n: n[at] })),
          ),
        );
      }
      if (soql.includes(' FROM FlowVariableView ')) return answering(part(undefined, variables));
      if (soql.includes(' FROM EntityDefinition ')) return answering(part(undefined, entities));
      throw new Error(`unexpected query ${soql}`);
    },
    toolingQuery: async (_orgId, soql) => {
      asked.push(soql);
      tooling.push(soql);
      if (soql === TRIGGERS_SOQL) return answering(part(refuse.triggers, triggers));
      if (soql === WORKFLOW_RULES_SOQL) return answering(part(refuse.workflowRules, rules));
      const id = /WHERE Id = '(\w+)'/.exec(soql)?.[1] ?? '';
      return answering(() => {
        const refused = refuse.conditions?.[id];
        if (refused) throw refused;
        return answer([
          {
            Metadata: metadata[id] ?? { start: starts[id] ?? { filterFormula: null, filters: [] } },
          },
        ]);
      });
    },
  };
  return { deps, asked, regular, tooling, mostInFlight: () => mostInFlight };
}

/** An error as jsforce raises one for an org's refusal. */
function refusal(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: code, errorCode: code });
}

/** A flow as the read gives it, its start condition read and naming nothing unless told. */
function readFlow(overrides: Partial<ForgeTargetFlow>): ForgeTargetFlow {
  return {
    apiName: '',
    label: '',
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: [],
    paths: [],
    messages: [],
    switches: [],
    ...overrides,
  };
}

/** An object as the read gives it, every list there. */
function readObject(
  objectApiName: string,
  overrides: Partial<ForgeTargetObjectAutomation> = {},
): ForgeTargetObjectAutomation {
  return {
    objectApiName,
    flows: [],
    triggers: [],
    processes: [],
    workflowRules: [],
    assignmentRules: [],
    duplicateRules: [],
    ...overrides,
  };
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
        readObject('Contact', {
          flows: [
            readFlow({
              apiName: 'Contact_Cleanup',
              label: 'Contact Cleanup',
              timing: 'beforeDelete',
              startsOn: 'delete',
            }),
          ],
          triggers: [{ name: 'pkg.ContactTrigger', events: ['beforeInsert', 'afterUpdate'] }],
        }),
        readObject('Case', {
          flows: [
            readFlow({
              apiName: 'Case_Defaults',
              label: 'Case Defaults',
              timing: 'beforeSave',
              startsOn: 'createAndUpdate',
            }),
            readFlow({
              apiName: 'Case_Notify_Customer',
              label: 'Case Notify Customer',
              permissions: [{ name: 'Case_BypassFlow', bypass: true, held: false }],
            }),
          ],
        }),
      ],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: CONDITIONS_BOUND,
      definitionsNotRead: 0,
      definitionsBound: DEFINITIONS_BOUND,
      // The org has no such custom permission: no permission set can hold it.
      bypassGrants: [{ permission: 'Case_BypassFlow', permissionSets: [] }],
      // Six parts, one start condition per flow of the run, the permissions of
      // the user the read runs as, and the custom permission it does not hold.
      requests: 11,
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
    expect(automation.requests).toBe(6 + CONDITIONS_BOUND);
    // Four at a time, beside the two describes of the metadata diff.
    expect(target.mostInFlight()).toBeLessThanOrEqual(4);
    expect(target.mostInFlight()).toBeGreaterThan(1);
  });

  it('keeps four requests in flight at most while it asks for every part', async () => {
    const target = fakeTarget({
      rules: [ruleRow('01Q000000000001AAA', 'Case rule', 'Case')],
      processes: [processRow('Case_Process', '301000000000009AAA', 'Case')],
      metadata: {
        '01Q000000000001AAA': { active: true, triggerType: 'onCreateOnly', actions: [] },
        '301000000000009AAA': { processMetadataValues: [], actionCalls: [] },
      },
    });

    await new TargetAutomationReader(target.deps).read('tgt', ['Case', 'Lead']);

    // Six parts asked for, Case and Lead taking assignment rules.
    expect(target.asked.slice(0, 6)).toEqual([
      FLOWS_SOQL,
      TRIGGERS_SOQL,
      PROCESSES_SOQL,
      WORKFLOW_RULES_SOQL,
      ASSIGNMENT_RULES_SOQL,
      DUPLICATE_RULES_SOQL,
    ]);
    expect(target.mostInFlight()).toBe(4);
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
      readObject('Case', { triggers: [{ name: 'CaseTrigger', events: ['afterInsert'] }] }),
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

  it('says each new part the target refuses, and reads the others all the same', async () => {
    const denied = refusal('INSUFFICIENT_ACCESS', 'no access');
    const target = fakeTarget({
      flows: [flowRow('Case', 'Case_Flow', 'RecordAfterSave', 'Create')],
      refuse: {
        processes: denied,
        workflowRules: denied,
        assignmentRules: denied,
        duplicateRules: denied,
      },
    });

    const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);

    expect(automation.unread.map((u) => u.part).sort()).toEqual([
      'assignmentRules',
      'duplicateRules',
      'processes',
      'workflowRules',
    ]);
    expect(automation.unread.every((u) => u.reason === 'INSUFFICIENT_ACCESS: no access')).toBe(
      true,
    );
    expect(automation.objects[0].flows.map((f) => [f.apiName, f.condition])).toEqual([
      ['Case_Flow', 'read'],
    ]);
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
        ['Readable', 'read', [{ name: 'Skip', bypass: true, held: false }]],
        ['Refused', 'unreadable', []],
      ],
    );
    expect(automation.unread).toEqual([
      { part: 'conditions', reason: 'INSUFFICIENT_ACCESS: no access' },
    ]);
    // Six parts, two conditions, the user's permissions, the bypass not held.
    expect(automation.requests).toBe(10);
  });

  it('sends no request for a flow version that is not an id, and says its condition unreadable', async () => {
    const target = fakeTarget({
      flows: [flowRow('Case', 'Odd', 'RecordAfterSave', 'Create', "x' OR Id != '")],
    });

    const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);

    expect(automation.objects[0].flows[0].condition).toBe('unreadable');
    expect(target.asked).toEqual([
      FLOWS_SOQL,
      TRIGGERS_SOQL,
      PROCESSES_SOQL,
      WORKFLOW_RULES_SOQL,
      ASSIGNMENT_RULES_SOQL,
      DUPLICATE_RULES_SOQL,
    ]);
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

  it('reads the flows, processes and rules of the org over the regular API, the triggers, rules and metadata over the Tooling API', async () => {
    const target = fakeTarget({
      flows: [flowRow('Case', 'Case_Flow', 'RecordAfterSave', 'Create', '301000000000001AAA')],
    });
    await new TargetAutomationReader(target.deps).read('tgt', ['Case']);
    expect(target.regular).toEqual([
      FLOWS_SOQL,
      PROCESSES_SOQL,
      ASSIGNMENT_RULES_SOQL,
      DUPLICATE_RULES_SOQL,
    ]);
    expect(target.tooling).toEqual([
      TRIGGERS_SOQL,
      WORKFLOW_RULES_SOQL,
      conditionSoql('301000000000001AAA'),
    ]);
  });

  it('sends no request for assignment rules when the run writes neither a case nor a lead', async () => {
    const target = fakeTarget({});
    await new TargetAutomationReader(target.deps).read('tgt', ['Account', 'Contact']);
    expect(target.asked).not.toContain(ASSIGNMENT_RULES_SOQL);
  });

  describe('after commit (A1)', () => {
    it("lists a flow's asynchronous and scheduled paths, read from its metadata", async () => {
      const target = fakeTarget({
        flows: [
          flowRow('Contact', 'Welcome', 'RecordAfterSave', 'Create', '301000000000001AAA', true),
        ],
        metadata: {
          '301000000000001AAA': {
            start: {
              filterFormula: null,
              scheduledPaths: [
                { name: 'Async', label: 'Run Asynchronously', pathType: 'AsyncAfterCommit' },
                {
                  name: 'Follow_Up',
                  label: 'Follow up',
                  offsetNumber: 3,
                  offsetUnit: 'Days',
                  timeSource: 'RecordTriggerEvent',
                },
              ],
            },
          },
        },
      });

      const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Contact']);

      expect(automation.objects[0].flows[0].paths).toEqual([
        { kind: 'async', label: 'Run Asynchronously' },
        { kind: 'scheduled', label: 'Follow up', offset: 3, unit: 'Days' },
      ]);
    });

    it('says the asynchronous path of a flow whose metadata the bound left unread', async () => {
      const flows = Array.from({ length: CONDITIONS_BOUND + 1 }, (_, i) =>
        flowRow(
          'Case',
          `Flow_${String(i).padStart(2, '0')}`,
          'RecordAfterSave',
          'Create',
          `3010000000002${String(i).padStart(2, '0')}AAA`,
          i === CONDITIONS_BOUND,
        ),
      );
      const target = fakeTarget({ flows });

      const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);

      const unreadFlow = automation.objects[0].flows.find((f) => f.condition === 'notRead');
      expect(unreadFlow?.paths).toEqual([{ kind: 'async' }]);
    });
  });

  describe('processes, workflow rules and assignment rules (A2)', () => {
    it('lists an active process on an object the run writes, with the writes and the messages its definition says', async () => {
      const target = fakeTarget({
        processes: [
          processRow('Case_Routing', '301000000000005AAA', 'Case'),
          processRow('Lead_Scoring', '301000000000006AAA', 'Lead'),
        ],
        metadata: {
          '301000000000005AAA': {
            processMetadataValues: [
              { name: 'ObjectType', value: { stringValue: 'Case' } },
              { name: 'TriggerType', value: { stringValue: 'onCreateOnly' } },
            ],
            actionCalls: [{ name: 'myRule_1_A1', label: 'Alert team', actionType: 'emailAlert' }],
          },
        },
      });

      const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);

      expect(automation.objects).toEqual([
        readObject('Case', {
          processes: [
            readFlow({
              apiName: 'Case_Routing',
              label: 'Case Routing',
              startsOn: 'create',
              messages: [{ kind: 'email', name: 'Alert team' }],
            }),
          ],
        }),
      ]);
      // The Lead process is none of the run's business: its definition was never asked.
      expect(target.asked).not.toContain(conditionSoql('301000000000006AAA'));
    });

    it("places a process the definition view names no object for by its version's record variable, in one request", async () => {
      const target = fakeTarget({
        processes: [
          processRow('Contact_Welcome', '301000000000007AAA'),
          processRow('Order_Sync', '301000000000008AAA'),
        ],
        variables: [
          {
            FlowVersionViewId: '301000000000007AAA',
            ApiName: 'myVariable_current',
            ObjectType: 'Contact',
          },
          {
            FlowVersionViewId: '301000000000007AAA',
            ApiName: 'myVariable_old',
            ObjectType: 'Contact',
          },
          {
            FlowVersionViewId: '301000000000008AAA',
            ApiName: 'myVariable_current',
            ObjectType: 'Order',
          },
        ],
      });

      const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Contact']);

      expect(automation.objects[0].processes?.map((p) => p.apiName)).toEqual(['Contact_Welcome']);
      expect(target.asked).toContain(
        processObjectsSoql(['301000000000007AAA', '301000000000008AAA']),
      );
      expect(target.asked).not.toContain(conditionSoql('301000000000008AAA'));
    });

    it('reads the definition of a process its variables did not place, and keeps it when it runs on an object the run writes', async () => {
      const target = fakeTarget({
        processes: [processRow('Unplaced', '301000000000007AAA')],
        metadata: {
          '301000000000007AAA': {
            processMetadataValues: [
              { name: 'ObjectType', value: { stringValue: 'Contact' } },
              { name: 'TriggerType', value: { stringValue: 'onAllChanges' } },
            ],
          },
        },
      });

      const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Contact']);

      expect(automation.objects[0].processes).toEqual([
        readFlow({ apiName: 'Unplaced', label: 'Unplaced', startsOn: 'createAndUpdate' }),
      ]);
    });

    it("lists a workflow rule's email alerts, outbound messages and time-dependent actions, and drops an inactive rule", async () => {
      const target = fakeTarget({
        rules: [
          ruleRow('01Q000000000001AAA', 'Notify on new case', 'Case'),
          ruleRow('01Q000000000002AAA', 'Old rule', 'Case'),
          ruleRow('01Q000000000003AAA', 'Lead rule', 'Lead'),
        ],
        metadata: {
          '01Q000000000001AAA': {
            active: true,
            triggerType: 'onCreateOrTriggeringUpdate',
            actions: [
              { name: 'New_case_alert', type: 'Alert' },
              { name: 'Set_priority', type: 'FieldUpdate' },
              { name: 'Push_to_ERP', type: 'OutboundMessage' },
            ],
            workflowTimeTriggers: [
              {
                actions: [{ name: 'Reminder_alert', type: 'Alert' }],
                offsetFromField: 'Case.CreatedDate',
                timeLength: '2',
                workflowTimeTriggerUnit: 'Days',
              },
            ],
          },
          '01Q000000000002AAA': { active: false, triggerType: 'onCreateOnly', actions: [] },
        },
      });

      const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);

      expect(automation.objects[0].workflowRules).toEqual([
        readFlow({
          apiName: 'Notify on new case',
          label: 'Notify on new case',
          startsOn: 'createAndUpdate',
          paths: [{ kind: 'scheduled', offset: 2, unit: 'Days', field: 'Case.CreatedDate' }],
          messages: [
            { kind: 'email', name: 'New_case_alert' },
            { kind: 'outbound', name: 'Push_to_ERP' },
            { kind: 'email', name: 'Reminder_alert' },
          ],
        }),
      ]);
      expect(target.asked).toContain(ruleDefinitionSoql('01Q000000000002AAA'));
      expect(target.asked).not.toContain(ruleDefinitionSoql('01Q000000000003AAA'));
    });

    it('matches a rule on a custom object by the id the org names its table with', async () => {
      const target = fakeTarget({
        rules: [ruleRow('01Q000000000004AAA', 'Item rule', '01I000000000001AAA')],
        entities: [{ DurableId: '01I000000000001AAA', QualifiedApiName: 'Item__c' }],
        metadata: {
          '01Q000000000004AAA': { active: true, triggerType: 'onCreateOnly', actions: [] },
        },
      });

      const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Item__c']);

      expect(automation.objects[0].workflowRules?.map((r) => r.apiName)).toEqual(['Item rule']);
      expect(target.asked).toContain(customObjectIdsSoql(['Item__c']));
    });

    it('keeps a rule past its bound, said unread, and reads the processes before the rules', async () => {
      const rules = Array.from({ length: DEFINITIONS_BOUND }, (_, i) =>
        ruleRow(
          `01Q0000000001${String(i).padStart(2, '0')}AAA`,
          `Rule ${String(i).padStart(2, '0')}`,
          'Case',
        ),
      );
      const target = fakeTarget({
        rules,
        processes: [processRow('Case_Process', '301000000000009AAA', 'Case')],
        metadata: Object.fromEntries(
          rules.map((row) => [row.Id as string, { active: true, triggerType: 'onCreateOnly' }]),
        ),
      });

      const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);

      expect(automation.definitionsNotRead).toBe(1);
      expect(automation.objects[0].processes?.[0].condition).toBe('read');
      const left = automation.objects[0].workflowRules?.filter((r) => r.condition === 'notRead');
      expect(left?.map((r) => [r.label, r.startsOn])).toEqual([['Rule 14', 'createAndUpdate']]);
    });

    it('says the definitions the target refused, once', async () => {
      const target = fakeTarget({
        rules: [ruleRow('01Q000000000001AAA', 'Refused rule', 'Case')],
        refuse: {
          conditions: { '01Q000000000001AAA': refusal('INSUFFICIENT_ACCESS', 'no access') },
        },
      });

      const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);

      expect(automation.objects[0].workflowRules?.[0].condition).toBe('unreadable');
      expect(automation.unread).toEqual([
        { part: 'definitions', reason: 'INSUFFICIENT_ACCESS: no access' },
      ]);
    });

    it('lists the active assignment rule of a case or a lead the run writes', async () => {
      const target = fakeTarget({
        assignmentRules: [
          { Name: 'Lead routing', SobjectType: 'Lead' },
          { Name: 'Case routing', SobjectType: 'Case' },
        ],
      });

      const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Lead']);

      expect(automation.objects).toEqual([
        readObject('Lead', { assignmentRules: [{ name: 'Lead routing' }] }),
      ]);
    });
  });

  describe('bypasses (A3)', () => {
    it('says whether the user the read runs as holds each permission a flow names', async () => {
      const target = fakeTarget({
        flows: [flowRow('Case', 'Case_Flow', 'RecordAfterSave', 'Create', '301000000000001AAA')],
        starts: {
          '301000000000001AAA': {
            filterFormula: 'AND(NOT({!$Permission.Load_Data}), NOT({!$Permission.pkg__Skip}))',
          },
        },
        userPermissions: [
          { DeveloperName: 'Load_Data', NamespacePrefix: null },
          { DeveloperName: 'Skip', NamespacePrefix: 'other' },
        ],
      });

      const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);

      expect(automation.objects[0].flows[0].permissions).toEqual([
        { name: 'Load_Data', bypass: true, held: true },
        { name: 'pkg__Skip', bypass: true, held: false },
      ]);
    });

    it('asks for the permissions of the user only when a condition names one', async () => {
      const target = fakeTarget({
        flows: [flowRow('Case', 'Case_Flow', 'RecordAfterSave', 'Create', '301000000000001AAA')],
      });
      await new TargetAutomationReader(target.deps).read('tgt', ['Case']);
      expect(target.asked).not.toContain(USER_PERMISSIONS_SOQL);
    });

    it("asks for the user's custom permissions by the key prefix their ids carry", () => {
      // The fakes answer the query whatever it says; a real org answers only
      // 0CP. Under 0CF it answered nothing, and every bypass read as not held.
      expect(USER_PERMISSIONS_SOQL).toContain("KeyPrefix = '0CP'");
    });

    it('finds the permission sets that hold a bypass the user does not, the smallest first', async () => {
      const target = fakeTarget({
        flows: [flowRow('Case', 'Case_Flow', 'RecordAfterSave', 'Create', '301000000000001AAA')],
        starts: {
          '301000000000001AAA': {
            filterFormula: 'AND(NOT({!$Permission.Load_Data}), NOT({!$Permission.ns__Skip}))',
          },
        },
        customPermissions: [
          { Id: '0CP000000000001AAA', DeveloperName: 'Load_Data', NamespacePrefix: null },
          { Id: '0CP000000000002AAA', DeveloperName: 'Skip', NamespacePrefix: 'ns' },
          // Another namespace's permission of the same name is not the one named.
          { Id: '0CP000000000003AAA', DeveloperName: 'Load_Data', NamespacePrefix: 'other' },
        ],
        holdings: [
          {
            SetupEntityId: '0CP000000000001AAA',
            ParentId: '0PS000000000001AAA',
            Parent: { Name: 'Integration', Label: 'Integration user', NamespacePrefix: null },
          },
          {
            SetupEntityId: '0CP000000000001AAA',
            ParentId: '0PS000000000002AAA',
            Parent: { Name: 'Data_Load', Label: 'Data load', NamespacePrefix: null },
          },
          {
            SetupEntityId: '0CP000000000003AAA',
            ParentId: '0PS000000000003AAA',
            Parent: { Name: 'Other', Label: 'Other', NamespacePrefix: 'other' },
          },
        ],
        sizes: { '0PS000000000001AAA': [40, 25], '0PS000000000002AAA': [1, 0] },
      });

      const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);

      expect(automation.bypassGrants).toEqual([
        {
          permission: 'Load_Data',
          permissionSets: [
            { name: 'Data_Load', label: 'Data load', grants: 1 },
            { name: 'Integration', label: 'Integration user', grants: 65 },
          ],
        },
        { permission: 'ns__Skip', permissionSets: [] },
      ]);
      expect(target.regular).toContain(
        "SELECT Id, DeveloperName, NamespacePrefix FROM CustomPermission WHERE DeveloperName IN ('Load_Data', 'Skip')",
      );
      // A profile's own permission set, and a group's, cannot be assigned.
      expect(target.regular.find((soql) => soql.includes('SetupEntityType'))).toContain(
        'Parent.IsOwnedByProfile = false AND Parent.PermissionSetGroupId = null',
      );
    });

    it('looks up no permission set for a bypass the user holds', async () => {
      const target = fakeTarget({
        flows: [flowRow('Case', 'Case_Flow', 'RecordAfterSave', 'Create', '301000000000001AAA')],
        starts: { '301000000000001AAA': { filterFormula: 'NOT({!$Permission.Load_Data})' } },
        userPermissions: [{ DeveloperName: 'Load_Data', NamespacePrefix: null }],
      });

      const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);

      expect(automation.bypassGrants).toBeUndefined();
      expect(target.regular.some((soql) => soql.includes('CustomPermission'))).toBe(false);
    });

    it('says the permission sets could not be read, and says nothing of one', async () => {
      const target = fakeTarget({
        flows: [flowRow('Case', 'Case_Flow', 'RecordAfterSave', 'Create', '301000000000001AAA')],
        starts: { '301000000000001AAA': { filterFormula: 'NOT({!$Permission.Load_Data})' } },
        refuse: { permissionSets: refusal('INVALID_TYPE', 'sObject type is not supported') },
      });

      const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);

      expect(automation.bypassGrants).toBeUndefined();
      expect(automation.unread).toEqual([
        { part: 'permissionSets', reason: 'INVALID_TYPE: sObject type is not supported' },
      ]);
    });

    it("says the user's permissions could not be read, and leaves whether one is held unsaid", async () => {
      const target = fakeTarget({
        flows: [flowRow('Case', 'Case_Flow', 'RecordAfterSave', 'Create', '301000000000001AAA')],
        starts: { '301000000000001AAA': { filterFormula: 'NOT({!$Permission.Load_Data})' } },
        refuse: { userPermissions: refusal('INVALID_TYPE', 'not supported') },
      });

      const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);

      expect(automation.objects[0].flows[0].permissions).toEqual([
        { name: 'Load_Data', bypass: true },
      ]);
      expect(automation.unread).toEqual([
        { part: 'userPermissions', reason: 'INVALID_TYPE: not supported' },
      ]);
    });

    it("reads the switches of a flow's start and first decision, and of a rule's criteria", async () => {
      const target = fakeTarget({
        flows: [flowRow('Case', 'Case_Flow', 'RecordAfterSave', 'Create', '301000000000001AAA')],
        rules: [ruleRow('01Q000000000001AAA', 'Case rule', 'Case')],
        metadata: {
          '301000000000001AAA': flowMetadata(
            'Gate',
            [
              {
                name: 'Gate',
                rules: [
                  {
                    name: 'Skip',
                    conditions: [condition('$User.Bypass__c', 'EqualTo', { booleanValue: true })],
                    connector: null,
                  },
                ],
                defaultConnector: { targetReference: 'Notify' },
              },
            ],
            { start: { filterFormula: 'NOT({!$Setup.Bypass__c.Flows__c})' } },
          ),
          '01Q000000000001AAA': {
            active: true,
            triggerType: 'onCreateOnly',
            formula: "AND(NOT($Permission.Skip_Rules), $Profile.Name <> 'Integration')",
          },
        },
      });

      const automation = await new TargetAutomationReader(target.deps).read('tgt', ['Case']);

      expect(automation.objects[0].flows[0].switches).toEqual([
        { reference: '$Setup.Bypass__c.Flows__c', where: 'start', bypass: true },
        { reference: '$User.Bypass__c', where: 'decision', bypass: true },
      ]);
      expect(automation.objects[0].workflowRules?.[0]).toMatchObject({
        permissions: [{ name: 'Skip_Rules', bypass: true, held: false }],
        switches: [
          { reference: '$Profile.Name', value: 'Integration', where: 'start', bypass: true },
        ],
      });
    });
  });

  describe('duplicate rules (A6)', () => {
    it('lists the active duplicate rules of each object the run writes', async () => {
      const target = fakeTarget({
        duplicateRules: [
          { DeveloperName: 'Contact_Rule', MasterLabel: 'Contact rule', SobjectType: 'Contact' },
          { DeveloperName: 'Account_Rule', MasterLabel: 'Account rule', SobjectType: 'Account' },
          { DeveloperName: 'Lead_Rule', MasterLabel: 'Lead rule', SobjectType: 'Lead' },
        ],
      });

      const automation = await new TargetAutomationReader(target.deps).read('tgt', [
        'Account',
        'Contact',
      ]);

      expect(automation.objects).toEqual([
        readObject('Account', {
          duplicateRules: [{ name: 'Account rule', developerName: 'Account_Rule' }],
        }),
        readObject('Contact', {
          duplicateRules: [{ name: 'Contact rule', developerName: 'Contact_Rule' }],
        }),
      ]);
    });
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

  it('gives under a bypass the permission set that holds it and the command that assigns it, or says none does', () => {
    const lines = automationLines(
      {
        ...automation,
        objects: [
          {
            ...automation.objects[0],
            flows: [
              {
                ...automation.objects[0].flows[0],
                permissions: [
                  { name: 'Case_BypassFlow', bypass: true, held: false },
                  { name: 'Skip_All', bypass: true, held: false },
                ],
              },
            ],
          },
        ],
        bypassGrants: [
          {
            permission: 'Case_BypassFlow',
            permissionSets: [
              { name: 'Bypass_Flows', label: 'Bypass flows', grants: 1 },
              { name: 'Admin_Tools', label: 'Admin tools', grants: 300 },
            ],
          },
          { permission: 'Skip_All', permissionSets: [] },
        ],
      },
      'TGT',
      { username: 'loader@example.com' },
    );
    expect(lines).toContain(
      '    Case_BypassFlow: held by permission set Bypass_Flows, the smallest; also held by ' +
        'Admin_Tools: sf org assign permset --name Bypass_Flows --target-org TGT --on-behalf-of loader@example.com',
    );
    expect(lines).toContain(
      '    Skip_All: no permission set of TGT holds it: an admin creates one that includes it',
    );
  });

  it('says nothing runs when it read everything and found nothing', () => {
    const none = { ...automation, objects: [], unread: [], conditionsNotRead: 0, requests: 2 };
    expect(automationLines(none, 'TGT')).toEqual([
      'target automation: what TGT runs on the 3 object(s) the run writes',
      '  no active flow, process, workflow rule, Apex trigger, assignment rule or duplicate rule runs on them',
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

  it('marks what sends messages, and says what runs after commit', () => {
    const loud: ForgeTargetAutomation = {
      ...automation,
      unread: [],
      conditionsNotRead: 0,
      objects: [
        {
          objectApiName: 'Contact',
          flows: [
            readFlow({
              apiName: 'Welcome',
              label: 'Welcome',
              paths: [
                { kind: 'async', label: 'Run Asynchronously' },
                { kind: 'scheduled', label: 'Follow up', offset: 1, unit: 'Days' },
                { kind: 'scheduled', offset: -2, unit: 'Hours', field: 'Birthdate' },
              ],
              messages: [
                { kind: 'email', name: 'Send welcome' },
                { kind: 'sms', name: 'Send SMS', guessed: true },
              ],
            }),
          ],
          triggers: [],
        },
      ],
    };
    expect(automationLines(loud, 'TGT')[2]).toBe(
      '    on insert: flow "Welcome" (after save; SENDS MESSAGES: email "Send welcome", text message "Send SMS" (guessed from the name of an Apex action); ' +
        'then after commit: asynchronous path "Run Asynchronously", scheduled path "Follow up" (1 Day after the save), scheduled path (2 Hours before Birthdate))',
    );
  });

  it('names processes and workflow rules, their definitions left unread, and the switches that keep a flow quiet', () => {
    const lines = automationLines(
      {
        ...automation,
        unread: [],
        conditionsNotRead: 0,
        definitionsNotRead: 2,
        definitionsBound: DEFINITIONS_BOUND,
        objects: [
          {
            objectApiName: 'Case',
            flows: [
              readFlow({
                label: 'Case notify',
                switches: [
                  { reference: '$Setup.Bypass__c.Flows__c', where: 'start', bypass: true },
                  {
                    reference: '$Profile.Name',
                    value: 'Integration',
                    where: 'decision',
                    bypass: true,
                  },
                  { reference: '$User.Region__c', where: 'decision', bypass: false },
                ],
                permissions: [{ name: 'Load_Data', bypass: true, where: 'decision', held: false }],
              }),
            ],
            triggers: [],
            processes: [readFlow({ label: 'Case routing', condition: 'notRead' })],
            workflowRules: [
              readFlow({
                label: 'Notify owner',
                messages: [{ kind: 'outbound', name: 'Push_to_ERP' }],
              }),
            ],
          },
        ],
      },
      'TGT',
    );
    expect(lines[2]).toBe(
      '    on insert: workflow rule "Notify owner" (after save; SENDS MESSAGES: outbound message "Push_to_ERP"), ' +
        'process "Case routing" (after save; definition not read), ' +
        'flow "Case notify" (after save; its first decision ends it for a user with Load_Data (not held); ' +
        "not when $Setup.Bypass__c.Flows__c is true; its first decision ends it when $Profile.Name is 'Integration'; " +
        'its decisions test $User.Region__c)',
    );
    expect(lines).toContain(
      `  2 process or workflow rule definition(s) not read: the read takes ${DEFINITIONS_BOUND} at most, one request each`,
    );
  });

  it('says a permission the user the run writes as holds keeps a flow quiet for the run', () => {
    const lines = automationLines(
      {
        ...automation,
        unread: [],
        conditionsNotRead: 0,
        objects: [
          {
            objectApiName: 'Case',
            flows: [
              readFlow({
                label: 'Case notify',
                permissions: [{ name: 'Case_BypassFlow', bypass: true, held: true }],
              }),
            ],
            triggers: [],
          },
        ],
      },
      'TGT',
    );
    expect(lines).toContain(
      '    on insert: flow "Case notify" (after save; not for a user with Case_BypassFlow (held); quiet for this run)',
    );
    expect(lines).toContain(
      '  bypass held: the user the run writes as holds Case_BypassFlow, and what excludes them stays quiet for this run',
    );
    expect(lines.some((line) => line.startsWith('  bypass: assign'))).toBe(false);
  });

  it('says which applies of the assignment rules, and what the duplicate rules still refuse', () => {
    const ruled: ForgeTargetAutomation = {
      ...automation,
      unread: [],
      conditionsNotRead: 0,
      objects: [
        readObject('Lead', {
          assignmentRules: [{ name: 'Lead routing' }],
          duplicateRules: [
            { name: 'Lead email', developerName: 'Lead_Email' },
            { name: 'Lead name', developerName: 'Lead_Name' },
          ],
        }),
      ],
    };
    expect(automationLines(ruled, 'TGT').slice(1, 4)).toEqual([
      '  Lead',
      '    assignment rule "Lead routing": not applied: the run sends Sforce-Auto-Assign: FALSE and keeps the owner it sets (--apply-assignment-rules applies it)',
      '    duplicate rules: "Lead email", "Lead name": the run saves a record a rule only alerts on; a rule that blocks still refuses it',
    ]);
    expect(automationLines(ruled, 'TGT', { applyAssignmentRules: true })[2]).toBe(
      '    assignment rule "Lead routing": applied (--apply-assignment-rules): it can give the records it routes another owner, and mail that owner',
    );
  });
});
