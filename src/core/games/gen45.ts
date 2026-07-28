/**
 * Generation 4/5 adapter — Nintendo DS games (Diamond/Pearl/Platinum,
 * HeartGold/SoulSilver, Black/White/B2W2) and hacks built on them,
 * e.g. Platinum Kaizo.
 *
 * DS data lives in the NitroFS file system, so tables are opened by
 * path instead of signature-scanned. The Gen 4 personal entry (44 bytes,
 * one NARC subfile per species) is byte-verified against the
 * pret/pokeplatinum struct and is a superset of Gen 3's layout. Gen 5
 * changed the layout past the catch rate, so only the stable prefix is
 * editable there until verified further (see docs/HANDOFF.md).
 */
import { Rom } from '../rom'
import {
  isNdsRom,
  parseNdsHeader,
  listNdsFiles,
  findNdsFile,
  parseNarc,
  rebuildNarcWithSubfile,
  type NarcSubfile,
  type NdsFile,
} from '../nds/nds'
import { parseMsgBank, rebuildMsgBank, writeMsgEntry } from '../nds/msgdata'
import { buildPokegra } from '../nds/pokegra'
import { fixNdsHeaderCrc } from '../checksum'
import { EGG_GROUPS, GEN3_GROWTH, GEN3_TYPES, GENDER_RATIOS } from './data'
import { NATDEX_NAMES, NATDEX_ABILITIES } from './natdex-names'
import type {
  EntryHandle,
  FieldSpec,
  FieldValue,
  GameAdapter,
  SelectOption,
  TrainerModule,
  WildModule,
} from './schema'

const GEN4_ENTRY = 44

/** Gen 5 dropped the ??? type; everything after Ghost/Steel shifts down. */
const GEN5_TYPES: SelectOption[] = GEN3_TYPES.filter((t) => t.value !== 9).map((t) => ({
  value: t.value > 9 ? t.value - 1 : t.value,
  label: t.label,
}))

const GAMES: { prefix: string; name: string; gen: 4 | 5; paths: string[] }[] = [
  { prefix: 'ADA', name: 'Pokémon Diamond', gen: 4, paths: ['/poketool/personal/personal.narc'] },
  { prefix: 'APA', name: 'Pokémon Pearl', gen: 4, paths: ['/poketool/personal/personal.narc'] },
  { prefix: 'CPU', name: 'Pokémon Platinum', gen: 4, paths: ['/poketool/personal/pl_personal.narc'] },
  { prefix: 'IPK', name: 'Pokémon HeartGold', gen: 4, paths: ['/a/0/0/2'] },
  { prefix: 'IPG', name: 'Pokémon SoulSilver', gen: 4, paths: ['/a/0/0/2'] },
  { prefix: 'IRB', name: 'Pokémon Black', gen: 5, paths: ['/a/0/1/6'] },
  { prefix: 'IRA', name: 'Pokémon White', gen: 5, paths: ['/a/0/1/6'] },
  { prefix: 'IRE', name: 'Pokémon Black 2', gen: 5, paths: ['/a/0/1/6'] },
  { prefix: 'IRD', name: 'Pokémon White 2', gen: 5, paths: ['/a/0/1/6'] },
]
const ALL_PATHS = [...new Set(GAMES.flatMap((g) => g.paths))]

// Same byte offsets as Gen 3 for the first 28 bytes — verified against
// pret/pokeplatinum include/struct_defs/species.h.
const STAT_BYTES: Record<string, number> = {
  hp: 0,
  atk: 1,
  def: 2,
  spd: 3,
  sat: 4,
  sdf: 5,
  type1: 6,
  type2: 7,
  catchRate: 8,
  baseExp: 9,
  gender: 16,
  eggCycles: 17,
  friendship: 18,
  growthRate: 19,
  eggGroup1: 20,
  eggGroup2: 21,
  ability1: 22,
  ability2: 23,
}
const EV_STATS: [string, number][] = [
  ['evHp', 0],
  ['evAtk', 1],
  ['evDef', 2],
  ['evSpd', 3],
  ['evSat', 4],
  ['evSdf', 5],
]

// Gen 5 personal entries — B/W are 0x3C bytes, B2W2 0x4C. No Gen 5
// decomp or buildable ROM exists, so this layout is verified against
// PKHeX's PersonalInfo5BW/B2W2 (field-by-field, not from memory).
// Stats/types/catch match Gen 4; gender block shifts +2 for item3 and
// abilities gain a hidden slot.
const GEN5_STAT_BYTES: Record<string, number> = {
  hp: 0,
  atk: 1,
  def: 2,
  spd: 3,
  sat: 4,
  sdf: 5,
  type1: 6,
  type2: 7,
  catchRate: 8,
  gender: 0x12,
  eggCycles: 0x13,
  friendship: 0x14,
  growthRate: 0x15,
  eggGroup1: 0x16,
  eggGroup2: 0x17,
  ability1: 0x18,
  ability2: 0x19,
  abilityH: 0x1a,
}
const GEN5_TMHM = 0x28
const GEN5_TM_FLAGS = 101 // TM01-95 then HM01-06


/* --------------------------------------------------- trainers (Gen 4) */

// TrainerHeader (trdata.narc, one subfile per trainer), verified against
// pret/pokeplatinum struct_defs/trainer_data.h:
//   monDataType u8, class u8, sprite u8, partySize u8,
//   items u16[4], aiMask u32, battleType u32   (20 bytes)
// Party entries (trpoke.narc): ivScale u16, level u16, species u16
// [, item u16][, moves u16[4]], cbSeal u16 — 8/10/16/18 bytes by type.
const TR_ENTRY_SIZES = [8, 16, 10, 18]

export function buildGen4Trainers(
  rom: Rom,
  trdata: NarcSubfile[],
  trpoke: NarcSubfile[],
  names?: {
    trainers: string[]
    classes: string[]
    /** In-place msg-bank rename; null = read-only names. */
    rename?: ((id: number, name: string) => boolean) | null
  },
): TrainerModule {
  const bytes = rom.bytes
  const count = Math.min(trdata.length, trpoke.length)
  const entries: EntryHandle[] = []
  for (let i = 0; i < count; i++) {
    const name = names?.trainers[i] || `Trainer #${i}`
    const cls = bytes[trdata[i].offset + 1]
    const clsLabel = names?.classes[cls] || `class ${cls}`
    entries.push({ id: i, label: `#${String(i).padStart(3, '0')} ${name} · ${clsLabel}`, name })
  }

  const header = (id: number) => trdata[id].offset
  const partyInfo = (id: number) => {
    const type = bytes[header(id)] & 3
    return {
      type,
      entSize: TR_ENTRY_SIZES[type],
      size: bytes[header(id) + 3],
      off: trpoke[id].offset,
      capacity: trpoke[id].length,
    }
  }

  return {
    entries,
    nameLength: names?.rename ? 10 : 0,
    nameHint: names?.trainers.length
      ? 'Read from the message banks — names are not editable in this ROM.'
      : undefined,
    classOptions:
      names && names.classes.length > 0
        ? names.classes.map((label, value) => ({ value, label: label || `Class ${value}` }))
        : null,
    setName(id, name) {
      if (!names?.rename || name.length === 0) return false
      if (!names.rename(id, name)) return false
      entries[id].name = name
      const cls = bytes[trdata[id].offset + 1]
      entries[id].label = `#${String(id).padStart(3, '0')} ${name} · ${names.classes[cls] || `class ${cls}`}`
      return true
    },

    read(id) {
      const o = header(id)
      const { size, entSize, capacity } = partyInfo(id)
      return {
        name: entries[id].name,
        trainerClass: bytes[o + 1],
        pic: bytes[o + 2],
        music: 0,
        gender: 0,
        doubleBattle: rom.readU16LE(o + 16) !== 0 ? 1 : 0,
        aiFlags: (rom.readU16LE(o + 12) | (rom.readU16LE(o + 14) << 16)) >>> 0,
        items: [0, 1, 2, 3].map((i) => rom.readU16LE(o + 4 + i * 2)),
        partySize: size,
        maxPartySize: Math.min(6, Math.floor(capacity / entSize)),
      }
    },

    write(id, field, value) {
      const o = header(id)
      if (field === 'trainerClass') rom.writeU8(o + 1, value)
      else if (field === 'pic') rom.writeU8(o + 2, value)
      else if (field === 'doubleBattle') {
        rom.writeU16LE(o + 16, value ? 2 : 0)
        rom.writeU16LE(o + 18, 0)
      } else if (field === 'aiFlags') {
        rom.writeU16LE(o + 12, value & 0xffff)
        rom.writeU16LE(o + 14, (value >>> 16) & 0xffff)
      } else if (field === 'partySize') {
        const max = Math.min(6, Math.floor(partyInfo(id).capacity / partyInfo(id).entSize))
        rom.writeU8(o + 3, Math.max(1, Math.min(max, value)))
      }
    },

    setItem(id, slot, item) {
      if (slot >= 0 && slot < 4) rom.writeU16LE(header(id) + 4 + slot * 2, item)
    },

    party(id) {
      const { type, entSize, size, off } = partyInfo(id)
      const out = []
      for (let i = 0; i < size; i++) {
        const o = off + i * entSize
        const hasItem = (type & 2) === 2
        const hasMoves = (type & 1) === 1
        out.push({
          iv: rom.readU16LE(o),
          level: rom.readU16LE(o + 2),
          species: rom.readU16LE(o + 4) & 0x3ff, // upper bits = form
          item: hasItem ? rom.readU16LE(o + 6) : null,
          moves: hasMoves ? [0, 1, 2, 3].map((m) => rom.readU16LE(o + (hasItem ? 8 : 6) + m * 2)) : null,
        })
      }
      return out
    },

    writePartyField(id, slot, field, value) {
      const { type, entSize, size, off } = partyInfo(id)
      if (slot < 0 || slot >= size) return
      const o = off + slot * entSize
      if (field === 'iv') rom.writeU16LE(o, Math.min(255, value))
      else if (field === 'level') rom.writeU16LE(o + 2, value)
      else if (field === 'species') {
        const form = rom.readU16LE(o + 4) & 0xfc00
        rom.writeU16LE(o + 4, form | (value & 0x3ff))
      } else if (field === 'item' && (type & 2) === 2) rom.writeU16LE(o + 6, value)
      else if (field.startsWith('move') && (type & 1) === 1) {
        const m = Number(field.slice(4))
        if (m >= 0 && m < 4) rom.writeU16LE(o + ((type & 2) === 2 ? 8 : 6) + m * 2, value)
      }
    },

    revert(id) {
      rom.revertRange(header(id), trdata[id].length)
      rom.revertRange(trpoke[id].offset, trpoke[id].length)
    },
  }
}

/* ---------------------------------------------- wild encounters (Gen 4) */

// WildEncounters (d/p/pl_enc_data.narc, 424 bytes per area), verified
// against pret/pokeplatinum overlay006/wild_encounters.h. All ints LE.
const ENC_FILE_SIZE = 424
const ENC_GROUPS = [
  { name: 'Grass', rateOff: 0, slotsOff: 4, slots: 12, grass: true },
  { name: 'Surfing', rateOff: 204, slotsOff: 208, slots: 5, grass: false },
  { name: 'Old Rod', rateOff: 292, slotsOff: 296, slots: 5, grass: false },
  { name: 'Good Rod', rateOff: 336, slotsOff: 340, slots: 5, grass: false },
  { name: 'Super Rod', rateOff: 380, slotsOff: 384, slots: 5, grass: false },
]

export function buildGen4Wild(rom: Rom, subs: NarcSubfile[]): WildModule | null {
  const bytes = rom.bytes
  const areas = subs.filter((s) => s.length === ENC_FILE_SIZE)
  if (areas.length < 10) return null

  const entries = areas.map((a) => ({ key: String(a.index), label: `Area #${a.index}` }))
  const byKey = new Map(areas.map((a) => [String(a.index), a]))

  const readI32 = (o: number) => (rom.readU16LE(o) | (rom.readU16LE(o + 2) << 16)) >>> 0
  const groupList = (key: string) => {
    const a = byKey.get(key)
    if (!a) return []
    return ENC_GROUPS.map((g) => ({ ...g, base: a.offset }))
  }

  return {
    entries,
    groups(key) {
      return groupList(key).map((g) => ({
        name: g.name,
        rate: readI32(g.base + g.rateOff),
        slots: Array.from({ length: g.slots }, (_, i) => {
          const o = g.base + g.slotsOff + i * 8
          return g.grass
            ? { minLevel: bytes[o], maxLevel: bytes[o], species: readI32(o + 4) & 0xffff }
            : { minLevel: bytes[o + 1], maxLevel: bytes[o], species: readI32(o + 4) & 0xffff }
        }),
      }))
    },
    setRate(key, group, rate) {
      const g = groupList(key)[group]
      if (!g) return
      rom.writeU16LE(g.base + g.rateOff, rate & 0xffff)
      rom.writeU16LE(g.base + g.rateOff + 2, 0)
    },
    setSlot(key, group, slot, field, value) {
      const g = groupList(key)[group]
      if (!g || slot < 0 || slot >= g.slots) return
      const o = g.base + g.slotsOff + slot * 8
      if (field === 'species') {
        rom.writeU16LE(o + 4, value & 0xffff)
        rom.writeU16LE(o + 6, 0)
      } else if (g.grass) {
        rom.writeU8(o, value) // single level
      } else if (field === 'minLevel') rom.writeU8(o + 1, value)
      else if (field === 'maxLevel') rom.writeU8(o, value)
    },
    revert(key) {
      const a = byKey.get(key)
      if (a) rom.revertRange(a.offset, a.length)
    },
  }
}

/* -------------------------------------------- wild encounters (HGSS) */

// EncounterData (g_enc_data.narc → /a/0/3/7 in HeartGold, s_enc_data →
// /a/1/3/6 in SoulSilver; 0xC4 bytes per area), verified against
// pret/pokeheartgold include/wild_encounter.h. Land species are stored
// per time of day over one shared level array.
const HGSS_ENC_SIZE = 0xc4
const HGSS_LAND_SLOTS = 12
const HGSS_SLOT_GROUPS = [
  { name: 'Surfing', rateOff: 1, slotsOff: 0x64, slots: 5 },
  { name: 'Rock Smash', rateOff: 2, slotsOff: 0x78, slots: 2 },
  { name: 'Old Rod', rateOff: 3, slotsOff: 0x80, slots: 5 },
  { name: 'Good Rod', rateOff: 4, slotsOff: 0x94, slots: 5 },
  { name: 'Super Rod', rateOff: 5, slotsOff: 0xa8, slots: 5 },
]
const HGSS_SPECIES_GROUPS = [
  { name: 'Radio: Hoenn sound', slotsOff: 0x5c, slots: 2 },
  { name: 'Radio: Sinnoh sound', slotsOff: 0x60, slots: 2 },
  { name: 'Swarm (land / surf / night fish / fish)', slotsOff: 0xbc, slots: 4 },
]
const HGSS_TIMES = ['Grass (morning)', 'Grass (day)', 'Grass (night)']

export function buildHgssWild(rom: Rom, subs: NarcSubfile[]): WildModule | null {
  const bytes = rom.bytes
  const areas = subs.filter((s) => s.length === HGSS_ENC_SIZE)
  if (areas.length < 10) return null
  const byKey = new Map(areas.map((a) => [String(a.index), a]))
  const entries = areas.map((a) => ({ key: String(a.index), label: `Area #${a.index}` }))

  // Flatten to the generic group list: 3 land time groups, then the
  // level+species groups, then the species-only radio/swarm groups.
  interface HgssGroup {
    name: string
    rateOff: number | null
    slotsOff: number
    slots: number
    kind: 'land' | 'ranged' | 'speciesOnly'
    time?: number
  }
  const defs: HgssGroup[] = [
    ...HGSS_TIMES.map((name, time) => ({
      name, rateOff: 0, slotsOff: 0x14 + time * HGSS_LAND_SLOTS * 2, slots: HGSS_LAND_SLOTS,
      kind: 'land' as const, time,
    })),
    ...HGSS_SLOT_GROUPS.map((g) => ({ ...g, kind: 'ranged' as const })),
    ...HGSS_SPECIES_GROUPS.map((g) => ({ ...g, rateOff: null, kind: 'speciesOnly' as const })),
  ]

  return {
    entries,
    groups(key) {
      const a = byKey.get(key)
      if (!a) return []
      return defs.map((g) => ({
        name: g.name,
        rate: g.rateOff === null ? 0 : bytes[a.offset + g.rateOff],
        slots: Array.from({ length: g.slots }, (_, i) => {
          if (g.kind === 'land') {
            const level = bytes[a.offset + 8 + i]
            return { minLevel: level, maxLevel: level, species: rom.readU16LE(a.offset + g.slotsOff + i * 2) }
          }
          if (g.kind === 'speciesOnly')
            return { minLevel: 0, maxLevel: 0, species: rom.readU16LE(a.offset + g.slotsOff + i * 2) }
          const o = a.offset + g.slotsOff + i * 4
          return { minLevel: bytes[o], maxLevel: bytes[o + 1], species: rom.readU16LE(o + 2) }
        }),
      }))
    },
    setRate(key, group, rate) {
      const a = byKey.get(key)
      const g = defs[group]
      if (a && g && g.rateOff !== null) rom.writeU8(a.offset + g.rateOff, rate)
    },
    setSlot(key, group, slot, field, value) {
      const a = byKey.get(key)
      const g = defs[group]
      if (!a || !g || slot < 0 || slot >= g.slots) return
      if (g.kind === 'land') {
        // One level array shared by morning/day/night.
        if (field === 'minLevel' || field === 'maxLevel') rom.writeU8(a.offset + 8 + slot, value)
        else if (field === 'species') rom.writeU16LE(a.offset + g.slotsOff + slot * 2, value & 0xffff)
        return
      }
      if (g.kind === 'speciesOnly') {
        if (field === 'species') rom.writeU16LE(a.offset + g.slotsOff + slot * 2, value & 0xffff)
        return
      }
      const o = a.offset + g.slotsOff + slot * 4
      if (field === 'minLevel') rom.writeU8(o, value)
      else if (field === 'maxLevel') rom.writeU8(o + 1, value)
      else if (field === 'species') rom.writeU16LE(o + 2, value & 0xffff)
    },
    revert(key) {
      const a = byKey.get(key)
      if (a) rom.revertRange(a.offset, a.length)
    },
  }
}

export function tryBuildGen45(rom: Rom): GameAdapter | null {
  const bytes = rom.bytes
  if (!isNdsRom(bytes)) return null
  const header = parseNdsHeader(bytes)!
  const game = GAMES.find((g) => header.gameCode.startsWith(g.prefix))

  const files = listNdsFiles(bytes, header)
  let personal: { offset: number; length: number }[] | null = null
  let personalPath = ''
  for (const path of game?.paths ?? ALL_PATHS) {
    const file = findNdsFile(files, path)
    if (!file) continue
    const subs = parseNarc(bytes, file.start)
    if (subs && subs.length > 100) {
      personal = subs
      personalPath = path
      break
    }
  }
  if (!personal) return null

  const entrySize = personal[1]?.length ?? 0
  const fullLayout = entrySize === GEN4_ENTRY
  const gen5Layout = !fullLayout && (entrySize === 0x3c || entrySize === 0x4c)
  const generation = game?.gen ?? (fullLayout ? 4 : 5)
  const gameName = `${game?.name ?? 'Pokémon (DS)'} (${header.gameCode})`
  const warnings: string[] = []
  if (!fullLayout && !gen5Layout) {
    warnings.push(
      `Unrecognised personal entry size (${entrySize} bytes): stats, types and catch rate only.`,
    )
  }
  warnings.push('DS support is new — save a copy of your ROM before editing, and report anything odd.')

  // Human-readable names straight from the game's message banks. Bank
  // indices verified against the decomps: pokediamond (species 362,
  // moves 588, trainers 559, classes 560), pokeplatinum text_banks.txt
  // (412/647/618/619), pokeheartgold msgdata.c + message_format.c
  // (237/750/729/730). HGSS's msg.narc is name-stripped to /a/0/2/7.
  const code3 = header.gameCode.slice(0, 3)
  // Item banks: D/P 344 (pokediamond message_format.c), Pt 392
  // (text_banks.txt line 393), HGSS 222 (pokeheartgold BufferItemName).
  const MSG_BANKS: Record<string, { path: string; species: number; moves: number; trainers: number; classes: number; items: number }> = {
    ADA: { path: '/msgdata/msg.narc', species: 362, moves: 588, trainers: 559, classes: 560, items: 344 },
    APA: { path: '/msgdata/msg.narc', species: 362, moves: 588, trainers: 559, classes: 560, items: 344 },
    CPU: { path: '/msgdata/pl_msg.narc', species: 412, moves: 647, trainers: 618, classes: 619, items: 392 },
    IPK: { path: '/a/0/2/7', species: 237, moves: 750, trainers: 729, classes: 730, items: 222 },
    IPG: { path: '/a/0/2/7', species: 237, moves: 750, trainers: 729, classes: 730, items: 222 },
  }
  let msgSpecies: string[] = []
  let msgMoves: string[] = []
  let msgTrainers: string[] = []
  let msgClasses: string[] = []
  let msgItems: string[] = []
  let speciesBank: NarcSubfile | null = null
  let trainerBank: NarcSubfile | null = null
  let movesBank: NarcSubfile | null = null
  let msgFile: NdsFile | null = null
  let msgSubs: NarcSubfile[] | null = null
  const msgCfg = MSG_BANKS[code3]
  if (msgCfg) {
    msgFile = findNdsFile(files, msgCfg.path)
    msgSubs = msgFile ? parseNarc(bytes, msgFile.start) : null
    if (msgSubs) {
      const sub = (index: number) => msgSubs!.find((s) => s.index === index) ?? null
      const bank = (index: number) => {
        const s = sub(index)
        return s ? parseMsgBank(bytes, s.offset, s.length) : []
      }
      speciesBank = sub(msgCfg.species)
      trainerBank = sub(msgCfg.trainers)
      movesBank = sub(msgCfg.moves)
      msgSpecies = bank(msgCfg.species)
      msgMoves = bank(msgCfg.moves)
      msgTrainers = bank(msgCfg.trainers)
      msgClasses = bank(msgCfg.classes)
      msgItems = bank(msgCfg.items)
    }
  }

  // Growth path for renames that outgrow their msg-bank slot: rebuild
  // the bank, repack the msg NARC, and relocate it into the trailing
  // 0xFF/0x00 padding at the end of the ROM (retail dumps are padded
  // to a power of two), retargeting its FAT entry. Trimmed ROMs with
  // no padding simply keep the in-place-only behaviour.
  const readU32 = (o: number) => (rom.readU16LE(o) | (rom.readU16LE(o + 2) << 16)) >>> 0
  const writeU32 = (o: number, v: number) => {
    rom.writeU16LE(o, v & 0xffff)
    rom.writeU16LE(o + 2, (v >>> 16) & 0xffff)
  }
  /**
   * Replace one subfile in a NARC file, relocating the whole NARC into
   * end-of-ROM padding when it grows (FAT retarget + used-size + header
   * CRC). Returns the file's new location, or null when it can't fit.
   */
  const replaceNarcSub = (file: NdsFile, subIndex: number, data: Uint8Array): NdsFile | null => {
    const newNarc = rebuildNarcWithSubfile(bytes, file.start, subIndex, data)
    if (!newNarc) return null
    let dest = file.start
    if (newNarc.length > file.end - file.start) {
      // Free space must sit beyond every live FAT entry (read fresh —
      // an earlier growth may already have moved a file out here).
      let maxEnd = 0
      for (let f = header.fatOffset; f + 8 <= header.fatOffset + header.fatSize; f += 8) {
        maxEnd = Math.max(maxEnd, readU32(f + 4))
      }
      let padStart = bytes.length
      while (padStart > maxEnd && (bytes[padStart - 1] === 0xff || bytes[padStart - 1] === 0)) padStart--
      dest = (Math.max(padStart, maxEnd) + 0x1ff) & ~0x1ff
      if (dest + newNarc.length > bytes.length) return null
    }
    rom.writeBlock(dest, newNarc)
    const fat = header.fatOffset + file.id * 8
    writeU32(fat, dest)
    writeU32(fat + 4, dest + newNarc.length)
    if (dest + newNarc.length > readU32(0x80)) writeU32(0x80, dest + newNarc.length)
    fixNdsHeaderCrc(rom)
    return { ...file, start: dest, end: dest + newNarc.length }
  }

  const growMsgEntry = (bankIndex: number, entry: number, text: string): boolean => {
    if (!msgFile || !msgSubs) return false
    const s = msgSubs.find((x) => x.index === bankIndex)
    if (!s) return false
    const newBank = rebuildMsgBank(bytes, s.offset, s.length, entry, text)
    if (!newBank) return false
    const moved = replaceNarcSub(msgFile, bankIndex, newBank)
    if (!moved) return false
    msgFile = moved
    msgSubs = parseNarc(bytes, moved.start)
    if (!msgSubs) return false
    speciesBank = msgSubs.find((x) => x.index === msgCfg!.species) ?? null
    trainerBank = msgSubs.find((x) => x.index === msgCfg!.trainers) ?? null
    movesBank = msgSubs.find((x) => x.index === msgCfg!.moves) ?? null
    return true
  }

  // Evolutions (evo.narc / a/0/3/4): per species, 7 entries of
  // {u16 method, u16 param, u16 target} (pokeheartgold
  // pokemon_types_def.h struct Evolution + MAX_EVOS_PER_POKE).
  // Learnsets (wotbl.narc / a/0/3/3): u16s of (level << 9) | move,
  // 0xFFFF-terminated (pokemon.h LEVEL_UP_LEARNSET_*).
  const GEN4_EVO_METHODS: SelectOption[] = [
    { value: 0, label: '— none —' },
    { value: 1, label: 'Friendship' },
    { value: 2, label: 'Friendship (day)' },
    { value: 3, label: 'Friendship (night)' },
    { value: 4, label: 'Level up' },
    { value: 5, label: 'Trade' },
    { value: 6, label: 'Trade holding item' },
    { value: 7, label: 'Use item' },
    { value: 8, label: 'Level, Atk > Def' },
    { value: 9, label: 'Level, Atk = Def' },
    { value: 10, label: 'Level, Atk < Def' },
    { value: 11, label: 'Level (personality lo)' },
    { value: 12, label: 'Level (personality hi)' },
    { value: 13, label: 'Level (Ninjask)' },
    { value: 14, label: 'Level (Shedinja)' },
    { value: 15, label: 'Beauty' },
    { value: 16, label: 'Use item (male)' },
    { value: 17, label: 'Use item (female)' },
    { value: 18, label: 'Item held (day)' },
    { value: 19, label: 'Item held (night)' },
    { value: 20, label: 'Knows move' },
    { value: 21, label: 'Species in party' },
    { value: 22, label: 'Level (male)' },
    { value: 23, label: 'Level (female)' },
    { value: 24, label: 'Level at Mt. Coronet' },
    { value: 25, label: 'Level at Eterna Forest' },
    { value: 26, label: 'Level at Route 217' },
  ]
  let evoFile = findNdsFile(files, '/poketool/personal/evo.narc') ?? findNdsFile(files, '/a/0/3/4')
  const evoSubs = evoFile && fullLayout ? parseNarc(bytes, evoFile.start) : null
  let evolutions: GameAdapter['evolutions'] = null
  if (evoSubs && evoSubs.length > 100 && (evoSubs.find((s) => s.index === 1)?.length ?? 0) >= 42) {
    const subFor = (id: number) => evoSubs.find((s) => s.index === id) ?? null
    evolutions = {
      methods: GEN4_EVO_METHODS,
      itemParamMethods: [6, 7, 16, 17, 18, 19],
      read(id) {
        const s = subFor(id)
        if (!s) return []
        const out = []
        for (let slot = 0; slot < 7; slot++) {
          const o = s.offset + slot * 6
          out.push({ method: rom.readU16LE(o), param: rom.readU16LE(o + 2), target: rom.readU16LE(o + 4) })
        }
        return out
      },
      write(id, slot, field, value) {
        const s = subFor(id)
        if (!s || slot < 0 || slot >= 7) return
        const o = s.offset + slot * 6
        if (field === 'method') rom.writeU16LE(o, value)
        else if (field === 'param') rom.writeU16LE(o + 2, value)
        else if (field === 'target') rom.writeU16LE(o + 4, value)
      },
      revert(id) {
        const s = subFor(id)
        if (s) rom.revertRange(s.offset, s.length)
      },
    }
  }

  let wotblFile = findNdsFile(files, '/poketool/personal/wotbl.narc') ?? findNdsFile(files, '/a/0/3/3')
  let wotblSubs = wotblFile && fullLayout ? parseNarc(bytes, wotblFile.start) : null
  let learnsets: GameAdapter['learnsets'] = null
  if (wotblSubs && wotblSubs.length > 100) {
    learnsets = {
      read(id) {
        const s = wotblSubs!.find((x) => x.index === id)
        if (!s) return []
        const out = []
        for (let o = s.offset; o + 2 <= s.offset + s.length; o += 2) {
          const v = rom.readU16LE(o)
          if (v === 0xffff) break
          out.push({ level: v >> 9, move: v & 0x1ff })
        }
        return out
      },
      write(id, entries) {
        if (!wotblFile || !wotblSubs) return false
        const s = wotblSubs.find((x) => x.index === id)
        if (!s) return false
        const clean = entries
          .filter((e) => e.level >= 1 && e.level <= 100 && e.move >= 1 && e.move <= 0x1ff)
          .slice(0, 40)
          .sort((a, b) => a.level - b.level)
        const words = [...clean.map((e) => (e.level << 9) | e.move), 0xffff]
        if (words.length * 2 <= s.length) {
          // Fits in place; pad the tail with terminators.
          words.forEach((w, i) => rom.writeU16LE(s.offset + i * 2, w))
          for (let o = words.length * 2; o + 2 <= s.length; o += 2) {
            rom.writeU16LE(s.offset + o, 0xffff)
          }
          return true
        }
        // Grow the subfile: rebuild + relocate the wotbl NARC.
        const data = new Uint8Array(words.length * 2)
        words.forEach((w, i) => {
          data[i * 2] = w & 0xff
          data[i * 2 + 1] = (w >> 8) & 0xff
        })
        const moved = replaceNarcSub(wotblFile, id, data)
        if (!moved) return false
        wotblFile = moved
        wotblSubs = parseNarc(bytes, moved.start)
        return wotblSubs !== null
      },
    }
  }

  // Move data (MoveTbl, 16 bytes/move — verified against pokeplatinum
  // move_table.h and pokeheartgold move.h, identical layouts): effect
  // u16, category u8, power u8, type u8, accuracy u8 (percent), pp u8,
  // effectChance u8, range u16, priority s8, flags u8, contest x4.
  const WAZA_PATHS: Record<string, string> = {
    ADA: '/poketool/waza/waza_tbl.narc',
    APA: '/poketool/waza/waza_tbl.narc',
    CPU: '/poketool/waza/pl_waza_tbl.narc',
    IPK: '/a/0/1/1', // waza_tbl.narc, name-stripped
    IPG: '/a/0/1/1',
  }
  let waza: NarcSubfile[] | null = null
  if (WAZA_PATHS[code3]) {
    const file = findNdsFile(files, WAZA_PATHS[code3])
    const subs = file ? parseNarc(bytes, file.start) : null
    if (subs && subs.length > 400 && subs[1]?.length === 16) waza = subs
  }

  // Sprites: the pokegra NARC (6 subfiles per species — see
  // src/core/nds/pokegra.ts). D/P scramble differs from Pt/HGSS.
  const GRA_PATHS: Record<string, { path: string; mode: 'dp' | 'pt' }> = {
    ADA: { path: '/poketool/pokegra/pokegra.narc', mode: 'dp' },
    APA: { path: '/poketool/pokegra/pokegra.narc', mode: 'dp' },
    CPU: { path: '/poketool/pokegra/pl_pokegra.narc', mode: 'pt' },
    IPK: { path: '/a/0/0/4', mode: 'pt' },
    IPG: { path: '/a/0/0/4', mode: 'pt' },
  }
  let pokegra: ReturnType<typeof buildPokegra> = null
  if (GRA_PATHS[code3]) {
    const file = findNdsFile(files, GRA_PATHS[code3].path)
    const subs = file ? parseNarc(bytes, file.start) : null
    if (subs && subs.length > 600) {
      pokegra = buildPokegra(rom, subs, GRA_PATHS[code3].mode, personal.length - 1)
    }
  }

  const moveHandles = msgMoves
    .map((name, id) => ({ id, label: `${String(id).padStart(3, '0')} ${name}`, name }))
    .filter((m) => m.id > 0 && m.name.length > 0)

  const speciesCount = personal.length - 1
  const speciesName = (id: number) => msgSpecies[id] || NATDEX_NAMES[id - 1] || `Extra entry #${id}`
  const species: EntryHandle[] = []
  for (let id = 1; id <= speciesCount; id++) {
    species.push({
      id,
      label: `#${String(id).padStart(3, '0')} ${speciesName(id)}`,
      name: speciesName(id),
    })
  }

  const abilityOptions: SelectOption[] = [
    { value: 0, label: '— none —' },
    ...NATDEX_ABILITIES.map((label, i) => ({ value: i + 1, label })),
  ]
  const evOptions = [0, 1, 2, 3].map((v) => ({ value: v, label: String(v) }))
  const itemField = (key: string, label: string): FieldSpec =>
    msgItems.length > 1
      ? { key, label, kind: 'select', options: msgItems.map((l, value) => ({ value, label: value === 0 ? '— none —' : l || `Item #${value}` })), group: 'battle' }
      : { key, label, kind: 'number', min: 0, max: 65535, group: 'battle', help: 'Item ID (0 = none).' }
  const tmLabels: string[] = []
  for (let i = 0; i < 128; i++) {
    tmLabels.push(i < 92 ? `TM${String(i + 1).padStart(2, '0')}` : i < 100 ? `HM${String(i - 91).padStart(2, '0')}` : '(unused)')
  }

  const minimalFields: FieldSpec[] = [
    { key: 'hp', label: 'HP', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'atk', label: 'Attack', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'def', label: 'Defense', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'spd', label: 'Speed', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'sat', label: 'Sp. Attack', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'sdf', label: 'Sp. Defense', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'type1', label: 'Type 1', kind: 'type', group: 'typing' },
    { key: 'type2', label: 'Type 2', kind: 'type', group: 'typing' },
    { key: 'catchRate', label: 'Catch rate', kind: 'number', min: 1, max: 255, group: 'battle' },
  ]
  const speciesFields: FieldSpec[] = fullLayout
    ? [
        ...minimalFields,
        { key: 'baseExp', label: 'Base EXP yield', kind: 'number', min: 0, max: 255, group: 'battle' },
        { key: 'growthRate', label: 'Level curve', kind: 'select', options: GEN3_GROWTH, group: 'battle' },
        itemField('item1', 'Wild held item (common)'),
        itemField('item2', 'Wild held item (rare)'),
        { key: 'ability1', label: 'Ability 1', kind: 'select', options: abilityOptions, group: 'typing' },
        { key: 'ability2', label: 'Ability 2', kind: 'select', options: abilityOptions, group: 'typing' },
        { key: 'evHp', label: 'EV yield: HP', kind: 'select', options: evOptions, group: 'evs' },
        { key: 'evAtk', label: 'EV yield: Attack', kind: 'select', options: evOptions, group: 'evs' },
        { key: 'evDef', label: 'EV yield: Defense', kind: 'select', options: evOptions, group: 'evs' },
        { key: 'evSpd', label: 'EV yield: Speed', kind: 'select', options: evOptions, group: 'evs' },
        { key: 'evSat', label: 'EV yield: Sp. Atk', kind: 'select', options: evOptions, group: 'evs' },
        { key: 'evSdf', label: 'EV yield: Sp. Def', kind: 'select', options: evOptions, group: 'evs' },
        { key: 'gender', label: 'Gender ratio', kind: 'select', options: GENDER_RATIOS, group: 'breeding' },
        { key: 'eggCycles', label: 'Egg cycles', kind: 'number', min: 1, max: 255, group: 'breeding' },
        { key: 'friendship', label: 'Base friendship', kind: 'number', min: 0, max: 255, group: 'breeding' },
        { key: 'eggGroup1', label: 'Egg group 1', kind: 'select', options: EGG_GROUPS, group: 'breeding' },
        { key: 'eggGroup2', label: 'Egg group 2', kind: 'select', options: EGG_GROUPS, group: 'breeding' },
        { key: 'tmhm', label: 'TM / HM compatibility', kind: 'flags', flagLabels: tmLabels, group: 'tmhm' },
      ]
    : gen5Layout
      ? [
          ...minimalFields,
          { key: 'baseExp', label: 'Base EXP yield', kind: 'number' as const, min: 0, max: 65535, group: 'battle' },
          { key: 'growthRate', label: 'Level curve', kind: 'select' as const, options: GEN3_GROWTH, group: 'battle' },
          itemField('item1', 'Wild held item (50%)'),
          itemField('item2', 'Wild held item (5%)'),
          itemField('item3', 'Wild held item (1%)'),
          { key: 'ability1', label: 'Ability 1', kind: 'select' as const, options: abilityOptions, group: 'typing' },
          { key: 'ability2', label: 'Ability 2', kind: 'select' as const, options: abilityOptions, group: 'typing' },
          { key: 'abilityH', label: 'Hidden ability', kind: 'select' as const, options: abilityOptions, group: 'typing' },
          { key: 'evHp', label: 'EV yield: HP', kind: 'select' as const, options: evOptions, group: 'evs' },
          { key: 'evAtk', label: 'EV yield: Attack', kind: 'select' as const, options: evOptions, group: 'evs' },
          { key: 'evDef', label: 'EV yield: Defense', kind: 'select' as const, options: evOptions, group: 'evs' },
          { key: 'evSpd', label: 'EV yield: Speed', kind: 'select' as const, options: evOptions, group: 'evs' },
          { key: 'evSat', label: 'EV yield: Sp. Atk', kind: 'select' as const, options: evOptions, group: 'evs' },
          { key: 'evSdf', label: 'EV yield: Sp. Def', kind: 'select' as const, options: evOptions, group: 'evs' },
          { key: 'gender', label: 'Gender ratio', kind: 'select' as const, options: GENDER_RATIOS, group: 'breeding' },
          { key: 'eggCycles', label: 'Egg cycles', kind: 'number' as const, min: 1, max: 255, group: 'breeding' },
          { key: 'friendship', label: 'Base friendship', kind: 'number' as const, min: 0, max: 255, group: 'breeding' },
          { key: 'eggGroup1', label: 'Egg group 1', kind: 'select' as const, options: EGG_GROUPS, group: 'breeding' },
          { key: 'eggGroup2', label: 'Egg group 2', kind: 'select' as const, options: EGG_GROUPS, group: 'breeding' },
          {
            key: 'tmhm',
            label: 'TM / HM compatibility',
            kind: 'flags' as const,
            flagLabels: Array.from({ length: GEN5_TM_FLAGS }, (_, i) =>
              i < 95 ? `TM${String(i + 1).padStart(2, '0')}` : `HM${String(i - 94).padStart(2, '0')}`,
            ),
            group: 'tmhm',
          },
        ]
      : minimalFields
  const statBytes = gen5Layout ? GEN5_STAT_BYTES : STAT_BYTES
  const editableStatKeys = new Set(speciesFields.filter((f) => f.key in statBytes).map((f) => f.key))

  const base = (id: number) => personal![id].offset

  // Trainers and encounters (Gen 4 only; HGSS encounters differ).
  let trainerModule: TrainerModule | null = null
  let wildModule: WildModule | null = null
  const regions = [
    {
      name: `Personal data (${personalPath}, ${speciesCount} species)`,
      offset: personal[0].offset,
      length: personal.length * entrySize,
    },
  ]
  if (fullLayout) {
    // HGSS ships the same trainer NARCs with their names stripped
    // (poketool/trainer/trdata.narc → a/0/5/5 per pokeheartgold's
    // filesystem.mk); the party entry and header layouts are identical.
    const trd = findNdsFile(files, '/poketool/trainer/trdata.narc') ?? findNdsFile(files, '/a/0/5/5')
    const trp = findNdsFile(files, '/poketool/trainer/trpoke.narc') ?? findNdsFile(files, '/a/0/5/6')
    if (trd && trp) {
      const dSubs = parseNarc(bytes, trd.start)
      const pSubs = parseNarc(bytes, trp.start)
      if (dSubs && pSubs && dSubs.length > 50) {
        trainerModule = buildGen4Trainers(rom, dSubs, pSubs, {
          trainers: msgTrainers,
          classes: msgClasses,
          rename: trainerBank
            ? (id, name) =>
                writeMsgEntry(rom, trainerBank!.offset, trainerBank!.length, id, name) ||
                growMsgEntry(msgCfg!.trainers, id, name)
            : null,
        })
        regions.push({ name: `Trainers (${trainerModule.entries.length})`, offset: trd.start, length: trd.end - trd.start })
      }
    }
    const code = header.gameCode.slice(0, 3)
    const encPath = {
      CPU: '/fielddata/encountdata/pl_enc_data.narc',
      ADA: '/fielddata/encountdata/d_enc_data.narc',
      APA: '/fielddata/encountdata/p_enc_data.narc',
      IPK: '/a/0/3/7', // HeartGold g_enc_data.narc, name-stripped
      IPG: '/a/1/3/6', // SoulSilver s_enc_data.narc
    }[code]
    if (encPath) {
      const enc = findNdsFile(files, encPath)
      const encSubs = enc ? parseNarc(bytes, enc.start) : null
      if (encSubs) {
        wildModule =
          code === 'IPK' || code === 'IPG' ? buildHgssWild(rom, encSubs) : buildGen4Wild(rom, encSubs)
        if (wildModule) {
          regions.push({ name: `Wild encounters (${wildModule.entries.length} areas)`, offset: enc!.start, length: enc!.end - enc!.start })
        }
      }
    }
  }
  if (!trainerModule) warnings.push('Trainer editing not available for this DS game yet.')
  if (!wildModule) warnings.push('Wild encounter editing not available for this DS game yet (D/P/Pt/HGSS so far).')

  return {
    gameName,
    platform: 'NDS',
    generation,
    rom,
    regions,
    warnings,
    species,
    speciesFields,
    typeOptions: generation === 5 ? GEN5_TYPES : GEN3_TYPES,
    mapModule: null,
    trainerModule,
    wildModule,
    itemOptions:
      msgItems.length > 1
        ? msgItems.map((label, value) => ({ value, label: value === 0 ? '— none —' : label || `Item #${value}` }))
        : null,
    speciesSprite: pokegra ? (id, shiny) => pokegra!.front(id, shiny ?? false) : null,
    speciesSpriteBack: pokegra ? (id, shiny) => pokegra!.back(id, shiny ?? false) : null,
    hasShinySprites: pokegra !== null,
    importSpeciesSprite: pokegra ? (id, image) => pokegra!.importFront(id, image) : null,
    importSpeciesSpriteBack: pokegra ? (id, image) => pokegra!.importBack(id, image) : null,
    evolutions,
    learnsets,
    typeChart: null,
    // Msg-bank rename: written in place when the new name fits the
    // entry's original allocation; otherwise the bank is rebuilt and
    // the msg NARC relocated into end-of-ROM padding (FAT retarget).
    speciesNameLength: speciesBank ? 12 : null,
    setSpeciesName(id, name) {
      if (!speciesBank || name.length === 0) return false
      if (
        !writeMsgEntry(rom, speciesBank.offset, speciesBank.length, id, name) &&
        !growMsgEntry(msgCfg!.species, id, name)
      )
        return false
      msgSpecies[id] = name
      const handle = species[id - 1]
      if (handle) {
        handle.name = name
        handle.label = `#${String(id).padStart(3, '0')} ${name}`
      }
      return true
    },

    readSpecies(id) {
      const o = base(id)
      const out: Record<string, FieldValue> = {}
      for (const key of editableStatKeys) out[key] = bytes[o + statBytes[key]]
      if (fullLayout || gen5Layout) {
        // EV bitfield and TM flags share their layout between Gen 4 and
        // Gen 5; item and TM offsets differ.
        out.item1 = rom.readU16LE(o + (gen5Layout ? 0x0c : 12))
        out.item2 = rom.readU16LE(o + (gen5Layout ? 0x0e : 14))
        if (gen5Layout) {
          out.item3 = rom.readU16LE(o + 0x10)
          out.baseExp = rom.readU16LE(o + 0x22)
        }
        const ev = rom.readU16LE(o + 10)
        for (const [key, idx] of EV_STATS) out[key] = (ev >> (idx * 2)) & 3
        const tmOff = gen5Layout ? GEN5_TMHM : 28
        const tmCount = gen5Layout ? GEN5_TM_FLAGS : 128
        const flags: boolean[] = []
        for (let i = 0; i < tmCount; i++) {
          flags.push(((bytes[o + tmOff + (i >> 3)] >> (i & 7)) & 1) === 1)
        }
        out.tmhm = flags
      }
      return out
    },

    writeSpeciesField(id, key, value) {
      const o = base(id)
      if (key === 'tmhm' && Array.isArray(value) && (fullLayout || gen5Layout)) {
        const flags = value as boolean[]
        const tmOff = gen5Layout ? GEN5_TMHM : 28
        const byteCount = gen5Layout ? Math.ceil(GEN5_TM_FLAGS / 8) : 16
        for (let b = 0; b < byteCount; b++) {
          let v = 0
          for (let bit = 0; bit < 8; bit++) if (flags[b * 8 + bit]) v |= 1 << bit
          rom.writeU8(o + tmOff + b, v)
        }
        return
      }
      if (typeof value !== 'number') return
      if ((fullLayout || gen5Layout) && key === 'item1') return rom.writeU16LE(o + (gen5Layout ? 0x0c : 12), value)
      if ((fullLayout || gen5Layout) && key === 'item2') return rom.writeU16LE(o + (gen5Layout ? 0x0e : 14), value)
      if (gen5Layout && key === 'item3') return rom.writeU16LE(o + 0x10, value)
      if (gen5Layout && key === 'baseExp') return rom.writeU16LE(o + 0x22, value)
      const ev = EV_STATS.find(([k]) => k === key)
      if (ev && (fullLayout || gen5Layout)) {
        const cur = rom.readU16LE(o + 10)
        rom.writeU16LE(o + 10, (cur & ~(3 << (ev[1] * 2))) | ((value & 3) << (ev[1] * 2)))
        return
      }
      if (editableStatKeys.has(key)) rom.writeU8(o + statBytes[key], value)
    },

    revertSpecies(id) {
      rom.revertRange(base(id), entrySize)
    },

    // Move names feed the party-move dropdowns and the Moves editor.
    moves: moveHandles,
    moveFields: waza
      ? [
          { key: 'power', label: 'Power', kind: 'number', min: 0, max: 255 },
          { key: 'type', label: 'Type', kind: 'type' },
          {
            key: 'category',
            label: 'Category',
            kind: 'select',
            options: [
              { value: 0, label: 'Physical' },
              { value: 1, label: 'Special' },
              { value: 2, label: 'Status' },
            ],
          },
          { key: 'accuracy', label: 'Accuracy %', kind: 'number', min: 0, max: 100 },
          { key: 'pp', label: 'PP', kind: 'number', min: 0, max: 63 },
          { key: 'effect', label: 'Effect ID', kind: 'number', min: 0, max: 65535 },
          { key: 'effectChance', label: 'Effect chance %', kind: 'number', min: 0, max: 100 },
          { key: 'priority', label: 'Priority', kind: 'number', min: -7, max: 7 },
        ]
      : [],
    // Move renames ride the same msg-bank machinery as species names:
    // in place when the new name fits, NARC growth path otherwise.
    moveNameLength: movesBank ? 16 : null,
    setMoveName(id, name) {
      if (!movesBank || name.length === 0 || id <= 0 || id >= msgMoves.length) return false
      if (
        !writeMsgEntry(rom, movesBank.offset, movesBank.length, id, name) &&
        !growMsgEntry(msgCfg!.moves, id, name)
      )
        return false
      msgMoves[id] = name
      const handle = moveHandles.find((m) => m.id === id)
      if (handle) {
        handle.name = name
        handle.label = `${String(id).padStart(3, '0')} ${name}`
      }
      return true
    },
    readMove(id) {
      const out: Record<string, FieldValue> = {}
      if (!waza?.[id]) return out
      const o = waza[id].offset
      const prio = bytes[o + 10]
      out.effect = rom.readU16LE(o)
      out.category = bytes[o + 2]
      out.power = bytes[o + 3]
      out.type = bytes[o + 4]
      out.accuracy = bytes[o + 5]
      out.pp = bytes[o + 6]
      out.effectChance = bytes[o + 7]
      out.priority = prio >= 128 ? prio - 256 : prio
      return out
    },
    writeMoveField(id, key, value) {
      if (!waza?.[id] || typeof value !== 'number') return
      const o = waza[id].offset
      if (key === 'effect') rom.writeU16LE(o, value)
      else if (key === 'category') rom.writeU8(o + 2, value)
      else if (key === 'power') rom.writeU8(o + 3, value)
      else if (key === 'type') rom.writeU8(o + 4, value)
      else if (key === 'accuracy') rom.writeU8(o + 5, value)
      else if (key === 'pp') rom.writeU8(o + 6, value)
      else if (key === 'effectChance') rom.writeU8(o + 7, value)
      else if (key === 'priority') rom.writeU8(o + 10, value < 0 ? value + 256 : value)
    },
    revertMove(id) {
      if (waza?.[id]) rom.revertRange(waza[id].offset, 16)
    },
  }
}
