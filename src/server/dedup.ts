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

// The reward chest reuses the exact same icon art regardless of what's actually inside it,
// so icon-signature matching can't tell two genuinely different chest lots apart — treating
// them as "the same item" would hide a real lot. Exempted from cross-upload merging in
// screenshots.ts (still merges fine with other chest rows *within* one upload, where they
// really are repeats).
//
// Round 2026-09-01 (invasion-cv rewrite): the single old reference (captured against the
// prior Vision-pipeline's crop framing) stopped matching once icon crops started coming
// from the new code-side pipeline (src/server/invasion-cv.ts) — its margins and framing
// differ, so the old signature was too far away even at the widened SAME_ITEM_THRESHOLD.
// This surfaced as chests silently re-merging with summed-up quantities live. Recalibrated
// against real new-pipeline crops (scripts/icon-signature-report.js), and split into ONE
// reference PER RARITY COLOR instead of a single value — the chest graphic is identical
// regardless of contents, but its rarity-colored border isn't, and two real chest crops of
// different colors don't fall within SAME_ITEM_THRESHOLD of each other. Each reference below
// was confirmed generic by matching a same-color chest from a SEPARATE upload within ~2-5
// (well under the threshold) — only a genuinely content-independent icon does that.
const CHEST_REFERENCE_SIGNATURE_PURPLE: IconSignature = Buffer.from([
  229, 209, 192, 186, 143, 198, 179, 125, 220, 184, 129, 219, 183, 128, 219, 183, 128, 219, 184, 129, 220, 184, 129,
  220, 184, 129, 219, 183, 128, 217, 183, 128, 216, 183, 128, 217, 183, 129, 219, 180, 125, 219, 188, 143, 198, 227,
  210, 191, 197, 169, 184, 172, 113, 221, 223, 169, 254, 219, 164, 250, 221, 167, 254, 222, 167, 253, 221, 166, 250,
  220, 166, 250, 221, 166, 250, 225, 169, 254, 225, 172, 255, 221, 170, 255, 222, 167, 252, 223, 168, 254, 178, 119,
  226, 201, 175, 186, 195, 165, 184, 163, 98, 214, 220, 159, 249, 220, 164, 249, 210, 156, 236, 212, 158, 244, 217,
  161, 255, 217, 161, 254, 216, 161, 255, 192, 140, 215, 175, 118, 148, 197, 128, 143, 207, 151, 220, 219, 161, 254,
  168, 104, 215, 200, 173, 186, 196, 166, 184, 165, 98, 216, 197, 136, 230, 146, 89, 106, 201, 115, 81, 200, 125,
  118, 214, 154, 182, 208, 149, 163, 209, 149, 150, 206, 140, 102, 195, 113, 42, 205, 101, 28, 193, 113, 110, 203,
  140, 243, 168, 102, 216, 201, 174, 186, 195, 165, 182, 169, 101, 226, 175, 116, 188, 69, 21, 4, 184, 97, 47, 249,
  151, 80, 240, 168, 92, 239, 169, 92, 236, 160, 78, 238, 159, 78, 235, 157, 77, 202, 111, 45, 168, 77, 46, 192,
  126, 211, 169, 104, 223, 201, 173, 185, 195, 166, 182, 168, 101, 226, 153, 95, 142, 65, 32, 14, 140, 84, 61, 197,
  106, 61, 213, 134, 77, 227, 153, 85, 226, 144, 74, 216, 131, 68, 213, 130, 60, 192, 103, 44, 153, 61, 25, 183,
  116, 186, 169, 103, 227, 200, 173, 183, 195, 166, 185, 168, 97, 217, 103, 70, 101, 100, 148, 170, 153, 170, 184,
  126, 138, 155, 168, 113, 74, 223, 131, 55, 221, 131, 73, 212, 122, 56, 192, 103, 43, 184, 92, 41, 170, 74, 28,
  167, 91, 111, 164, 99, 220, 201, 174, 184, 199, 168, 188, 153, 85, 200, 97, 143, 203, 141, 155, 189, 159, 164,
  145, 121, 170, 141, 120, 116, 99, 170, 77, 32, 169, 84, 33, 151, 85, 31, 148, 77, 29, 163, 78, 40, 132, 52, 19,
  137, 69, 72, 161, 97, 216, 203, 175, 185, 201, 170, 189, 137, 78, 192, 137, 140, 165, 182, 161, 129, 197, 169,
  91, 153, 178, 139, 68, 124, 180, 121, 44, 74, 146, 73, 90, 155, 93, 40, 158, 85, 38, 123, 52, 26, 91, 32, 19,
  161, 95, 160, 169, 100, 224, 200, 174, 184, 197, 168, 185, 158, 87, 219, 138, 105, 130, 207, 188, 99, 184, 170,
  90, 204, 175, 99, 149, 133, 170, 131, 103, 170, 200, 143, 208, 132, 78, 56, 147, 76, 34, 110, 45, 18, 117, 47,
  36, 187, 114, 211, 167, 97, 223, 200, 174, 184, 199, 169, 188, 147, 82, 198, 212, 173, 149, 163, 193, 173, 132,
  212, 227, 163, 180, 149, 187, 164, 126, 167, 191, 216, 183, 205, 233, 121, 74, 91, 124, 50, 6, 153, 63, 21, 143,
  58, 20, 153, 85, 145, 168, 98, 227, 200, 175, 183, 202, 171, 192, 136, 75, 178, 186, 162, 132, 147, 157, 166,
  165, 183, 207, 186, 172, 126, 207, 171, 97, 163, 160, 236, 145, 139, 209, 163, 93, 148, 137, 71, 87, 146, 66,
  97, 139, 98, 96, 173, 146, 184, 156, 84, 210, 203, 177, 187, 197, 169, 184, 161, 86, 220, 141, 90, 141, 168,
  150, 114, 137, 121, 128, 163, 136, 101, 163, 114, 136, 142, 113, 176, 115, 86, 134, 134, 71, 161, 184, 108,
  232, 194, 107, 247, 167, 114, 204, 178, 155, 195, 153, 82, 207, 204, 179, 189, 193, 165, 182, 158, 87, 218,
  177, 102, 221, 146, 106, 119, 141, 105, 114, 135, 96, 108, 119, 62, 142, 146, 81, 173, 175, 101, 215, 195, 110,
  241, 195, 108, 238, 196, 107, 241, 184, 108, 222, 169, 127, 195, 154, 83, 211, 202, 175, 184, 202, 179, 179,
  119, 64, 163, 147, 76, 207, 141, 69, 203, 138, 68, 198, 142, 71, 206, 150, 79, 207, 155, 80, 212, 152, 78, 209,
  148, 75, 204, 148, 76, 204, 149, 77, 203, 148, 76, 201, 137, 69, 197, 120, 66, 164, 206, 184, 180, 234, 217,
  194, 186, 160, 170, 152, 119, 158, 159, 126, 161, 160, 125, 162, 158, 125, 161, 157, 123, 159, 156, 123, 160,
  156, 123, 160, 157, 123, 161, 157, 123, 161, 157, 123, 161, 158, 125, 161, 154, 121, 159, 187, 160, 171, 232,
  217, 195,
]);
const CHEST_REFERENCE_SIGNATURE_BLUE: IconSignature = Buffer.from([
  236, 218, 194, 196, 190, 187, 150, 160, 181, 155, 162, 181, 154, 162, 181, 154, 162, 182, 154, 162, 182, 154,
  162, 182, 154, 162, 182, 154, 162, 182, 154, 162, 181, 154, 162, 180, 155, 163, 181, 150, 160, 181, 179, 179,
  184, 235, 216, 194, 198, 191, 189, 100, 142, 201, 112, 168, 230, 119, 172, 228, 119, 171, 228, 119, 172, 228,
  118, 172, 229, 118, 172, 229, 118, 172, 229, 118, 172, 229, 119, 175, 232, 118, 175, 234, 118, 173, 230, 116,
  172, 231, 97, 144, 209, 175, 176, 184, 158, 163, 181, 93, 146, 219, 160, 215, 250, 156, 216, 253, 152, 216, 255,
  155, 216, 253, 156, 212, 250, 157, 213, 251, 156, 215, 253, 153, 213, 254, 151, 202, 240, 156, 199, 231, 153,
  209, 246, 163, 218, 252, 109, 164, 231, 124, 143, 183, 162, 165, 182, 91, 142, 215, 142, 200, 246, 144, 172,
  199, 165, 160, 169, 148, 170, 193, 145, 200, 242, 145, 192, 229, 148, 192, 226, 152, 165, 178, 154, 104, 81,
  193, 105, 63, 168, 144, 138, 143, 204, 248, 100, 155, 226, 129, 145, 182, 161, 164, 180, 92, 147, 224, 122,
  163, 204, 95, 46, 30, 209, 107, 50, 223, 136, 79, 213, 166, 120, 219, 165, 111, 219, 157, 97, 231, 153, 81,
  234, 150, 66, 211, 112, 41, 191, 93, 44, 138, 163, 194, 98, 158, 234, 129, 145, 181, 161, 162, 178, 90, 150,
  228, 120, 140, 169, 64, 9, 0, 148, 75, 38, 238, 136, 71, 236, 156, 87, 239, 167, 96, 234, 154, 79, 226, 147,
  75, 223, 145, 72, 204, 122, 54, 159, 58, 18, 134, 135, 153, 96, 164, 242, 129, 143, 178, 162, 165, 181, 89,
  143, 218, 100, 85, 93, 91, 97, 100, 144, 134, 134, 153, 113, 109, 180, 110, 66, 223, 141, 66, 225, 138, 72,
  219, 126, 67, 206, 118, 52, 191, 105, 43, 173, 70, 25, 150, 108, 103, 95, 153, 227, 129, 146, 181, 163, 167,
  186, 83, 130, 202, 68, 116, 156, 128, 165, 205, 159, 176, 176, 115, 164, 160, 141, 117, 89, 203, 107, 45, 196,
  105, 55, 188, 108, 44, 161, 86, 32, 170, 83, 37, 153, 63, 30, 146, 69, 38, 89, 130, 194, 130, 150, 188, 166,
  170, 187, 69, 115, 188, 126, 167, 197, 177, 156, 156, 177, 171, 116, 139, 176, 137, 70, 124, 155, 127, 52, 45,
  139, 61, 46, 148, 84, 33, 141, 75, 31, 158, 77, 39, 112, 42, 22, 116, 77, 71, 90, 142, 213, 130, 147, 185, 164,
  168, 185, 74, 125, 204, 109, 117, 124, 205, 174, 92, 200, 162, 63, 198, 176, 103, 120, 136, 186, 119, 72, 140,
  184, 114, 186, 153, 98, 69, 159, 85, 39, 112, 50, 22, 90, 24, 8, 114, 134, 166, 91, 157, 238, 129, 143, 180,
  163, 166, 184, 76, 131, 208, 172, 172, 141, 185, 196, 153, 133, 202, 195, 173, 178, 134, 183, 152, 137, 148,
  165, 193, 199, 203, 235, 126, 86, 101, 117, 48, 11, 153, 67, 25, 149, 52, 16, 126, 109, 120, 84, 151, 234, 130,
  145, 180, 164, 170, 191, 70, 110, 166, 204, 186, 141, 136, 159, 173, 168, 207, 223, 172, 178, 140, 204, 176,
  86, 170, 175, 232, 149, 171, 228, 173, 106, 163, 118, 61, 45, 134, 69, 55, 127, 75, 62, 140, 135, 142, 85, 137,
  209, 129, 147, 184, 165, 167, 183, 72, 127, 208, 119, 124, 124, 171, 147, 134, 142, 128, 152, 175, 144, 116,
  189, 137, 125, 161, 126, 203, 122, 98, 150, 116, 77, 147, 98, 144, 195, 107, 164, 229, 96, 148, 205, 146, 165,
  181, 87, 134, 200, 129, 147, 185, 161, 165, 181, 80, 137, 225, 99, 150, 203, 140, 132, 101, 128, 117, 98, 129,
  120, 94, 101, 79, 131, 102, 105, 157, 90, 143, 187, 97, 165, 224, 109, 176, 244, 105, 176, 249, 120, 164, 209,
  156, 163, 170, 74, 122, 197, 129, 149, 189, 170, 168, 174, 48, 90, 171, 76, 134, 219, 60, 116, 193, 61, 115,
  188, 62, 119, 194, 68, 127, 202, 73, 137, 216, 80, 142, 226, 79, 138, 221, 77, 135, 216, 77, 135, 217, 78, 131,
  206, 87, 134, 206, 47, 92, 175, 133, 142, 165, 226, 211, 190, 135, 139, 155, 96, 111, 150, 106, 120, 158, 105,
  120, 158, 105, 119, 156, 103, 117, 155, 101, 115, 152, 100, 114, 151, 100, 114, 152, 101, 115, 152, 101, 115,
  152, 101, 116, 154, 95, 113, 154, 118, 128, 152, 215, 202, 185,
]);

export const CHEST_REFERENCE_SIGNATURES: IconSignature[] = [CHEST_REFERENCE_SIGNATURE_PURPLE, CHEST_REFERENCE_SIGNATURE_BLUE];

// Kept as the pre-round-2 single-value export name, still pointing at a real reference
// (purple) — nothing outside this file should rely on it being the ONLY reference in use;
// isGenericChestIcon below checks the full CHEST_REFERENCE_SIGNATURES list.
export const CHEST_REFERENCE_SIGNATURE: IconSignature = CHEST_REFERENCE_SIGNATURE_PURPLE;

export function isGenericChestIcon(signature: IconSignature): boolean {
  return CHEST_REFERENCE_SIGNATURES.some((ref) => isSameIcon(signature, ref));
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
