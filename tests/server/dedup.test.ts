import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { computeIconSignature, groupBySignature } from '../../src/server/dedup';

describe('dedup', () => {
  let tmpDir: string;
  let redPath: string;
  let redPath2: string;
  let bluePath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dedup-'));
    redPath = path.join(tmpDir, 'red.png');
    redPath2 = path.join(tmpDir, 'red2.png');
    bluePath = path.join(tmpDir, 'blue.png');
    await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toFile(redPath);
    // Slightly different red, standing in for JPEG re-compression noise on a genuine duplicate.
    await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 196, g: 34, b: 28 } } }).png().toFile(redPath2);
    await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 30, g: 60, b: 200 } } }).png().toFile(bluePath);
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('treats near-identical icons (minor compression noise) as the same item', async () => {
    const a = await computeIconSignature(redPath);
    const b = await computeIconSignature(redPath2);
    const groups = groupBySignature([
      { signature: a, value: 'a' },
      { signature: b, value: 'b' },
    ]);
    expect(groups).toEqual([['a', 'b']]);
  });

  it('keeps visibly different icons in separate groups', async () => {
    const red = await computeIconSignature(redPath);
    const blue = await computeIconSignature(bluePath);
    const groups = groupBySignature([
      { signature: red, value: 'red' },
      { signature: blue, value: 'blue' },
    ]);
    expect(groups).toEqual([['red'], ['blue']]);
  });

  it('groups several duplicates together regardless of order', async () => {
    const red = await computeIconSignature(redPath);
    const red2 = await computeIconSignature(redPath2);
    const blue = await computeIconSignature(bluePath);
    const groups = groupBySignature([
      { signature: red, value: 1 },
      { signature: blue, value: 2 },
      { signature: red2, value: 3 },
      { signature: red, value: 4 },
    ]);
    expect(groups).toEqual([
      [1, 3, 4],
      [2],
    ]);
  });
});
