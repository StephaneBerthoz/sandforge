import { create } from 'zustand';

/** A recent operation displayed in the sidebar and status footer. */
export interface RecentOp {
  /** Unique identifier for the operation. */
  id: string;
  /** Module that produced the operation. */
  type: 'forge' | 'seed' | 'sync' | 'compare' | 'dataops' | 'automation' | 'frozen' | 'grappe';
  /** Short human-readable label. */
  label: string;
  /** Current execution status. */
  status: 'success' | 'running' | 'failed';
  /** Unix-ms timestamp of last status change. */
  timestamp: number;
  /** Optional record count. */
  recordCount?: number;
  /** Optional target org alias. */
  targetOrg?: string;
}

/** State and actions for recent operations tracking. */
interface RecentOpsState {
  /** The list of recent operations, newest first, capped at 10. */
  ops: RecentOp[];
  /** Add a new operation (prepend, cap at 10). */
  addOp: (op: RecentOp) => void;
  /** Partially update an existing operation by id. */
  updateOp: (id: string, updates: Partial<RecentOp>) => void;
  /** Clear all operations. */
  clearOps: () => void;
}

/** Zustand store for tracking recent operations across modules. */
export const useRecentOpsStore = create<RecentOpsState>((set) => ({
  ops: [],
  addOp: (op) => set((s) => ({ ops: [op, ...s.ops].slice(0, 10) })),
  updateOp: (id, updates) =>
    set((s) => ({
      ops: s.ops.map((o) => (o.id === id ? { ...o, ...updates } : o)),
    })),
  clearOps: () => set({ ops: [] }),
}));
