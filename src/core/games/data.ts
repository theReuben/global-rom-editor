import type { SelectOption } from './schema'

/** Type ids differ per generation; these are the canonical in-ROM values. */
export const GEN1_TYPES: SelectOption[] = [
  { value: 0x00, label: 'Normal' },
  { value: 0x01, label: 'Fighting' },
  { value: 0x02, label: 'Flying' },
  { value: 0x03, label: 'Poison' },
  { value: 0x04, label: 'Ground' },
  { value: 0x05, label: 'Rock' },
  { value: 0x07, label: 'Bug' },
  { value: 0x08, label: 'Ghost' },
  { value: 0x14, label: 'Fire' },
  { value: 0x15, label: 'Water' },
  { value: 0x16, label: 'Grass' },
  { value: 0x17, label: 'Electric' },
  { value: 0x18, label: 'Psychic' },
  { value: 0x19, label: 'Ice' },
  { value: 0x1a, label: 'Dragon' },
]

export const GEN2_TYPES: SelectOption[] = [
  ...GEN1_TYPES,
  { value: 0x09, label: 'Steel' },
  { value: 0x1b, label: 'Dark' },
].sort((a, b) => a.value - b.value)

export const GEN3_TYPES: SelectOption[] = [
  { value: 0, label: 'Normal' },
  { value: 1, label: 'Fighting' },
  { value: 2, label: 'Flying' },
  { value: 3, label: 'Poison' },
  { value: 4, label: 'Ground' },
  { value: 5, label: 'Rock' },
  { value: 6, label: 'Bug' },
  { value: 7, label: 'Ghost' },
  { value: 8, label: 'Steel' },
  { value: 9, label: '??? (Mystery)' },
  { value: 10, label: 'Fire' },
  { value: 11, label: 'Water' },
  { value: 12, label: 'Grass' },
  { value: 13, label: 'Electric' },
  { value: 14, label: 'Psychic' },
  { value: 15, label: 'Ice' },
  { value: 16, label: 'Dragon' },
  { value: 17, label: 'Dark' },
]

export const GEN12_GROWTH: SelectOption[] = [
  { value: 0, label: 'Medium Fast' },
  { value: 3, label: 'Medium Slow' },
  { value: 4, label: 'Fast' },
  { value: 5, label: 'Slow' },
]

export const GEN3_GROWTH: SelectOption[] = [
  { value: 0, label: 'Medium Fast' },
  { value: 1, label: 'Erratic' },
  { value: 2, label: 'Fluctuating' },
  { value: 3, label: 'Medium Slow' },
  { value: 4, label: 'Fast' },
  { value: 5, label: 'Slow' },
]

export const EGG_GROUPS: SelectOption[] = [
  { value: 1, label: 'Monster' },
  { value: 2, label: 'Water 1' },
  { value: 3, label: 'Bug' },
  { value: 4, label: 'Flying' },
  { value: 5, label: 'Field' },
  { value: 6, label: 'Fairy' },
  { value: 7, label: 'Grass' },
  { value: 8, label: 'Human-Like' },
  { value: 9, label: 'Water 3' },
  { value: 10, label: 'Mineral' },
  { value: 11, label: 'Amorphous' },
  { value: 12, label: 'Water 2' },
  { value: 13, label: 'Ditto' },
  { value: 15, label: 'Undiscovered' },
]

export const GENDER_RATIOS: SelectOption[] = [
  { value: 0, label: 'Always male' },
  { value: 31, label: '87.5% male' },
  { value: 63, label: '75% male' },
  { value: 127, label: '50% / 50%' },
  { value: 191, label: '75% female' },
  { value: 223, label: '87.5% female' },
  { value: 254, label: 'Always female' },
  { value: 255, label: 'Genderless' },
]

export function padDex(n: number): string {
  return `#${String(n).padStart(3, '0')}`
}
