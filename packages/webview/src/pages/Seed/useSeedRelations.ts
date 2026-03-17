import { useState, useCallback } from 'react';
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

/** Hook managing parent-child relation configuration for the Seed wizard. */
export function useSeedRelations(): SeedRelationsState {
  const [relations, setRelations] = useState<SeedRelation[]>([]);

  const handleAddRelation = useCallback(() => {
    setRelations((prev) => [...prev, { childObject: '', childField: '', parentObject: '', parentField: 'Id' }]);
  }, []);

  const handleRemoveRelation = useCallback((index: number) => {
    setRelations((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleChangeRelation = useCallback((index: number, field: keyof SeedRelation, value: string) => {
    setRelations((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  }, []);

  return {
    relations,
    handleAddRelation,
    handleRemoveRelation,
    handleChangeRelation,
  };
}
