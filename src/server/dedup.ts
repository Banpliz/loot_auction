// src/server/dedup.ts
import sharp from 'sharp';

// Downscaled-thumbnail fingerprint of an icon crop, compared by mean per-byte
// difference. Calibrated against a real screenshot with genuine duplicate rows
// (2026-08-27): same item ~1.4-2.1, different items ~20-22, even after the
// client's JPEG re-compression — a threshold of 8 leaves a wide margin both ways.
const SIGNATURE_SIZE = 16;
const SAME_ITEM_THRESHOLD = 8;

export type IconSignature = Buffer;

export async function computeIconSignature(imagePath: string): Promise<IconSignature> {
  return sharp(imagePath).resize(SIGNATURE_SIZE, SIGNATURE_SIZE, { fit: 'fill' }).raw().toBuffer();
}

function signatureDistance(a: IconSignature, b: IconSignature): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

export function isSameIcon(a: IconSignature, b: IconSignature): boolean {
  return signatureDistance(a, b) < SAME_ITEM_THRESHOLD;
}

// Groups entries whose icon looks the same, in encounter order — each group's
// "leader" is whichever entry started it, so later near-duplicates just join
// rather than re-comparing every pair (fine at upload-batch scale, a few dozen
// rows at most).
export function groupBySignature<T>(entries: { signature: IconSignature; value: T }[]): T[][] {
  const groups: { signature: IconSignature; values: T[] }[] = [];
  for (const entry of entries) {
    const group = groups.find((g) => signatureDistance(g.signature, entry.signature) < SAME_ITEM_THRESHOLD);
    if (group) group.values.push(entry.value);
    else groups.push({ signature: entry.signature, values: [entry.value] });
  }
  return groups.map((g) => g.values);
}
