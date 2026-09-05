import { describe, it, expect, vi } from 'vitest';
import { subscribeToChanges, publishChange } from '../../src/server/pubsub';

describe('pubsub', () => {
  it('calls every subscribed listener on publish', () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeToChanges(a);
    subscribeToChanges(b);
    publishChange();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('stops calling a listener once it unsubscribes', () => {
    const fn = vi.fn();
    const unsubscribe = subscribeToChanges(fn);
    publishChange();
    unsubscribe();
    publishChange();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('publishing with no subscribers does nothing', () => {
    expect(() => publishChange()).not.toThrow();
  });
});
