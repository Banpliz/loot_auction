import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs/promises';

export interface Cell {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function computeGridCells(imageWidth: number, imageHeight: number, rows: number, cols: number): Cell[] {
  const cellWidth = Math.floor(imageWidth / cols);
  const cellHeight = Math.floor(imageHeight / rows);
  const cells: Cell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({ left: c * cellWidth, top: r * cellHeight, width: cellWidth, height: cellHeight });
    }
  }
  return cells;
}

export async function sliceImageToCells(
  sourcePath: string,
  rows: number,
  cols: number,
  outDir: string,
  baseName: string
): Promise<string[]> {
  const metadata = await sharp(sourcePath).metadata();
  const cells = computeGridCells(metadata.width ?? 0, metadata.height ?? 0, rows, cols);

  await fs.mkdir(outDir, { recursive: true });

  const outputPaths: string[] = [];
  for (let i = 0; i < cells.length; i++) {
    const outPath = path.join(outDir, `${baseName}-${i}.png`);
    await sharp(sourcePath).extract(cells[i]).toFile(outPath);
    outputPaths.push(outPath);
  }
  return outputPaths;
}
