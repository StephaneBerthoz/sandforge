import { create } from 'zustand';

/** A single command palette item. */
export interface CommandItem {
  /** Unique identifier. */
  id: string;
  /** Display label. */
  label: string;
  /** Category group for the command. */
  group: 'actions' | 'orgs' | 'recent' | 'navigate';
  /** Codicon name for the item icon. */
  icon?: string;
  /** Action to execute when selected. */
  action: () => void;
  /** Extra keywords for search matching. */
  keywords?: string[];
}

/** Command palette store state. */
interface CommandState {
  /** Whether the command palette is open. */
  open: boolean;
  /** Registered command items. */
  items: CommandItem[];
  /** Set the open state. */
  setOpen: (open: boolean) => void;
  /** Toggle the open state. */
  toggle: () => void;
  /** Register items, deduplicating by id. */
  registerItems: (items: CommandItem[]) => void;
  /** Remove items by their ids. */
  removeItems: (ids: string[]) => void;
}

/**
 * Zustand store for the command palette.
 * Manages open/close state and the registry of command items.
 */
export const useCommandStore = create<CommandState>((set) => ({
  open: false,
  items: [],
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  registerItems: (items) =>
    set((s) => ({
      items: [...s.items.filter((i) => !items.some((n) => n.id === i.id)), ...items],
    })),
  removeItems: (ids) =>
    set((s) => ({
      items: s.items.filter((i) => !ids.includes(i.id)),
    })),
}));
