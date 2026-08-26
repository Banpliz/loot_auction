// src/server/ocr.ts
import { createWorker, PSM, type Worker } from 'tesseract.js';
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

export async function recognizeStrip(
  stripPath: string,
  template: Template,
  cacheDir?: string
): Promise<{ name: string; price: string }> {
  const { nameBox, priceBox } = LAYOUT_TEMPLATES[template];
  const worker = await getWorker(cacheDir);

  // Name wraps across up to two lines; price is always one line ("<icon> N.NK") -
  // telling tesseract which shape to expect noticeably cuts down on garbage,
  // since its default auto-segmentation was treating the coin icon and text as
  // separate blocks and mangling both.
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
  const nameImage = await cropForOcr(stripPath, nameBox);
  const nameResult = await worker.recognize(nameImage);

  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
  const priceImage = await cropForOcr(stripPath, priceBox);
  const priceResult = await worker.recognize(priceImage);

  return {
    name: nameResult.data.text.trim(),
    price: priceResult.data.text.trim(),
  };
}
