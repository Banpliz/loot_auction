export const ITEM_COLORS: { value: string; label: string; hex: string }[] = [
  { value: 'blue', label: 'Синий', hex: '#3b82f6' },
  { value: 'purple', label: 'Фиолетовый', hex: '#a855f7' },
  { value: 'red', label: 'Красный', hex: '#ef4444' },
];

export function colorHex(color: string | null | undefined): string {
  return ITEM_COLORS.find((c) => c.value === color)?.hex ?? 'transparent';
}
