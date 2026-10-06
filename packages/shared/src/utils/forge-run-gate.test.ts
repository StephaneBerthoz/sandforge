import { describe, expect, it } from 'vitest';
import { FORGE_RUN_GATE_CODES, forgeRunGateStopOf, isForgeRunGateCode } from './forge-run-gate.js';

describe('forge run gate stops', () => {
  it('names the five ways a run stops at its gate', () => {
    expect(FORGE_RUN_GATE_CODES).toEqual([
      'PRODUCTION_TARGET',
      'AUTOMATION_DECLINED',
      'WRITE_DECLINED',
      'STORAGE_EXCEEDED',
      'CONFIRMATION_UNAVAILABLE',
    ]);
  });

  it('tells a gate code from any other code an execute error carries', () => {
    expect(isForgeRunGateCode('WRITE_DECLINED')).toBe(true);
    expect(isForgeRunGateCode('GUARD_DECLINED')).toBe(false);
    expect(isForgeRunGateCode('EXECUTE_ERROR')).toBe(false);
    expect(isForgeRunGateCode(undefined)).toBe(false);
  });

  it('reads a stop and the storage a refusal for storage names', () => {
    expect(forgeRunGateStopOf({ code: 'AUTOMATION_DECLINED' })).toEqual({
      code: 'AUTOMATION_DECLINED',
    });
    expect(
      forgeRunGateStopOf({
        code: 'STORAGE_EXCEEDED',
        storage: { estimateMB: 66.8, remainingMB: -3 },
      }),
    ).toEqual({ code: 'STORAGE_EXCEEDED', storage: { estimateMB: 66.8, remainingMB: -3 } });
  });

  it('reads nothing from a field that is not a stop', () => {
    expect(forgeRunGateStopOf(undefined)).toBeNull();
    expect(forgeRunGateStopOf({ code: 'EXECUTE_ERROR' })).toBeNull();
    expect(forgeRunGateStopOf({ code: 'STORAGE_EXCEEDED', storage: { estimateMB: 'a lot' } })).toBe(
      null,
    );
    expect(forgeRunGateStopOf('PRODUCTION_TARGET')).toBeNull();
  });
});
