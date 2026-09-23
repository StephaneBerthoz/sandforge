import { useCallback, useMemo } from 'react';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import type { SeedRelationDraft, SeedRelationDraftPatch } from '../../stores/useSeedWizardStore';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';
import { checkRelations, newRelationDraft, relationLookups } from './seedRelationDrafts';
import type { CheckedRelation, RelationLookup, SeedVolumes } from './seedRelationDrafts';

/** Return type for the useSeedRelations hook. */
export interface SeedRelationsState {
  /** Relation rows, in the order they were added. */
  relations: SeedRelationDraft[];
  /** The lookups of the selected objects a row can fill. */
  lookups: RelationLookup[];
  /** Each row checked against the wizard, in row order. */
  checked: CheckedRelation[];
  /** Whether every row can be sent as it stands. */
  relationsReady: boolean;
  /** Add a row on the first lookup no row fills yet; nothing when there is no lookup. */
  handleAddRelation: () => void;
  /** Remove a row by index. */
  handleRemoveRelation: (index: number) => void;
  /** Change settings of a row by index. */
  handleChangeRelation: (index: number, patch: SeedRelationDraftPatch) => void;
}

/** Keys of the rows added since the page loaded. */
let rowsAdded = 0;

/**
 * Relation rows of the Seed wizard, checked against the objects, their
 * lookups and their volumes. The rows live in `useSeedWizardStore`; what is
 * derived from them is computed here, the same way for the editor that shows
 * a row and for the wizard that sends it.
 */
export function useSeedRelations(
  fieldConfigs: readonly ObjectFieldConfig[],
  volumes: SeedVolumes,
): SeedRelationsState {
  const relations = useSeedWizardStore((s) => s.relations);
  const selectedObjects = useSeedWizardStore((s) => s.selectedObjects);
  const addRelation = useSeedWizardStore((s) => s.handleAddRelation);
  const handleRemoveRelation = useSeedWizardStore((s) => s.handleRemoveRelation);
  const handleChangeRelation = useSeedWizardStore((s) => s.handleChangeRelation);

  const lookups = useMemo(
    () => relationLookups(fieldConfigs, selectedObjects),
    [fieldConfigs, selectedObjects],
  );
  const checked = useMemo(
    () => checkRelations(relations, { selectedObjects, volumes, lookups }),
    [relations, selectedObjects, volumes, lookups],
  );

  const handleAddRelation = useCallback(() => {
    const row = newRelationDraft(lookups, selectedObjects, relations, `relation-${++rowsAdded}`);
    if (row) addRelation(row);
  }, [lookups, selectedObjects, relations, addRelation]);

  return {
    relations,
    lookups,
    checked,
    relationsReady: checked.every((c) => c.problem === null),
    handleAddRelation,
    handleRemoveRelation,
    handleChangeRelation,
  };
}
