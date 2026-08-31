import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectColor } from '../../src/server/color-detect';

describe('detectColor', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'color-detect-'));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function solidStrip(name: string, rgb: [number, number, number]): Promise<string> {
    const file = path.join(tmpDir, name);
    await sharp({
      create: { width: 200, height: 60, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
    })
      .png()
      .toFile(file);
    return file;
  }

  it('matches a solid blue strip to blue', async () => {
    const file = await solidStrip('blue.png', [74, 144, 217]);
    expect(await detectColor(file, 'feast')).toBe('blue');
  });

  it('matches a solid purple strip to purple', async () => {
    const file = await solidStrip('purple.png', [156, 74, 201]);
    expect(await detectColor(file, 'feast')).toBe('purple');
  });

  it('matches a solid red strip to red', async () => {
    const file = await solidStrip('red.png', [209, 67, 78]);
    expect(await detectColor(file, 'feast')).toBe('red');
  });

  it('returns some valid color instead of throwing on an ambiguous input', async () => {
    const file = await solidStrip('gray.png', [128, 128, 128]);
    const result = await detectColor(file, 'feast');
    expect(['blue', 'purple', 'red']).toContain(result);
  });
});
