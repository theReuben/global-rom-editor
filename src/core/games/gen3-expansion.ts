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
import { EVO_CONDITIONS_END, GEN3_EVO_CONDITIONS } from './gen3-evo-conditions'
import { FORM_CHANGE_ENTRY, GEN3_FORM_CHANGES } from './gen3-form-changes'
import { GEN3_SPECIES_FLAGS, GEN3_SPECIES_FLAG_PRESERVE_MASK } from './gen3-species-flags'
import { discoverMaps, type Gen3MapIndex } from '../gba/mapscan'
import { buildTrainerLocations, type TrainerLocationIndex } from '../gba/trainer-locations'
import { buildTrainerSprites } from '../gba/trainer-sprites'
import { buildExpansionTrainers } from '../gba/expansion-trainers'
import { buildExpansionItems, ITEM_ENTRY } from '../gba/expansion-items'
import { buildWildModule } from '../gba/wild'
import {
  EVOLUTION_ENTRY,
  LEVEL_UP_MOVE_END,
  MOVE_UNAVAILABLE,
  MV,
  PTR_BLOCK,
  speciesFormLabel,
  EVO_CONDITION_ENTRY,
  parseEvolutionConditions,
  parseFormChanges,
  type FormChangeEntry,
  type EvolutionCondition,
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
  FormChangeModule,
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
  RenderedImage,
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
    /** Locates one evolution entry, or null if the slot is not real. */
    const evoAt = (id: number, slot: number): number | null => {
      const pf = blobPtr(id, PTR_BLOCK.evolutions)
      if (pf === null) return null
      const p = readGbaPointer(bytes, pf)
      if (p === null) return null
      const existing = parseEvolutions(bytes, p, SPECIES_COUNT)
      if (existing === null || slot >= existing.length) return null
      return p + slot * EVOLUTION_ENTRY
    }

    /**
     * Condition lists this editor has moved: key -> the block it wrote.
     * Revert needs the size it actually wrote, not the size the list
     * happens to be now, or removing a condition after adding one leaves
     * the tail of the old block behind.
     */
    const movedConditions = new Map<string, { at: number; size: number }>()

    /**
     * Writes a condition list somewhere it fits and points the evolution
     * at it. Lists are stored back to back and sized exactly, so any
     * change in length has to move rather than overwrite a neighbour.
     */
    const writeConditions = (key: string, at: number, list: EvolutionCondition[]): boolean => {
      const bytesNeeded = (list.length + 1) * EVO_CONDITION_ENTRY
      const dest = findFreeSpaceAtEnd(rom.bytes, bytesNeeded)
      if (dest === null) return false
      const block = new Uint8Array(bytesNeeded)
      list.forEach((c, i) => {
        const o = i * EVO_CONDITION_ENTRY
        block[o] = c.condition & 0xff
        block[o + 1] = (c.condition >> 8) & 0xff
        c.args.forEach((v, a) => {
          block[o + 2 + a * 2] = v & 0xff
          block[o + 3 + a * 2] = (v >> 8) & 0xff
        })
      })
      const term = list.length * EVO_CONDITION_ENTRY
      block[term] = EVO_CONDITIONS_END & 0xff
      block[term + 1] = (EVO_CONDITIONS_END >> 8) & 0xff
      rom.writeBlock(dest, block)
      writeGbaPointer(rom, at + 8, dest)
      const previous = movedConditions.get(key)
      movedConditions.set(key, {
        at: dest,
        size: Math.max(bytesNeeded, previous?.at === dest ? previous.size : 0),
      })
      return true
    }

    evolutions = {
      methods: EVO_METHODS,
      itemParamMethods: EVO_ITEM_METHODS,
      conditionOptions: Object.entries(GEN3_EVO_CONDITIONS).map(([value, c]) => ({
        value: Number(value),
        label: c.label,
        args: c.args,
        argKind: c.argKind,
        description: c.description,
      })),
      read(id) {
        const field = blobPtr(id, PTR_BLOCK.evolutions)
        if (field === null) return []
        const p = readGbaPointer(bytes, field)
        if (p === null) return []
        return (parseEvolutions(bytes, p, SPECIES_COUNT) ?? []).map((e) => ({
          method: e.method,
          param: e.param,
          target: e.target,
          conditions: e.conditions,
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
      writeCondition(id, slot, index, arg, value) {
        const at = evoAt(id, slot)
        if (at === null || arg < 0 || arg > 2) return
        const list = readGbaPointer(bytes, at + 8)
        if (list === null) return
        const current = parseEvolutionConditions(bytes, list)
        if (index < 0 || index >= current.length) return
        rom.writeU16LE(list + index * EVO_CONDITION_ENTRY + 2 + arg * 2, value)
      },

      addCondition(id, slot, condition) {
        const at = evoAt(id, slot)
        if (at === null) return false
        const list = readGbaPointer(bytes, at + 8)
        const current = list === null ? [] : parseEvolutionConditions(bytes, list)
        if (current.length >= 8) return false
        return writeConditions(`${id}:${slot}`, at, [...current, { condition, args: [0, 0, 0] }])
      },

      removeCondition(id, slot, index) {
        const at = evoAt(id, slot)
        if (at === null) return false
        const list = readGbaPointer(bytes, at + 8)
        if (list === null) return false
        const current = parseEvolutionConditions(bytes, list)
        if (index < 0 || index >= current.length) return false
        const next = current.filter((_, i) => i !== index)
        // Shrinking fits where it is, so the list stays put and the
        // pointer does not have to move.
        const size = (next.length + 1) * EVO_CONDITION_ENTRY
        const block = new Uint8Array(size)
        next.forEach((c, i) => {
          const o = i * EVO_CONDITION_ENTRY
          block[o] = c.condition & 0xff
          block[o + 1] = (c.condition >> 8) & 0xff
          c.args.forEach((v, a) => {
            block[o + 2 + a * 2] = v & 0xff
            block[o + 3 + a * 2] = (v >> 8) & 0xff
          })
        })
        block[next.length * EVO_CONDITION_ENTRY] = EVO_CONDITIONS_END & 0xff
        block[next.length * EVO_CONDITION_ENTRY + 1] = (EVO_CONDITIONS_END >> 8) & 0xff
        rom.writeBlock(list, block)
        return true
      },

      revert(id) {
        const pf = blobPtr(id, PTR_BLOCK.evolutions)
        if (pf === null) return
        const p = readGbaPointer(bytes, pf)
        if (p === null) return
        const existing = parseEvolutions(bytes, p, SPECIES_COUNT)
        if (existing === null) return
        // Condition lists live outside the evolution blob, so they need
        // reverting too - both where they are now and where they were,
        // in case adding a condition moved one.
        existing.forEach((e, slot) => {
          // Where the list lives now, where it lived originally, and any
          // block this editor allocated for it - all three may hold
          // bytes that differ from the ROM as shipped.
          const original = readGbaPointer(rom.original, p + slot * EVOLUTION_ENTRY + 8)
          for (const at of [e.conditionsOffset, original]) {
            if (at === null) continue
            const list = parseEvolutionConditions(bytes, at)
            rom.revertRange(at, (list.length + 1) * EVO_CONDITION_ENTRY)
          }
          const moved = movedConditions.get(`${id}:${slot}`)
          if (moved) {
            rom.revertRange(moved.at, moved.size)
            movedConditions.delete(`${id}:${slot}`)
          }
        })
        rom.revertRange(p, (existing.length + 1) * EVOLUTION_ENTRY)
      },
    }
  }

  /* --------------------------------------------- form changes */

  /**
   * Mega Evolution is a form change here, not an evolution, so this is
   * the only place its trigger - the stone, or the move - can be seen.
   */
  let formChanges: FormChangeModule | null = null
  if (ptr !== null) {
    const tableAt = (id: number): number | null => {
      const field = blobPtr(id, PTR_BLOCK.formChangeTable)
      return field === null ? null : readGbaPointer(bytes, field)
    }
    const readEntries = (id: number): FormChangeEntry[] => {
      const at = tableAt(id)
      return at === null ? [] : parseFormChanges(bytes, at, SPECIES_COUNT)
    }
    /** Blocks this editor allocated, so revert can reclaim them whole. */
    const movedTables = new Map<number, { at: number; size: number }>()

    const writeTable = (id: number, list: FormChangeEntry[]): boolean => {
      const field = blobPtr(id, PTR_BLOCK.formChangeTable)
      if (field === null) return false
      const size = (list.length + 1) * FORM_CHANGE_ENTRY
      const dest = findFreeSpaceAtEnd(rom.bytes, size)
      if (dest === null) return false
      const block = new Uint8Array(size)
      list.forEach((e, i) => {
        const o = i * FORM_CHANGE_ENTRY
        const put = (at: number, v: number) => {
          block[at] = v & 0xff
          block[at + 1] = (v >> 8) & 0xff
        }
        put(o, e.method)
        put(o + 2, e.target)
        e.params.forEach((v, n) => put(o + 4 + n * 2, v))
      })
      // Terminator is method 0, which the zero fill already provides.
      rom.writeBlock(dest, block)
      writeGbaPointer(rom, field, dest)
      const previous = movedTables.get(id)
      movedTables.set(id, {
        at: dest,
        size: Math.max(size, previous?.at === dest ? previous.size : 0),
      })
      return true
    }

    formChanges = {
      methods: Object.entries(GEN3_FORM_CHANGES).map(([value, m]) => ({
        value: Number(value),
        label: m.label,
        params: m.params,
        description: m.description,
      })),
      read: readEntries,
      write(id, slot, field, value) {
        const at = tableAt(id)
        const list = readEntries(id)
        if (at === null || slot >= list.length) return
        const o = at + slot * FORM_CHANGE_ENTRY
        const m = /^param(\d)$/.exec(field)
        if (m) return rom.writeU16LE(o + 4 + Number(m[1]) * 2, value)
        if (field === 'method') return rom.writeU16LE(o, value)
        if (field === 'target') return rom.writeU16LE(o + 2, value)
      },
      add(id, method) {
        const list = readEntries(id)
        if (list.length >= 16) return false
        return writeTable(id, [...list, { method, target: 0, params: [0, 0, 0, 0] }])
      },
      remove(id, slot) {
        const at = tableAt(id)
        const list = readEntries(id)
        if (at === null || slot >= list.length) return false
        const next = list.filter((_, i) => i !== slot)
        // Shrinking fits where it is, so the table stays put.
        const block = new Uint8Array((next.length + 1) * FORM_CHANGE_ENTRY)
        next.forEach((e, i) => {
          const o = i * FORM_CHANGE_ENTRY
          const put = (a: number, v: number) => {
            block[a] = v & 0xff
            block[a + 1] = (v >> 8) & 0xff
          }
          put(o, e.method)
          put(o + 2, e.target)
          e.params.forEach((v, n) => put(o + 4 + n * 2, v))
        })
        rom.writeBlock(at, block)
        return true
      },
      revert(id) {
        const field = blobPtr(id, PTR_BLOCK.formChangeTable)
        if (field === null) return
        const original = readGbaPointer(rom.original, field)
        for (const at of [tableAt(id), original]) {
          if (at === null) continue
          const list = parseFormChanges(bytes, at, SPECIES_COUNT)
          rom.revertRange(at, (list.length + 1) * FORM_CHANGE_ENTRY)
        }
        const moved = movedTables.get(id)
        if (moved) {
          rom.revertRange(moved.at, moved.size)
          movedTables.delete(id)
        }
        rom.revertRange(field, 4)
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
  let mapIndex: Gen3MapIndex | null = null
  try {
    const gameCode = String.fromCharCode(...bytes.subarray(0xac, 0xb0)).replace(/[^ -~]/g, '')
    const maps = buildGen3MapModule(rom, gameCode)
    if (maps) {
      mapModule = maps.module
      mapIndex = maps.index
      mapKeys = new Set(maps.module.entries.map((e) => e.key))
      if (maps.index.skippedMaps > 0)
        warnings.push(
          `${maps.index.skippedMaps} map${maps.index.skippedMaps === 1 ? '' : 's'} could not be verified and ` +
            'are missing from the map list — everything else on this ROM is unaffected.',
        )
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
        mapIndex = index
        mapKeys = new Set()
        index.banks.forEach((maps, bank) => maps.forEach((_, map) => mapKeys!.add(`${bank}.${map}`)))
      }
    } catch {
      mapKeys = null
    }
  }

  // Area names come from the map module, so the Wild tab labels its maps
  // the same way the Maps tab does.
  const areaName = (key: string) =>
    mapModule?.entries.find((e) => e.key === key)?.areaName

  let wildModule: WildModule | null = null
  try {
    if (mapKeys) {
      // The expansion's time-of-day header first, since that is what
      // these ROMs normally carry; a hack that kept vanilla's flat
      // 20-byte header still works through the vanilla scanner.
      const wild = buildExpansionWildModule(rom, mapKeys, SPECIES_COUNT, areaName)
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
        const vanilla = buildWildModule(rom, mapKeys, areaName)
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
  }

  /**
   * Trainer ids in this table are the game's own TRAINER_* constants, so
   * the ids map scripts reference index straight into it.
   */
  let trainerSprite: ((picId: number) => RenderedImage | null) | null = null
  let trainerSpriteCount: number | null = null
  try {
    const sprites = buildTrainerSprites(rom)
    if (sprites) {
      trainerSprite = sprites.render
      trainerSpriteCount = sprites.count
      regions.push({
        name: `Trainer sprites (${sprites.count})`,
        offset: sprites.offset,
        length: sprites.count * 32,
      })
    }
  } catch {
    trainerSprite = null
    trainerSpriteCount = null
  }

  let trainerLocations: TrainerLocationIndex | null = null
  if (trainerModule && mapIndex) {
    try {
      trainerLocations = buildTrainerLocations(bytes, mapIndex, trainerModule.entries.length)
    } catch {
      trainerLocations = null
    }
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

  /**
   * The one-bit species flags. They sit in a u32 eight bytes before the
   * pointer block: the struct ends with the flags, two shadow offsets
   * and a u16 before that block, so no separate offset has to be found.
   */
  const flagsOffset = (id: number): number | null =>
    table.pointerBlock === null ? null : entry(id) + table.pointerBlock - 8

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
  if (table.pointerBlock !== null) {
    // Whether a species IS a Mega, a Hisuian form, a legendary and so on.
    // isMegaEvolution is not cosmetic: it drives IsBattlerMegaEvolved,
    // disables affection hearts, changes the cry and shows in the dex,
    // so a form built by hand needs it set to behave like a real one.
    speciesFields.push({
      key: 'formFlags',
      label: 'Species flags',
      kind: 'flags',
      flagLabels: GEN3_SPECIES_FLAGS.map((f) => f.label),
      group: 'flags',
    })
  }

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
  const formOf = new Map<number, string | null>()
  for (let id = 1; id <= SPECIES_COUNT; id++) {
    const name = speciesName(id)
    // Form species share the base form's name, so without this the list
    // shows several identical "Typhlosion" rows.
    formOf.set(id, speciesFormLabel(bytes, table, id))
    species.push({ id, label: '', name })
  }

  /**
   * Names every entry so it can be told from the others.
   *
   * Form species carry the base form's name - all nine Castforms are
   * called "Castform" - so a list or dropdown built from the name alone
   * repeats the same word. Each duplicate is given the least it needs to
   * be distinct, in order of how much it explains:
   *
   *   1. the form flag, which covers most of them ("Mega", "Hisuian")
   *   2. the typing, which separates Castform's weather and terrain
   *      forms and Rotom's appliances, and tells Charizard's Mega X
   *      from its Mega Y where the flags cannot
   *   3. a number, only where even that leaves them identical - Deoxys'
   *      four forms are all plain Psychic
   */
  {
    const typeName = (v: number) => typeOptions.find((o) => o.value === v)?.label ?? String(v)
    const typing = (id: number) => {
      const t1 = typeName(bytes[entry(id) + SP.type1])
      const t2 = typeName(bytes[entry(id) + SP.type2])
      return t1 === t2 ? t1 : `${t1}/${t2}`
    }

    const byName = new Map<string, EntryHandle[]>()
    for (const h of species) byName.set(h.name, [...(byName.get(h.name) ?? []), h])

    for (const [, group] of byName) {
      if (group.length === 1) {
        group[0].displayName = group[0].name.trim() || '(blank)'
      } else {
        const flag = (h: EntryHandle) => formOf.get(h.id) ?? ''
        // The typing only earns its place when the group does not all
        // share one: sixteen Pikachu are every bit as Electric as each
        // other, and saying so on each row explains nothing.
        const typesDiffer = new Set(group.map((h) => typing(h.id))).size > 1

        const describe = (h: EntryHandle) => {
          const parts: string[] = []
          if (flag(h)) parts.push(flag(h))
          if (typesDiffer) parts.push(typing(h.id))
          return parts
        }

        // Number only within a key that is genuinely identical, so the
        // one Gigantamax Pikachu keeps its name while its sixteen
        // indistinguishable cousins are numbered.
        const totals = new Map<string, number>()
        for (const h of group) {
          const key = describe(h).join('|')
          totals.set(key, (totals.get(key) ?? 0) + 1)
        }
        const seen = new Map<string, number>()
        for (const h of group) {
          const parts = describe(h)
          const key = parts.join('|')
          if ((totals.get(key) ?? 0) > 1) {
            const n = (seen.get(key) ?? 0) + 1
            seen.set(key, n)
            parts.push(String(n))
          }
          const base = h.name.trim() || '(blank)'
          h.displayName = parts.length ? `${base} (${parts.join(', ')})` : base
        }
      }
      for (const h of group) h.label = `#${String(h.id).padStart(4, '0')} ${h.displayName}`
    }
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
    h.label = `#${String(id).padStart(4, '0')} ${h.name.trim() || '(blank)'}`
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
    trainerLocations,
    trainerSprite,
    trainerSpriteCount,
    wildModule,
    itemOptions,
    itemModule,
    typeChart: null,
    evolutions,
    formChanges,
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
      const flags = flagsOffset(id)
      if (flags !== null) {
        const word = rom.readU16LE(flags) | (rom.readU16LE(flags + 2) << 16)
        out.formFlags = GEN3_SPECIES_FLAGS.map((f) => ((word >>> f.bit) & 1) === 1)
      }
      return out
    },

    writeSpeciesField(id, key, value) {
      if (key === 'formFlags' && Array.isArray(value)) {
        const at = flagsOffset(id)
        if (at === null) return
        const current = (rom.readU16LE(at) | (rom.readU16LE(at + 2) << 16)) >>> 0
        // perfectIVCount shares this word and is three bits wide, so the
        // bits it owns are carried across untouched.
        let next = current & GEN3_SPECIES_FLAG_PRESERVE_MASK
        GEN3_SPECIES_FLAGS.forEach((f, i) => {
          if (value[i]) next |= 1 << f.bit
        })
        rom.writeU16LE(at, next & 0xffff)
        rom.writeU16LE(at + 2, (next >>> 16) & 0xffff)
        return
      }
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
