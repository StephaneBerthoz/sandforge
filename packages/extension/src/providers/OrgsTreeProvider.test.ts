import { describe, it, expect, vi, beforeEach } from 'vitest';

interface MockEmitter {
  event: ReturnType<typeof vi.fn>;
  fire: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

let lastEmitter: MockEmitter;

vi.mock('vscode', () => ({
  EventEmitter: vi.fn(() => {
    lastEmitter = { event: vi.fn(), fire: vi.fn(), dispose: vi.fn() };
    return lastEmitter;
  }),
  TreeItem: class {
    label?: string;
    collapsibleState?: number;
    description?: string;
    tooltip?: string;
    contextValue?: string;
    iconPath?: unknown;
    constructor(label: string, collapsibleState?: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    constructor(readonly id: string) {}
  },
}));

import { OrgsTreeProvider, OrgTreeItem } from './OrgsTreeProvider';
import { OrgManager } from '../core/connection/OrgManager';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';

function makeOrg(overrides: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: 'org-1',
    alias: 'dev',
    username: 'admin@dev.com',
    instanceUrl: 'https://dev.my.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Sandbox',
    authMethod: 'sfdx_import',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0000FF', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Developer', features: [] },
    status: 'connected',
    lastConnected: '2026-08-10T00:00:00.000Z',
    tags: [],
    ...overrides,
  };
}

describe('OrgsTreeProvider', () => {
  let orgManager: OrgManager;
  let provider: OrgsTreeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    orgManager = new OrgManager();
    provider = new OrgsTreeProvider(orgManager);
  });

  describe('getChildren', () => {
    it('returns an empty array when no orgs are registered', () => {
      expect(provider.getChildren()).toEqual([]);
    });

    it('returns one item per registered org with the alias as label', () => {
      orgManager.addOrg(makeOrg());
      orgManager.addOrg(makeOrg({ id: 'org-2', alias: 'prod', orgType: 'Production' }));

      const children = provider.getChildren();

      expect(children).toHaveLength(2);
      expect(children.map((c) => c.label)).toEqual(['dev', 'prod']);
    });

    it('returns no children for a leaf item', () => {
      orgManager.addOrg(makeOrg());
      const [item] = provider.getChildren();

      expect(provider.getChildren(item)).toEqual([]);
    });
  });

  describe('getTreeItem', () => {
    it('returns the element unchanged', () => {
      orgManager.addOrg(makeOrg());
      const [item] = provider.getChildren();

      expect(provider.getTreeItem(item)).toBe(item);
    });
  });

  describe('OrgTreeItem', () => {
    it('exposes username + status in the description and the org on the item', () => {
      const item = new OrgTreeItem(makeOrg({ status: 'expired' }));

      expect(item.org.alias).toBe('dev');
      expect(item.description).toBe('admin@dev.com — expired');
      expect(item.contextValue).toBe('sandforgeOrg');
      expect(item.tooltip).toContain('https://dev.my.salesforce.com');
    });

    it('picks a type-specific icon (Production → cloud, Sandbox → beaker)', () => {
      const prod = new OrgTreeItem(makeOrg({ orgType: 'Production' }));
      const sandbox = new OrgTreeItem(makeOrg({ orgType: 'Sandbox' }));

      expect(prod.iconPath).toEqual(expect.objectContaining({ id: 'cloud' }));
      expect(sandbox.iconPath).toEqual(expect.objectContaining({ id: 'beaker' }));
    });
  });

  describe('refresh', () => {
    it('fires the change event when an org is added to the manager', () => {
      orgManager.addOrg(makeOrg());

      expect(lastEmitter.fire).toHaveBeenCalledWith(undefined);
    });

    it('fires the change event on manual refresh()', () => {
      provider.refresh();

      expect(lastEmitter.fire).toHaveBeenCalledWith(undefined);
    });
  });

  describe('dispose', () => {
    it('unsubscribes from the OrgManager and disposes the emitter', () => {
      provider.dispose();

      expect(lastEmitter.dispose).toHaveBeenCalledOnce();

      lastEmitter.fire.mockClear();
      orgManager.addOrg(makeOrg());
      expect(lastEmitter.fire).not.toHaveBeenCalled();
    });
  });
});
