export const ITEM_COLORS: { value: string; label: string; hex: string }[] = [
  { value: 'blue', label: 'Синий', hex: '#3b82f6' },
  { value: 'purple', label: 'Фиолетовый', hex: '#a855f7' },
  { value: 'red', label: 'Красный', hex: '#ef4444' },
];

export function colorHex(color: string | null | undefined): string {
  return ITEM_COLORS.find((c) => c.value === color)?.hex ?? 'transparent';
}

// Feast-only win-limit dimension (gear capped at 2/person, tempering stones at 3,
// remelting stones at 1 — see winLimitGroup in src/server/routes/events.ts). Gear is
// mutually exclusive with both stone kinds; the two stone kinds aren't exclusive of each
// other. Irrelevant for invasion lots.
export const ITEM_CATEGORIES: { value: string; label: string }[] = [
  { value: 'item', label: 'Предмет' },
  { value: 'stone_temper', label: 'Закалка' },
  { value: 'stone_remelt', label: 'Переплавка' },
];

// Same value set for both a participant's class (users.class) and a lot's class
// restriction (items.class) — a claim is rejected outright when they're both set and
// don't match (see the claim handler in src/server/routes/items.ts). Empty string means
// "not set" for a participant, or "no restriction" for a lot.
export const CLASSES: { value: string; label: string }[] = [
  { value: 'tank', label: 'Танк' },
  { value: 'rogue', label: 'Рог' },
  { value: 'mage', label: 'Маг' },
  { value: 'healer', label: 'Хил' },
  { value: 'hunter', label: 'Хант' },
];
