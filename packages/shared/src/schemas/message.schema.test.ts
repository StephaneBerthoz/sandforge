import { describe, it, expect } from 'vitest';
import { baseMessageSchema } from './message.schema';

describe('baseMessageSchema', () => {
  it('should accept a valid base message', () => {
    const msg = { id: 'msg-1', type: 'org:list', timestamp: Date.now() };
    const result = baseMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('should accept a message with extra payload fields (passthrough)', () => {
    const msg = { id: 'msg-1', type: 'seed:execute', timestamp: 1000, payload: { foo: 'bar' } };
    const result = baseMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>)['payload']).toEqual({ foo: 'bar' });
    }
  });

  it('should reject when id is missing', () => {
    const msg = { type: 'org:list', timestamp: 1000 };
    const result = baseMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it('should reject when id is empty string', () => {
    const msg = { id: '', type: 'org:list', timestamp: 1000 };
    const result = baseMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it('should reject when type is missing', () => {
    const msg = { id: 'msg-1', timestamp: 1000 };
    const result = baseMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it('should reject when type is empty string', () => {
    const msg = { id: 'msg-1', type: '', timestamp: 1000 };
    const result = baseMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it('should reject when timestamp is missing', () => {
    const msg = { id: 'msg-1', type: 'org:list' };
    const result = baseMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it('should reject when timestamp is not a number', () => {
    const msg = { id: 'msg-1', type: 'org:list', timestamp: 'not-a-number' };
    const result = baseMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it('should reject when timestamp is Infinity', () => {
    const msg = { id: 'msg-1', type: 'org:list', timestamp: Infinity };
    const result = baseMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it('should reject null input', () => {
    const result = baseMessageSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it('should reject undefined input', () => {
    const result = baseMessageSchema.safeParse(undefined);
    expect(result.success).toBe(false);
  });
});
