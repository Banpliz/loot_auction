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
  // colorSample/nameBox/priceBox are fractions of one row-unit (not the whole
  // screenshot) — a row-unit is everything from the top of one item's row
  // (including "Аукцион вторжения"'s per-row countdown pill, if present) to
  // the top of the next one.
  colorSample: Point;
  nameBox: Box;
  priceBox: Box;
}

// ponytail: fractional coordinates estimated by eye from real screenshots the
// admin sent (10x "Аукцион вторжения" + 10x "Пир победы" — see chat), not
// measured pixel-exact. The admin's review list is the safety net for
// whatever this misses; only touch these if extraction is drifting
// consistently across many uploads, not for one-off misses.
export const LAYOUT_TEMPLATES: Record<Template, LayoutTemplate> = {
  feast: {
    // Header = status bar + "Пир победы" balance bar + subtitle text + tier
    // badges row, ending where the "Посмотреть/Все" panel starts — shorter
    // than invasion's, about 6-7 rows fit below it per screenshot vs ~4.
    contentTop: 0.43,
    // Same row-unit shape as invasion (countdown pill above an item card),
    // just a bit more compact — icon frames sit slightly further left.
    colorSample: { x: 0.08, y: 0.62 },
    nameBox: { x: 0.24, y: 0.32, w: 0.3, h: 0.55 },
    priceBox: { x: 0.58, y: 0.42, w: 0.15, h: 0.35 },
  },
  invasion: {
    // Measured pixel-exact from a real 720x1565 "Аукцион вторжения"
    // screenshot (2026-08-26): row-unit clock-pill tops at y=687/852/1018/
    // 1183 → contentTop=687/1565, rowHeight=(1183-687)/3/1565. The old
    // eyeballed contentTop=0.5 combined with (1-contentTop)/rows for row
    // height put every slice about a third of a row too low and stretched
    // each one ~30px too tall, so slices straddled two items — see chat
    // 2026-08-26 for the before/after screenshots.
    contentTop: 0.439,
    rowHeight: 0.106,
    // Each row-unit = a countdown pill (top ~25%) above the item card
    // (bottom ~75%), so color/name/price all sample within that bottom band.
    colorSample: { x: 0.12, y: 0.62 },
    nameBox: { x: 0.27, y: 0.35, w: 0.3, h: 0.55 },
    // Price sits top-right of the card (coin icon + amount), well above the
    // "Ставка" button — the old box (y=0.45) was centered on the button
    // instead, which is why recognized "prices" were fragments of "Ставка".
    priceBox: { x: 0.56, y: 0.02, w: 0.26, h: 0.32 },
  },
};

export function isTemplate(value: unknown): value is Template {
  return value === 'feast' || value === 'invasion';
}
