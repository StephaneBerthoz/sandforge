import { create } from 'zustand';
import type { SyncScheduleEntry } from '@sandforge/shared';
import { sendBridgeMessage } from '../bridge/sendBridgeMessage';

/** Fields required to create or update a schedule (server computes nextRunAt, lastRunAt, lastResult). */
export type SyncScheduleUpsertPayload = Omit<
  SyncScheduleEntry,
  'nextRunAt' | 'lastRunAt' | 'lastResult'
>;

/** State and actions for the sync schedule management panel. */
export interface SyncScheduleState {
  /** List of all sync schedules. */
  schedules: SyncScheduleEntry[];
  /** Whether a fetch operation is in progress. */
  loading: boolean;
  /** Last error message, if any. */
  error: string | null;
  /** Fetch all sync schedules from the extension. */
  fetchSchedules: () => void;
  /** Create or update a schedule. */
  upsertSchedule: (schedule: SyncScheduleUpsertPayload) => void;
  /** Toggle a schedule between enabled and paused. */
  toggleSchedule: (scheduleId: string, enabled: boolean) => void;
  /** Delete a schedule permanently. */
  deleteSchedule: (scheduleId: string) => void;
  /** Handle incoming messages from the extension host. */
  handleMessage: (message: unknown) => void;
}

/** Type guard for messages with a type field. */
function isTypedMessage(msg: unknown): msg is { type: string; payload?: Record<string, unknown> } {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    typeof (msg as Record<string, unknown>).type === 'string'
  );
}

/** Zustand store for managing sync schedules. */
export const useSyncScheduleStore = create<SyncScheduleState>((set) => ({
  schedules: [],
  loading: false,
  error: null,

  fetchSchedules(): void {
    set({ loading: true, error: null });
    sendBridgeMessage('sync:schedule:list');
  },

  upsertSchedule(schedule: SyncScheduleUpsertPayload): void {
    set({ loading: true, error: null });
    sendBridgeMessage('sync:schedule:upsert', { schedule });
  },

  toggleSchedule(scheduleId: string, enabled: boolean): void {
    sendBridgeMessage('sync:schedule:toggle', { scheduleId, enabled });
  },

  deleteSchedule(scheduleId: string): void {
    sendBridgeMessage('sync:schedule:delete', { scheduleId });
  },

  handleMessage(message: unknown): void {
    if (!isTypedMessage(message)) return;

    const payload = message.payload as Record<string, unknown> | undefined;

    switch (message.type) {
      case 'sync:schedule:list:response': {
        const schedules = (payload?.schedules ?? []) as SyncScheduleEntry[];
        set({ schedules, loading: false, error: null });
        break;
      }
      case 'sync:schedule:upsert:response': {
        const schedule = payload?.schedule as SyncScheduleEntry | undefined;
        if (schedule) {
          set((state) => {
            const exists = state.schedules.some((s) => s.id === schedule.id);
            const schedules = exists
              ? state.schedules.map((s) => (s.id === schedule.id ? schedule : s))
              : [...state.schedules, schedule];
            return { schedules, loading: false, error: null };
          });
        }
        break;
      }
      case 'sync:schedule:toggle:response': {
        const toggledId = payload?.scheduleId as string | undefined;
        const enabled = payload?.enabled as boolean | undefined;
        if (toggledId !== undefined && enabled !== undefined) {
          set((state) => ({
            schedules: state.schedules.map((s) => (s.id === toggledId ? { ...s, enabled } : s)),
          }));
        }
        break;
      }
      case 'sync:schedule:delete:response': {
        const deletedId = payload?.scheduleId as string | undefined;
        if (deletedId) {
          set((state) => ({
            schedules: state.schedules.filter((s) => s.id !== deletedId),
          }));
        }
        break;
      }
      case 'sync:schedule:error': {
        const errorMsg = (payload?.message ?? 'Unknown error') as string;
        set({ loading: false, error: errorMsg });
        break;
      }
      default:
        break;
    }
  },
}));
