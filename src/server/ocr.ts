// src/server/ocr.ts
import { createWorker, type Worker } from 'tesseract.js';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import { LAYOUT_TEMPLATES, type Box, type Template } from './layout-templates';

let workerPromise: Promise<Worker> | null = null;

// ponytail: one worker for the lifetime of the process, never terminated —
// simpler than tracking a per-upload-batch create/terminate cycle, and
// avoids paying WASM startup cost (~1-2s) on every screenshot upload.
async function getWorker(cacheDir?: string): Promise<Worker> {
  if (!workerPromise) {
    if (cacheDir) await fs.mkdir(cacheDir, { recursive: true });
    workerPromise = createWorker('rus+eng', undefined, cacheDir ? { cachePath: cacheDir } : undefined).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

async function cropForOcr(stripPath: string, box: Box): Promise<Buffer> {
  const image = sharp(stripPath);
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  const left = Math.max(Math.round(width * box.x), 0);
  const top = Math.max(Math.round(height * box.y), 0);
  const cropWidth = Math.max(Math.min(Math.round(width * box.w), width - left), 1);
  const cropHeight = Math.max(Math.min(Math.round(height * box.h), height - top), 1);

  return image
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .resize({ width: cropWidth * 3 })
    .grayscale()
    .normalize()
    .png()
    .toBuffer();
}

// Only the price is OCR'd — the item's name is no longer auto-extracted.
// Reading it reliably would mean recognizing 1-2 lines of small stylized game
// text, which stayed garbage even after fixing the row-slicing bug that was
// mangling it further; the icon crop (see grid-slice.ts's cropBox / iconBox)
// already identifies the item without any OCR. Admin fills in a name by hand
// only where the icon alone is ambiguous (e.g. same chest art, different
// tier).
export async function recognizeStrip(stripPath: string, template: Template, cacheDir?: string): Promise<{ price: string }> {
  const { priceBox } = LAYOUT_TEMPLATES[template];
  const worker = await getWorker(cacheDir);

  // ponytail: tried pinning tessedit_pageseg_mode to SINGLE_LINE (price is
  // always one line) expecting cleaner segmentation. Reverted: on a crop with
  // no legible text (a mis-cropped row, or the screenshots.test.ts synthetic
  // solid-color fixtures) it made tesseract hang instead of the default AUTO
  // mode's fast bail-out — a stuck recognize() blocks the whole extraction
  // loop's DB write for that item, including the color that was already
  // detected. Default AUTO segmentation is worse at reading the
  // coin-icon-adjacent price text but never hangs.
  const priceImage = await cropForOcr(stripPath, priceBox);
  const priceResult = await worker.recognize(priceImage);

  return { price: priceResult.data.text.trim() };
}
