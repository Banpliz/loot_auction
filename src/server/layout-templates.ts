// src/server/layout-templates.ts

export type Template = 'feast' | 'invasion';

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutTemplate {
  // Fraction of the full screenshot height to skip before the item list
  // starts. Both layouts repeat a fixed header (balance, mascot/banner,
  // table column labels) above the actual item list every time — without
  // this, the header eats into the first row's slice.
  contentTop: number;
  // Fraction of the full screenshot height that one row-unit occupies.
  // Row count is admin-supplied and the list never fills exactly to the
  // bottom of the screenshot (there's always trailing footer/nav content
  // below the last row), so row height must be measured directly from a
  // real screenshot rather than derived as (1 - contentTop) / rows — that
  // formula overshoots by however much footer is left over, and the error
  // compounds row by row until slices straddle two adjacent items instead
  // of containing one. Leave undefined only where this hasn't been measured
  // yet; grid-slice.ts falls back to the old (worse) per-rows division.
  rowHeight?: number;
  // colorSample/iconBox are fractions of one row-unit (not the whole
  // screenshot) — a row-unit is everything from the top of one item's row
  // (including "Аукцион вторжения"'s per-row countdown pill, if present) to
  // the top of the next one.
  colorSample: Point;
  // The item's rarity-framed icon badge (level + sprite + stack count) — used
  // as the lot's displayed image instead of the whole row screenshot, since
  // the badge alone identifies the item at a glance and neither it nor the
  // price need OCR (price isn't shown at all — players already see it in the
  // game). Leave undefined where this hasn't been measured yet;
  // screenshots.ts falls back to using the full row strip as the image.
  iconBox?: Box;
}

export const LAYOUT_TEMPLATES: Partial<Record<Template, LayoutTemplate>> = {
  feast: {
    // Measured pixel-exact from a real 1177x2560 "Пир победы" screenshot
    // (2026-08-27): row-unit (countdown pill) tops at
    // y=712/972/1231/1491/1750/2010 → contentTop=712/2560,
    // rowHeight=(2010-712)/5/2560. The old eyeballed contentTop=0.43 was
    // close by coincidence-ish but still off by several rows' worth of drift
    // by the time it reached the last row of a long list.
    contentTop: 0.278,
    rowHeight: 0.1014,
    // Sampled at the icon frame's inner-left border, clear of both the
    // corner level/material badges and the center sprite art (which can be
    // any color) — verified to classify as the item's real rarity color
    // across every row in the reference screenshot.
    colorSample: { x: 0.13, y: 0.65 },
    // The rarity-framed icon badge (level pill + sprite), left/right edges at
    // x=136/311 of 1177, top/bottom at row-offset 58/220 of a 259.5 row.
    // Measured the same way as contentTop/rowHeight above.
    iconBox: { x: 0.115, y: 0.223, w: 0.149, h: 0.626 },
  },
};

export function isTemplate(value: unknown): value is Template {
  return value === 'feast' || value === 'invasion';
}
