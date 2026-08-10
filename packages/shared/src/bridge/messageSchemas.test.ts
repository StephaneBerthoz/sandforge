import { describe, it, expect } from 'vitest';
import {
  BridgeMessageSchema,
  EnvelopedMessageSchema,
  OrgMessageSchema,
  SeedMessageSchema,
  SyncMessageSchema,
  MonitorMessageSchema,
  CompareMessageSchema,
  DataOpsMessageSchema,
  AutomationMessageSchema,
  ExecutionMessageSchema,
  AIMessageSchema,
  SettingsMessageSchema,
  RealtimeMessageSchema,
  ConflictMessageSchema,
  CacheMessageSchema,
  SmartActionMessageSchema,
  FrozenMessageSchema,
} from './messageSchemas.js';
import { PROTOCOL_VERSION } from './protocolVersion.js';

function baseFields(type: string) {
  return {
    id: 'msg-1',
    type,
    timestamp: Date.now(),
  };
}

describe('Domain schemas — valid / invalid samples', () => {
  it('OrgMessageSchema accepts org:list and rejects unknown type', () => {
    expect(OrgMessageSchema.safeParse(baseFields('org:list')).success).toBe(true);
    expect(OrgMessageSchema.safeParse(baseFields('org:unknown')).success).toBe(false);
    // Missing required base field `id`
    expect(OrgMessageSchema.safeParse({ type: 'org:list', timestamp: 1 }).success).toBe(false);
  });

  it('SeedMessageSchema accepts seed:execute and rejects bogus type', () => {
    const valid = {
      ...baseFields('seed:execute'),
      payload: { templateId: 't1', orgId: 'o1', dryRun: false },
    };
    expect(SeedMessageSchema.safeParse(valid).success).toBe(true);
    expect(SeedMessageSchema.safeParse(baseFields('seed:bogus')).success).toBe(false);
  });

  it('SyncMessageSchema accepts sync:execute and rejects bad timestamp', () => {
    expect(SyncMessageSchema.safeParse(baseFields('sync:execute')).success).toBe(true);
    expect(
      SyncMessageSchema.safeParse({ id: 'x', type: 'sync:execute', timestamp: Infinity }).success,
    ).toBe(false);
  });

  it('MonitorMessageSchema accepts monitor:refresh and rejects wrong type', () => {
    expect(MonitorMessageSchema.safeParse(baseFields('monitor:refresh')).success).toBe(true);
    expect(MonitorMessageSchema.safeParse(baseFields('ai:chat')).success).toBe(false);
  });

  it('CompareMessageSchema accepts compare:execute and rejects empty id', () => {
    expect(CompareMessageSchema.safeParse(baseFields('compare:execute')).success).toBe(true);
    expect(
      CompareMessageSchema.safeParse({ id: '', type: 'compare:execute', timestamp: 1 }).success,
    ).toBe(false);
  });

  it('DataOpsMessageSchema accepts backup:execute and rejects unknown type', () => {
    expect(DataOpsMessageSchema.safeParse(baseFields('backup:execute')).success).toBe(true);
    expect(DataOpsMessageSchema.safeParse(baseFields('dataops:unknown')).success).toBe(false);
  });

  it('AutomationMessageSchema accepts pipeline:run and forge:execute; rejects unknown', () => {
    expect(AutomationMessageSchema.safeParse(baseFields('pipeline:run')).success).toBe(true);
    expect(AutomationMessageSchema.safeParse(baseFields('forge:execute')).success).toBe(true);
    expect(AutomationMessageSchema.safeParse(baseFields('pipeline:bogus')).success).toBe(false);
  });

  it('ExecutionMessageSchema accepts execution:progress and operation:started', () => {
    expect(ExecutionMessageSchema.safeParse(baseFields('execution:progress')).success).toBe(true);
    expect(ExecutionMessageSchema.safeParse(baseFields('operation:started')).success).toBe(true);
    expect(ExecutionMessageSchema.safeParse(baseFields('execution:bogus')).success).toBe(false);
  });

  it('AIMessageSchema accepts ai:chat and rejects missing type', () => {
    expect(AIMessageSchema.safeParse(baseFields('ai:chat')).success).toBe(true);
    expect(AIMessageSchema.safeParse({ id: 'x', timestamp: 1 }).success).toBe(false);
  });

  it('SettingsMessageSchema accepts settings:get and bridge:error', () => {
    expect(SettingsMessageSchema.safeParse(baseFields('settings:get')).success).toBe(true);
    expect(SettingsMessageSchema.safeParse(baseFields('bridge:error')).success).toBe(true);
    expect(SettingsMessageSchema.safeParse(baseFields('settings:bogus')).success).toBe(false);
  });

  it('RealtimeMessageSchema accepts realtime:start and rejects bogus type', () => {
    expect(RealtimeMessageSchema.safeParse(baseFields('realtime:start')).success).toBe(true);
    expect(RealtimeMessageSchema.safeParse(baseFields('realtime:bogus')).success).toBe(false);
  });

  it('ConflictMessageSchema accepts scheduler:list and rejects unknown', () => {
    expect(ConflictMessageSchema.safeParse(baseFields('scheduler:list')).success).toBe(true);
    expect(ConflictMessageSchema.safeParse(baseFields('scheduler:bogus')).success).toBe(false);
  });

  it('CacheMessageSchema accepts cache:invalidate-all and rejects cache:bogus', () => {
    expect(CacheMessageSchema.safeParse(baseFields('cache:invalidate-all')).success).toBe(true);
    expect(CacheMessageSchema.safeParse(baseFields('cache:bogus')).success).toBe(false);
  });

  it('SmartActionMessageSchema accepts smart-action:analyze and rejects unknown', () => {
    expect(SmartActionMessageSchema.safeParse(baseFields('smart-action:analyze')).success).toBe(
      true,
    );
    expect(SmartActionMessageSchema.safeParse(baseFields('smart-action:bogus')).success).toBe(
      false,
    );
  });

  it('FrozenMessageSchema accepts frozen:extract and frozen:status; rejects unknown', () => {
    expect(FrozenMessageSchema.safeParse(baseFields('frozen:extract')).success).toBe(true);
    expect(FrozenMessageSchema.safeParse(baseFields('frozen:status')).success).toBe(true);
    expect(FrozenMessageSchema.safeParse(baseFields('frozen:bogus')).success).toBe(false);
  });
});

describe('BridgeMessageSchema — full union', () => {
  it('accepts messages from any domain', () => {
    const samples = [
      baseFields('org:list'),
      baseFields('seed:execute'),
      baseFields('sync:execute'),
      baseFields('monitor:refresh'),
      baseFields('ai:chat'),
      baseFields('realtime:start'),
    ];
    for (const sample of samples) {
      expect(BridgeMessageSchema.safeParse(sample).success).toBe(true);
    }
  });

  it('rejects completely unknown type values', () => {
    expect(BridgeMessageSchema.safeParse(baseFields('totally:unknown')).success).toBe(false);
    expect(BridgeMessageSchema.safeParse({ type: 'unknown:type' }).success).toBe(false);
  });

  it('rejects messages missing base fields', () => {
    expect(BridgeMessageSchema.safeParse({ type: 'org:list' }).success).toBe(false);
    expect(BridgeMessageSchema.safeParse({ id: 'x', timestamp: 1 }).success).toBe(false);
  });
});

describe('EnvelopedMessageSchema', () => {
  it('accepts a valid envelope with payload', () => {
    const result = EnvelopedMessageSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      payload: baseFields('org:list'),
    });
    expect(result.success).toBe(true);
  });

  it('accepts envelope with optional correlationId', () => {
    const result = EnvelopedMessageSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      correlationId: 'req-42',
      payload: baseFields('seed:execute'),
    });
    expect(result.success).toBe(true);
  });

  it('rejects envelope with missing protocolVersion', () => {
    const result = EnvelopedMessageSchema.safeParse({
      payload: baseFields('org:list'),
    });
    expect(result.success).toBe(false);
  });

  it('rejects envelope with non-positive protocolVersion', () => {
    expect(
      EnvelopedMessageSchema.safeParse({
        protocolVersion: 0,
        payload: baseFields('org:list'),
      }).success,
    ).toBe(false);
    expect(
      EnvelopedMessageSchema.safeParse({
        protocolVersion: -1,
        payload: baseFields('org:list'),
      }).success,
    ).toBe(false);
  });

  it('rejects envelope with invalid inner payload type', () => {
    const result = EnvelopedMessageSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      payload: { id: 'x', type: 'totally:unknown', timestamp: 1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects envelope with non-object payload', () => {
    const result = EnvelopedMessageSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      payload: 'not-an-object',
    });
    expect(result.success).toBe(false);
  });
});
