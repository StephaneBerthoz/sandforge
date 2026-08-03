import type { BaseMessage } from './base.messages.js';

/** Frequency for scheduled operations. */
export type ScheduleFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

/** Operation type that can be scheduled. */
export type SchedulableOperation = 'backup' | 'sync' | 'cleanup';

/** A scheduled operation definition. */
export interface ScheduledOperation {
  id: string;
  operationType: SchedulableOperation;
  frequency: ScheduleFrequency;
  time: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
}

/** A history entry for a completed scheduled operation. */
export interface ScheduledOperationRun {
  id: string;
  scheduleId: string;
  operationType: SchedulableOperation;
  status: 'success' | 'failure' | 'partial';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  recordsProcessed: number;
  error?: string;
}

/** Request to list all scheduled operations. */
export interface SchedulerListRequest extends BaseMessage {
  type: 'scheduler:list';
}

/** Response containing all scheduled operations. */
export interface SchedulerListResponse extends BaseMessage {
  type: 'scheduler:list:response';
  payload: {
    schedules: ScheduledOperation[];
    history: ScheduledOperationRun[];
  };
}

/** Request to create or update a scheduled operation. */
export interface SchedulerUpsertRequest extends BaseMessage {
  type: 'scheduler:upsert';
  payload: {
    schedule: Omit<ScheduledOperation, 'lastRunAt' | 'nextRunAt'>;
  };
}

/** Response after creating or updating a scheduled operation. */
export interface SchedulerUpsertResponse extends BaseMessage {
  type: 'scheduler:upsert:response';
  payload: {
    success: boolean;
    schedule?: ScheduledOperation;
    error?: string;
  };
}

/** Request to delete a scheduled operation. */
export interface SchedulerDeleteRequest extends BaseMessage {
  type: 'scheduler:delete';
  payload: { scheduleId: string };
}

/** Response after deleting a scheduled operation. */
export interface SchedulerDeleteResponse extends BaseMessage {
  type: 'scheduler:delete:response';
  payload: {
    success: boolean;
    error?: string;
  };
}

/** Request to toggle a scheduled operation on/off. */
export interface SchedulerToggleRequest extends BaseMessage {
  type: 'scheduler:toggle';
  payload: { scheduleId: string; enabled: boolean };
}

/** Response after toggling a scheduled operation. */
export interface SchedulerToggleResponse extends BaseMessage {
  type: 'scheduler:toggle:response';
  payload: {
    success: boolean;
    schedule?: ScheduledOperation;
    error?: string;
  };
}
