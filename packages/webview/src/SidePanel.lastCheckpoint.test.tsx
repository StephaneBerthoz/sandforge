import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, render, screen } from '@testing-library/react';
import i18n from 'i18next';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import './i18n';
import fr from './i18n/locales/fr.json';
import { useFavoritesStore } from './stores/useFavoritesStore';
import { useOrgStore } from './stores/useOrgStore';
import { useRecentOpsStore } from './stores/useRecentOpsStore';

/*
 * The line under Checkpoints in the side bar: when the selected org's latest
 * checkpoint that can be rewound to was taken. The side bar asks the
 * extension on its raw lane, never through the broker, and the extension
 * answers from this machine's store. Rendered with the real catalogue, as the
 * side bar ships it, so what is read is the sentence a person reads.
 */

const host = vi.hoisted(() => {
  const posted: Array<{ type?: string; payload?: { orgId?: string } }> = [];
  // One object for the whole file, as the webview's own API is: the side
  // bar's effects hang on it.
  const api = {
    postMessage: (message: { type?: string; payload?: { orgId?: string } }) => {
      posted.push(message);
    },
    getState: () => undefined,
    setState: () => undefined,
  };
  return { posted, api };
});

vi.mock('./hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => host.api,
  getVscodeApi: () => host.api,
}));

import { SidePanel } from './SidePanel';

const NOW = Date.parse('2026-10-28T14:00:00.000Z');

function org(overrides: Partial<SalesforceOrg>): SalesforceOrg {
  return {
    id: 'org-1',
    alias: 'DevSandbox',
    username: 'dev@example.com',
    instanceUrl: 'https://example.my.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.MEDIUM,
    appearance: { color: '#4a9eff', icon: '', position: 0 },
    metadata: { apiVersion: '66.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-10-01T09:00:00.000Z',
    tags: [],
    ...overrides,
  };
}

const DEV = org({});
const QA = org({ id: 'org-2', alias: 'QASandbox', orgId: '00D000000000002' });
const PROD = org({
  id: 'org-prod',
  alias: 'Prod',
  orgId: '00D000000000003',
  orgType: 'Production',
  safetyTier: OrgSafetyTier.CRITICAL,
});

/** Deliver a message from the extension, as the side bar receives it. */
function fromExtension(data: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  });
}

function deliverOrgs(orgs: SalesforceOrg[], selectedOrgId: string): void {
  fromExtension({ type: 'org:list:response', payload: { orgs, selectedOrgId } });
}

/** The extension's answer for `orgId`, with a checkpoint taken `agoMs` before now. */
function answer(orgId: string, agoMs?: number, name = 'Before UAT'): void {
  fromExtension({
    type: 'sidebar:lastCheckpoint',
    payload:
      agoMs === undefined
        ? { orgId }
        : {
            orgId,
            checkpoint: {
              checkpointId: 'ck-20261028-120000-0001',
              name,
              takenAt: new Date(Date.now() - agoMs).toISOString(),
            },
          },
  });
}

/** The orgs the side bar asked the line of, in order. */
function asked(): Array<string | undefined> {
  return host.posted
    .filter((message) => message.type === 'sidebar:requestLastCheckpoint')
    .map((message) => message.payload?.orgId);
}

const line = () => screen.queryByTestId('sidepanel-last-checkpoint');
const checkpointsButton = () => screen.getByTestId('sidepanel-nav-checkpoint');

describe('SidePanel — the line under Checkpoints', () => {
  beforeEach(async () => {
    host.posted.length = 0;
    useRecentOpsStore.setState({ ops: [] });
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    useFavoritesStore.setState({ favorites: [] });
    await i18n.changeLanguage('en');
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('names the selected sandbox’s latest checkpoint and its age under the row, which keeps its name and is described by the line', () => {
    render(<SidePanel />);
    deliverOrgs([DEV, QA], DEV.id);
    expect(asked()).toEqual([DEV.id]);

    answer(DEV.id, 2 * 3_600_000);

    const shown = line();
    expect(shown).toHaveTextContent('Last checkpoint of DevSandbox: 2 hours ago');
    const takenAt = new Date(NOW - 2 * 3_600_000);
    const date = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(takenAt);
    expect(shown).toHaveAttribute('title', `“Before UAT”, taken ${date}`);
    // Right under the Checkpoints row, inside the Modules list.
    expect(checkpointsButton().parentElement?.nextElementSibling).toBe(shown);
    expect(screen.getByTestId('sidepanel-modules')).toContainElement(shown);
    expect(checkpointsButton()).toHaveAccessibleName('Checkpoints');
    expect(checkpointsButton()).toHaveAccessibleDescription(
      'Last checkpoint of DevSandbox: 2 hours ago',
    );
    // Not a control of its own: the row opens the page.
    expect(shown?.closest('button')).toBeNull();
  });

  it('shows no line, and describes nothing, when the org has no checkpoint that can be rewound to', () => {
    render(<SidePanel />);
    deliverOrgs([DEV, QA], DEV.id);

    answer(DEV.id);
    expect(line()).toBeNull();
    expect(checkpointsButton()).not.toHaveAttribute('aria-describedby');

    // An answer that is not one is let be.
    fromExtension({
      type: 'sidebar:lastCheckpoint',
      payload: { orgId: DEV.id, checkpoint: { checkpointId: 'ck-1', name: 3, takenAt: 'x' } },
    });
    expect(line()).toBeNull();
  });

  it('never asks of a production org, and shows nothing for one whatever answers', () => {
    render(<SidePanel />);
    deliverOrgs([PROD, DEV], PROD.id);
    expect(asked()).toEqual([]);

    answer(PROD.id, 3_600_000);
    expect(line()).toBeNull();

    // Positive control: the sandbox beside it, once selected, is asked of.
    act(() => useOrgStore.getState().selectOrg(DEV.id));
    expect(asked()).toEqual([DEV.id]);
  });

  it('keeps the line to the org selected: an answer for the org before is let be', () => {
    render(<SidePanel />);
    deliverOrgs([DEV, QA], DEV.id);
    answer(DEV.id, 3_600_000);
    expect(line()).toHaveTextContent('DevSandbox');

    act(() => useOrgStore.getState().selectOrg(QA.id));
    expect(asked()).toEqual([DEV.id, QA.id]);
    expect(line()).toBeNull();

    // The answer for the org before, arriving late, says nothing of this one.
    answer(DEV.id, 3_600_000);
    expect(line()).toBeNull();

    answer(QA.id, 5 * 60_000, 'Clean baseline');
    expect(line()).toHaveTextContent('Last checkpoint of QASandbox: 5 minutes ago');
  });

  it('writes the age again each minute, and asks again, while the org stays selected', () => {
    render(<SidePanel />);
    deliverOrgs([DEV, QA], DEV.id);
    answer(DEV.id, 60_000);
    expect(line()).toHaveTextContent('Last checkpoint of DevSandbox: 1 minute ago');

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(line()).toHaveTextContent('Last checkpoint of DevSandbox: 2 minutes ago');
    // Asked again: a checkpoint taken from the command line shows as well.
    expect(asked()).toEqual([DEV.id, DEV.id]);
  });

  it('says a take the org’s clock ends ahead of this machine’s ended now, not in the future', () => {
    render(<SidePanel />);
    deliverOrgs([DEV, QA], DEV.id);

    answer(DEV.id, -5_000);

    expect(line()).toHaveTextContent('Last checkpoint of DevSandbox: now');
  });

  it('says it in French, the age and the date written in French too', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await act(async () => {
      await i18n.changeLanguage('fr');
    });
    render(<SidePanel />);
    deliverOrgs([DEV, QA], DEV.id);

    answer(DEV.id, 2 * 3_600_000);

    const date = new Intl.DateTimeFormat('fr', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(NOW - 2 * 3_600_000));
    expect(line()).toHaveTextContent('Dernier point de contrôle de DevSandbox : il y a 2 heures');
    expect(line()).toHaveAttribute('title', `« Before UAT », créé le ${date}`);
    expect(checkpointsButton()).toHaveAccessibleName('Points de contrôle');
  });
});
