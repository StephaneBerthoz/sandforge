import { create } from 'zustand';
import type { UIConflict, ConflictStrategy, FieldResolution } from '@sandforge/shared';
import { buildMessage } from '../bridge/messageHelpers';
import { getVscodeApi } from '../hooks/useVSCodeApi';

/** Maximum number of conflicts stored before FIFO eviction. */
const MAX_CONFLICTS = 500;

/** State shape for the conflict resolution store. */
export interface ConflictStoreState {
  /** All tracked conflicts. */
  conflicts: UIConflict[];
  /** Currently selected conflict ID for detail view. */
  selectedConflictId: string | null;
  /** Object API name filter (null = show all). */
  filterObject: string | null;
  /** Conflict type filter (null = show all). */
  filterType: string | null;
}

/** Actions available on the conflict store. */
export interface ConflictStoreActions {
  /** Add a single conflict, deduplicating by id. */
  addConflict: (conflict: UIConflict) => void;
  /** Add a batch of conflicts, deduplicating by id. */
  addConflicts: (conflicts: UIConflict[]) => void;
  /** Select a conflict by id for detail view. */
  selectConflict: (id: string | null) => void;
  /** Set the object API name filter. */
  setFilterObject: (objectApiName: string | null) => void;
  /** Set the conflict type filter. */
  setFilterType: (type: string | null) => void;
  /** Resolve a single conflict and send message to extension. */
  resolveConflict: (
    id: string,
    resolution: ConflictStrategy,
    fieldResolutions?: Record<string, FieldResolution>,
  ) => void;
  /** Resolve all unresolved conflicts with source_wins strategy. */
  resolveAllSource: () => void;
  /** Resolve all unresolved conflicts with target_wins strategy. */
  resolveAllTarget: () => void;
  /** Remove all resolved conflicts from the array. */
  clearResolved: () => void;
}

/** Send a resolve-conflict message to the extension. */
function sendResolveMessage(
  conflictId: string,
  resolution: ConflictStrategy,
  fieldResolutions?: Record<string, FieldResolution>,
): void {
  getVscodeApi().postMessage(
    buildMessage('realtime:resolve-conflict', {
      conflictId,
      resolution,
      fieldResolutions,
    }),
  );
}

/** Insert conflicts into array with deduplication and FIFO eviction at MAX_CONFLICTS. */
function insertConflicts(
  existing: UIConflict[],
  incoming: UIConflict[],
): UIConflict[] {
  const ids = new Set(existing.map((c) => c.id));
  const merged = [...existing];

  for (const conflict of incoming) {
    if (!ids.has(conflict.id)) {
      ids.add(conflict.id);
      merged.push(conflict);
    }
  }

  // FIFO eviction: keep the most recent MAX_CONFLICTS
  if (merged.length > MAX_CONFLICTS) {
    return merged.slice(merged.length - MAX_CONFLICTS);
  }
  return merged;
}

/** Zustand store for managing conflict resolution state in the WebView. */
export const useConflictStore = create<ConflictStoreState & ConflictStoreActions>(
  (set, get) => ({
    conflicts: [],
    selectedConflictId: null,
    filterObject: null,
    filterType: null,

    addConflict(conflict: UIConflict): void {
      set({ conflicts: insertConflicts(get().conflicts, [conflict]) });
    },

    addConflicts(conflicts: UIConflict[]): void {
      set({ conflicts: insertConflicts(get().conflicts, conflicts) });
    },

    selectConflict(id: string | null): void {
      set({ selectedConflictId: id });
    },

    setFilterObject(objectApiName: string | null): void {
      set({ filterObject: objectApiName });
    },

    setFilterType(type: string | null): void {
      set({ filterType: type });
    },

    resolveConflict(
      id: string,
      resolution: ConflictStrategy,
      fieldResolutions?: Record<string, FieldResolution>,
    ): void {
      set({
        conflicts: get().conflicts.map((c) =>
          c.id === id
            ? { ...c, resolved: true, resolution, fieldResolutions }
            : c,
        ),
      });
      sendResolveMessage(id, resolution, fieldResolutions);
    },

    resolveAllSource(): void {
      const unresolved = get().conflicts.filter((c) => !c.resolved);
      set({
        conflicts: get().conflicts.map((c) =>
          c.resolved ? c : { ...c, resolved: true, resolution: 'source_wins' as ConflictStrategy },
        ),
      });
      for (const conflict of unresolved) {
        sendResolveMessage(conflict.id, 'source_wins');
      }
    },

    resolveAllTarget(): void {
      const unresolved = get().conflicts.filter((c) => !c.resolved);
      set({
        conflicts: get().conflicts.map((c) =>
          c.resolved ? c : { ...c, resolved: true, resolution: 'target_wins' as ConflictStrategy },
        ),
      });
      for (const conflict of unresolved) {
        sendResolveMessage(conflict.id, 'target_wins');
      }
    },

    clearResolved(): void {
      set({ conflicts: get().conflicts.filter((c) => !c.resolved) });
    },
  }),
);

/**
 * Compute the count of unresolved conflicts.
 * Use as a selector: `useConflictStore((s) => unresolvedCount(s.conflicts))`
 */
export function unresolvedCount(conflicts: UIConflict[]): number {
  return conflicts.filter((c) => !c.resolved).length;
}

/**
 * Filter conflicts by object and type.
 * Use as a selector for filtered views.
 */
export function filteredConflicts(
  conflicts: UIConflict[],
  filterObject: string | null,
  filterType: string | null,
): UIConflict[] {
  let result = conflicts;
  if (filterObject) {
    result = result.filter((c) => c.objectApiName === filterObject);
  }
  if (filterType) {
    result = result.filter((c) => c.conflictType === filterType);
  }
  return result;
}
