// src/server/dedup.ts
import sharp from 'sharp';

// Downscaled-thumbnail fingerprint of an icon crop, compared by mean per-byte
// difference. Calibrated against a real screenshot with genuine duplicate rows
// (2026-08-27): same item ~1.4-2.1, different items ~20-22, even after the
// client's JPEG re-compression — a threshold of 8 leaves a wide margin both ways.
//
// That calibration was against feast's fixed pixel-grid slicer, where every crop of a
// given cell uses the exact same box every time. Invasion's vision-detected crops don't:
// each icon's box comes from a fresh Claude call and its margin/size varies a bit instance
// to instance (see vision.ts) — the same icon can end up with a different amount of
// surrounding panel background, or a slightly different zoom level, each time it's cut.
// That framing noise was pushing genuine invasion duplicates well past 8, so they showed
// up as separate lots instead of merging — confirmed live 2026-09-01. Raised the threshold
// to give that framing variance headroom while staying comfortably under "different items".
const SIGNATURE_SIZE = 16;
const SAME_ITEM_THRESHOLD = 16;

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

// The purple reward chest reuses the exact same icon art regardless of what's
// actually inside it, so icon-signature matching can't tell two genuinely
// different chest lots apart — treating them as "the same item" would hide a
// real lot. Reference signature captured 2026-08-27 from a real chest crop
// (data/uploads/items/ss6-0-icon.png) on production. Any icon matching this
// is exempted from cross-upload merging in screenshots.ts (still merges fine
// with other chest rows *within* one upload, where they really are repeats).
export const CHEST_REFERENCE_SIGNATURE: IconSignature = Buffer.from([
  210, 162, 67, 209, 163, 71, 215, 166, 65, 208, 162, 65, 214, 169, 78, 214, 167, 66, 234, 177, 58, 235, 177, 58,
  235, 175, 52, 232, 185, 87, 241, 228, 204, 242, 230, 209, 242, 230, 207, 241, 229, 208, 238, 225, 207, 239, 226,
  207, 240, 220, 185, 243, 224, 186, 234, 210, 184, 228, 202, 182, 229, 203, 179, 228, 203, 181, 224, 201, 183, 224,
  201, 183, 223, 200, 182, 226, 206, 195, 227, 210, 203, 226, 208, 201, 226, 208, 202, 230, 213, 202, 242, 230, 207,
  239, 225, 207, 242, 231, 212, 224, 204, 207, 185, 139, 218, 190, 137, 230, 190, 139, 227, 190, 138, 228, 191, 140,
  228, 191, 140, 228, 191, 139, 228, 190, 137, 224, 192, 138, 224, 192, 138, 224, 190, 138, 224, 186, 133, 219, 217,
  192, 204, 241, 230, 207, 248, 237, 208, 185, 145, 195, 187, 127, 235, 228, 173, 255, 223, 167, 255, 224, 168, 255,
  223, 165, 251, 223, 165, 253, 223, 166, 254, 224, 167, 255, 218, 164, 253, 217, 164, 252, 227, 172, 254, 203, 143,
  246, 175, 131, 197, 243, 232, 206, 247, 238, 209, 185, 146, 195, 179, 112, 229, 215, 157, 241, 206, 145, 201, 204,
  143, 199, 212, 156, 245, 212, 156, 244, 212, 156, 238, 183, 131, 173, 177, 105, 91, 199, 120, 110, 211, 154, 226,
  194, 128, 241, 171, 126, 194, 244, 233, 207, 249, 241, 212, 184, 145, 193, 183, 113, 238, 140, 90, 134, 146, 73,
  30, 227, 132, 73, 221, 153, 119, 223, 159, 119, 223, 155, 103, 228, 154, 81, 219, 134, 51, 202, 99, 27, 187, 112,
  134, 189, 121, 243, 173, 126, 194, 243, 232, 207, 231, 216, 189, 187, 148, 197, 178, 109, 232, 113, 63, 78, 89, 32,
  4, 222, 123, 68, 234, 148, 79, 235, 166, 94, 233, 154, 76, 226, 145, 74, 224, 144, 71, 180, 86, 30, 159, 80, 82,
  189, 121, 242, 172, 126, 194, 245, 234, 208, 201, 180, 154, 188, 150, 203, 161, 86, 189, 84, 75, 83, 129, 148, 155,
  145, 128, 135, 163, 109, 80, 221, 136, 61, 226, 137, 75, 214, 123, 62, 199, 111, 48, 183, 88, 36, 166, 78, 51, 174,
  104, 201, 177, 131, 203, 235, 222, 196, 212, 194, 168, 193, 150, 204, 134, 89, 190, 94, 151, 197, 163, 168, 181,
  126, 177, 161, 118, 129, 114, 179, 91, 40, 182, 93, 39, 162, 91, 34, 161, 84, 33, 155, 70, 38, 136, 57, 16, 154,
  85, 158, 180, 133, 209, 236, 224, 197, 241, 232, 202, 193, 150, 202, 121, 84, 181, 157, 162, 157, 196, 159, 98,
  183, 182, 107, 82, 143, 180, 111, 52, 86, 147, 71, 81, 148, 88, 38, 154, 81, 39, 106, 40, 18, 113, 53, 58, 174,
  102, 213, 174, 128, 199, 244, 234, 207, 247, 239, 210, 190, 149, 200, 149, 82, 199, 173, 149, 101, 190, 190, 112,
  185, 172, 96, 169, 149, 157, 130, 114, 175, 194, 149, 206, 133, 79, 58, 142, 70, 30, 112, 42, 11, 143, 71, 93, 185,
  109, 242, 172, 127, 194, 241, 229, 203, 247, 238, 207, 186, 146, 205, 157, 99, 166, 207, 198, 158, 133, 196, 212,
  162, 201, 191, 191, 165, 100, 168, 186, 208, 176, 198, 239, 135, 81, 100, 125, 49, 5, 149, 61, 20, 142, 75, 57,
  164, 95, 209, 177, 130, 201, 238, 227, 200, 247, 238, 207, 190, 149, 205, 139, 81, 159, 169, 155, 135, 147, 150,
  173, 175, 161, 155, 201, 162, 92, 169, 151, 217, 133, 115, 181, 146, 80, 143, 160, 89, 155, 155, 79, 152, 149,
  132, 147, 173, 119, 213, 173, 123, 198, 242, 232, 205, 247, 238, 209, 188, 149, 199, 164, 83, 226, 154, 113, 132,
  152, 132, 100, 142, 117, 90, 134, 88, 117, 135, 89, 157, 131, 88, 154, 165, 92, 205, 198, 114, 249, 199, 109, 254,
  159, 119, 185, 169, 116, 207, 176, 124, 202, 243, 233, 206, 249, 239, 212, 176, 144, 182, 142, 68, 206, 164, 88,
  211, 138, 75, 171, 143, 80, 178, 141, 73, 187, 157, 80, 208, 178, 93, 233, 178, 94, 232, 171, 90, 223, 174, 89,
  226, 159, 91, 208, 139, 73, 197, 162, 120, 180, 245, 234, 208, 242, 230, 209, 221, 205, 197, 147, 111, 162, 145,
  102, 170, 150, 106, 178, 149, 105, 177, 150, 106, 175, 147, 105, 171, 142, 102, 165, 142, 102, 164, 144, 103, 166,
  143, 103, 166, 147, 102, 171, 143, 103, 163, 209, 193, 189, 243, 231, 210,
]);

export function isGenericChestIcon(signature: IconSignature): boolean {
  return isSameIcon(signature, CHEST_REFERENCE_SIGNATURE);
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
