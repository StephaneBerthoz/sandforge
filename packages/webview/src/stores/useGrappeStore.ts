import { create } from 'zustand';

/** A single grappe partition's progress in the UI */
export interface GrappePartitionUI {
  grappeId: string;
  percentage: number;
  processedRecords: number;
}

/** Zustand state for grappe (cluster) operations */
export interface GrappeState {
  /** Whether a grappe operation is currently active */
  active: boolean;
  /** Current operation ID */
  operationId: string | null;
  /** Total partitions in the operation */
  totalPartitions: number;
  /** Total records across all partitions */
  totalRecords: number;
  /** Per-partition progress */
  partitions: Map<string, GrappePartitionUI>;
  /** Final totals after completion */
  totalProcessed: number;
  totalFailed: number;

  /** Actions */
  start: (operationId: string, totalPartitions: number, totalRecords: number) => void;
  updatePartition: (grappeId: string, percentage: number, processedRecords: number) => void;
  complete: (totalProcessed: number, totalFailed: number) => void;
  reset: () => void;
}

/** Zustand store for tracking grappe operation progress */
export const useGrappeStore = create<GrappeState>((set) => ({
  active: false,
  operationId: null,
  totalPartitions: 0,
  totalRecords: 0,
  partitions: new Map(),
  totalProcessed: 0,
  totalFailed: 0,

  start(operationId: string, totalPartitions: number, totalRecords: number): void {
    set({
      active: true,
      operationId,
      totalPartitions,
      totalRecords,
      partitions: new Map(),
      totalProcessed: 0,
      totalFailed: 0,
    });
  },

  updatePartition(grappeId: string, percentage: number, processedRecords: number): void {
    set((state) => {
      const next = new Map(state.partitions);
      next.set(grappeId, { grappeId, percentage, processedRecords });
      return { partitions: next };
    });
  },

  complete(totalProcessed: number, totalFailed: number): void {
    set({ active: false, totalProcessed, totalFailed });
  },

  reset(): void {
    set({
      active: false,
      operationId: null,
      totalPartitions: 0,
      totalRecords: 0,
      partitions: new Map(),
      totalProcessed: 0,
      totalFailed: 0,
    });
  },
}));
