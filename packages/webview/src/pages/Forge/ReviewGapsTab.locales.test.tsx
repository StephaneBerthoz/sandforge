import type { ReactElement } from 'react';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { createInstance, type i18n as I18n } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import type {
  ForgeConfig,
  ForgeGap,
  ForgeGraph,
  ForgeGraphNode,
  MutedAutomationAlsoLifted,
} from '@sandforge/shared';
import { forgeGapId } from '@sandforge/shared';

import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import de from '../../i18n/locales/de.json';
import es from '../../i18n/locales/es.json';
import ptBR from '../../i18n/locales/pt-BR.json';
import ja from '../../i18n/locales/ja.json';
import { useForgeStore } from '../../stores/useForgeStore';
import { ReviewGapsTab } from './ReviewGapsTab';

vi.mock('../../bridge/sendBridgeMessage', () => ({ sendBridgeMessage: vi.fn(() => 'req-1') }));

/*
 * The list for the target's admin under the mute, in each of the six locales,
 * under a real i18next instance: what the list says to change is read in the
 * locale's own words, so a step left in for a rule the mute lifts shows
 * whatever the translation calls it.
 */
const LOCALES = { en, fr, de, es, 'pt-BR': ptBR, ja } as const;
let instance: I18n;

beforeAll(async () => {
  instance = createInstance();
  await instance.use(initReactI18next).init({
    resources: Object.fromEntries(
      Object.entries(LOCALES).map(([lng, translation]) => [lng, { translation }]),
    ),
    lng: 'en',
    fallbackLng: false,
    interpolation: { escapeValue: false },
  });
});

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

function node(objectApiName: string): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 10,
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
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
  };
}

const GRAPH: ForgeGraph = {
  nodes: [node('Account'), node('Contact')],
  edges: [],
  totalRecords: 20,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

/** A field only the target requires: the admin makes it optional, mute or not. */
const REQUIRED: ForgeGap = {
  id: forgeGapId('required_field_missing', 'Account', 'Region__c'),
  kind: 'required_field_missing',
  severity: 'blocking',
  source: 'metadata',
  objectApiName: 'Account',
  field: 'Region__c',
  rows: 0,
  decisions: ['set_default', 'exclude_object'],
};

/** A validation rule of Contact whose bypass the set the mute assigns holds, as on the trap org. */
const RULE: ForgeGap = {
  id: forgeGapId('validation_rule', 'Contact', 'Email', undefined, 'Email_Required'),
  kind: 'validation_rule',
  severity: 'warning',
  source: 'metadata',
  objectApiName: 'Contact',
  field: 'Email',
  value: 'Email_Required',
  rows: 0,
  detail: {
    rule: 'Email_Required',
    bypasses: ['$Permission.Skip_Rules'],
    assign: ['Skip_Rules=Data_Load'],
  },
  decisions: ['leave_empty', 'ignore'],
  defaultDecision: 'leave_empty',
};

/** What the mute's set lifts beside the flow it is assigned for. */
const LIFTS: MutedAutomationAlsoLifted = {
  objectApiName: 'Contact',
  kind: 'validationRule',
  name: 'Email_Required',
  permission: 'Skip_Rules',
  permissionSet: 'Data_Load',
};

/** The tab in the instance's language, the mute ticked when `lifted` is given. */
function tab(lifted?: readonly MutedAutomationAlsoLifted[]): ReactElement {
  return (
    <I18nextProvider i18n={instance}>
      <ReviewGapsTab {...(lifted ? { lifted } : {})} />
    </I18nextProvider>
  );
}

describe("ReviewGapsTab — the list for the target's admin under the mute, in six locales", () => {
  beforeEach(() => {
    cleanup();
    useForgeStore.getState().reset();
    useForgeStore.getState().setConfig(CONFIG);
    useForgeStore.getState().setGraph(GRAPH);
  });

  for (const locale of Object.keys(LOCALES)) {
    describe(locale, () => {
      beforeEach(async () => {
        await act(async () => {
          await instance.changeLanguage(locale);
        });
      });

      // With the mute ticked, the Gaps tab said the rule lifted and refusing
      // nothing; the list for the admin under it still said to turn it off.
      const turnOff = (): string =>
        instance.t('forgeRun.gaps.admin.step.deactivateValidationRule', {
          value: 'Email_Required',
          object: 'Contact',
        });
      const makeOptional = (): string =>
        instance.t('forgeRun.gaps.admin.step.makeFieldOptional', {
          object: 'Account',
          field: 'Region__c',
        });

      it('leaves out a rule the ticked mute lifts, and names only what the admin still has to change', () => {
        act(() => useForgeStore.getState().setGaps('metadata', [REQUIRED, RULE]));
        render(tab([LIFTS]));

        const text = screen.getByTestId('gaps-admin-text').textContent ?? '';
        expect(text).not.toContain(turnOff());
        expect(text).not.toContain('Email_Required');
        expect(text).toContain(`- ${makeOptional()}`);
        expect(
          within(screen.getByTestId('gaps-admin-list')).getByText(
            instance.t('forgeRun.gaps.admin.show', { count: 1 }),
          ),
        ).toBeTruthy();
        // The tab says it lifted, in the same locale, where the list leaves it out.
        expect(
          within(screen.getByTestId(`gap-${RULE.id}`)).getByTestId('gap-lifted').textContent,
        ).toBe(instance.t('forgeRun.gaps.lifted', { permission: 'Skip_Rules', set: 'Data_Load' }));
      });

      it('shows no list when the rule the mute lifts was all it held', () => {
        act(() => useForgeStore.getState().setGaps('metadata', [RULE]));
        render(tab([LIFTS]));

        expect(screen.queryByTestId('gaps-admin')).toBeNull();
      });

      it('keeps the rule in the list with the mute unticked, or lifting another rule', () => {
        act(() => useForgeStore.getState().setGaps('metadata', [REQUIRED, RULE]));
        const { rerender } = render(tab());
        const said = (): void => {
          const text = screen.getByTestId('gaps-admin-text').textContent ?? '';
          expect(text).toContain(`- ${turnOff()}`);
          expect(text).toContain(`- ${makeOptional()}`);
          expect(
            within(screen.getByTestId('gaps-admin-list')).getByText(
              instance.t('forgeRun.gaps.admin.show', { count: 2 }),
            ),
          ).toBeTruthy();
        };
        said();

        rerender(tab([{ ...LIFTS, name: 'Phone_Format' }]));
        said();
      });
    });
  }
});
