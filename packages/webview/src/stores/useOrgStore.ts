import { create } from 'zustand';
import type { SalesforceOrg, OrgSafetyTier } from '@sandforge/shared';

/** State and actions for managing Salesforce orgs */
export interface OrgState {
  orgs: SalesforceOrg[];
  selectedOrgId: string | null;
  isConnecting: boolean;
  setOrgs: (orgs: SalesforceOrg[]) => void;
  addOrg: (org: SalesforceOrg) => void;
  updateOrg: (id: string, updates: Partial<SalesforceOrg>) => void;
  removeOrg: (id: string) => void;
  selectOrg: (id: string | null) => void;
  setConnecting: (connecting: boolean) => void;
  selectedOrg: () => SalesforceOrg | undefined;
  connectedOrgs: () => SalesforceOrg[];
  orgsByTier: (tier: OrgSafetyTier) => SalesforceOrg[];
}

/** Zustand store for Salesforce org management */
export const useOrgStore = create<OrgState>((set, get) => ({
  orgs: [],
  selectedOrgId: null,
  isConnecting: false,

  setOrgs(orgs: SalesforceOrg[]): void {
    set({ orgs });
  },

  addOrg(org: SalesforceOrg): void {
    set((state) => ({ orgs: [...state.orgs, org] }));
  },

  updateOrg(id: string, updates: Partial<SalesforceOrg>): void {
    set((state) => ({
      orgs: state.orgs.map((org) =>
        org.id === id ? { ...org, ...updates } : org,
      ),
    }));
  },

  removeOrg(id: string): void {
    set((state) => ({
      orgs: state.orgs.filter((org) => org.id !== id),
      selectedOrgId: state.selectedOrgId === id ? null : state.selectedOrgId,
    }));
  },

  selectOrg(id: string | null): void {
    set({ selectedOrgId: id });
  },

  setConnecting(connecting: boolean): void {
    set({ isConnecting: connecting });
  },

  selectedOrg(): SalesforceOrg | undefined {
    const { orgs, selectedOrgId } = get();
    return orgs.find((org) => org.id === selectedOrgId);
  },

  connectedOrgs(): SalesforceOrg[] {
    return get().orgs.filter((org) => org.status === 'connected');
  },

  orgsByTier(tier: OrgSafetyTier): SalesforceOrg[] {
    return get().orgs.filter((org) => org.safetyTier === tier);
  },
}));

/** External selectors for reactive subscriptions */
export const selectSelectedOrg = (state: OrgState): SalesforceOrg | undefined =>
  state.orgs.find((org) => org.id === state.selectedOrgId);

/** Selector returning the number of connected orgs */
export const selectConnectedCount = (state: OrgState): number =>
  state.orgs.filter((org) => org.status === 'connected').length;
