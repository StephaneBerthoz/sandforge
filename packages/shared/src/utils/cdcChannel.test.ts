import { describe, it, expect } from 'vitest';
import { buildCdcChannel } from './cdcChannel';

describe('buildCdcChannel', () => {
  it('should build channel for standard objects', () => {
    expect(buildCdcChannel('Account')).toBe('/data/AccountChangeEvent');
  });

  it('should build channel for Contact standard object', () => {
    expect(buildCdcChannel('Contact')).toBe('/data/ContactChangeEvent');
  });

  it('should build channel for custom objects (__c -> __ChangeEvent)', () => {
    expect(buildCdcChannel('MyObj__c')).toBe('/data/MyObj__ChangeEvent');
  });

  it('should build channel for namespaced custom objects', () => {
    expect(buildCdcChannel('ns__MyObj__c')).toBe('/data/ns__MyObj__ChangeEvent');
  });

  it('should handle double-namespaced custom objects', () => {
    expect(buildCdcChannel('pkg__Sub__c')).toBe('/data/pkg__Sub__ChangeEvent');
  });
});
