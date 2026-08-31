import sharp from 'sharp';
import { LAYOUT_TEMPLATES } from './layout-templates';

export type RarityColor = 'blue' | 'purple' | 'red';

const REFERENCE_COLORS: Record<RarityColor, [number, number, number]> = {
  blue: [74, 144, 217],
  purple: [156, 74, 201],
  red: [209, 67, 78],
};

const PATCH_SIZE = 6;

export async function detectColor(stripPath: string, template: 'feast'): Promise<RarityColor> {
  // Non-null assertion is safe: 'feast' is always present in LAYOUT_TEMPLATES (invasion's
  // entry was removed once its screenshots stopped using pixel-grid recognition — see
  // docs/superpowers/specs/2026-08-31-invasion-vision-recognition-design.md).
  const { colorSample } = LAYOUT_TEMPLATES[template]!;
  const image = sharp(stripPath);
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  const half = Math.floor(PATCH_SIZE / 2);
  const left = clamp(Math.round(width * colorSample.x) - half, 0, Math.max(width - PATCH_SIZE, 0));
  const top = clamp(Math.round(height * colorSample.y) - half, 0, Math.max(height - PATCH_SIZE, 0));
  const patchWidth = Math.min(PATCH_SIZE, width);
  const patchHeight = Math.min(PATCH_SIZE, height);

  const { data, info } = await image
    .extract({ left, top, width: patchWidth, height: patchHeight })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixelCount = info.width * info.height;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < pixelCount; i++) {
    r += data[i * info.channels];
    g += data[i * info.channels + 1];
    b += data[i * info.channels + 2];
  }
  r /= pixelCount;
  g /= pixelCount;
  b /= pixelCount;

  let best: RarityColor = 'blue';
  let bestDist = Infinity;
  for (const [color, [refR, refG, refB]] of Object.entries(REFERENCE_COLORS) as [RarityColor, [number, number, number]][]) {
    const dist = (r - refR) ** 2 + (g - refG) ** 2 + (b - refB) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = color;
    }
  }
  return best;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
