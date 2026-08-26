import { describe, it, expect, vi, afterEach } from 'vitest';
import { pickRandom, shuffle } from '../../src/server/random';

describe('pickRandom', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null for an empty array', () => {
    expect(pickRandom([])).toBeNull();
  });

  it('returns the only item for a single-element array', () => {
    expect(pickRandom(['a'])).toBe('a');
  });

  it('picks the item at the index implied by Math.random', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(pickRandom(['a', 'b', 'c', 'd'])).toBe('c'); // floor(0.5 * 4) = 2
  });
});

describe('shuffle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an array with the same elements', () => {
    const result = shuffle([1, 2, 3, 4]);
    expect(result.sort()).toEqual([1, 2, 3, 4]);
  });

  it('does not mutate the input array', () => {
    const input = [1, 2, 3];
    shuffle(input);
    expect(input).toEqual([1, 2, 3]);
  });
});
