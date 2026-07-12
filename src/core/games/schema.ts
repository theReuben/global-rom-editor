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
  generation: 1 | 2 | 3 | 4 | 5
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

  /** Map/scene editing, when supported for this game (null = not yet). */
  mapModule: MapModule | null
  /** Trainer editing, when supported for this game (null = not yet). */
  trainerModule: TrainerModule | null
  /** Evolution editing (null = not supported / not found). */
  evolutions: EvolutionModule | null
  /** Level-up learnset editing (null = not supported / not found). */
  learnsets: LearnsetModule | null
  /** Type effectiveness chart editing (null = not supported / not found). */
  typeChart: TypeChartModule | null
  /** Wild encounter editing, when supported for this game (null = not yet). */
  wildModule: WildModule | null
  /** Item id → name options, when item names could be read from the ROM. */
  itemOptions: SelectOption[] | null
  /** Front sprite renderer, when the sprite tables were found. */
  speciesSprite: ((id: number, shiny?: boolean) => RenderedImage | null) | null
  /** Back sprite renderer (null = table not found for this game). */
  speciesSpriteBack: ((id: number, shiny?: boolean) => RenderedImage | null) | null
  /** True when a shiny palette exists (sprite renderers accept shiny). */
  hasShinySprites: boolean
  /**
   * Replace a species' front sprite (64×64, ≤16 colors). Returns an
   * error message or null on success. Null when importing isn't
   * supported for this game. Front and back share one palette, so the
   * most recent import defines the colors for both.
   */
  importSpeciesSprite: ((id: number, image: RenderedImage) => string | null) | null
  importSpeciesSpriteBack: ((id: number, image: RenderedImage) => string | null) | null
}

/* -------------------------------------------------------------- trainers */

export interface PartyMon {
  species: number
  level: number
  /** IV strength 0-255 (scales all IVs); null when the game has none. */
  iv: number | null
  /** Held item id; null when this trainer's party has no item slots. */
  item: number | null
  /** Four move ids; null when the party uses default level-up moves. */
  moves: number[] | null
}

/** Which trainer sections the UI should show; missing keys default to true. */
export interface TrainerFeatures {
  /** Class / sprite / gender / music / battle-type fields. */
  identity?: boolean
  ai?: boolean
  items?: boolean
  partySize?: boolean
}

export interface TrainerData {
  name: string
  trainerClass: number
  pic: number
  music: number
  gender: number
  doubleBattle: number
  aiFlags: number
  items: number[]
  partySize: number
  /** Largest party size that fits the original allocation. */
  maxPartySize: number
}

export interface TrainerModule {
  entries: EntryHandle[]
  nameLength: number
  /** Shown instead of the name editor when nameLength is 0. */
  nameHint?: string
  /** Section visibility for the UI; omitted = show everything. */
  features?: TrainerFeatures
  /** Class id → name, when class names could be read from the ROM. */
  classOptions: SelectOption[] | null
  read(id: number): TrainerData
  write(id: number, field: string, value: number): void
  setName(id: number, name: string): boolean
  setItem(id: number, slot: number, item: number): void
  party(id: number): PartyMon[]
  writePartyField(id: number, slot: number, field: string, value: number): void
  revert(id: number): void
}

/* ----------------------------------------- evolutions / learnsets / types */

export interface EvolutionEntry {
  method: number
  param: number
  target: number
}

export interface EvolutionModule {
  methods: SelectOption[]
  /**
   * Methods whose param is an item id (shown as an item dropdown when
   * itemOptions exist). Defaults to Gen 3's use-item/trade-item pair.
   */
  itemParamMethods?: number[]
  read(id: number): EvolutionEntry[]
  write(id: number, slot: number, field: string, value: number): void
  revert(id: number): void
}

export interface LearnsetEntry {
  level: number
  move: number
}

export interface LearnsetModule {
  read(id: number): LearnsetEntry[]
  /** Replace the whole list; relocates to free space when it grows. */
  write(id: number, entries: LearnsetEntry[]): boolean
}

export interface TypeChartEntry {
  attacker: number
  defender: number
  /** Damage ×10: 0 = immune, 5 = ½×, 20 = 2×. */
  multiplier: number
  offset: number
}

export interface TypeChartModule {
  entries(): TypeChartEntry[]
  setMultiplier(index: number, multiplier: number): void
  addEntry(attacker: number, defender: number, multiplier: number): boolean
  removeEntry(index: number): boolean
}

/* ------------------------------------------------------- wild encounters */

export interface WildSlot {
  minLevel: number
  maxLevel: number
  species: number
}

export interface WildGroup {
  name: string
  rate: number
  slots: WildSlot[]
}

export interface WildModule {
  /** Maps that have wild encounter data, keyed like MapModule ("bank.map"). */
  entries: { key: string; label: string }[]
  groups(key: string): WildGroup[]
  setRate(key: string, group: number, rate: number): void
  setSlot(key: string, group: number, slot: number, field: string, value: number): void
  revert(key: string): void
}

/* ------------------------------------------------------------------ maps */

export interface MapEntry {
  key: string
  bank: number
  map: number
  label: string
}

export interface RenderedImage {
  pixels: Uint8ClampedArray
  width: number
  height: number
}

export interface CellInfo {
  blockId: number
  /** Movement permission bits (collision/elevation), 0–63. */
  permission: number
}

export interface NpcEvent {
  x: number
  y: number
  elevation: number
  graphicsId: number
  movementType: number
}

export interface WarpEvent {
  x: number
  y: number
  elevation: number
  warpId: number
  targetMap: number
  targetBank: number
}

export interface SignEvent {
  x: number
  y: number
  elevation: number
  kind: number
}

export interface MapEvents {
  npcs: NpcEvent[]
  warps: WarpEvent[]
  signs: SignEvent[]
}

export type EventKind = 'npc' | 'warp' | 'sign'

export type ScriptStep =
  | { kind: 'message'; text: string }
  | { kind: 'giveItem'; item: number; quantity: number }
  | { kind: 'givePokemon'; species: number; level: number }
  | { kind: 'setFlag'; flag: number }
  | { kind: 'clearFlag'; flag: number }
  /** Ask a yes/no question; if the player answers No, the script ends. */
  | { kind: 'yesNo'; question: string }
  /** Single trainer battle with intro / defeat dialogue. */
  | { kind: 'trainerBattle'; trainerId: number; intro: string; defeat: string }

export interface MapModule {
  entries: MapEntry[]
  describe(key: string): { widthBlocks: number; heightBlocks: number; blockCount: number }
  /** Render the full map to RGBA (16px per block). */
  render(key: string): RenderedImage
  /** Render the block picker strip. */
  renderBlocks(key: string, perRow: number): RenderedImage & { perRow: number; count: number }
  cell(key: string, x: number, y: number): CellInfo
  /** Paint a block; movement permission bits are preserved. */
  paint(key: string, x: number, y: number, blockId: number): void
  setPermission(key: string, x: number, y: number, permission: number): void
  events(key: string): MapEvents
  updateEvent(key: string, kind: EventKind, index: number, field: string, value: number): void
  /**
   * Resize the map, keeping the overlapping area. The new block grid is
   * placed in free space and the layout repointed. False = no space.
   */
  resize(key: string, width: number, height: number): boolean
  /**
   * Create a brand-new map in the same bank by duplicating this one
   * (terrain, tilesets and settings; no events). Returns the new map's
   * key, or null if there was no free space.
   */
  duplicateMap(key: string): string | null
  /** Append a new blank NPC/warp/sign (relocates the event array). */
  addEvent(key: string, kind: EventKind): boolean
  /** Remove an event, shifting the rest down (in place). */
  removeEvent(key: string, kind: EventKind, index: number): void
  /**
   * Compile steps to script bytecode in free space and attach it to an
   * NPC (talk script) or sign. False = encoding failed or no space.
   */
  attachScript(key: string, kind: 'npc' | 'sign', index: number, steps: ScriptStep[]): boolean
  /** Revert all block-grid edits on this map. */
  revertBlocks(key: string): void
}
