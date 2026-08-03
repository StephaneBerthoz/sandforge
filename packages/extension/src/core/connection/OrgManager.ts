import type { SalesforceOrg, OrgStatus, UUID } from '@sandforge/shared';
import { logger } from '../../logger.js';
import { extractErrorMessage } from '../common/extractErrorMessage.js';

/** Event emitted when org state changes */
export interface OrgManagerEvent {
  type: 'added' | 'removed' | 'updated' | 'statusChanged';
  orgId: UUID;
  org?: SalesforceOrg;
}

/** Listener function type */
export type OrgManagerListener = (event: OrgManagerEvent) => void;

/**
 * Manages the lifecycle of Salesforce org connections.
 * Acts as the central registry for all connected orgs.
 */
export class OrgManager {
  private orgs: Map<UUID, SalesforceOrg> = new Map();
  private listeners: Set<OrgManagerListener> = new Set();

  /**
   * Register a listener for org change events.
   * @returns An unsubscribe function removing the listener.
   */
  onOrgChange(listener: OrgManagerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Remove a listener */
  offOrgChange(listener: OrgManagerListener): void {
    this.listeners.delete(listener);
  }

  private emit(event: OrgManagerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.warn('OrgManager listener threw', {
          error: extractErrorMessage(err),
        });
      }
    }
  }

  /** Add or update an org */
  addOrg(org: SalesforceOrg): void {
    const existing = this.orgs.has(org.id);
    this.orgs.set(org.id, org);
    this.emit({ type: existing ? 'updated' : 'added', orgId: org.id, org });
  }

  /** Remove an org by ID */
  removeOrg(orgId: UUID): boolean {
    const existed = this.orgs.delete(orgId);
    if (existed) {
      this.emit({ type: 'removed', orgId });
    }
    return existed;
  }

  /** Get an org by ID */
  getOrg(orgId: UUID): SalesforceOrg | undefined {
    return this.orgs.get(orgId);
  }

  /** Get all orgs */
  getAllOrgs(): SalesforceOrg[] {
    return Array.from(this.orgs.values());
  }

  /** Update org status */
  updateStatus(orgId: UUID, status: OrgStatus): boolean {
    const org = this.orgs.get(orgId);
    if (!org) return false;
    const updated = { ...org, status };
    this.orgs.set(orgId, updated);
    this.emit({ type: 'statusChanged', orgId, org: updated });
    return true;
  }

  /** Find orgs by tag */
  findByTag(tag: string): SalesforceOrg[] {
    return this.getAllOrgs().filter((org) => org.tags.includes(tag));
  }

  /** Get the number of connected orgs */
  get connectedCount(): number {
    return this.getAllOrgs().filter((org) => org.status === 'connected').length;
  }

  /** Clear all orgs */
  clear(): void {
    const orgIds = Array.from(this.orgs.keys());
    this.orgs.clear();
    for (const orgId of orgIds) {
      this.emit({ type: 'removed', orgId });
    }
  }

  /** Dispose the manager */
  dispose(): void {
    this.listeners.clear();
    this.orgs.clear();
  }
}
