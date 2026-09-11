import { create } from 'zustand';
import type { PersonaMsg } from '@sandforge/shared';

/** One parent-child relation row of the Seed wizard. */
export interface SeedRelation {
  childObject: string;
  childField: string;
  parentObject: string;
  parentField: string;
}

/** Wizard state shared across the Seed page step sections. */
export interface SeedWizardState {
  /** Currently selected org identifier ('' when none). */
  selectedOrgId: string;
  /** API names of currently selected objects. */
  selectedObjects: string[];
  /** Parent-child relation configuration rows. */
  relations: SeedRelation[];
  /** Page-level error message, if any. */
  error: string | null;
  /** Currently selected AI persona, or null. */
  selectedPersona: PersonaMsg | null;
  /** Number of fields last configured by persona application. */
  personaMatchedFields: number;

  /** Update the selected org. */
  handleOrgSelect: (orgId: string) => void;
  /** Toggle an object in/out of the selection. */
  handleToggleObject: (apiName: string) => void;
  /** Add an empty relation entry. */
  handleAddRelation: () => void;
  /** Remove a relation by index. */
  handleRemoveRelation: (index: number) => void;
  /** Update a specific field of a relation by index. */
  handleChangeRelation: (index: number, field: keyof SeedRelation, value: string) => void;
  /** Set or clear the page-level error. */
  setError: (e: string | null) => void;
  /** Set the selected persona (from PersonaGallery callback). */
  setSelectedPersona: (persona: PersonaMsg | null) => void;
  /** Record how many fields a persona application matched. */
  setPersonaMatchedFields: (count: number) => void;
  /** Reset all wizard slices to their initial values. */
  resetSeedWizard: () => void;
}

/** Initial slice values (also applied by resetSeedWizard). */
const INITIAL_STATE = {
  selectedOrgId: '',
  selectedObjects: [] as string[],
  relations: [] as SeedRelation[],
  error: null as string | null,
  selectedPersona: null as PersonaMsg | null,
  personaMatchedFields: 0,
};

/**
 * Zustand store for the Seed wizard UI state. Step sections subscribe to
 * the slices they need instead of receiving the whole wizard state object
 * through props. Bridge-coupled data (describes, mutations, execution)
 * intentionally stays in the React hooks under `pages/Seed`.
 *
 * Lifecycle: `useSeedWizardState` resets the store on mount/unmount so it
 * behaves like component-local state (a fresh wizard on every page mount),
 * then re-applies the persisted draft.
 */
export const useSeedWizardStore = create<SeedWizardState>((set) => ({
  ...INITIAL_STATE,

  handleOrgSelect(orgId: string): void {
    set({ selectedOrgId: orgId });
  },

  handleToggleObject(apiName: string): void {
    set((state) => ({
      selectedObjects: state.selectedObjects.includes(apiName)
        ? state.selectedObjects.filter((o) => o !== apiName)
        : [...state.selectedObjects, apiName],
    }));
  },

  handleAddRelation(): void {
    set((state) => ({
      relations: [
        ...state.relations,
        { childObject: '', childField: '', parentObject: '', parentField: 'Id' },
      ],
    }));
  },

  handleRemoveRelation(index: number): void {
    set((state) => ({ relations: state.relations.filter((_, i) => i !== index) }));
  },

  handleChangeRelation(index: number, field: keyof SeedRelation, value: string): void {
    set((state) => ({
      relations: state.relations.map((r, i) => (i === index ? { ...r, [field]: value } : r)),
    }));
  },

  setError(e: string | null): void {
    set({ error: e });
  },

  setSelectedPersona(persona: PersonaMsg | null): void {
    set({ selectedPersona: persona });
  },

  setPersonaMatchedFields(count: number): void {
    set({ personaMatchedFields: count });
  },

  resetSeedWizard(): void {
    set({ ...INITIAL_STATE });
  },
}));
