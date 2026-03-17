import { describe, it, expect, vi } from 'vitest';
import { TypedEventEmitter } from './TypedEventEmitter.js';

type TestEvents = {
  added: { id: string };
  removed: { id: string };
};

class TestEmitter extends TypedEventEmitter<TestEvents> {
  fire<K extends keyof TestEvents>(type: K, event: TestEvents[K]): void {
    this.emit(type, event);
  }
}

describe('TypedEventEmitter', () => {
  it('should notify all listeners for a specific event type', () => {
    const emitter = new TestEmitter();
    const l1 = vi.fn();
    const l2 = vi.fn();
    emitter.on('added', l1);
    emitter.on('added', l2);
    emitter.fire('added', { id: '1' });
    expect(l1).toHaveBeenCalledWith({ id: '1' });
    expect(l2).toHaveBeenCalledWith({ id: '1' });
  });

  it('should not cross-notify different event types', () => {
    const emitter = new TestEmitter();
    const addedL = vi.fn();
    const removedL = vi.fn();
    emitter.on('added', addedL);
    emitter.on('removed', removedL);
    emitter.fire('added', { id: '1' });
    expect(addedL).toHaveBeenCalledTimes(1);
    expect(removedL).not.toHaveBeenCalled();
  });

  it('should isolate listener errors — other listeners still called', () => {
    const emitter = new TestEmitter();
    const throwing = vi.fn(() => {
      throw new Error('boom');
    });
    const safe = vi.fn();
    emitter.on('added', throwing);
    emitter.on('added', safe);
    emitter.fire('added', { id: '1' });
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(safe).toHaveBeenCalledTimes(1);
  });

  it('should support unsubscribe via returned function', () => {
    const emitter = new TestEmitter();
    const listener = vi.fn();
    const unsub = emitter.on('added', listener);
    unsub();
    emitter.fire('added', { id: '1' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('should support removeAllListeners', () => {
    const emitter = new TestEmitter();
    const l = vi.fn();
    emitter.on('added', l);
    emitter.on('removed', l);
    emitter.removeAllListeners();
    emitter.fire('added', { id: '1' });
    emitter.fire('removed', { id: '2' });
    expect(l).not.toHaveBeenCalled();
  });
});
