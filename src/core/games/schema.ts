/**
 * The adapter contract every supported game implements.
 *
 * Adapters describe their editable data declaratively (FieldSpec), so the
 * UI renders the right form for any game without game-specific view code.
 * Adding support for a new game = writing one adapter, zero UI changes.
 */
import type { Rom } from '../rom'

export type FieldKind =
  | 'number' // plain numeric byte/word
  | 'type' // pokémon type id → dropdown of type names
  | 'move' // move id → dropdown of move names
  | 'select' // enumerated options
  | 'flags' // bitfield → checkbox grid (e.g. TM/HM compatibility)

export interface SelectOption {
  value: number
  label: string
}

export interface FieldSpec {
  key: string
  label: string
  kind: FieldKind
  min?: number
  max?: number
  /** For kind 'select'. */
  options?: SelectOption[]
  /** For kind 'flags': one label per bit, in bit order. */
  flagLabels?: string[]
  /** Grouping hint for the UI ("stats", "battle", "breeding", ...). */
  group?: string
  help?: string
}

export type FieldValue = number | number[] | boolean[]

export interface EntryHandle {
  /** Index used with read/write calls. */
  id: number
  /** Display label, e.g. "#001 BULBASAUR". */
  label: string
  name: string
}

export interface TableRegion {
  name: string
  offset: number
  length: number
}

export interface GameAdapter {
  /** e.g. "Pokémon FireRed (BPRE)". */
  gameName: string
  platform: string
  generation: 1 | 2 | 3
  rom: Rom

  /** Data tables that were located & verified — shown for transparency. */
  regions: TableRegion[]
  /** Anything we looked for but could not verify. */
  warnings: string[]

  /* ------------------------------------------------- Pokémon species */
  species: EntryHandle[]
  speciesFields: FieldSpec[]
  readSpecies(id: number): Record<string, FieldValue>
  writeSpeciesField(id: number, key: string, value: FieldValue): void
  /** Max name length in characters; null = names not editable. */
  speciesNameLength: number | null
  setSpeciesName(id: number, name: string): boolean
  revertSpecies(id: number): void

  /* ------------------------------------------------------------ Moves */
  moves: EntryHandle[]
  moveFields: FieldSpec[]
  readMove(id: number): Record<string, FieldValue>
  writeMoveField(id: number, key: string, value: FieldValue): void
  /** Max move-name length in characters; null = move names not editable. */
  moveNameLength: number | null
  setMoveName(id: number, name: string): boolean
  revertMove(id: number): void

  /** Type id → display name (used by 'type' fields). */
  typeOptions: SelectOption[]
}
