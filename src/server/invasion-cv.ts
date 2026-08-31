import sharp from 'sharp';
import { REFERENCE_COLORS, type RarityColor } from './color-detect';

export interface DetectedFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  rarity: RarityColor;
}

// Estimated from screenshots seen 2026-09-01/02 — the "Трофеи" panel's light cream/beige
// background. Not independently calibrated against a large sample; retune here if live
// testing shows the panel isn't being found (see Open Risks in the design doc).
const PANEL_REFERENCE_COLOR: [number, number, number] = [237, 224, 196];
const PANEL_COLOR_TOLERANCE = 28;

// Invasion's frames look visually identical to feast's (same game, same rarity palette),
// but were never independently sampled — reusing feast's calibrated values as a starting
// point, not a guarantee (see design doc's Open Risks).
const RARITY_COLOR_TOLERANCE = 40;

// A real panel spans most of the screenshot's height in every real example seen this
// session — a smaller match is more likely a false positive (a chat bubble, an unrelated
// icon) than an actual panel.
const MIN_PANEL_HEIGHT_RATIO = 0.25;

// Filters single-pixel/anti-aliasing color noise out of the connected-component pass — a
// real icon frame is a meaningful fraction of the image, never a handful of pixels.
const MIN_FRAME_AREA_RATIO = 0.0008;

// Icon frames are roughly square. Anything egregiously off square is two touching frames
// flood-filled into one component (or other noise), not a real icon.
//
// The review that asked for this guard suggested 1.3, but that is too tight to ship: a
// 30x40 frame (ratio 1.33) is a shape the existing detection tests already treat as one
// valid icon, and vision.ts's own geometry constants allow an icon up to ~1.2-1.3x taller
// than wide — a 1.3 ceiling would start discarding real single icons, trading this bug for
// a worse one. The target of the guard is a MERGED PAIR, which is ~2x off square, so 1.5
// catches every case the finding is about with real headroom above plausible icon shapes.
const MAX_FRAME_ASPECT_RATIO = 1.5;

type RawPixels = { data: Buffer; width: number; height: number; channels: number };

function colorDistance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

async function readRawRgb(imageBuffer: Buffer): Promise<RawPixels> {
  const { data, info } = await sharp(imageBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

// Finds the largest contiguous vertical span of rows that are mostly the panel's cream
// color. Returns pixel bounds, or null if nothing large enough matches.
function findPanelBounds(pixels: RawPixels): { top: number; bottom: number } | null {
  const { data, width, height, channels } = pixels;
  const rowIsPanel: boolean[] = new Array(height);
  for (let y = 0; y < height; y++) {
    let matchCount = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      if (colorDistance([data[i], data[i + 1], data[i + 2]], PANEL_REFERENCE_COLOR) <= PANEL_COLOR_TOLERANCE) {
        matchCount++;
      }
    }
    rowIsPanel[y] = matchCount / width > 0.5;
  }

  let bestStart = -1;
  let bestLength = 0;
  let currentStart = -1;
  for (let y = 0; y < height; y++) {
    if (rowIsPanel[y]) {
      if (currentStart === -1) currentStart = y;
    } else if (currentStart !== -1) {
      const length = y - currentStart;
      if (length > bestLength) {
        bestLength = length;
        bestStart = currentStart;
      }
      currentStart = -1;
    }
  }
  if (currentStart !== -1 && height - currentStart > bestLength) {
    bestLength = height - currentStart;
    bestStart = currentStart;
  }

  if (bestStart === -1 || bestLength / height < MIN_PANEL_HEIGHT_RATIO) return null;
  return { top: bestStart, bottom: bestStart + bestLength };
}

// Connected-component search (BFS flood fill) for pixels matching any rarity color, scoped
// to the panel's vertical span. Each component becomes one DetectedFrame; its rarity is
// whichever reference color the majority of its pixels matched (a component isn't split
// per exact color match — anti-aliased edge pixels can drift toward a neighboring
// reference color, so connectivity treats "any rarity color" as one foreground class and
// resolves the actual rarity afterward by majority vote).
function findFrames(pixels: RawPixels, panelTop: number, panelBottom: number): DetectedFrame[] {
  const { data, width, height, channels } = pixels;
  const rarityLabels: (RarityColor | null)[] = new Array(width * height).fill(null);
  const colorEntries = Object.entries(REFERENCE_COLORS) as [RarityColor, [number, number, number]][];

  for (let y = panelTop; y < panelBottom; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const pixel: [number, number, number] = [data[i], data[i + 1], data[i + 2]];
      let bestColor: RarityColor | null = null;
      let bestDist = RARITY_COLOR_TOLERANCE;
      for (const [color, ref] of colorEntries) {
        const dist = colorDistance(pixel, ref);
        if (dist <= bestDist) {
          bestDist = dist;
          bestColor = color;
        }
      }
      rarityLabels[y * width + x] = bestColor;
    }
  }

  const visited = new Uint8Array(width * height);
  const frames: DetectedFrame[] = [];
  const minArea = width * height * MIN_FRAME_AREA_RATIO;

  for (let y = panelTop; y < panelBottom; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (visited[idx] || !rarityLabels[idx]) continue;

      const stack = [idx];
      visited[idx] = 1;
      const colorCounts: Record<RarityColor, number> = { blue: 0, purple: 0, red: 0 };
      let minX = x, maxX = x, minY = y, maxY = y;

      while (stack.length > 0) {
        const current = stack.pop()!;
        const cx = current % width;
        const cy = Math.floor(current / width);
        colorCounts[rarityLabels[current]!]++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const neighbors: [number, number][] = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= width || ny < panelTop || ny >= panelBottom) continue;
          const nIdx = ny * width + nx;
          if (visited[nIdx] || !rarityLabels[nIdx]) continue;
          visited[nIdx] = 1;
          stack.push(nIdx);
        }
      }

      // Measured on the component's FOOTPRINT, not its matched-pixel count: a real rarity
      // frame is a hollow colored ring, so its matched pixels scale with the ring's
      // perimeter (linear in icon size) while minArea scales with image area (quadratic in
      // resolution) — at real screenshot resolutions a genuine 3-6px ring falls under
      // minArea and got thrown away as noise. Its bounding box doesn't.
      const bboxWidth = maxX - minX + 1;
      const bboxHeight = maxY - minY + 1;
      if (bboxWidth * bboxHeight < minArea) continue;

      // Icons are roughly square. A component far off square is two adjacent same-rarity
      // frames that the flood fill merged into one (connectivity only asks "is this pixel
      // any rarity color", not "is this the same icon"), or some other non-icon blob —
      // either way it's not one real frame, so drop just this component and keep going.
      if (bboxWidth > bboxHeight * MAX_FRAME_ASPECT_RATIO || bboxHeight > bboxWidth * MAX_FRAME_ASPECT_RATIO) continue;

      let rarity: RarityColor = 'blue';
      let bestCount = -1;
      for (const [color, count] of Object.entries(colorCounts) as [RarityColor, number][]) {
        if (count > bestCount) {
          bestCount = count;
          rarity = color;
        }
      }

      frames.push({
        x: minX / width,
        y: minY / height,
        w: (maxX - minX + 1) / width,
        h: (maxY - minY + 1) / height,
        rarity,
      });
    }
  }

  return frames;
}

// Returns null when the pipeline isn't confident it found the panel or any icon frames —
// the caller (screenshots.ts) falls back to extractInvasionLoot (vision.ts) in that case.
export async function detectInvasionFrames(imageBuffer: Buffer): Promise<DetectedFrame[] | null> {
  const pixels = await readRawRgb(imageBuffer);
  const panel = findPanelBounds(pixels);
  if (!panel) return null;

  const frames = findFrames(pixels, panel.top, panel.bottom);
  if (frames.length === 0) return null;

  return frames;
}

// The quantity badge sits in the icon frame's bottom-right corner in every real screenshot
// seen this session — these ratios are a first estimate, not measured against a large
// sample; retune if live testing shows the crop misses the number (see design doc's Open
// Risks).
const BADGE_WIDTH_RATIO = 0.4;
const BADGE_HEIGHT_RATIO = 0.3;

// The spec calls for small, symmetric padding around each detected frame before the
// final crop the admin sees, matching the general look of icons cropped by the Vision
// fallback path (which already applies margin). This must NEVER be applied to the frame
// passed into cropBadge() — that function's ratios are calibrated against the frame's
// own tight bounding box, and padding it first would shift the badge crop.
const COSMETIC_MARGIN_RATIO = 0.06;

export function withCosmeticMargin(frame: DetectedFrame): DetectedFrame {
  const marginX = frame.w * COSMETIC_MARGIN_RATIO;
  const marginY = frame.h * COSMETIC_MARGIN_RATIO;
  const x = Math.max(0, frame.x - marginX);
  const y = Math.max(0, frame.y - marginY);
  const w = Math.min(1 - x, frame.w + 2 * marginX);
  const h = Math.min(1 - y, frame.h + 2 * marginY);
  return { ...frame, x, y, w, h };
}

export async function cropBadge(imageBuffer: Buffer, frame: DetectedFrame): Promise<Buffer> {
  const { width, height } = await sharp(imageBuffer).metadata();
  if (!width || !height) {
    throw new Error('cropBadge: could not read image dimensions');
  }

  const badgeLeftFraction = frame.x + frame.w * (1 - BADGE_WIDTH_RATIO);
  const badgeTopFraction = frame.y + frame.h * (1 - BADGE_HEIGHT_RATIO);
  const left = Math.max(0, Math.min(width - 1, Math.round(badgeLeftFraction * width)));
  const top = Math.max(0, Math.min(height - 1, Math.round(badgeTopFraction * height)));
  const cropWidth = Math.max(1, Math.min(width - left, Math.round(frame.w * BADGE_WIDTH_RATIO * width)));
  const cropHeight = Math.max(1, Math.min(height - top, Math.round(frame.h * BADGE_HEIGHT_RATIO * height)));

  return sharp(imageBuffer).extract({ left, top, width: cropWidth, height: cropHeight }).png().toBuffer();
}
