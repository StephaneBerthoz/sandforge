import { create } from 'zustand';
import type { PersonaMsg, SeedRelation } from '@sandforge/shared';

/** How a relation row spreads children over parents. */
export type SeedRelationMode = SeedRelation['distribution']['mode'];

/**
 * One relation row of the Seed wizard, as the editor holds it while it is
 * filled in. The settings of every mode and source are kept side by side, so
 * switching the mode back and forth keeps what was typed; a number is NaN
 * while its field is being retyped.
 */
export interface SeedRelationDraft {
  /** Stable name of the row, for React and for the ids of its fields. */
  key: string;
  /** The selected object whose lookup the row fills. */
  childObject: string;
  /** The lookup field of the child. */
  lookupField: string;
  /** The object the lookup points at. */
  parentObject: string;
  /** Whether the parents are the records this run writes or records already in the org. */
  source: SeedRelation['parents']['kind'];
  /** SOQL WHERE condition on the records already in the org. */
  where: string;
  /** The most records already in the org the relation reads. */
  limit: number;
  mode: SeedRelationMode;
  /** Children per parent, for `perParent`. */
  count: number;
  /** Fewest and most children per parent, for `range`. */
  min: number;
  max: number;
  /** Children per parent on average, for `ratio`. */
  ratio: number;
}

/** What the editor may change on a relation row: anything but its key. */
export type SeedRelationDraftPatch = Partial<Omit<SeedRelationDraft, 'key'>>;

/** Wizard state shared across the Seed page step sections. */
export interface SeedWizardState {
  /** Currently selected org identifier ('' when none). */
  selectedOrgId: string;
  /** API names of currently selected objects. */
  selectedObjects: string[];
  /** Relation rows, in the order they were added. */
  relations: SeedRelationDraft[];
  /** Page-level error message, if any. */
  error: string | null;
  /** Currently selected AI persona, or null. */
  selectedPersona: PersonaMsg | null;

  /** Update the selected org. */
  handleOrgSelect: (orgId: string) => void;
  /**
   * Toggle an object in/out of the selection. Taking one out also takes out
   * the relations that fill its lookups or draw from the records it would
   * have written: nothing is left for them to act on.
   */
  handleToggleObject: (apiName: string) => void;
  /** Append a relation row. */
  handleAddRelation: (relation: SeedRelationDraft) => void;
  /** Remove a relation row by index. */
  handleRemoveRelation: (index: number) => void;
  /** Change settings of a relation row by index. */
  handleChangeRelation: (index: number, patch: SeedRelationDraftPatch) => void;
  /** Set or clear the page-level error. */
  setError: (e: string | null) => void;
  /** Set the selected persona (from PersonaGallery callback). */
  setSelectedPersona: (persona: PersonaMsg | null) => void;
  /** Reset all wizard slices to their initial values. */
  resetSeedWizard: () => void;
}

/** Initial slice values (also applied by resetSeedWizard). */
const INITIAL_STATE = {
  selectedOrgId: '',
  selectedObjects: [] as string[],
  relations: [] as SeedRelationDraft[],
  error: null as string | null,
  selectedPersona: null as PersonaMsg | null,
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
    set((state) => {
      if (!state.selectedObjects.includes(apiName)) {
        return { selectedObjects: [...state.selectedObjects, apiName] };
      }
      return {
        selectedObjects: state.selectedObjects.filter((o) => o !== apiName),
        relations: state.relations.filter(
          (r) =>
            r.childObject !== apiName && !(r.source === 'generated' && r.parentObject === apiName),
        ),
      };
    });
  },

  handleAddRelation(relation: SeedRelationDraft): void {
    set((state) => ({ relations: [...state.relations, relation] }));
  },

  handleRemoveRelation(index: number): void {
    set((state) => ({ relations: state.relations.filter((_, i) => i !== index) }));
  },

  handleChangeRelation(index: number, patch: SeedRelationDraftPatch): void {
    set((state) => ({
      relations: state.relations.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  },

  setError(e: string | null): void {
    set({ error: e });
  },

  setSelectedPersona(persona: PersonaMsg | null): void {
    set({ selectedPersona: persona });
  },

  resetSeedWizard(): void {
    set({ ...INITIAL_STATE });
  },
}));
