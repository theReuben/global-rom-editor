/**
 * Adapter for pokeemerald-expansion (and the hacks built on it).
 *
 * These ROMs keep vanilla Gen 3's *container* — same GBA header, same
 * map/encounter structures — but replace the per-species and per-move
 * data with far richer structs, so `gen3.ts` finds none of its anchors
 * and the editor used to reject the ROM outright. Rather than teach the
 * vanilla adapter two layouts, this is a separate module: the two
 * formats share almost no field offsets, and conflating them is how you
 * end up silently writing a catch rate over an EV yield.
 *
 * Everything structural lives in `core/gba/expansion.ts`; this file is
 * the declarative surface the UI renders. Modules whose format the
 * expansion changed and that are NOT yet decoded stay null with a
 * warning, per invariant 1 — never a guess.
 */
import { Rom } from '../rom'
import { gen3Codec } from '../text'
import { findFreeSpaceAtEnd, readGbaPointer, writeGbaPointer } from '../freespace'
import { buildGen3MapModule } from '../gba/maps'
import { discoverMaps } from '../gba/mapscan'
import { buildExpansionTrainers } from '../gba/expansion-trainers'
import { buildExpansionItems, ITEM_ENTRY } from '../gba/expansion-items'
import { buildWildModule } from '../gba/wild'
import {
  EVOLUTION_ENTRY,
  LEVEL_UP_MOVE_END,
  MOVE_UNAVAILABLE,
  MV,
  PTR_BLOCK,
  SP,
  SPECIES_NAME_LEN,
  buildExpansionSprites,
  buildExpansionWildModule,
  spritesDecodable,
  findAbilityNames,
  findItemNames,
  findMoveTable,
  findSpeciesTable,
  scanExpansion,
  findTypeNames,
  parseEvolutions,
  parseLevelUpLearnset,
  parseMoveList,
  readText,
  writePointerText,
  type SpeciesTable,
} from '../gba/expansion'
import { EGG_GROUPS, GEN3_GROWTH, GENDER_RATIOS } from './data'
import type {
  EggMoveModule,
  EntryHandle,
  EvolutionModule,
  FieldSpec,
  FieldValue,
  GameAdapter,
  ItemModule,
  LearnsetEntry,
  LearnsetModule,
  MapModule,
  SelectOption,
  TableRegion,
  TrainerModule,
  WildModule,
} from './schema'

/**
 * `enum EvolutionMode`'s companion — the expansion collapsed vanilla's
 * ~40 evolution methods into nine, moving the extra conditions into a
 * separate `params` array that this editor preserves but does not edit.
 */
const EVO_METHODS: SelectOption[] = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Level up' },
  { value: 2, label: 'Trade' },
  { value: 3, label: 'Use item' },
  { value: 4, label: 'Split from evolution' },
  { value: 5, label: 'Script trigger' },
  { value: 6, label: 'Level up (in battle)' },
  { value: 7, label: 'Battle end' },
  { value: 8, label: 'Spin in the overworld' },
]
/** Methods whose `param` is an item id, for the item dropdown. */
const EVO_ITEM_METHODS = [3]

/**
 * `MOVE_NAME_LENGTH` in the expansion. Move names sit behind a pointer,
 * so nothing in the ROM bounds them — but the game copies them into a
 * fixed buffer, so a longer name would overflow it in-game.
 */
const MOVE_NAME_MAX = 16

const MOVE_CATEGORIES: SelectOption[] = [
  { value: 0, label: 'Physical' },
  { value: 1, label: 'Special' },
  { value: 2, label: 'Status' },
]

const STAT_BYTES: Record<string, number> = {
  hp: SP.hp,
  atk: SP.atk,
  def: SP.def,
  spd: SP.spd,
  sat: SP.sat,
  sdf: SP.sdf,
  type1: SP.type1,
  type2: SP.type2,
  catchRate: SP.catchRate,
  forceTeraType: SP.forceTeraType,
  gender: SP.genderRatio,
  eggCycles: SP.eggCycles,
  friendship: SP.friendship,
  growthRate: SP.growthRate,
  eggGroup1: SP.eggGroup1,
  eggGroup2: SP.eggGroup2,
  safariFleeRate: SP.safariFleeRate,
}
/** u16 fields, read/written whole. */
const STAT_WORDS: Record<string, number> = {
  // expYield is the one field the expansion widened from a vanilla u8.
  expYield: SP.expYield,
  item1: SP.itemCommon,
  item2: SP.itemRare,
  ability1: SP.abilities,
  ability2: SP.abilities + 2,
  abilityHidden: SP.abilities + 4,
}
const EV_STATS: [string, number][] = [
  ['evHp', 0],
  ['evAtk', 1],
  ['evDef', 2],
  ['evSpd', 3],
  ['evSat', 4],
  ['evSdf', 5],
]

export function tryBuildGen3Expansion(rom: Rom, gameName: string, platform: string): GameAdapter | null {
  const bytes = rom.bytes
  // One sweep locates every name-anchored table; see `scanExpansion`.
  const scan = scanExpansion(bytes)
  const table = findSpeciesTable(bytes, scan)
  if (table === null) return null

  const warnings: string[] = []
  const regions: TableRegion[] = []
  const SPECIES_COUNT = table.count
  regions.push({
    name: `Species info (${SPECIES_COUNT}, ${table.stride}-byte entries)`,
    offset: table.base,
    length: (SPECIES_COUNT + 1) * table.stride,
  })

  const moveTable = findMoveTable(bytes, scan)
  const MOVE_COUNT = moveTable?.count ?? 0
  if (moveTable === null) {
    warnings.push("Couldn't locate the expansion move table — move editing is disabled.")
  } else {
    regions.push({
      name: `Move info (${MOVE_COUNT}, ${moveTable.stride}-byte entries)`,
      offset: moveTable.base,
      length: (MOVE_COUNT + 1) * moveTable.stride,
    })
  }

  const types = findTypeNames(bytes, scan)
  const typeOptions: SelectOption[] = types
    ? types.names.map((label, value) => ({ value, label: label || `Type #${value}` }))
    : Array.from({ length: 21 }, (_, value) => ({ value, label: `Type #${value}` }))
  if (types) regions.push({ name: 'Type names', offset: types.table.base, length: types.names.length * types.table.stride })
  else warnings.push("Couldn't read the type names — types are shown as numbers.")

  const abilities = findAbilityNames(bytes, scan)
  const abilityOptions: SelectOption[] = abilities
    ? abilities.names.map((label, value) => ({ value, label: value === 0 ? '— none —' : label || `Ability #${value}` }))
    : Array.from({ length: 256 }, (_, value) => ({ value, label: value === 0 ? '— none —' : `Ability #${value}` }))
  if (abilities) {
    regions.push({ name: 'Ability names', offset: abilities.table.base, length: abilities.names.length * abilities.table.stride })
  }

  // Items: the same table `findItemNames` located, now decoded in full.
  const itemNames = findItemNames(bytes, scan)
  let itemModule: ItemModule | null = null
  let itemOptions: SelectOption[] | null = null
  if (itemNames && itemNames.table.stride === ITEM_ENTRY) {
    const items = buildExpansionItems(rom, { offset: itemNames.table.base, count: itemNames.names.length })
    itemModule = items.module
    itemOptions = items.options
    regions.push({ name: `Item data (${items.count})`, offset: items.offset, length: items.count * ITEM_ENTRY })
  } else if (itemNames) {
    itemOptions = itemNames.names.map((label, value) => ({ value, label: value === 0 ? '— none —' : label || `Item #${value}` }))
    warnings.push("The item table has an unexpected entry size — item names are shown but item editing is disabled.")
  }

  /* --------------------------------------------------- helpers */

  const entry = (id: number) => table.base + id * table.stride
  const speciesName = (id: number): string =>
    gen3Codec.decode(bytes.subarray(entry(id) + SP.speciesName, entry(id) + SP.speciesName + SPECIES_NAME_LEN))
  const moveName = (id: number): string => {
    if (moveTable === null) return `Move #${id}`
    const p = readGbaPointer(bytes, moveTable.base + id * moveTable.stride + MV.name)
    return p === null ? `Move #${id}` : readText(bytes, p, 32) || `Move #${id}`
  }

  /* ------------------------------------- per-species blob writes */

  /**
   * Rewrite a blob a single species points at. Growing blobs go to
   * fresh space and only THIS species is repointed — forms and
   * regional variants routinely share one learnset, and dragging them
   * along would silently edit Pokémon the user never selected.
   */
  const writeSpeciesBlob = (ptrField: number, blob: Uint8Array, oldLength: number): boolean => {
    const target = readGbaPointer(bytes, ptrField)
    if (target !== null && blob.length <= oldLength) {
      rom.writeBytes(target, blob)
      return true
    }
    const dest = findFreeSpaceAtEnd(bytes, blob.length)
    if (dest === null) return false
    rom.writeBytes(dest, blob)
    writeGbaPointer(rom, ptrField, dest)
    return true
  }

  const ptr = table.pointerBlock
  const blobPtr = (id: number, which: number): number | null =>
    ptr === null ? null : entry(id) + ptr + which

  /* ----------------------------------------------- learnsets */

  let learnsets: LearnsetModule | null = null
  if (ptr !== null) {
    learnsets = {
      read(id) {
        const field = blobPtr(id, PTR_BLOCK.levelUpLearnset)
        if (field === null) return []
        const p = readGbaPointer(bytes, field)
        if (p === null) return []
        return (parseLevelUpLearnset(bytes, p) ?? []).map((e) => ({ level: e.level, move: e.move }))
      },
      write(id, entries: LearnsetEntry[]) {
        const field = blobPtr(id, PTR_BLOCK.levelUpLearnset)
        if (field === null) return false
        const p = readGbaPointer(bytes, field)
        const old = p === null ? null : parseLevelUpLearnset(bytes, p)
        if (old === null) return false
        const blob = new Uint8Array((entries.length + 1) * 4)
        entries.forEach((e, i) => {
          blob[i * 4] = e.move & 0xff
          blob[i * 4 + 1] = (e.move >> 8) & 0xff
          blob[i * 4 + 2] = e.level & 0xff
          blob[i * 4 + 3] = (e.level >> 8) & 0xff
        })
        blob[entries.length * 4] = LEVEL_UP_MOVE_END & 0xff
        blob[entries.length * 4 + 1] = LEVEL_UP_MOVE_END >> 8
        return writeSpeciesBlob(field, blob, (old.length + 1) * 4)
      },
    }
    regions.push({
      name: `Learnset/evolution pointers (species struct +${ptr}, per species)`,
      offset: table.base + ptr + PTR_BLOCK.levelUpLearnset,
      length: 16,
    })
  } else {
    warnings.push(
      "Couldn't locate the learnset/evolution pointers inside the species struct — " +
        'learnset, egg move and evolution editing are disabled for this ROM.',
    )
  }

  /* ----------------------------------------------- egg moves */

  let eggMoves: EggMoveModule | null = null
  if (ptr !== null) {
    const readEgg = (id: number): number[] => {
      const field = blobPtr(id, PTR_BLOCK.eggMoveLearnset)
      if (field === null) return []
      const p = readGbaPointer(bytes, field)
      if (p === null) return []
      return parseMoveList(bytes, p, MOVE_COUNT || 0xffff) ?? []
    }
    eggMoves = {
      maxMoves: 32,
      read: readEgg,
      write(id, moves) {
        const field = blobPtr(id, PTR_BLOCK.eggMoveLearnset)
        if (field === null) return false
        const old = readEgg(id)
        const blob = new Uint8Array((moves.length + 1) * 2)
        moves.forEach((m, i) => {
          blob[i * 2] = m & 0xff
          blob[i * 2 + 1] = (m >> 8) & 0xff
        })
        blob[moves.length * 2] = MOVE_UNAVAILABLE & 0xff
        blob[moves.length * 2 + 1] = MOVE_UNAVAILABLE >> 8
        return writeSpeciesBlob(field, blob, (old.length + 1) * 2)
      },
      species() {
        const out: number[] = []
        for (let id = 1; id <= SPECIES_COUNT; id++) {
          const field = blobPtr(id, PTR_BLOCK.eggMoveLearnset)
          if (field !== null && readGbaPointer(bytes, field) !== null && readEgg(id).length > 0) out.push(id)
        }
        return out
      },
    }
  }

  /* ---------------------------------------------- evolutions */

  let evolutions: EvolutionModule | null = null
  if (ptr !== null) {
    evolutions = {
      methods: EVO_METHODS,
      itemParamMethods: EVO_ITEM_METHODS,
      read(id) {
        const field = blobPtr(id, PTR_BLOCK.evolutions)
        if (field === null) return []
        const p = readGbaPointer(bytes, field)
        if (p === null) return []
        return (parseEvolutions(bytes, p, SPECIES_COUNT) ?? []).map((e) => ({
          method: e.method,
          param: e.param,
          target: e.target,
        }))
      },
      write(id, slot, field, value) {
        const pf = blobPtr(id, PTR_BLOCK.evolutions)
        if (pf === null) return
        const p = readGbaPointer(bytes, pf)
        if (p === null) return
        const existing = parseEvolutions(bytes, p, SPECIES_COUNT)
        // Editing beyond the terminator would need to grow the blob and
        // its parallel `params` array, so only real entries are writable.
        if (existing === null || slot >= existing.length) return
        const at = p + slot * EVOLUTION_ENTRY
        const off = field === 'method' ? 0 : field === 'param' ? 2 : field === 'target' ? 4 : -1
        if (off < 0) return
        rom.writeU16LE(at + off, value)
      },
      revert(id) {
        const pf = blobPtr(id, PTR_BLOCK.evolutions)
        if (pf === null) return
        const p = readGbaPointer(bytes, pf)
        if (p === null) return
        const existing = parseEvolutions(bytes, p, SPECIES_COUNT)
        if (existing !== null) rom.revertRange(p, (existing.length + 1) * EVOLUTION_ENTRY)
      },
    }
  }

  /* --------------------------------------- maps / wild encounters */

  /**
   * Maps. Now that `smol` decodes, expansion tilesets render like any
   * vanilla ones, so this is the ordinary path again — no relaxed
   * pre-pass. If discovery still fails, the map index is re-derived
   * with the codec check relaxed purely so wild encounters (which are
   * uncompressed) keep their map-key cross-check.
   */
  let mapModule: MapModule | null = null
  let mapKeys: Set<string> | null = null
  try {
    const gameCode = String.fromCharCode(...bytes.subarray(0xac, 0xb0)).replace(/[^ -~]/g, '')
    const maps = buildGen3MapModule(rom, gameCode)
    if (maps) {
      mapModule = maps.module
      mapKeys = new Set(maps.module.entries.map((e) => e.key))
      regions.push({
        name: `Map bank table (${maps.index.banks.length} banks, ${maps.module.entries.length} maps)`,
        offset: maps.index.bankTableOffset,
        length: maps.index.banks.length * 4,
      })
    }
  } catch {
    mapModule = null
  }
  if (!mapModule) {
    warnings.push("Couldn't verify the map data structures — map editing is disabled for this ROM.")
    try {
      const index = discoverMaps(bytes, { anyGraphicsCodec: true })
      if (index) {
        mapKeys = new Set()
        index.banks.forEach((maps, bank) => maps.forEach((_, map) => mapKeys!.add(`${bank}.${map}`)))
      }
    } catch {
      mapKeys = null
    }
  }

  let wildModule: WildModule | null = null
  try {
    if (mapKeys) {
      // The expansion's time-of-day header first, since that is what
      // these ROMs normally carry; a hack that kept vanilla's flat
      // 20-byte header still works through the vanilla scanner.
      const wild = buildExpansionWildModule(rom, mapKeys, SPECIES_COUNT)
      if (wild) {
        wildModule = wild.module
        regions.push({
          name:
            `Wild encounters (${wild.module.entries.length} maps, ` +
            `${wild.table.timesOfDay} time${wild.table.timesOfDay === 1 ? '' : 's'} of day)`,
          offset: wild.table.offset,
          length: wild.table.count * wild.table.headerSize,
        })
      } else {
        const vanilla = buildWildModule(rom, mapKeys)
        if (vanilla) {
          wildModule = vanilla.module
          regions.push({
            name: `Wild encounters (${vanilla.module.entries.length} maps)`,
            offset: vanilla.offset,
            length: vanilla.count * 20,
          })
        }
      }
    }
  } catch {
    wildModule = null
  }
  if (!wildModule) warnings.push("Couldn't verify wild encounter tables — wild editing is disabled for this ROM.")

  let trainerModule: TrainerModule | null = null
  try {
    const trainers = buildExpansionTrainers(rom, SPECIES_COUNT, MOVE_COUNT)
    if (trainers) {
      trainerModule = trainers.module
      regions.push({
        name: `Trainers (${trainers.count})`,
        offset: trainers.offset,
        length: trainers.count * 52,
      })
    }
  } catch {
    trainerModule = null
  }
  if (!trainerModule) {
    warnings.push("Couldn't verify the trainer table — trainer editing is disabled for this ROM.")
  } else {
    warnings.push(
      'Trainer Pokémon IVs are not editable: the expansion stores six 5-bit IVs per mon, which the single ' +
        '“IV strength” control cannot represent without flattening the spread. Everything else on a party ' +
        'member — species, level, held item and moves — is editable.',
    )
  }

  // Both LZ77 and the expansion's `smol` codec decode here; anything
  // else leaves the tab off rather than rendering noise.
  const sprites = spritesDecodable(bytes, table) ? buildExpansionSprites(rom, table) : null
  if (!sprites) {
    warnings.push(
      "This ROM's Pokémon graphics use a compression this editor doesn't recognise " +
        '(neither LZ77 nor the expansion\'s `smol`), so sprite viewing and importing are disabled.',
    )
  }

  /* ------------------------------------------------ field specs */

  const evOptions: SelectOption[] = [0, 1, 2, 3].map((v) => ({ value: v, label: String(v) }))
  const itemField = (key: string, label: string, help: string): FieldSpec =>
    itemOptions
      ? { key, label, kind: 'select', options: itemOptions, group: 'battle', help }
      : { key, label, kind: 'number', min: 0, max: 65535, group: 'battle', help: `Item ID (0 = none). ${help}` }

  const speciesFields: FieldSpec[] = [
    { key: 'hp', label: 'HP', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'atk', label: 'Attack', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'def', label: 'Defense', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'spd', label: 'Speed', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'sat', label: 'Sp. Attack', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'sdf', label: 'Sp. Defense', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'type1', label: 'Type 1', kind: 'type', group: 'typing' },
    { key: 'type2', label: 'Type 2', kind: 'type', group: 'typing', help: 'Set both types the same for a mono-type Pokémon.' },
    { key: 'ability1', label: 'Ability 1', kind: 'select', options: abilityOptions, group: 'typing' },
    { key: 'ability2', label: 'Ability 2', kind: 'select', options: abilityOptions, group: 'typing' },
    { key: 'abilityHidden', label: 'Hidden ability', kind: 'select', options: abilityOptions, group: 'typing' },
    { key: 'catchRate', label: 'Catch rate', kind: 'number', min: 1, max: 255, group: 'battle' },
    {
      key: 'expYield',
      label: 'Base EXP yield',
      kind: 'number',
      min: 0,
      max: 65535,
      group: 'battle',
      help: 'The expansion widened this to 16 bits.',
    },
    { key: 'growthRate', label: 'Level curve', kind: 'select', options: GEN3_GROWTH, group: 'battle' },
    { key: 'forceTeraType', label: 'Forced Tera type', kind: 'type', group: 'battle', help: '0 = derived from the species.' },
    itemField('item1', 'Wild held item 1', '50% chance in the wild.'),
    itemField('item2', 'Wild held item 2', '5% chance in the wild.'),
    { key: 'evHp', label: 'EV yield: HP', kind: 'select', options: evOptions, group: 'evs' },
    { key: 'evAtk', label: 'EV yield: Attack', kind: 'select', options: evOptions, group: 'evs' },
    { key: 'evDef', label: 'EV yield: Defense', kind: 'select', options: evOptions, group: 'evs' },
    { key: 'evSpd', label: 'EV yield: Speed', kind: 'select', options: evOptions, group: 'evs' },
    { key: 'evSat', label: 'EV yield: Sp. Atk', kind: 'select', options: evOptions, group: 'evs' },
    { key: 'evSdf', label: 'EV yield: Sp. Def', kind: 'select', options: evOptions, group: 'evs' },
    { key: 'gender', label: 'Gender ratio', kind: 'select', options: GENDER_RATIOS, group: 'breeding' },
    { key: 'eggCycles', label: 'Egg cycles', kind: 'number', min: 1, max: 255, group: 'breeding', help: 'Steps to hatch = cycles × 256.' },
    { key: 'friendship', label: 'Base friendship', kind: 'number', min: 0, max: 255, group: 'breeding' },
    { key: 'eggGroup1', label: 'Egg group 1', kind: 'select', options: EGG_GROUPS, group: 'breeding' },
    { key: 'eggGroup2', label: 'Egg group 2', kind: 'select', options: EGG_GROUPS, group: 'breeding' },
    { key: 'safariFleeRate', label: 'Safari flee rate', kind: 'number', min: 0, max: 255, group: 'breeding' },
  ]

  const moveFields: FieldSpec[] = [
    { key: 'power', label: 'Power', kind: 'number', min: 0, max: 511, help: 'The expansion widened this to 9 bits.' },
    { key: 'type', label: 'Type', kind: 'type' },
    { key: 'category', label: 'Category', kind: 'select', options: MOVE_CATEGORIES, help: 'The physical/special split is per move, not per type.' },
    { key: 'accuracy', label: 'Accuracy', kind: 'number', min: 0, max: 100, help: 'Percentage (0 = never misses).' },
    { key: 'pp', label: 'PP', kind: 'number', min: 0, max: 64 },
    { key: 'priority', label: 'Priority', kind: 'number', min: -8, max: 7, help: 'Higher acts first (Quick Attack = +1).' },
    { key: 'effect', label: 'Effect ID', kind: 'number', min: 0, max: 65535, help: 'Battle effect index.' },
    { key: 'target', label: 'Target', kind: 'number', min: 0, max: 511, help: 'Raw MOVE_TARGET bitfield.' },
  ]

  /* ------------------------------------------------- handles */

  const species: EntryHandle[] = []
  for (let id = 1; id <= SPECIES_COUNT; id++) {
    const name = speciesName(id)
    species.push({ id, label: `#${String(id).padStart(4, '0')} ${name || '(blank)'}`, name })
  }
  const moves: EntryHandle[] =
    moveTable === null
      ? []
      : Array.from({ length: MOVE_COUNT }, (_, i) => {
          const name = moveName(i + 1)
          return { id: i + 1, label: `${String(i + 1).padStart(3, '0')} ${name}`, name }
        })

  const refreshSpecies = (id: number) => {
    const h = species[id - 1]
    h.name = speciesName(id)
    h.label = `#${String(id).padStart(4, '0')} ${h.name || '(blank)'}`
  }
  const refreshMove = (id: number) => {
    const h = moves[id - 1]
    if (!h) return
    h.name = moveName(id)
    h.label = `${String(id).padStart(3, '0')} ${h.name}`
  }
  const moveBase = (id: number) => moveTable!.base + id * moveTable!.stride

  return {
    gameName: `${gameName} — pokeemerald-expansion`,
    platform,
    generation: 3,
    rom,
    regions,
    warnings,
    species,
    speciesFields,
    typeOptions,
    mapModule,
    trainerModule,
    wildModule,
    itemOptions,
    itemModule,
    typeChart: null,
    evolutions,
    learnsets,
    eggMoves,
    speciesSprite: sprites ? (id, shiny) => sprites.front(id, shiny) : null,
    speciesSpriteBack: sprites?.back ? (id, shiny) => sprites.back!(id, shiny) : null,
    hasShinySprites: sprites?.hasShiny ?? false,
    importSpeciesSprite: sprites ? (id, image) => sprites.importFront(id, image) : null,
    importSpeciesSpriteBack: sprites?.importBack ? (id, image) => sprites.importBack!(id, image) : null,
    speciesNameLength: SPECIES_NAME_LEN - 1,

    readSpecies(id) {
      const base = entry(id)
      const out: Record<string, FieldValue> = {}
      for (const [key, byte] of Object.entries(STAT_BYTES)) out[key] = bytes[base + byte]
      for (const [key, word] of Object.entries(STAT_WORDS)) out[key] = rom.readU16LE(base + word)
      const ev = rom.readU16LE(base + SP.evYield)
      for (const [key, idx] of EV_STATS) out[key] = (ev >> (idx * 2)) & 3
      return out
    },

    writeSpeciesField(id, key, value) {
      if (typeof value !== 'number') return
      const base = entry(id)
      const word = STAT_WORDS[key]
      if (word !== undefined) return rom.writeU16LE(base + word, value)
      const ev = EV_STATS.find(([k]) => k === key)
      if (ev) {
        const cur = rom.readU16LE(base + SP.evYield)
        rom.writeU16LE(base + SP.evYield, (cur & ~(3 << (ev[1] * 2))) | ((value & 3) << (ev[1] * 2)))
        return
      }
      const byte = STAT_BYTES[key]
      if (byte !== undefined) rom.writeU8(base + byte, value)
    },

    setSpeciesName(id, name) {
      const encoded = gen3Codec.encode(name, SPECIES_NAME_LEN - 1)
      if (!encoded || name.length === 0) return false
      rom.writeBytes(entry(id) + SP.speciesName, [...encoded, 0xff].slice(0, SPECIES_NAME_LEN))
      refreshSpecies(id)
      return true
    },

    revertSpecies(id) {
      rom.revertRange(entry(id), table.stride)
      refreshSpecies(id)
    },

    moves,
    moveFields,
    moveNameLength: moveTable !== null ? MOVE_NAME_MAX : null,

    setMoveName(id, name) {
      if (moveTable === null) return false
      if (!writePointerText(rom, moveBase(id) + MV.name, name, MOVE_NAME_MAX)) return false
      refreshMove(id)
      return true
    },

    readMove(id) {
      const base = moveBase(id)
      const tp = rom.readU16LE(base + MV.typePowerWord)
      const at = rom.readU16LE(base + MV.accTargetWord)
      const prio = bytes[base + MV.priorityWord] & 0xf
      return {
        effect: rom.readU16LE(base + MV.effect),
        type: tp & 0x1f,
        category: (tp >> 5) & 0x3,
        power: (tp >> 7) & 0x1ff,
        accuracy: at & 0x7f,
        target: (at >> 7) & 0x1ff,
        pp: bytes[base + MV.pp],
        priority: prio >= 8 ? prio - 16 : prio, // 4-bit signed
      }
    },

    writeMoveField(id, key, value) {
      if (typeof value !== 'number' || moveTable === null) return
      const base = moveBase(id)
      if (key === 'effect') return rom.writeU16LE(base + MV.effect, value)
      if (key === 'pp') return rom.writeU8(base + MV.pp, value)
      if (key === 'type' || key === 'category' || key === 'power') {
        const cur = rom.readU16LE(base + MV.typePowerWord)
        const next =
          key === 'type'
            ? (cur & ~0x1f) | (value & 0x1f)
            : key === 'category'
              ? (cur & ~(0x3 << 5)) | ((value & 0x3) << 5)
              : (cur & ~(0x1ff << 7)) | ((value & 0x1ff) << 7)
        return rom.writeU16LE(base + MV.typePowerWord, next)
      }
      if (key === 'accuracy' || key === 'target') {
        const cur = rom.readU16LE(base + MV.accTargetWord)
        const next =
          key === 'accuracy'
            ? (cur & ~0x7f) | (value & 0x7f)
            : (cur & ~(0x1ff << 7)) | ((value & 0x1ff) << 7)
        return rom.writeU16LE(base + MV.accTargetWord, next)
      }
      if (key === 'priority') {
        // Bottom nibble of a packed word; the other 28 bits are flags.
        const cur = bytes[base + MV.priorityWord]
        rom.writeU8(base + MV.priorityWord, (cur & 0xf0) | ((value < 0 ? value + 16 : value) & 0xf))
      }
    },

    revertMove(id) {
      if (moveTable === null) return
      rom.revertRange(moveBase(id), moveTable.stride)
      refreshMove(id)
    },
  }
}

export type { SpeciesTable }
