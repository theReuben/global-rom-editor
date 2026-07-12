/**
 * Generation 1 adapter — Pokémon Red / Blue / Yellow (and derived hacks).
 *
 * Every table is located by signature scanning + verification, so this
 * works across versions, regions with Latin text, and most existing hacks.
 *
 * Gen 1 quirks handled here:
 *  - Base stats are stored in Pokédex order, but names in "internal"
 *    order; a mapping table connects the two.
 *  - In Red/Blue, Mew's stats live outside the main table.
 */
import { Rom } from '../rom'
import { findAll, findByVote, findVerified, matchesAt } from '../scan'
import { gen12Bytes, gen12Codec } from '../text'
import { GEN1_TYPES, GEN12_GROWTH, padDex } from './data'
import { GEN1_MAP_NAMES, GEN1_TRAINER_CLASSES } from './gen1-constants'
import type {
  EntryHandle,
  FieldSpec,
  FieldValue,
  GameAdapter,
  TableRegion,
  TrainerModule,
  WildModule,
} from './schema'

const STATS_ENTRY = 28
const NAME_LEN = 10
const MOVE_ENTRY = 6
const MOVE_COUNT = 165
const INTERNAL_COUNT = 190

// dex#, HP, ATK, DEF, SPD, SPC, Grass, Poison, catch rate — Bulbasaur.
const BULBASAUR = [0x01, 45, 49, 49, 45, 65, 0x16, 0x03, 45]
const IVYSAUR = [0x02, 60, 62, 63, 60, 80, 0x16, 0x03, 45]
const MEW = [0x97, 100, 100, 100, 100, 100, 0x18, 0x18, 45, 64]
// Internal order starts Rhydon, Kangaskhan, Nidoran♂, Clefairy, Spearow,
// Voltorb, Nidoking, Slowbro, Ivysaur — expressed as dex numbers.
const INTERNAL_TO_DEX_SIG = [0x70, 0x73, 0x20, 0x23, 0x15, 0x64, 0x22, 0x50]
// Pound, Karate Chop (Normal-type in Gen 1), Doubleslap.
const POUND = [0x01, 0x00, 40, 0x00, 0xff, 35]
const KARATE_CHOP = [0x02, 0x00, 50, 0x00, 0xff, 25]
// TM01..TM08: Mega Punch, Razor Wind, Swords Dance, Whirlwind, Mega Kick,
// Toxic, Horn Drill, Body Slam.
const TM_LIST_SIG = [5, 13, 14, 18, 25, 92, 32, 34]

const STAT_BYTES: Record<string, number> = {
  hp: 1,
  atk: 2,
  def: 3,
  spd: 4,
  spc: 5,
  type1: 6,
  type2: 7,
  catchRate: 8,
  baseExp: 9,
  growthRate: 19,
  startMove1: 15,
  startMove2: 16,
  startMove3: 17,
  startMove4: 18,
}

// Route 1's grass encounters (Pidgey 0x24 / Rattata 0xA5 pairs, water
// rate 0) — byte-exact anchors from the pokered / pokeyellow sources.
const ROUTE1_WILD_RB = [25, 3, 0x24, 3, 0xa5, 3, 0xa5, 2, 0xa5, 2, 0x24, 3, 0x24, 3, 0x24, 4, 0xa5, 4, 0x24, 5, 0x24, 0]
const ROUTE1_WILD_Y = [25, 3, 0x24, 4, 0x24, 2, 0xa5, 3, 0xa5, 2, 0x24, 3, 0x24, 5, 0x24, 4, 0xa5, 6, 0x24, 7, 0x24, 0]
const ROUTE1_MAP_ID = 12
const WILD_SLOTS = 10

/**
 * Gen 1 wild encounters: a per-map table of bank-local 2-byte pointers;
 * each block is [grassRate, 10×(level, species)?, waterRate, 10×pairs?].
 * Species are internal ids — translated to dex numbers for the UI.
 */
function buildGen1Wild(
  rom: Rom,
  internalToDex: (internal: number) => number,
  dexToInternalFn: (dex: number) => number,
): { module: WildModule; offset: number; count: number } | null {
  const bytes = rom.bytes
  const route1 = findVerified(bytes, ROUTE1_WILD_RB, []) ?? findVerified(bytes, ROUTE1_WILD_Y, [])
  if (route1 === null) return null
  const bank = Math.floor(route1 / 0x4000)
  const toLocal = (off: number) => 0x4000 + (off % 0x4000)
  const toFile = (local: number) => bank * 0x4000 + (local - 0x4000)

  // Find Route 1's pointer; the 12 map slots before it share one
  // "no encounters" pointer, which pins the table start exactly.
  const lo = toLocal(route1) & 0xff
  const hi = toLocal(route1) >> 8
  let table: number | null = null
  for (let o = ROUTE1_MAP_ID * 2; o + 2 <= bytes.length; o += 1) {
    if (bytes[o] !== lo || bytes[o + 1] !== hi) continue
    const start = o - ROUTE1_MAP_ID * 2
    const v0 = bytes[start] | (bytes[start + 1] << 8)
    if (v0 < 0x4000 || v0 >= 0x8000) continue
    let same = true
    for (let i = 1; i < ROUTE1_MAP_ID; i++) {
      if ((bytes[start + i * 2] | (bytes[start + i * 2 + 1] << 8)) !== v0) same = false
    }
    if (!same) continue
    table = start
    break
  }
  if (table === null) return null

  let count = 0
  while (count < 249) {
    const v = rom.readU16LE(table + count * 2)
    if (v < 0x4000 || v >= 0x8000) break
    count++
  }

  const tableOff = table
  const blockOff = (mapId: number) => toFile(rom.readU16LE(tableOff + mapId * 2))
  const groupOffsets = (mapId: number): { name: string; rateOff: number; monsOff: number }[] => {
    const out = []
    let p = blockOff(mapId)
    const grassRate = bytes[p]
    if (grassRate > 0) out.push({ name: 'Grass', rateOff: p, monsOff: p + 1 })
    p += grassRate > 0 ? 1 + WILD_SLOTS * 2 : 1
    if (bytes[p] > 0) out.push({ name: 'Water', rateOff: p, monsOff: p + 1 })
    return out
  }

  const entries: { key: string; label: string }[] = []
  for (let m = 0; m < count; m++) {
    if (groupOffsets(m).length === 0) continue
    entries.push({ key: String(m), label: GEN1_MAP_NAMES[m] ?? `Map #${m}` })
  }

  const module: WildModule = {
    entries,
    groups(key) {
      return groupOffsets(Number(key)).map((g) => ({
        name: g.name,
        rate: bytes[g.rateOff],
        slots: Array.from({ length: WILD_SLOTS }, (_, i) => ({
          minLevel: bytes[g.monsOff + i * 2],
          maxLevel: bytes[g.monsOff + i * 2],
          species: internalToDex(bytes[g.monsOff + i * 2 + 1]),
        })),
      }))
    },
    setRate(key, group, rate) {
      const g = groupOffsets(Number(key))[group]
      if (g) rom.writeU8(g.rateOff, rate)
    },
    setSlot(key, group, slot, field, value) {
      const g = groupOffsets(Number(key))[group]
      if (!g || slot < 0 || slot >= WILD_SLOTS) return
      // Gen 1 has a single level per slot; min and max both map to it.
      if (field === 'minLevel' || field === 'maxLevel') rom.writeU8(g.monsOff + slot * 2, value)
      else if (field === 'species') {
        const internal = dexToInternalFn(value)
        if (internal > 0) rom.writeU8(g.monsOff + slot * 2 + 1, internal)
      }
    },
    revert(key) {
      for (const g of groupOffsets(Number(key))) {
        rom.revertRange(g.rateOff, 1 + WILD_SLOTS * 2)
      }
    },
  }
  return { module, offset: tableOff, count }
}

// The first three Youngster party lists — byte-identical in Red, Blue and
// Yellow: "db 11, RATTATA, EKANS, 0 / db 14, SPEAROW, 0 /
// db 10, RATTATA, RATTATA, ZUBAT, 0" (pokered data/trainers/parties.asm).
const YOUNGSTER_LISTS = [11, 0xa5, 0x6c, 0, 14, 0x05, 0]
const YOUNGSTER_VERIFY = [10, 0xa5, 0xa5, 0x6b, 0]
const TRAINER_CLASS_COUNT = 47
const MAX_LIST_LEVEL = 120
const MAX_PARTY = 6

interface Gen1TrainerRec {
  classId: number
  indexInClass: number
  off: number
  len: number
  /** true = "$FF, level, mon, level, mon, 0"; false = "level, mon.., 0". */
  special: boolean
}

/**
 * Gen 1 trainer parties: 47 class pointers (bank-local u16) each leading
 * to a run of null-terminated party lists. Scripts identify trainers by
 * class + list number, so entries are labelled that way and lists are
 * edited strictly in place.
 */
function buildGen1Trainers(
  rom: Rom,
  internalToDex: (internal: number) => number,
  dexToInternalFn: (dex: number) => number,
): { module: TrainerModule; offset: number; trainerCount: number } | null {
  const bytes = rom.bytes
  const toLocal = (off: number) => 0x4000 + (off % 0x4000)

  // All 47 pointers plausible: bank-local, non-decreasing, and each
  // pointing at a byte that can start a party list.
  const validTableAt = (start: number): boolean => {
    const bank = Math.floor(start / 0x4000)
    let prev = 0x4000
    for (let c = 0; c < TRAINER_CLASS_COUNT; c++) {
      const v = rom.readU16LE(start + c * 2)
      if (v < prev || v >= 0x8000) return false
      const first = bytes[bank * 0x4000 + (v - 0x4000)]
      if (first !== 0xff && first > MAX_LIST_LEVEL) return false
      prev = v
    }
    return true
  }

  // Primary: the byte-exact Youngster anchor, with the pointer table
  // immediately before it like the original games lay it out.
  let tableOff: number | null = null
  const anchor = findVerified(bytes, YOUNGSTER_LISTS, [{ delta: 7, pattern: YOUNGSTER_VERIFY }])
  if (anchor !== null) {
    const direct = anchor - TRAINER_CLASS_COUNT * 2
    if (direct >= 0 && rom.readU16LE(direct) === toLocal(anchor) && validTableAt(direct)) {
      tableOff = direct
    } else {
      // A hack moved the table: scan the anchor's bank for an entry 0
      // that points at the anchor.
      const bankStart = Math.floor(anchor / 0x4000) * 0x4000
      for (let o = bankStart; o < bankStart + 0x4000 - TRAINER_CLASS_COUNT * 2; o++) {
        if (rom.readU16LE(o) === toLocal(anchor) && validTableAt(o)) {
          tableOff = o
          break
        }
      }
    }
  }
  // Fallback (survives edits to Youngster #1, which IS the anchor): the
  // table is self-referencing — entry 0 points at the byte right after
  // the 47 entries.
  if (tableOff === null) {
    for (let o = 0; o + TRAINER_CLASS_COUNT * 2 <= bytes.length; o += 1) {
      if (rom.readU16LE(o) !== toLocal(o) + TRAINER_CLASS_COUNT * 2) continue
      if (validTableAt(o)) {
        tableOff = o
        break
      }
    }
  }
  if (tableOff === null) return null
  const bank = Math.floor(tableOff / 0x4000)
  const toFile = (local: number) => bank * 0x4000 + (local - 0x4000)

  const ptrs: number[] = []
  for (let c = 0; c < TRAINER_CLASS_COUNT; c++) ptrs.push(rom.readU16LE(tableOff + c * 2))

  // A class's lists run from its pointer to the next-higher pointer (the
  // data is contiguous); the last class parses until a list looks wrong.
  const parseClass = (c: number): Gen1TrainerRec[] => {
    // Unused classes alias the next class's pointer (e.g. Chief →
    // Scientist); the later class is the real owner of the lists.
    for (let d = c + 1; d < TRAINER_CLASS_COUNT; d++) if (ptrs[d] === ptrs[c]) return []
    let end = (bank + 1) * 0x4000
    let nextLocal = Infinity
    for (const p of ptrs) if (p > ptrs[c] && p < nextLocal) nextLocal = p
    if (nextLocal !== Infinity) end = toFile(nextLocal)

    const out: Gen1TrainerRec[] = []
    let p = toFile(ptrs[c])
    while (p < end && out.length < 200) {
      const special = bytes[p] === 0xff
      let q = p
      let mons = 0
      let ok = true
      if (special) {
        q++
        while (bytes[q] !== 0) {
          const lvl = bytes[q]
          const sp = bytes[q + 1]
          if (lvl < 1 || lvl > MAX_LIST_LEVEL || sp < 1 || sp > INTERNAL_COUNT || mons >= MAX_PARTY) {
            ok = false
            break
          }
          q += 2
          mons++
        }
      } else {
        if (bytes[p] < 1 || bytes[p] > MAX_LIST_LEVEL) ok = false
        q++
        while (ok && bytes[q] !== 0) {
          const sp = bytes[q]
          if (sp < 1 || sp > INTERNAL_COUNT || mons >= MAX_PARTY) {
            ok = false
            break
          }
          q++
          mons++
        }
      }
      if (!ok || mons === 0) break
      out.push({ classId: c, indexInClass: out.length, off: p, len: q + 1 - p, special })
      p = q + 1
    }
    return out
  }

  const trainers: Gen1TrainerRec[] = []
  for (let c = 0; c < TRAINER_CLASS_COUNT; c++) trainers.push(...parseClass(c))
  if (trainers.length === 0) return null

  // Byte offsets for each mon's level and species (levelOff is shared by
  // the whole party in the fixed-level format).
  const partyOf = (t: Gen1TrainerRec) => {
    const out: { level: number; internal: number; levelOff: number; speciesOff: number }[] = []
    if (t.special) {
      for (let q = t.off + 1; bytes[q] !== 0; q += 2)
        out.push({ level: bytes[q], internal: bytes[q + 1], levelOff: q, speciesOff: q + 1 })
    } else {
      for (let q = t.off + 1; bytes[q] !== 0; q++)
        out.push({ level: bytes[t.off], internal: bytes[q], levelOff: t.off, speciesOff: q })
    }
    return out
  }

  const entries: EntryHandle[] = trainers.map((t, i) => {
    const cls = GEN1_TRAINER_CLASSES[t.classId] ?? `Class ${t.classId}`
    const name = `${cls} #${t.indexInClass + 1}`
    return { id: i, label: name, name }
  })

  const module: TrainerModule = {
    entries,
    nameLength: 0,
    nameHint: 'Gen 1 identifies trainers by class + number — scripts reference this pair, so it can\'t be renamed.',
    features: { identity: false, ai: false, items: false, partySize: false },
    classOptions: GEN1_TRAINER_CLASSES.map((label, value) => ({ value, label })),
    read(id) {
      const t = trainers[id]
      const size = partyOf(t).length
      return {
        name: entries[id].name,
        trainerClass: t.classId,
        pic: 0,
        music: 0,
        gender: 0,
        doubleBattle: 0,
        aiFlags: 0,
        items: [],
        partySize: size,
        maxPartySize: size,
      }
    },
    write() {},
    setName: () => false,
    setItem() {},
    party(id) {
      return partyOf(trainers[id]).map((m) => ({
        species: internalToDex(m.internal),
        level: m.level,
        iv: null,
        item: null,
        moves: null,
      }))
    },
    writePartyField(id, slot, field, value) {
      const m = partyOf(trainers[id])[slot]
      if (!m) return
      // Level 0 would read as the list terminator, and anything above
      // MAX_LIST_LEVEL would break re-discovery of the table on reload.
      if (field === 'level') rom.writeU8(m.levelOff, Math.max(1, Math.min(MAX_LIST_LEVEL, value)))
      else if (field === 'species') {
        const internal = dexToInternalFn(value)
        if (internal > 0) rom.writeU8(m.speciesOff, internal)
      }
    },
    revert(id) {
      const t = trainers[id]
      rom.revertRange(t.off, t.len)
    },
  }
  return { module, offset: tableOff, trainerCount: trainers.length }
}

export function tryBuildGen1(rom: Rom, gameName: string, platform: string): GameAdapter | null {
  const bytes = rom.bytes
  // Stats, names and moves are found by anchor majority vote (bytes
  // extracted from built Red + Yellow, identical in both), so editing
  // any anchor species or move can't break re-discovery on reload.
  const statsOff = findByVote(
    bytes,
    [
      { index: 0, pattern: BULBASAUR },
      { index: 1, pattern: IVYSAUR },
      { index: 24, pattern: [25, 35, 55, 30, 90, 50, 23, 23, 190, 82] }, // Pikachu
      { index: 112, pattern: [113, 250, 5, 5, 50, 105, 0, 0, 30, 255] }, // Chansey
      { index: 149, pattern: [150, 106, 110, 90, 130, 154, 24, 24, 3, 220] }, // Mewtwo
    ],
    STATS_ENTRY,
  )
  if (statsOff === null) return null

  const warnings: string[] = []
  const regions: TableRegion[] = []

  // Mew: inline as entry 151 (Yellow) or a standalone table (Red/Blue).
  let mewOff: number | null = null
  if (matchesAt(bytes, statsOff + 150 * STATS_ENTRY, MEW)) {
    mewOff = statsOff + 150 * STATS_ENTRY
  } else {
    const hits = findAll(bytes, MEW, 2)
    if (hits.length === 1) mewOff = hits[0]
    else warnings.push("Couldn't locate Mew's stats — Mew is not editable in this ROM.")
  }
  const speciesCount = mewOff !== null ? 151 : 150

  const mapOff = findVerified(bytes, INTERNAL_TO_DEX_SIG, [{ delta: 8, pattern: [0x02] }])
  const gbPad = (t: string) => {
    const out = gen12Bytes(t)
    while (out.length < NAME_LEN) out.push(0x50)
    return out
  }
  const namesOff = findByVote(
    bytes,
    [
      { index: 0, pattern: gbPad('RHYDON') }, // internal order!
      { index: 1, pattern: gbPad('KANGASKHAN') },
      { index: 83, pattern: gbPad('PIKACHU') }, // internal 84
      { index: 130, pattern: gbPad('MEWTWO') }, // internal 131
    ],
    NAME_LEN,
  )
  if (mapOff === null || namesOff === null) {
    warnings.push("Couldn't locate the Pokémon name table — names are shown as numbers.")
  }

  const moveOff = findByVote(
    bytes,
    [
      { index: 0, pattern: POUND },
      { index: 1, pattern: KARATE_CHOP },
      { index: 32, pattern: [33, 0, 35, 0, 242, 35] }, // Tackle
      { index: 84, pattern: [85, 6, 95, 23, 255, 15] }, // Thunderbolt
      { index: 93, pattern: [94, 71, 90, 24, 255, 10] }, // Psychic
    ],
    MOVE_ENTRY,
  )
  if (moveOff === null) warnings.push("Couldn't locate the move data table — move editing disabled.")

  // Move names: variable-length 0x50-terminated strings, so read-only.
  const moveNames: string[] = []
  const moveNamesOff = findVerified(
    bytes,
    [...gen12Bytes('POUND'), 0x50, ...gen12Bytes('KARATE CHOP'), 0x50],
    [],
  )
  if (moveNamesOff !== null) {
    let p = moveNamesOff
    for (let i = 0; i < MOVE_COUNT && p < bytes.length; i++) {
      let end = p
      while (end < bytes.length && bytes[end] !== 0x50) end++
      const name = gen12Codec.decode(bytes.subarray(p, end))
      // Real move names are 1-12 chars; anything else means we ran off the table.
      moveNames.push(name.length >= 1 && name.length <= 12 ? name : `Move #${i + 1}`)
      p = end + 1
    }
  }
  const moveName = (id: number) => moveNames[id - 1] ?? `Move #${id}`

  let tmMoves: number[] | null = null
  const tmOff = findVerified(bytes, TM_LIST_SIG, [])
  if (tmOff !== null) tmMoves = Array.from(bytes.subarray(tmOff, tmOff + 55))

  // dex → internal index (1-based), needed to reach names.
  const dexToInternal = new Map<number, number>()
  if (mapOff !== null) {
    for (let i = 0; i < INTERNAL_COUNT; i++) {
      const dex = bytes[mapOff + i]
      if (dex >= 1 && dex <= 151 && !dexToInternal.has(dex)) dexToInternal.set(dex, i + 1)
    }
  }

  // Wild encounters (Red / Blue / Yellow).
  const wild = buildGen1Wild(
    rom,
    (internal) =>
      mapOff !== null && internal >= 1 && internal <= INTERNAL_COUNT ? bytes[mapOff + internal - 1] : 0,
    (dex) => dexToInternal.get(dex) ?? 0,
  )
  if (wild) {
    regions.push({ name: `Wild encounters (${wild.module.entries.length} maps)`, offset: wild.offset, length: wild.count * 2 })
  } else {
    warnings.push("Couldn't locate wild encounter data — wild editing disabled for this ROM.")
  }

  // Trainer parties.
  const trainers = buildGen1Trainers(
    rom,
    (internal) =>
      mapOff !== null && internal >= 1 && internal <= INTERNAL_COUNT ? bytes[mapOff + internal - 1] : 0,
    (dex) => dexToInternal.get(dex) ?? 0,
  )
  if (trainers) {
    regions.push({
      name: `Trainer parties (${trainers.trainerCount} trainers, ${TRAINER_CLASS_COUNT} classes)`,
      offset: trainers.offset,
      length: TRAINER_CLASS_COUNT * 2,
    })
  } else {
    warnings.push("Couldn't locate trainer party data — trainer editing disabled for this ROM.")
  }

  regions.push({ name: 'Base stats', offset: statsOff, length: 150 * STATS_ENTRY })
  if (mewOff !== null && mewOff !== statsOff + 150 * STATS_ENTRY)
    regions.push({ name: 'Mew stats', offset: mewOff, length: STATS_ENTRY })
  if (namesOff !== null)
    regions.push({ name: 'Pokémon names', offset: namesOff, length: INTERNAL_COUNT * NAME_LEN })
  if (mapOff !== null)
    regions.push({ name: 'Dex order table', offset: mapOff, length: INTERNAL_COUNT })
  if (moveOff !== null)
    regions.push({ name: 'Move data', offset: moveOff, length: MOVE_COUNT * MOVE_ENTRY })
  if (tmOff !== null) regions.push({ name: 'TM/HM move list', offset: tmOff, length: 55 })

  const statsOffsetFor = (dex: number) =>
    dex === 151 && mewOff !== null ? mewOff : statsOff + (dex - 1) * STATS_ENTRY
  const nameOffsetFor = (dex: number): number | null => {
    if (namesOff === null) return null
    const internal = dexToInternal.get(dex)
    return internal ? namesOff + (internal - 1) * NAME_LEN : null
  }
  const readName = (dex: number): string => {
    const off = nameOffsetFor(dex)
    if (off === null) return `POKÉMON #${dex}`
    return gen12Codec.decode(bytes.subarray(off, off + NAME_LEN))
  }

  const tmFlagLabels: string[] = []
  for (let i = 0; i < 56; i++) {
    const label = i < 50 ? `TM${String(i + 1).padStart(2, '0')}` : i < 55 ? `HM${String(i - 49).padStart(2, '0')}` : '(unused)'
    const mv = tmMoves && i < 55 ? ` ${moveName(tmMoves[i])}` : ''
    tmFlagLabels.push(label + mv)
  }

  const speciesFields: FieldSpec[] = [
    { key: 'hp', label: 'HP', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'atk', label: 'Attack', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'def', label: 'Defense', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'spd', label: 'Speed', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'spc', label: 'Special', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'type1', label: 'Type 1', kind: 'type', group: 'typing' },
    { key: 'type2', label: 'Type 2', kind: 'type', group: 'typing', help: 'Set both types the same for a mono-type Pokémon.' },
    { key: 'catchRate', label: 'Catch rate', kind: 'number', min: 1, max: 255, group: 'battle' },
    { key: 'baseExp', label: 'Base EXP yield', kind: 'number', min: 0, max: 255, group: 'battle' },
    { key: 'growthRate', label: 'Level curve', kind: 'select', options: GEN12_GROWTH, group: 'battle' },
    { key: 'startMove1', label: 'Starting move 1', kind: 'move', group: 'moves' },
    { key: 'startMove2', label: 'Starting move 2', kind: 'move', group: 'moves' },
    { key: 'startMove3', label: 'Starting move 3', kind: 'move', group: 'moves' },
    { key: 'startMove4', label: 'Starting move 4', kind: 'move', group: 'moves' },
    { key: 'tmhm', label: 'TM / HM compatibility', kind: 'flags', flagLabels: tmFlagLabels, group: 'tmhm' },
  ]

  const moveFields: FieldSpec[] = [
    { key: 'power', label: 'Power', kind: 'number', min: 0, max: 255 },
    { key: 'type', label: 'Type', kind: 'type' },
    { key: 'accuracy', label: 'Accuracy', kind: 'number', min: 0, max: 255, help: 'Out of 255 — e.g. 255 = 100%, 216 = 85%.' },
    { key: 'pp', label: 'PP', kind: 'number', min: 0, max: 63 },
    { key: 'effect', label: 'Effect ID', kind: 'number', min: 0, max: 255, help: 'Battle effect index (0 = plain damage).' },
  ]
  const MOVE_BYTES: Record<string, number> = { effect: 1, power: 2, type: 3, accuracy: 4, pp: 5 }

  const species: EntryHandle[] = []
  for (let dex = 1; dex <= speciesCount; dex++) {
    species.push({ id: dex, label: `${padDex(dex)} ${readName(dex)}`, name: readName(dex) })
  }
  const moves: EntryHandle[] =
    moveOff === null
      ? []
      : Array.from({ length: MOVE_COUNT }, (_, i) => ({
          id: i + 1,
          label: `${String(i + 1).padStart(3, '0')} ${moveName(i + 1)}`,
          name: moveName(i + 1),
        }))

  return {
    gameName,
    platform,
    generation: 1,
    rom,
    regions,
    warnings,
    species,
    speciesFields,
    typeOptions: GEN1_TYPES,
    mapModule: null, // Gen 1 map editing: on the roadmap
    trainerModule: trainers?.module ?? null,
    wildModule: wild?.module ?? null,
    itemOptions: null,
    speciesSprite: null,
    speciesSpriteBack: null,
    importSpeciesSprite: null,
    importSpeciesSpriteBack: null,
    evolutions: null,
    learnsets: null,
    typeChart: null,
    speciesNameLength: namesOff !== null ? NAME_LEN : null,

    readSpecies(dex) {
      const base = statsOffsetFor(dex)
      const out: Record<string, FieldValue> = {}
      for (const [key, byte] of Object.entries(STAT_BYTES)) out[key] = bytes[base + byte]
      const flags: boolean[] = []
      for (let i = 0; i < 56; i++) flags.push((bytes[base + 20 + (i >> 3)] >> (i & 7) & 1) === 1)
      out.tmhm = flags
      return out
    },

    writeSpeciesField(dex, key, value) {
      const base = statsOffsetFor(dex)
      if (key === 'tmhm' && Array.isArray(value)) {
        const flags = value as boolean[]
        for (let b = 0; b < 7; b++) {
          let v = 0
          for (let bit = 0; bit < 8; bit++) if (flags[b * 8 + bit]) v |= 1 << bit
          rom.writeU8(base + 20 + b, v)
        }
        return
      }
      const byte = STAT_BYTES[key]
      if (byte !== undefined && typeof value === 'number') rom.writeU8(base + byte, value)
    },

    setSpeciesName(dex, name) {
      const off = nameOffsetFor(dex)
      if (off === null) return false
      const encoded = gen12Codec.encode(name.toUpperCase(), NAME_LEN)
      if (!encoded || name.length === 0) return false
      rom.writeBytes(off, encoded)
      const handle = species[dex - 1]
      handle.name = readName(dex)
      handle.label = `${padDex(dex)} ${handle.name}`
      return true
    },

    revertSpecies(dex) {
      rom.revertRange(statsOffsetFor(dex), STATS_ENTRY)
      const off = nameOffsetFor(dex)
      if (off !== null) rom.revertRange(off, NAME_LEN)
      const handle = species[dex - 1]
      handle.name = readName(dex)
      handle.label = `${padDex(dex)} ${handle.name}`
    },

    moves,
    moveFields,
    moveNameLength: null,
    setMoveName: () => false,

    readMove(id) {
      const base = moveOff! + (id - 1) * MOVE_ENTRY
      const out: Record<string, FieldValue> = {}
      for (const [key, byte] of Object.entries(MOVE_BYTES)) out[key] = bytes[base + byte]
      return out
    },

    writeMoveField(id, key, value) {
      const byte = MOVE_BYTES[key]
      if (byte !== undefined && typeof value === 'number')
        rom.writeU8(moveOff! + (id - 1) * MOVE_ENTRY + byte, value)
    },

    revertMove(id) {
      rom.revertRange(moveOff! + (id - 1) * MOVE_ENTRY, MOVE_ENTRY)
    },
  }
}
