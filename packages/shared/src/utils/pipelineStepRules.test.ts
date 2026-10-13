import { describe, it, expect } from 'vitest';
import {
  APPROVAL_DEFAULT_TIMEOUT_MINUTES,
  APPROVAL_MAX_MESSAGE_LENGTH,
  approvalDefect,
  approvalTimeoutMinutes,
  isPipelineStepType,
  isRetiredPipelineStepType,
  PIPELINE_STEP_TYPES,
} from './pipelineStepRules';

describe('step types', () => {
  it('knows Approval and Sync, and none of the types SandForge no longer has', () => {
    expect(isPipelineStepType('approval')).toBe(true);
    expect(isPipelineStepType('sync')).toBe(true);
    for (const retired of ['script', 'loop', 'parallel']) {
      expect(isPipelineStepType(retired)).toBe(false);
      expect(isRetiredPipelineStepType(retired)).toBe(true);
    }
  });

  it('calls a type nobody ever had neither current nor retired', () => {
    expect(isPipelineStepType('dataops')).toBe(false);
    expect(isRetiredPipelineStepType('dataops')).toBe(false);
    expect(isRetiredPipelineStepType(undefined)).toBe(false);
  });

  it('lists no type twice', () => {
    expect(new Set(PIPELINE_STEP_TYPES).size).toBe(PIPELINE_STEP_TYPES.length);
  });
});

describe('approvalTimeoutMinutes', () => {
  it('waits an hour when the step says nothing', () => {
    expect(approvalTimeoutMinutes({})).toBe(APPROVAL_DEFAULT_TIMEOUT_MINUTES);
    expect(approvalTimeoutMinutes(undefined)).toBe(60);
  });

  it('takes a whole number of minutes from one up to a day', () => {
    expect(approvalTimeoutMinutes({ timeoutMinutes: 1 })).toBe(1);
    expect(approvalTimeoutMinutes({ timeoutMinutes: 1440 })).toBe(1440);
  });

  it('refuses no wait, a wait past a day, a fraction, and text', () => {
    for (const timeoutMinutes of [0, -5, 1441, 2.5, '30', Number.NaN]) {
      expect(approvalTimeoutMinutes({ timeoutMinutes })).toBeUndefined();
    }
  });
});

describe('approvalDefect', () => {
  it('finds nothing wrong with a step that names neither a wait nor a message', () => {
    expect(approvalDefect({})).toBeUndefined();
  });

  it('names the wait before the message', () => {
    expect(approvalDefect({ timeoutMinutes: 0, message: 42 })).toBe('timeout');
  });

  it('refuses a message that is not text, or longer than it may be', () => {
    expect(approvalDefect({ message: 42 })).toBe('message');
    expect(approvalDefect({ message: 'x'.repeat(APPROVAL_MAX_MESSAGE_LENGTH + 1) })).toBe(
      'message',
    );
    expect(approvalDefect({ message: 'Look at the comparison first.' })).toBeUndefined();
  });
});
