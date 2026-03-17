import { describe, it, expect } from 'vitest';
import { extractErrorMessage } from './extractErrorMessage.js';

describe('extractErrorMessage', () => {
  it('returns the message from an Error instance', () => {
    expect(extractErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns the message from a subclass of Error', () => {
    class CustomError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = 'CustomError';
      }
    }
    expect(extractErrorMessage(new CustomError('custom boom'))).toBe('custom boom');
  });

  it('converts a string to itself', () => {
    expect(extractErrorMessage('plain string')).toBe('plain string');
  });

  it('converts a number to its string representation', () => {
    expect(extractErrorMessage(42)).toBe('42');
  });

  it('converts null to "null"', () => {
    expect(extractErrorMessage(null)).toBe('null');
  });

  it('converts undefined to "undefined"', () => {
    expect(extractErrorMessage(undefined)).toBe('undefined');
  });

  it('converts an object to its string representation', () => {
    expect(extractErrorMessage({ key: 'value' })).toBe('[object Object]');
  });
});
