import { useState, useCallback } from 'react';

/** Return type for the useSeedVolumes hook. */
export interface SeedVolumesState {
  /** Volume configuration per object. */
  volumes: Record<string, { count: number; batchSize: number }>;
  /** Update the record count for an object. */
  handleChangeVolume: (objectApiName: string, count: number) => void;
  /** Update the batch size for an object. */
  handleChangeBatchSize: (objectApiName: string, size: number) => void;
}

/**
 * Hook managing record count and batch size configuration per Salesforce object.
 *
 * Provides handlers to update volume and batch size with sensible defaults
 * (100 records, batch size 200).
 */
export function useSeedVolumes(): SeedVolumesState {
  const [volumes, setVolumes] = useState<Record<string, { count: number; batchSize: number }>>({});

  const handleChangeVolume = useCallback((objectApiName: string, count: number) => {
    setVolumes((prev) => ({
      ...prev,
      [objectApiName]: {
        ...prev[objectApiName],
        count,
        batchSize: prev[objectApiName]?.batchSize ?? 200,
      },
    }));
  }, []);

  const handleChangeBatchSize = useCallback((objectApiName: string, size: number) => {
    setVolumes((prev) => ({
      ...prev,
      [objectApiName]: { count: prev[objectApiName]?.count ?? 100, batchSize: size },
    }));
  }, []);

  return {
    volumes,
    handleChangeVolume,
    handleChangeBatchSize,
  };
}
