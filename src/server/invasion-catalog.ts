// Curated from real "Трофеи вторжения" screenshots (2026-09-06) — every distinct reward
// icon the alliance has actually seen drop, deduplicated by hand since the game gives
// these no names of their own. Two purple chest entries on purpose: a kill commonly drops
// two independently-countable stacks of the same purple chest, not one.
export interface InvasionCatalogEntry {
  slug: string;
  color: 'blue' | 'purple' | 'red';
}

export const INVASION_CATALOG: InvasionCatalogEntry[] = [
  { slug: 'gorilla-blue', color: 'blue' },
  { slug: 'yellow-turtle', color: 'purple' },
  { slug: 'green-beast', color: 'purple' },
  { slug: 'orange-beast', color: 'purple' },
  { slug: 'teal-seal-uniq', color: 'purple' },
  { slug: 'brown-horse-uniq', color: 'purple' },
  { slug: 'green-dragon-uniq', color: 'purple' },
  { slug: 'brown-horse-plain', color: 'purple' },
  { slug: 'white-bear-uniq', color: 'purple' },
  { slug: 'swirl-uniq', color: 'blue' },
  { slug: 'mask-uniq', color: 'blue' },
  { slug: 'chest-purple-1', color: 'purple' },
  { slug: 'chest-purple-2', color: 'purple' },
  { slug: 'chest-blue-1', color: 'blue' },
];
