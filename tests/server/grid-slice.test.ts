import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { computeGridCells, sliceImageToCells } from '../../src/server/grid-slice';

describe('computeGridCells', () => {
  it('divides the image into rows*cols equal cells in row-major order', () => {
    const cells = computeGridCells(100, 40, 2, 5);
    expect(cells).toHaveLength(10);
    expect(cells[0]).toEqual({ left: 0, top: 0, width: 20, height: 20 });
    expect(cells[4]).toEqual({ left: 80, top: 0, width: 20, height: 20 });
    expect(cells[5]).toEqual({ left: 0, top: 20, width: 20, height: 20 });
    expect(cells[9]).toEqual({ left: 80, top: 20, width: 20, height: 20 });
  });

  it('floors leftover pixels instead of throwing on uneven division', () => {
    const cells = computeGridCells(101, 41, 2, 5);
    expect(cells[0]).toEqual({ left: 0, top: 0, width: 20, height: 20 });
  });
});

describe('sliceImageToCells', () => {
  let tmpDir: string;
  let sourcePath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grid-slice-'));
    sourcePath = path.join(tmpDir, 'source.png');
    await sharp({
      create: { width: 100, height: 40, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toFile(sourcePath);
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('produces rows*cols files matching cell dimensions', async () => {
    const outDir = path.join(tmpDir, 'out');
    const paths = await sliceImageToCells(sourcePath, 2, 5, outDir, 'item');
    expect(paths).toHaveLength(10);
    const meta = await sharp(paths[0]).metadata();
    expect(meta.width).toBe(20);
    expect(meta.height).toBe(20);
  });
});
