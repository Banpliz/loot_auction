import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { detectInvasionFrames } from '../../src/server/invasion-cv';

// Matches invasion-cv.ts's PANEL_REFERENCE_COLOR and RARITY reference colors exactly —
// these tests build synthetic images the detector should recognize, not real screenshots.
const PANEL_COLOR = { r: 237, g: 224, b: 196 };
const BLUE = { r: 74, g: 144, b: 217 };
const PURPLE = { r: 156, g: 74, b: 201 };
const RED = { r: 209, g: 67, b: 78 };
const DARK_BG = { r: 10, g: 10, b: 15 };

async function buildImage(
  width: number,
  height: number,
  panel: { top: number; bottom: number } | null,
  rects: { left: number; top: number; width: number; height: number; color: { r: number; g: number; b: number } }[]
): Promise<Buffer> {
  const layers: Array<{ input: Buffer; left: number; top: number }> = [];
  if (panel) {
    layers.push({
      input: await sharp({
        create: { width, height: panel.bottom - panel.top, channels: 3, background: PANEL_COLOR },
      })
        .png()
        .toBuffer(),
      left: 0,
      top: panel.top,
    });
  }
  for (const rect of rects) {
    layers.push({
      input: await sharp({ create: { width: rect.width, height: rect.height, channels: 3, background: rect.color } })
        .png()
        .toBuffer(),
      left: rect.left,
      top: rect.top,
    });
  }
  return sharp({ create: { width, height, channels: 3, background: DARK_BG } })
    .composite(layers)
    .png()
    .toBuffer();
}

import { cropBadge, withCosmeticMargin } from '../../src/server/invasion-cv';

describe('detectInvasionFrames', () => {
  it('detects a single icon frame inside the panel', async () => {
    const image = await buildImage(100, 200, { top: 20, bottom: 180 }, [
      { left: 60, top: 100, width: 30, height: 40, color: BLUE },
    ]);
    const frames = await detectInvasionFrames(image);
    expect(frames).not.toBeNull();
    expect(frames).toHaveLength(1);
    expect(frames![0].rarity).toBe('blue');
    expect(frames![0].x).toBeCloseTo(0.6, 1);
    expect(frames![0].y).toBeCloseTo(0.5, 1);
    expect(frames![0].w).toBeCloseTo(0.3, 1);
    expect(frames![0].h).toBeCloseTo(0.2, 1);
  });

  it('detects multiple frames of different rarities, left to right', async () => {
    const image = await buildImage(150, 200, { top: 20, bottom: 180 }, [
      { left: 10, top: 50, width: 20, height: 20, color: BLUE },
      { left: 60, top: 50, width: 20, height: 20, color: PURPLE },
      { left: 110, top: 50, width: 20, height: 20, color: RED },
    ]);
    const frames = await detectInvasionFrames(image);
    expect(frames).not.toBeNull();
    expect(frames!.map((f) => f.rarity)).toEqual(['blue', 'purple', 'red']);
  });

  it('returns null when no panel-colored region is found', async () => {
    const image = await buildImage(100, 200, null, [{ left: 60, top: 100, width: 30, height: 40, color: BLUE }]);
    expect(await detectInvasionFrames(image)).toBeNull();
  });

  it('returns null when the panel exists but contains no rarity-colored frames', async () => {
    const image = await buildImage(100, 200, { top: 20, bottom: 180 }, []);
    expect(await detectInvasionFrames(image)).toBeNull();
  });

  it('ignores a rarity-colored blob too small to be a real icon', async () => {
    const image = await buildImage(100, 200, { top: 20, bottom: 180 }, [
      { left: 60, top: 100, width: 2, height: 2, color: BLUE }, // 4px, well under the noise floor
    ]);
    expect(await detectInvasionFrames(image)).toBeNull();
  });

  it('detects a realistic thin-ringed icon frame, not just a filled block', async () => {
    // A hollow ring, not a filled rectangle — every OTHER test in this file uses filled
    // shapes, which don't reproduce this bug: a ring's pixel count scales with its
    // perimeter, but the noise filter used to compare against an area that scales with
    // the whole image — at realistic resolution a thin real ring fell below it even
    // though its footprint (bounding box) didn't. Needs a bigger, more realistic image
    // than this file's other tests to actually exercise that area relationship.
    const width = 1080;
    const height = 2400;
    const panelTop = 200;
    const panelBottom = 2200;
    const iconLeft = 800;
    const iconTop = 800;
    const iconSize = 90;
    const ringThickness = 4;

    const panelLayer = await sharp({
      create: { width, height: panelBottom - panelTop, channels: 3, background: PANEL_COLOR },
    }).png().toBuffer();
    // The ring: draw the full colored square, then paint a smaller panel-colored square
    // centered on top of it to hollow out the middle — leaving only a thin colored border.
    const ringOuter = await sharp({
      create: { width: iconSize, height: iconSize, channels: 3, background: BLUE },
    }).png().toBuffer();
    const ringInner = await sharp({
      create: {
        width: iconSize - ringThickness * 2,
        height: iconSize - ringThickness * 2,
        channels: 3,
        background: PANEL_COLOR,
      },
    }).png().toBuffer();
    const ringImage = await sharp(ringOuter)
      .composite([{ input: ringInner, left: ringThickness, top: ringThickness }])
      .png()
      .toBuffer();

    const image = await sharp({ create: { width, height, channels: 3, background: DARK_BG } })
      .composite([
        { input: panelLayer, left: 0, top: panelTop },
        { input: ringImage, left: iconLeft, top: iconTop },
      ])
      .png()
      .toBuffer();

    const frames = await detectInvasionFrames(image);
    expect(frames).not.toBeNull();
    expect(frames).toHaveLength(1);
    expect(frames![0].rarity).toBe('blue');
  });

  it('drops a merged blob from two touching same-rarity frames instead of reporting it as one icon', async () => {
    // Two 20x20 blue rects touching with zero gap between them (left=10..30, left=30..50)
    // would flood-fill into one 40x20 component (2x wider than tall) without the aspect
    // guard — that's a merged pair, not one real icon, and must be dropped rather than
    // reported as a single (wrong) frame. A separate, correctly-square purple frame
    // elsewhere in the same image proves the guard only drops the bad component, not
    // the whole detection pass.
    const image = await buildImage(150, 200, { top: 20, bottom: 180 }, [
      { left: 10, top: 50, width: 20, height: 20, color: BLUE },
      { left: 30, top: 50, width: 20, height: 20, color: BLUE }, // touching the one above
      { left: 100, top: 50, width: 20, height: 20, color: PURPLE }, // separate, valid icon
    ]);
    const frames = await detectInvasionFrames(image);
    expect(frames).not.toBeNull();
    expect(frames).toHaveLength(1);
    expect(frames![0].rarity).toBe('purple');
  });
});

describe('withCosmeticMargin', () => {
  it('expands the frame symmetrically by a small ratio, clamped to the image bounds', () => {
    const frame = { x: 0.3, y: 0.4, w: 0.2, h: 0.1, rarity: 'blue' as const };
    const padded = withCosmeticMargin(frame);
    expect(padded.x).toBeLessThan(frame.x);
    expect(padded.y).toBeLessThan(frame.y);
    expect(padded.w).toBeGreaterThan(frame.w);
    expect(padded.h).toBeGreaterThan(frame.h);
    expect(padded.rarity).toBe('blue');
  });

  it('never expands past the image edge (0..1)', () => {
    const frame = { x: 0.01, y: 0.01, w: 0.1, h: 0.1, rarity: 'red' as const };
    const padded = withCosmeticMargin(frame);
    expect(padded.x).toBeGreaterThanOrEqual(0);
    expect(padded.y).toBeGreaterThanOrEqual(0);
    expect(padded.x + padded.w).toBeLessThanOrEqual(1);
    expect(padded.y + padded.h).toBeLessThanOrEqual(1);
  });
});

describe('cropBadge', () => {
  it('crops the bottom-right corner of the frame, sized relative to the frame', async () => {
    const image = await buildImage(100, 200, { top: 20, bottom: 180 }, [
      { left: 60, top: 100, width: 30, height: 40, color: BLUE },
    ]);
    const frame = { x: 0.6, y: 0.5, w: 0.3, h: 0.2, rarity: 'blue' as const };
    const crop = await cropBadge(image, frame);
    const metadata = await sharp(crop).metadata();
    // BADGE_WIDTH_RATIO=0.4, BADGE_HEIGHT_RATIO=0.3 against a 30x40px frame ->
    // round(30*0.4)=12, round(40*0.3)=12.
    expect(metadata.width).toBe(12);
    expect(metadata.height).toBe(12);
  });

  it('never crops past the image edge for a frame flush against a corner', async () => {
    const image = await buildImage(100, 200, { top: 20, bottom: 180 }, [
      { left: 90, top: 160, width: 10, height: 20, color: RED },
    ]);
    const frame = { x: 0.9, y: 0.8, w: 0.1, h: 0.1, rarity: 'red' as const };
    const crop = await cropBadge(image, frame);
    const metadata = await sharp(crop).metadata();
    expect(metadata.width).toBeGreaterThan(0);
    expect(metadata.height).toBeGreaterThan(0);
  });
});
