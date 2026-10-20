import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { SalesforceOrg } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';
import { HAS_ORG_CONTEXT, wireHasOrgContext, type ExecuteCommand } from './orgContextComposition';
import { OrgManager } from '../core/connection/OrgManager';
import { OrgRegistry } from '../core/connection/OrgRegistry';
import { ConfigStore } from '../core/storage/ConfigStore';
import { SecretVault } from '../core/storage/SecretVault';
import { InMemoryConfigStoreBackend } from '../test/InMemoryConfigStoreBackend';

function org(id: string, alias: string): SalesforceOrg {
  return {
    id,
    alias,
    username: `admin@${alias.toLowerCase()}.test`,
    instanceUrl: `https://${alias.toLowerCase()}.example.test`,
    orgId: id,
    orgType: 'Developer',
    authMethod: 'sfdx_import',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-09-01T08:00:00.000Z',
    tags: [],
  };
}

/** A vault over a map, as the editor's secret storage would keep them. */
function vault(): SecretVault {
  const secrets = new Map<string, string>();
  return new SecretVault({
    get: (key) => Promise.resolve(secrets.get(key)),
    store: (key, value) => Promise.resolve(void secrets.set(key, value)),
    delete: (key) => Promise.resolve(void secrets.delete(key)),
  });
}

/** The values the context key was set to, in order. */
function contextValues(executeCommand: Mock<ExecuteCommand>): unknown[] {
  return executeCommand.mock.calls
    .filter(([command, key]) => command === 'setContext' && key === HAS_ORG_CONTEXT)
    .map((call) => call[2]);
}

describe('the context the Connect step of Get Started completes on', () => {
  let configStore: ConfigStore;
  let orgManager: OrgManager;
  let registry: OrgRegistry;
  let executeCommand: Mock<ExecuteCommand>;

  beforeEach(() => {
    configStore = new ConfigStore(new InMemoryConfigStoreBackend());
    configStore.initialize();
    orgManager = new OrgManager();
    registry = new OrgRegistry(configStore, vault(), orgManager);
    executeCommand = vi.fn<ExecuteCommand>(() => Promise.resolve(undefined));
  });

  it('is false at activation while no org is registered', () => {
    registry.loadAll();
    wireHasOrgContext(orgManager, executeCommand);

    expect(contextValues(executeCommand)).toEqual([false]);
  });

  it('is true at activation when the registry loads an org stored earlier', async () => {
    await registry.saveOrg(org('org-1', 'Dev'));
    const reloaded = new OrgManager();
    new OrgRegistry(configStore, vault(), reloaded).loadAll();

    wireHasOrgContext(reloaded, executeCommand);

    expect(contextValues(executeCommand)).toEqual([true]);
  });

  it('turns true once an org is registered, and false when the last one is removed', async () => {
    wireHasOrgContext(orgManager, executeCommand);

    await registry.saveOrg(org('org-1', 'Dev'));
    await registry.saveOrg(org('org-2', 'Uat'));
    await registry.removeOrg('org-1');
    expect(contextValues(executeCommand)).toEqual([false, true]);

    await registry.removeOrg('org-2');
    expect(contextValues(executeCommand)).toEqual([false, true, false]);
  });

  it('sets nothing for a change that leaves an org registered', async () => {
    await registry.saveOrg(org('org-1', 'Dev'));
    wireHasOrgContext(orgManager, executeCommand);

    orgManager.updateStatus('org-1', 'expired');
    registry.updateOrgMetadata({ ...org('org-1', 'Dev'), alias: 'Renamed' });

    expect(contextValues(executeCommand)).toEqual([true]);
  });

  it('stops following the registry once disposed', async () => {
    const wiring = wireHasOrgContext(orgManager, executeCommand);
    wiring.dispose();

    await registry.saveOrg(org('org-1', 'Dev'));

    expect(contextValues(executeCommand)).toEqual([false]);
  });

  it('keeps a context the editor failed to set from reaching the host as a rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      wireHasOrgContext(orgManager, () => Promise.reject(new Error('no editor')));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
