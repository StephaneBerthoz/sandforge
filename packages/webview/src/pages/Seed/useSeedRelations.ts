import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import type { SeedRelation } from './Step4_ConfigureRelations';

/** Return type for the useSeedRelations hook. */
export interface SeedRelationsState {
  /** Current list of configured relations. */
  relations: SeedRelation[];
  /** Add an empty relation entry. */
  handleAddRelation: () => void;
  /** Remove a relation by index. */
  handleRemoveRelation: (index: number) => void;
  /** Update a specific field of a relation by index. */
  handleChangeRelation: (index: number, field: keyof SeedRelation, value: string) => void;
}

/**
 * Hook managing parent-child relation configuration for the Seed wizard.
 * State lives in `useSeedWizardStore`; this hook is a typed facade.
 */
export function useSeedRelations(): SeedRelationsState {
  const relations = useSeedWizardStore((s) => s.relations);
  const handleAddRelation = useSeedWizardStore((s) => s.handleAddRelation);
  const handleRemoveRelation = useSeedWizardStore((s) => s.handleRemoveRelation);
  const handleChangeRelation = useSeedWizardStore((s) => s.handleChangeRelation);

  return {
    relations,
    handleAddRelation,
    handleRemoveRelation,
    handleChangeRelation,
  };
}
