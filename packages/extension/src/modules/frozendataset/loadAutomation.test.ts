import { describe, expect, it } from 'vitest';
import type { ForgeTargetAutomation, ForgeTargetFlow } from '@sandforge/shared';
import { mutePlanOf } from '@sandforge/shared';
import {
  AUTOMATION_NOT_ACCEPTED,
  loadAutomationLines,
  loadAutomationOf,
} from './loadAutomation.js';

/**
 * A load's question on what the target runs as it writes, against the flow a
 * scratch org ran: after save on the creation of an opportunity product, it
 * deletes the record that started it, and the load's two products were gone
 * the second they went in, with no question asked. Its bypass `Load_Data` is
 * held by the set `Data_Load`.
 */

/** The flow after save that deletes the product it starts on; quiet for `Load_Data` when `bypass`. */
function deletingFlow(options: { bypass?: boolean; held?: boolean } = {}): ForgeTargetFlow {
  return {
    apiName: 'GC_Gate_OLI_Delete',
    label: 'GC Gate OLI Delete',
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: options.bypass
      ? [{ name: 'Load_Data', bypass: true, ...(options.held ? { held: true } : {}) }]
      : [],
    messages: [],
  } as unknown as ForgeTargetFlow;
}

function automation(
  objects: ForgeTargetAutomation['objects'],
  unread: ForgeTargetAutomation['unread'] = [],
): ForgeTargetAutomation {
  return {
    objectsRead: objects.map((object) => object.objectApiName),
    objects,
    bypassGrants: [
      {
        permission: 'Load_Data',
        permissionSets: [{ name: 'Data_Load', label: 'Data load', grants: 1 }],
      },
    ],
    unread,
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 1,
  } as unknown as ForgeTargetAutomation;
}

const PRODUCTS = (flows: ForgeTargetFlow[]): ForgeTargetAutomation =>
  automation([{ objectApiName: 'OpportunityLineItem', flows, triggers: [] }]);

const WRITTEN = ['Opportunity', 'OpportunityLineItem'];

function ask(
  read: ForgeTargetAutomation | { unread: string },
  options: { accepted?: boolean; mute?: boolean; written?: string[] } = {},
) {
  const plan =
    options.mute === true && 'objects' in read
      ? mutePlanOf(read, (_object, write) => write === 'insert' || write === 'update')
      : undefined;
  return loadAutomationOf({
    read,
    ...(plan ? { plan } : {}),
    written: options.written ?? WRITTEN,
    accepted: options.accepted === true,
    target: 'SF-TARGET',
    mayMute: options.mute !== true,
  });
}

describe('loadAutomationOf', () => {
  it('refuses a load while a flow runs on the records it inserts, naming it, nothing written', () => {
    const { info, stop } = ask(PRODUCTS([deletingFlow()]));

    expect(stop?.code).toBe(AUTOMATION_NOT_ACCEPTED);
    expect(stop?.message).toBe(
      'SF-TARGET runs automation as this load inserts its records and updates them: ' +
        'OpportunityLineItem: flow "GC Gate OLI Delete" (insert). Nothing was written. Add ' +
        '--accept-automation to load all the same, or turn that automation off in SF-TARGET first.',
    );
    expect(info).toEqual({
      firing: [
        {
          objectApiName: 'OpportunityLineItem',
          kind: 'flow',
          name: 'GC Gate OLI Delete',
          writes: ['insert'],
        },
      ],
      accepted: false,
      refused: stop,
    });
  });

  it('lets a load with the accord through, saying what runs and that it was accepted', () => {
    const { info, stop } = ask(PRODUCTS([deletingFlow()]), { accepted: true });

    expect(stop).toBeUndefined();
    expect(info?.accepted).toBe(true);
    expect(info).not.toHaveProperty('refused');
    expect(loadAutomationLines(info!, 'SF-TARGET')).toEqual([
      'target automation: what SF-TARGET runs as the load inserts its records and updates them',
      '  OpportunityLineItem: flow "GC Gate OLI Delete" (insert)',
      '  accepted (--accept-automation): the load writes all the same',
    ]);
  });

  it('names a trigger once with every write of the load it runs on', () => {
    const { info } = ask(
      automation([
        {
          objectApiName: 'Opportunity',
          flows: [],
          triggers: [{ name: 'OpportunityTrigger', events: ['beforeInsert', 'afterUpdate'] }],
        },
      ]),
    );

    expect(info?.firing).toEqual([
      {
        objectApiName: 'Opportunity',
        kind: 'trigger',
        name: 'OpportunityTrigger',
        writes: ['insert', 'update'],
      },
    ]);
    expect(info?.refused?.message).toContain(
      'Opportunity: Apex trigger OpportunityTrigger (insert, update)',
    );
  });

  it('asks nothing of what runs only as records go, nor of an object the load does not write', () => {
    const quiet = ask(
      automation([
        {
          objectApiName: 'Opportunity',
          flows: [],
          triggers: [{ name: 'OpportunityCleanup', events: ['beforeDelete'] }],
        },
        { objectApiName: 'Asset', flows: [deletingFlow()], triggers: [] },
      ]),
    );

    expect(quiet).toEqual({});
  });

  it('asks nothing of what a bypass the user holds keeps quiet', () => {
    expect(ask(PRODUCTS([deletingFlow({ bypass: true, held: true })]))).toEqual({});
  });

  it('names the set --mute-automation would assign, and asks nothing once the mute keeps it quiet', () => {
    const asked = ask(PRODUCTS([deletingFlow({ bypass: true })]));
    expect(asked.stop?.message).toContain(
      'With --mute-automation, the load assigns Data_Load to the user it writes as for the load ' +
        'alone, under a lease, and what it keeps quiet does not fire.',
    );

    expect(ask(PRODUCTS([deletingFlow({ bypass: true })]), { mute: true })).toEqual({});
  });

  it('refuses a load whose target would not say what it runs, as one where something runs', () => {
    const { info, stop } = ask({ unread: 'INSUFFICIENT_ACCESS: Tooling API' });

    expect(info?.unread).toEqual([
      { part: 'automation', reason: 'INSUFFICIENT_ACCESS: Tooling API' },
    ]);
    expect(stop?.message).toMatch(
      /^What runs of SF-TARGET could not be read \(INSUFFICIENT_ACCESS: Tooling API\), so what fires as the load writes is not known\. Nothing was written\./,
    );
  });

  it('refuses a load when a part that hides what fires could not be read', () => {
    const { stop } = ask(automation([], [{ part: 'flows', reason: 'REQUEST_LIMIT_EXCEEDED' }]));

    expect(stop?.message).toContain(
      'The flows of SF-TARGET could not be read (REQUEST_LIMIT_EXCEEDED)',
    );
  });
});
