import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// `l10n.t` with the host's semantics: the source string looked up in a bundle,
// falling back to itself, then `{0}` interpolated. Tests load a real bundle,
// so a notice missing from it shows up as English where French was expected.
const l10nBundle = vi.hoisted(() => ({ current: {} as Record<string, string> }));

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn(),
  },
  l10n: {
    t: (message: string, ...args: unknown[]): string =>
      (l10nBundle.current[message] ?? message).replace(/\{(\d+)\}/g, (_m, i: string) =>
        String(args[Number(i)] ?? ''),
      ),
  },
}));

const identityObservers = vi.hoisted(() => ({
  current: undefined as ((orgId: string, identity: { organizationId: string }) => void) | undefined,
}));

vi.mock('../core/connection/ConnectionHelper', () => ({
  observeValidatedIdentities: vi.fn(
    (observer: ((orgId: string, identity: { organizationId: string }) => void) | undefined) => {
      identityObservers.current = observer;
    },
  ),
}));

import * as vscode from 'vscode';
import type { SalesforceOrg } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';
import { sandboxRefreshNotice, wireSandboxRefreshDetection } from './sandboxRefreshComposition';
import { observeValidatedIdentities } from '../core/connection/ConnectionHelper';
import { SandboxRefreshDetector } from '../modules/monitor/SandboxRefreshDetector';
import { ConfigStore } from '../core/storage/ConfigStore';
import { OrgManager } from '../core/connection/OrgManager';
import { InMemoryConfigStoreBackend } from '../test/InMemoryConfigStoreBackend';

const REGISTERED_ORG_ID = '00DXX00000AbCdE2A1';
const REFRESHED_ORG_ID = '00Dxx00000FgHiJ3B2';

function org(overrides: Partial<SalesforceOrg>): SalesforceOrg {
  return {
    id: REGISTERED_ORG_ID,
    alias: 'UAT',
    username: 'admin@acme.test.uat',
    instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
    orgId: REGISTERED_ORG_ID,
    orgType: 'Sandbox',
    authMethod: 'sfdx_import',
    safetyTier: OrgSafetyTier.MEDIUM,
    appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-09-01T08:00:00.000Z',
    tags: [],
    ...overrides,
  };
}

function bundle(locale: string): Record<string, string> {
  return JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'l10n', `bundle.l10n.${locale}.json`), 'utf8'),
  ) as Record<string, string>;
}

describe('sandbox refresh detection wiring', () => {
  let orgManager: OrgManager;
  let detector: SandboxRefreshDetector;

  beforeEach(() => {
    vi.mocked(vscode.window.showWarningMessage).mockReset();
    l10nBundle.current = bundle('fr');
    identityObservers.current = undefined;
    const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
    configStore.initialize();
    orgManager = new OrgManager();
    orgManager.addOrg(org({}));
    detector = new SandboxRefreshDetector({ configStore, orgManager });
  });

  it('hands the org every validated connection reached to the detector', () => {
    const observe = vi.spyOn(detector, 'observe');
    wireSandboxRefreshDetection(detector, orgManager);

    identityObservers.current?.(REGISTERED_ORG_ID, { organizationId: REFRESHED_ORG_ID });

    expect(observe).toHaveBeenCalledWith(
      REGISTERED_ORG_ID,
      { organizationId: REFRESHED_ORG_ID },
      'connection',
    );
  });

  it('warns the user, in the editor language, of a sandbox that answers as a new org', () => {
    wireSandboxRefreshDetection(detector, orgManager);

    identityObservers.current?.(REGISTERED_ORG_ID, { organizationId: REFRESHED_ORG_ID });

    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    const shown = String(vi.mocked(vscode.window.showWarningMessage).mock.calls[0][0]);
    expect(shown).toContain('la sandbox UAT a été rafraîchie');
  });

  it('says nothing of a sandbox that still answers as the org it was registered with', () => {
    wireSandboxRefreshDetection(detector, orgManager);

    identityObservers.current?.(REGISTERED_ORG_ID, { organizationId: REGISTERED_ORG_ID });

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('names the production org whose history reported the refresh', () => {
    orgManager.addOrg(
      org({
        id: '00Dxx00000KlMnO4C3',
        orgId: '00Dxx00000KlMnO4C3',
        alias: 'PROD',
        orgType: 'Production',
        instanceUrl: 'https://acme.my.salesforce.com',
      }),
    );

    const notice = sandboxRefreshNotice(
      {
        orgId: REGISTERED_ORG_ID,
        detectedAt: '2026-09-22T09:00:00.000Z',
        evidence: 'production',
        sandboxName: 'uat',
        reportedBy: '00Dxx00000KlMnO4C3',
      },
      orgManager,
    );

    expect(notice).toContain('UAT');
    expect(notice).toContain('PROD');
    expect(notice).toContain("l'historique de rafraîchissement");
  });

  it('stops observing and warning once disposed', () => {
    const wiring = wireSandboxRefreshDetection(detector, orgManager);

    wiring.dispose();
    detector.observe(REGISTERED_ORG_ID, { organizationId: REFRESHED_ORG_ID }, 'connection');

    expect(observeValidatedIdentities).toHaveBeenLastCalledWith(undefined);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });
});
