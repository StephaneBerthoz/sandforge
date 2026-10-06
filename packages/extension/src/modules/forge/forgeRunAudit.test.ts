import { describe, it, expect } from 'vitest';
import type { ForgeConfig, ForgeGraph, ForgeTargetAutomation } from '@sandforge/shared';

import {
  ForgeRunAudit,
  RecentTrials,
  TRIED_WITHIN_MS,
  decisionCounts,
  firedOnInsertCounts,
  forgeCaseKey,
} from './forgeRunAudit.js';

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: '001000000000123',
  depth: 'direct',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

const graphOf = (...objects: Array<[string, boolean]>): Pick<ForgeGraph, 'nodes'> => ({
  nodes: objects.map(
    ([objectApiName, included]) => ({ objectApiName, included }) as ForgeGraph['nodes'][number],
  ),
});

const GRAPH = graphOf(['Account', true], ['Contact', true], ['Case', false]);

/** A flow and a trigger on insert of a contact, a process on an account, and a quiet flow. */
const FIRES: ForgeTargetAutomation = {
  objectsRead: ['Account', 'Contact'],
  objects: [
    {
      objectApiName: 'Contact',
      flows: [
        {
          apiName: 'Contact_Welcome',
          label: 'Contact welcome',
          timing: 'afterSave',
          startsOn: 'create',
          condition: 'read',
          permissions: [],
        },
      ],
      triggers: [{ name: 'ContactTrigger', events: ['beforeInsert'] }],
    },
  ],
  unread: [{ part: 'processes', reason: 'not allowed' }],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 3,
};

describe('forgeCaseKey', () => {
  it('is the same case whatever was decided or left out since the discovery', () => {
    const decided: ForgeConfig = {
      ...CONFIG,
      dryRun: true,
      excludedObjects: ['Contact'],
      picklistValueMappings: [{ object: 'Account', field: 'Type', from: 'A', to: 'B' }],
      ignoredGaps: ['gap-1'],
    };

    expect(
      forgeCaseKey(graphOf(['Contact', false], ['Account', true], ['Case', true]), decided),
    ).toBe(forgeCaseKey(GRAPH, CONFIG));
  });

  it('is another case for another target, another record or another graph', () => {
    const key = forgeCaseKey(GRAPH, CONFIG);

    expect(forgeCaseKey(GRAPH, { ...CONFIG, targetOrgId: 'other-org' })).not.toBe(key);
    expect(forgeCaseKey(GRAPH, { ...CONFIG, recordId: '001000000000456' })).not.toBe(key);
    expect(forgeCaseKey(graphOf(['Account', true]), CONFIG)).not.toBe(key);
  });
});

describe('RecentTrials', () => {
  const KEY = forgeCaseKey(GRAPH, CONFIG);
  const AT = Date.parse('2026-10-06T10:00:00.000Z');

  it('says how many minutes before the run its simulation and its rehearsal ended', () => {
    const trials = new RecentTrials();
    trials.note('simulation', KEY, AT);
    trials.note('rehearsal', KEY, AT + 4 * 60_000);

    expect(trials.before(KEY, AT + 12 * 60_000)).toEqual({
      simulatedMinutesBefore: 12,
      rehearsedMinutesBefore: 8,
    });
  });

  it('counts a try seconds before the run as a minute before, never as none', () => {
    const trials = new RecentTrials();
    trials.note('simulation', KEY, AT);

    expect(trials.before(KEY, AT + 5_000)).toEqual({ simulatedMinutesBefore: 1 });
  });

  it('says nothing of a try past the half hour, nor of another case', () => {
    const trials = new RecentTrials();
    trials.note('simulation', KEY, AT);

    expect(trials.before(KEY, AT + TRIED_WITHIN_MS + 1)).toEqual({});
    expect(trials.before(forgeCaseKey(GRAPH, { ...CONFIG, targetOrgId: 'x' }), AT + 1)).toEqual({});
  });

  it('keeps the latest try of each kind', () => {
    const trials = new RecentTrials();
    trials.note('simulation', KEY, AT);
    trials.note('simulation', KEY, AT + 10 * 60_000);

    expect(trials.before(KEY, AT + 11 * 60_000)).toEqual({ simulatedMinutesBefore: 1 });
  });

  it('forgets the oldest case once sixteen others were tried after it', () => {
    const trials = new RecentTrials();
    trials.note('simulation', KEY, AT);
    for (let i = 0; i < 16; i++) {
      trials.note('simulation', forgeCaseKey(GRAPH, { ...CONFIG, recordId: `case-${i}` }), AT);
    }

    expect(trials.before(KEY, AT + 60_000)).toEqual({});
  });
});

describe('firedOnInsertCounts', () => {
  it('counts what fires on insert by kind, and names the parts that could not be read', () => {
    expect(firedOnInsertCounts({ automation: FIRES })).toEqual({
      flow: 1,
      trigger: 1,
      process: 0,
      workflowRule: 0,
      unread: ['processes'],
    });
  });

  it('says none of it could be read when the read failed', () => {
    expect(firedOnInsertCounts({ unread: 'timed out' })).toEqual({
      flow: 0,
      trigger: 0,
      process: 0,
      workflowRule: 0,
      unread: ['automation'],
    });
  });
});

describe('decisionCounts', () => {
  it('counts the decisions of each kind the config holds, and none it does not', () => {
    const config: ForgeConfig = {
      ...CONFIG,
      picklistValueMappings: [
        { object: 'Account', field: 'Type', from: 'A', to: 'B' },
        { object: 'Account', field: 'Type', from: 'C', to: 'B' },
        { object: 'Account', field: 'Rating', from: 'Hot', to: null },
      ],
      fieldExclusions: { Contact: ['Description', 'Fax'] },
      defaultValues: [{ object: 'Case', field: 'Origin', value: 'Web' }],
      truncateFields: [{ object: 'Account', field: 'Name' }],
      recordTypeMappings: [{ object: 'Account', from: 'Partner', to: null }],
      excludedObjects: ['Task'],
      ignoredGaps: ['g1', 'g2'],
    };

    expect(decisionCounts(config)).toEqual([
      { kind: 'map_value', count: 2 },
      { kind: 'leave_empty', count: 3 },
      { kind: 'set_default', count: 1 },
      { kind: 'truncate', count: 1 },
      { kind: 'map_record_type', count: 1 },
      { kind: 'exclude_object', count: 1 },
      { kind: 'ignore', count: 2 },
    ]);
    expect(decisionCounts(CONFIG)).toEqual([]);
  });

  it('adds the rows the run said each kind changed, and never a value', () => {
    const config: ForgeConfig = {
      ...CONFIG,
      picklistValueMappings: [{ object: 'Account', field: 'Type', from: 'Secret', to: 'Other' }],
    };

    const counts = decisionCounts(config, [
      {
        kind: 'map_value',
        objectApiName: 'Account',
        field: 'Type',
        from: 'Secret',
        to: 'Other',
        rows: 4,
      },
      {
        kind: 'map_value',
        objectApiName: 'Account',
        field: 'Type',
        from: 'Secret',
        to: 'Other',
        rows: 3,
      },
    ]);

    expect(counts).toEqual([{ kind: 'map_value', count: 1, rows: 7 }]);
    expect(JSON.stringify(counts)).not.toMatch(/Secret|Other|Type/);
  });
});

describe('ForgeRunAudit', () => {
  it('says what the config chose before the run met its gate', () => {
    const audit = new ForgeRunAudit(
      { ...CONFIG, anonymizePII: true, keepContactPoints: true },
      { reviewSkipped: true, simulatedMinutesBefore: 3 },
    );

    expect(audit.context()).toEqual({
      anonymized: true,
      contactPoints: 'kept',
      reviewSkipped: true,
      simulatedMinutesBefore: 3,
    });
  });

  it('says contact points neutralized by default, and Review not skipped when it was not', () => {
    expect(new ForgeRunAudit(CONFIG, { reviewSkipped: false }).context()).toEqual({
      anonymized: false,
      contactPoints: 'neutralized',
      reviewSkipped: false,
    });
  });

  it('adds what fired and what was confirmed, each question once, in the order answered', () => {
    const audit = new ForgeRunAudit(CONFIG, { reviewSkipped: false });
    audit.automationRead({ automation: FIRES });
    audit.confirm('automation');
    audit.confirm('volume');
    audit.confirm('volume');

    expect(audit.context()).toMatchObject({
      firedOnInsert: { flow: 1, trigger: 1, unread: ['processes'] },
      confirmed: ['automation', 'volume'],
    });
  });

  it('hands each entry a context of its own, which a later one does not change', () => {
    const audit = new ForgeRunAudit(CONFIG, { reviewSkipped: false });
    audit.automationRead({ automation: FIRES });
    audit.confirm('automation');
    const first = audit.context();
    audit.confirm('volume');

    expect(first.confirmed).toEqual(['automation']);
  });
});
