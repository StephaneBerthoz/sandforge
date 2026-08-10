import * as vscode from 'vscode';
import type { SalesforceOrg, OrgType } from '@sandforge/shared';
import type { OrgManager } from '../core/connection/OrgManager';

/** Codicon per org type — keeps the tree scannable at a glance. */
function iconForOrgType(orgType: OrgType): string {
  switch (orgType) {
    case 'Production':
      return 'cloud';
    case 'Sandbox':
      return 'beaker';
    case 'Scratch':
      return 'rocket';
    case 'Developer':
      return 'code';
    default:
      return 'plug';
  }
}

/**
 * Tree item for a registered org (leaf node). `contextValue` enables the
 * `view/item/context` menu contribution (`when: viewItem == sandforgeOrg`),
 * and `org` is passed to the `sandforge.openOrgInBrowser` command.
 */
export class OrgTreeItem extends vscode.TreeItem {
  constructor(readonly org: SalesforceOrg) {
    super(org.alias, vscode.TreeItemCollapsibleState.None);
    this.description = `${org.username} — ${org.status}`;
    this.tooltip = `${org.alias} — ${org.username}\n${org.orgType} · ${org.status}\n${org.instanceUrl}`;
    this.contextValue = 'sandforgeOrg';
    this.iconPath = new vscode.ThemeIcon(iconForOrgType(org.orgType));
  }
}

/**
 * Native TreeDataProvider listing the orgs known to the OrgManager.
 *
 * Refreshes automatically on OrgManager change events (added / removed /
 * updated / statusChanged) and on demand via refresh() (wired to the
 * `sandforge.orgsView.refresh` command in extension.ts).
 */
export class OrgsTreeProvider implements vscode.TreeDataProvider<OrgTreeItem> {
  /** The view ID registered in package.json (`contributes.views.sandforge`). */
  static readonly viewType = 'sandforge.orgsView';

  private readonly changeEmitter = new vscode.EventEmitter<OrgTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private readonly unsubOrgChange: () => void;

  constructor(private readonly orgManager: OrgManager) {
    this.unsubOrgChange = orgManager.onOrgChange(() => this.refresh());
  }

  /** Fire a full-tree refresh (no incremental diffing — the org list is small). */
  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(element: OrgTreeItem): vscode.TreeItem {
    return element;
  }

  /** Root level = all registered orgs; org items are leaves. */
  getChildren(element?: OrgTreeItem): OrgTreeItem[] {
    if (element) {
      return [];
    }
    return this.orgManager.getAllOrgs().map((org) => new OrgTreeItem(org));
  }

  /** Release the OrgManager subscription and the emitter. */
  dispose(): void {
    this.unsubOrgChange();
    this.changeEmitter.dispose();
  }
}
