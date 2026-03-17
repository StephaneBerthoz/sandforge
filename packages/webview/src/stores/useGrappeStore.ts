import { create } from 'zustand';
import type { BackPressureLevel } from '@sandforge/shared';

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
  /** Current back-pressure level */
  backPressureLevel: BackPressureLevel;
  /** API usage percentage */
  apiUsagePercent: number;
  /** Final totals after completion */
  totalProcessed: number;
  totalFailed: number;

  /** Actions */
  start: (operationId: string, totalPartitions: number, totalRecords: number) => void;
  updatePartition: (grappeId: string, percentage: number, processedRecords: number) => void;
  updateBackPressure: (level: BackPressureLevel, apiPercent: number) => void;
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
  backPressureLevel: 'normal' as BackPressureLevel,
  apiUsagePercent: 0,
  totalProcessed: 0,
  totalFailed: 0,

  start(operationId: string, totalPartitions: number, totalRecords: number): void {
    set({
      active: true,
      operationId,
      totalPartitions,
      totalRecords,
      partitions: new Map(),
      backPressureLevel: 'normal',
      apiUsagePercent: 0,
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

  updateBackPressure(level: BackPressureLevel, apiPercent: number): void {
    set({ backPressureLevel: level, apiUsagePercent: apiPercent });
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
      backPressureLevel: 'normal',
      apiUsagePercent: 0,
      totalProcessed: 0,
      totalFailed: 0,
    });
  },
}));
