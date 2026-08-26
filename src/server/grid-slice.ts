import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs/promises';

export interface Cell {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function computeGridCells(
  imageWidth: number,
  imageHeight: number,
  rows: number,
  cols: number,
  contentTopFraction = 0,
  rowHeightFraction?: number
): Cell[] {
  // Some screenshot layouts repeat a fixed header (balance, mascot, table
  // labels) above the actual row list — contentTopFraction skips that band
  // before dividing the rest into row-height cells.
  const contentTop = Math.floor(imageHeight * contentTopFraction);
  // rowHeightFraction (measured from a real screenshot) is preferred: row
  // height is fixed by the game UI regardless of how many rows the admin
  // says there are, and the list never fills exactly to the image bottom
  // (there's always trailing footer/nav below the last row). Falling back to
  // (imageHeight - contentTop) / rows assumes it does, which overshoots the
  // true row height and drifts every cell further off with each row down.
  const cellHeight =
    rowHeightFraction != null
      ? Math.floor(imageHeight * rowHeightFraction)
      : Math.floor((imageHeight - contentTop) / rows);
  const cellWidth = Math.floor(imageWidth / cols);
  const cells: Cell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({ left: c * cellWidth, top: contentTop + r * cellHeight, width: cellWidth, height: cellHeight });
    }
  }
  return cells;
}

export async function sliceImageToCells(
  sourcePath: string,
  rows: number,
  cols: number,
  outDir: string,
  baseName: string,
  contentTopFraction = 0,
  rowHeightFraction?: number
): Promise<string[]> {
  const metadata = await sharp(sourcePath).metadata();
  const cells = computeGridCells(
    metadata.width ?? 0,
    metadata.height ?? 0,
    rows,
    cols,
    contentTopFraction,
    rowHeightFraction
  );

  await fs.mkdir(outDir, { recursive: true });

  const outputPaths: string[] = [];
  for (let i = 0; i < cells.length; i++) {
    const outPath = path.join(outDir, `${baseName}-${i}.png`);
    await sharp(sourcePath).extract(cells[i]).toFile(outPath);
    outputPaths.push(outPath);
  }
  return outputPaths;
}
