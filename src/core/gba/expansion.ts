/**
 * pokeemerald-expansion data discovery.
 *
 * The expansion (and the large family of hacks built on it) keeps
 * vanilla Gen 3's ROM layout but replaces the *content* of nearly every
 * per-species and per-move table, so `games/gen3.ts` finds nothing:
 *
 *  - `gSpeciesInfo` grows from a 28-byte struct to one that carries the
 *    species' name, dex text, sprites, learnsets and evolutions inline.
 *    Its size depends on build-time config flags (`P_GENDER_DIFFERENCES`,
 *    `P_FOOTPRINTS`, `OW_POKEMON_OBJECT_EVENTS`, …), so the stride is
 *    discovered per ROM rather than assumed.
 *  - `gMovesInfo` replaces the 12-byte move struct with a bitfield-packed
 *    one whose name and description are pointers, not inline text.
 *  - Learnsets and evolutions are per-species pointers inside
 *    `gSpeciesInfo` instead of global pointer tables.
 *  - Type/ability/item names live in their own info structs.
 *
 * Discovery therefore works in two layers, and the split matters:
 *
 *  - **Table base and stride are discovered per ROM** (invariant 1): a
 *    spread of name anchors at known indices vote on a (stride, base)
 *    pair, and every pair of anchors must agree before we trust it.
 *  - **Offsets of fields *within* an entry are format constants**, in
 *    the same way "byte 8 is the catch rate" is a constant for vanilla
 *    Gen 3. Every one below was read off the annotated decomp structs
 *    AND verified byte-for-byte against a built expansion ROM; the
 *    layout is re-validated structurally before any editor is enabled,
 *    so a build whose head layout differs is rejected, never guessed at.
 */
import type { Rom } from '../rom'
import { toTitleCase } from '../text'
import { findAllMulti } from '../scan'
import { EVO_CONDITIONS_END, GEN3_EVO_CONDITIONS } from '../games/gen3-evo-conditions'
import { GBA_ROM_BASE, findFreeSpaceAtEnd, readGbaPointer, writeGbaPointer } from '../freespace'
import type { RenderedImage, WildGroup, WildModule, WildSlot } from '../games/schema'
import { lz77Compress } from './lz77'
import { compressedSize, decompressGraphics, isLz77 } from './compress'
import type { SpriteViewer } from './sprites'
import { decodeTile4bpp, encodeTile4bpp, readPalette, renderTilesRgba, rgbToBgr555 } from '../tiles'
import { gen3Bytes, gen3Codec, gen3DecodeText, gen3EncodeText } from '../text'

/* ------------------------------------------------------------------ */
/* struct SpeciesInfo — the head, which no config flag can move        */
/* ------------------------------------------------------------------ */

/**
 * Every field up to and including `speciesName` is unconditional in the
 * expansion's `struct SpeciesInfo`, so these offsets hold regardless of
 * which optional features the hack enabled. Verified against a built
 * ROM: Bulbasaur reads 45/49/49/45/65/65, Grass(13)/Poison(4), catch 45,
 * exp 64, 1 Sp.Atk EV, 12.5% female (31), 20 egg cycles, friendship 50,
 * growth 3, Monster(1)/Grass(7), Overgrow(65)/-/Chlorophyll(34).
 */
export const SP = {
  hp: 0,
  atk: 1,
  def: 2,
  spd: 3,
  sat: 4,
  sdf: 5,
  type1: 6,
  type2: 7,
  catchRate: 8,
  forceTeraType: 9,
  expYield: 10, // u16 — widened from u8 for the new EXP system
  evYield: 12, // u16 bitfield, 2 bits per stat in HP/Atk/Def/Spd/SpA/SpD order
  itemCommon: 14, // u16 — `enum Item` is 2 bytes (over 255 items)
  itemRare: 16,
  genderRatio: 18,
  eggCycles: 19,
  friendship: 20,
  growthRate: 21,
  eggGroup1: 22,
  eggGroup2: 23,
  abilities: 24, // u16 × NUM_ABILITY_SLOTS (3)
  safariFleeRate: 30,
  categoryName: 31, // 13 bytes, 0xFF-terminated
  speciesName: 44, // POKEMON_NAME_LENGTH (12) + terminator
} as const

export const SPECIES_NAME_LEN = 13
export const CATEGORY_NAME_LEN = 13
export const ABILITY_SLOTS = 3

/**
 * Sprite pointers. These sit after the dex block but still before the
 * first `#if`, so they too are unconditional.
 */
export const SP_GFX = {
  frontPic: 88,
  backPic: 92,
  palette: 96,
  shinyPalette: 100,
} as const

/**
 * The move-data pointer block at the tail of the struct. Everything
 * between the sprite pointers and this block IS config-dependent, so
 * `levelUpLearnset`'s offset is discovered per ROM (see
 * `findSpeciesPointerBlock`) and the rest are read relative to it —
 * their order inside the block is fixed by the struct.
 */
export const PTR_BLOCK = {
  levelUpLearnset: 0,
  teachableLearnset: 4,
  eggMoveLearnset: 8,
  evolutions: 12,
} as const

export const LEVEL_UP_MOVE_END = 0xffff
export const EVOLUTIONS_END = 0xffff
export const MOVE_UNAVAILABLE = 0xffff

/* ------------------------------------------------------------------ */
/* generic discovery helpers                                           */
/* ------------------------------------------------------------------ */

export interface TableLocation {
  /** Offset of entry 0. */
  base: number
  /** Bytes per entry. */
  stride: number
  /** How many independent anchor pairs agreed. */
  votes: number
}

/**
 * Vote a (base, stride) pair out of anchor hits at known indices.
 *
 * Each *pair* of anchors implies a stride — `(hitB - hitA) / (idxB -
 * idxA)` — and a base. Requiring at least two pairs to agree means no
 * single renamed or moved anchor can carry a wrong answer, which is the
 * same guarantee `findByVote` gives for fixed-stride vanilla tables but
 * without needing to know the stride up front.
 */
export function voteTable(
  hits: { index: number; offsets: number[] }[],
  opts: { minStride: number; maxStride: number; align?: number; minVotes?: number },
): TableLocation | null {
  const align = opts.align ?? 4
  const minVotes = opts.minVotes ?? 2
  const votes = new Map<string, number>()
  for (let a = 0; a < hits.length; a++) {
    for (let b = a + 1; b < hits.length; b++) {
      const di = hits[b].index - hits[a].index
      if (di === 0) continue
      for (const oa of hits[a].offsets) {
        for (const ob of hits[b].offsets) {
          const d = ob - oa
          if (d % di !== 0) continue
          const stride = d / di
          if (stride < opts.minStride || stride > opts.maxStride) continue
          if (stride % align !== 0) continue
          const base = oa - hits[a].index * stride
          if (base < 0) continue
          const key = `${base}:${stride}`
          votes.set(key, (votes.get(key) ?? 0) + 1)
        }
      }
    }
  }
  let best: TableLocation | null = null
  for (const [key, v] of votes) {
    if (best !== null && v <= best.votes) continue
    const [base, stride] = key.split(':').map(Number)
    best = { base, stride, votes: v }
  }
  return best !== null && best.votes >= minVotes ? best : null
}

/** Read a 0xFF-terminated string of at most `max` bytes. */
export function readText(bytes: Uint8Array, off: number, max = 64): string {
  if (off < 0 || off >= bytes.length) return ''
  return gen3DecodeText(bytes.subarray(off, Math.min(off + max, bytes.length)))
}

/**
 * Every 4-aligned u32 in the ROM that points at one of `targets`, in a
 * single pass. Locating five tables by their name pointers otherwise
 * means five full scans of a 32 MB ROM.
 */
export function findPointerRefs(bytes: Uint8Array, targets: number[]): Map<number, number[]> {
  const out = new Map<number, number[]>()
  for (const t of targets) out.set(t, [])
  if (targets.length === 0) return out
  // Prefilter on the low 16 bits so the great majority of words are
  // rejected by one byte-array lookup instead of a Map probe.
  const low = new Uint8Array(0x10000)
  const want = new Map<number, number>()
  for (const t of targets) {
    const v = (t + GBA_ROM_BASE) >>> 0
    low[v & 0xffff] = 1
    want.set(v, t)
  }
  const end = bytes.length - 3
  for (let i = 0; i < end; i += 4) {
    if (low[bytes[i] | (bytes[i + 1] << 8)] === 0) continue
    const v = ((bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0)
    const target = want.get(v)
    if (target !== undefined) out.get(target)!.push(i)
  }
  return out
}

/**
 * One sweep for every anchor in the ROM.
 *
 * Species, move, type, ability and item tables are each found from a
 * handful of name anchors. Scanning for them separately cost a full
 * sweep per table — about a second each on a 32 MB ROM — so all the
 * patterns are matched in a single pass here, and the two tables that
 * store their names behind a pointer share one pass for the pointer
 * refs too. Discovery is otherwise unchanged; this is purely about not
 * reading the ROM five times over.
 */
export interface AnchorScan {
  /** group name → per-anchor offsets of the name TEXT. */
  text: Map<string, number[][]>
  /** text offset → the 4-aligned u32s pointing at it. */
  refs: Map<number, number[]>
}

export interface AnchorGroup {
  name: string
  anchors: { index: number; name: string }[]
  /** True when entries point at their name instead of storing it inline. */
  byPointer?: boolean
}

export function scanAnchors(bytes: Uint8Array, groups: AnchorGroup[]): AnchorScan {
  const patterns: number[][] = []
  const owner: { group: string; anchor: number }[] = []
  for (const g of groups) {
    g.anchors.forEach((a, i) => {
      for (const variant of nameVariants(a.name)) {
        patterns.push([...gen3Bytes(variant), 0xff])
        owner.push({ group: g.name, anchor: i })
      }
    })
  }
  const found = findAllMulti(bytes, patterns, 24)

  const text = new Map<string, number[][]>()
  for (const g of groups) text.set(g.name, g.anchors.map(() => []))
  found.forEach((offsets, pi) => {
    const { group, anchor } = owner[pi]
    text.get(group)![anchor].push(...offsets)
  })

  const pointerTexts: number[] = []
  for (const g of groups) {
    if (!g.byPointer) continue
    for (const offsets of text.get(g.name)!) pointerTexts.push(...offsets)
  }
  return { text, refs: findPointerRefs(bytes, pointerTexts) }
}

/**
 * Locate a table whose entries store a name INLINE at a fixed offset
 * (species, types, abilities).
 */
export function findInlineNameTable(
  scan: AnchorScan,
  group: string,
  anchors: { index: number; name: string }[],
  nameOffset: number,
  opts: { minStride: number; maxStride: number; minVotes?: number },
): TableLocation | null {
  const text = scan.text.get(group) ?? []
  const hits = anchors.map((a, i) => ({
    index: a.index,
    offsets: (text[i] ?? []).map((o) => o - nameOffset),
  }))
  return voteTable(hits, opts)
}

/**
 * Locate a table whose entries store a POINTER to their name (moves,
 * items).
 */
export function findPointerNameTable(
  scan: AnchorScan,
  group: string,
  anchors: { index: number; name: string }[],
  nameFieldOffset: number,
  opts: { minStride: number; maxStride: number; minVotes?: number },
): TableLocation | null {
  const text = scan.text.get(group) ?? []
  const hits = anchors.map((a, i) => ({
    index: a.index,
    offsets: (text[i] ?? []).flatMap((o) => (scan.refs.get(o) ?? []).map((r) => r - nameFieldOffset)),
  }))
  return voteTable(hits, opts)
}

/** "Karate Chop" → itself, "KARATE CHOP" — the two casings hacks use. */
function nameVariants(name: string): string[] {
  const upper = name.toUpperCase()
  return upper === name ? [name] : [name, upper]
}

/* ------------------------------------------------------------------ */
/* gSpeciesInfo                                                        */
/* ------------------------------------------------------------------ */

/**
 * Spread across the dex so that renaming any few of them — which hacks
 * do constantly — cannot break discovery. All are base species, whose
 * `SPECIES_` ids the expansion keeps in national dex order.
 */
const SPECIES_ANCHORS = [
  { index: 1, name: 'Bulbasaur' },
  { index: 4, name: 'Charmander' },
  { index: 7, name: 'Squirtle' },
  { index: 25, name: 'Pikachu' },
  { index: 94, name: 'Gengar' },
  { index: 130, name: 'Gyarados' },
  { index: 150, name: 'Mewtwo' },
  { index: 249, name: 'Lugia' },
  { index: 384, name: 'Rayquaza' },
]

export interface SpeciesTable extends TableLocation {
  /** Number of usable entries; ids run 1..count (0 is SPECIES_NONE). */
  count: number
  /** Discovered offset of the levelUpLearnset pointer within an entry. */
  pointerBlock: number | null
}

/** Does this entry look like a filled-in `struct SpeciesInfo`? */
function speciesEntrySane(bytes: Uint8Array, off: number, stride: number): boolean {
  if (off + stride > bytes.length) return false
  if (bytes[off + SP.growthRate] > 5) return false
  if (bytes[off + SP.eggGroup1] > 15 || bytes[off + SP.eggGroup2] > 15) return false
  // Both name fields must be terminated inside their fixed width.
  const name = bytes.subarray(off + SP.speciesName, off + SP.speciesName + SPECIES_NAME_LEN)
  const cat = bytes.subarray(off + SP.categoryName, off + SP.categoryName + CATEGORY_NAME_LEN)
  return name.indexOf(0xff) >= 0 && cat.indexOf(0xff) >= 0
}

export function findSpeciesTable(bytes: Uint8Array, scan = scanExpansion(bytes)): SpeciesTable | null {
  const found = findInlineNameTable(scan, 'species', SPECIES_ANCHORS, SP.speciesName, {
    // A vanilla-sized 28-byte entry can never be an expansion struct;
    // the smallest real one is ~0xC4, the largest seen ~0x2xx.
    minStride: 0x80,
    maxStride: 0x400,
  })
  if (!found) return null

  // Independent structural verification: entry 0 must be SPECIES_NONE
  // (all-zero stats) and a long run of real entries must follow.
  const zeroStats = [0, 1, 2, 3, 4, 5].every((i) => bytes[found.base + i] === 0)
  if (!zeroStats) return null

  let count = 1
  while (count < 4096 && speciesEntrySane(bytes, found.base + count * found.stride, found.stride)) count++
  count -= 1 // ids run 1..count
  if (count < 100) return null

  return { ...found, count, pointerBlock: findSpeciesPointerBlock(bytes, found, count) }
}

/**
 * Find `levelUpLearnset` inside the entry.
 *
 * Its offset shifts with the optional sprite/footprint/overworld fields
 * ahead of it, so it is voted for rather than assumed: the winning
 * offset is the one where, across a wide sample of species, the u32
 * dereferences to something that parses as a `struct LevelUpMove` array
 * terminated by LEVEL_UP_MOVE_END. Almost every species has a level-up
 * learnset, so the true field scores near-unanimously while unrelated
 * pointer fields (sprites, palettes, dex text) score near zero.
 */
function findSpeciesPointerBlock(bytes: Uint8Array, table: TableLocation, count: number): number | null {
  const sample: number[] = []
  for (let id = 1; id <= count; id += Math.max(1, Math.floor(count / 300))) sample.push(id)
  let best: { offset: number; score: number } | null = null
  // The block is after the sprite pointers and 16 bytes short of the end.
  for (let k = SP_GFX.shinyPalette + 4; k + 16 <= table.stride; k += 4) {
    let score = 0
    for (const id of sample) {
      const p = readGbaPointer(bytes, table.base + id * table.stride + k)
      if (p !== null && parseLevelUpLearnset(bytes, p) !== null) score++
    }
    if (best === null || score > best.score) best = { offset: k, score }
  }
  // Demand a strong majority; a weak winner means we found nothing.
  return best !== null && best.score >= sample.length * 0.75 ? best.offset : null
}

/* ------------------------------------------------------------------ */
/* per-species blobs                                                   */
/* ------------------------------------------------------------------ */

export interface LevelUpMove {
  level: number
  move: number
}

/** `struct LevelUpMove { u16 move; u16 level; }`, LEVEL_UP_MOVE_END. */
export function parseLevelUpLearnset(bytes: Uint8Array, off: number): LevelUpMove[] | null {
  const out: LevelUpMove[] = []
  for (let p = off; p + 4 <= bytes.length && out.length <= 128; p += 4) {
    const move = bytes[p] | (bytes[p + 1] << 8)
    if (move === LEVEL_UP_MOVE_END) return out
    const level = bytes[p + 2] | (bytes[p + 3] << 8)
    if (move === 0 || level > 200) return null
    out.push({ level, move })
  }
  return null
}

export interface EvolutionCondition {
  condition: number
  args: [number, number, number]
}

export interface ExpansionEvolution {
  method: number
  param: number
  target: number
  /**
   * Extra requirements hanging off this evolution. The expansion moved
   * friendship, time of day, held items and the rest out of `method`
   * into this list, which is why so many EVO_LEVEL entries carry a
   * param of 0 - the real requirement lives here.
   */
  conditions: EvolutionCondition[]
  /** Where the condition list lives, or null when there is none. */
  conditionsOffset: number | null
}

/**
 * `struct Evolution { u16 method; u16 param; u16 targetSpecies; const
 * struct EvolutionParam *params; }` — 12 bytes, not 8: the pointer
 * forces 4-byte alignment and two bytes of padding after
 * `targetSpecies`. Verified on a built ROM (Bulbasaur: method 1, param
 * 16, target 2, params NULL; Pikachu: two EVO_ITEM entries with a
 * non-null params pointer each), and the padding and `params` pointer
 * are preserved verbatim on write.
 */
export const EVOLUTION_ENTRY = 12

export function parseEvolutions(
  bytes: Uint8Array,
  off: number,
  speciesCount: number,
): ExpansionEvolution[] | null {
  const out: ExpansionEvolution[] = []
  for (let p = off; p + EVOLUTION_ENTRY <= bytes.length && out.length <= 32; p += EVOLUTION_ENTRY) {
    const method = bytes[p] | (bytes[p + 1] << 8)
    if (method === EVOLUTIONS_END) return out
    if (method === 0 || method > 200) return null
    const target = bytes[p + 4] | (bytes[p + 5] << 8)
    if (target === 0 || target > speciesCount) return null
    const conditionsOffset = readGbaPointer(bytes, p + 8)
    out.push({
      method,
      param: bytes[p + 2] | (bytes[p + 3] << 8),
      target,
      conditions: conditionsOffset === null ? [] : parseEvolutionConditions(bytes, conditionsOffset),
      conditionsOffset,
    })
  }
  return null
}

/** `struct EvolutionParam { u16 condition; u16 arg1, arg2, arg3; }`. */
export const EVO_CONDITION_ENTRY = 8

/**
 * Reads a condition list up to its CONDITIONS_END terminator. A list
 * that runs past the end of the ROM or holds an unknown condition comes
 * back empty rather than as guesses, since the pointer may not have been
 * a condition list at all.
 */
export function parseEvolutionConditions(bytes: Uint8Array, off: number): EvolutionCondition[] {
  const out: EvolutionCondition[] = []
  for (let p = off; p + EVO_CONDITION_ENTRY <= bytes.length && out.length <= 16; p += EVO_CONDITION_ENTRY) {
    const condition = bytes[p] | (bytes[p + 1] << 8)
    if (condition === EVO_CONDITIONS_END) return out
    if (!(condition in GEN3_EVO_CONDITIONS)) return []
    out.push({
      condition,
      args: [
        bytes[p + 2] | (bytes[p + 3] << 8),
        bytes[p + 4] | (bytes[p + 5] << 8),
        bytes[p + 6] | (bytes[p + 7] << 8),
      ],
    })
  }
  return []
}

/** A 0xFFFF-terminated u16 move list (egg moves, teachable moves). */
export function parseMoveList(bytes: Uint8Array, off: number, moveCount: number): number[] | null {
  const out: number[] = []
  for (let p = off; p + 2 <= bytes.length && out.length <= 256; p += 2) {
    const move = bytes[p] | (bytes[p + 1] << 8)
    if (move === MOVE_UNAVAILABLE) return out
    if (move === 0 || move > moveCount) return null
    out.push(move)
  }
  return null
}

/* ------------------------------------------------------------------ */
/* gMovesInfo                                                          */
/* ------------------------------------------------------------------ */

/**
 * `struct MoveInfo` head. Offsets 0-15 are unconditional; everything
 * past `zMove` is bitfield flags that vary between expansion versions,
 * so only the fields below are exposed.
 *
 * Verified on a built ROM: Pound = effect 1, type Normal(1), Physical,
 * power 40, accuracy 100, target 1, pp 35.
 */
export const MV = {
  name: 0, // const u8 *
  description: 4, // const u8 *
  effect: 8, // u16 (enum BattleMoveEffects, packed to 2 bytes)
  typePowerWord: 10, // u16: type:5 | category:2 | power:9
  accTargetWord: 12, // u16: accuracy:7 | target:9
  pp: 14,
  zMove: 15,
  priorityWord: 16, // u32: priority:4 (signed) | strikeCount:4 | ...
} as const

const MOVE_ANCHORS = [
  { index: 1, name: 'Pound' },
  { index: 2, name: 'Karate Chop' },
  { index: 33, name: 'Tackle' },
  { index: 85, name: 'Thunderbolt' },
  { index: 94, name: 'Psychic' },
  { index: 165, name: 'Struggle' },
]

export interface MoveTable extends TableLocation {
  count: number
}

export function findMoveTable(bytes: Uint8Array, scan = scanExpansion(bytes)): MoveTable | null {
  const found = findPointerNameTable(scan, 'move', MOVE_ANCHORS, MV.name, {
    minStride: 0x20,
    maxStride: 0x100,
  })
  if (!found) return null
  // Verify structurally: real entries carry two valid text pointers and
  // a plausible accuracy/pp. Move 0 (MOVE_NONE) counts as an entry.
  const sane = (id: number): boolean => {
    const o = found.base + id * found.stride
    if (o + found.stride > bytes.length) return false
    const name = readGbaPointer(bytes, o + MV.name)
    const desc = readGbaPointer(bytes, o + MV.description)
    if (name === null || desc === null) return false
    const acc = (bytes[o + MV.accTargetWord] | (bytes[o + MV.accTargetWord + 1] << 8)) & 0x7f
    return acc <= 100 && bytes[o + MV.pp] <= 64
  }
  let count = 1
  while (count < 4096 && sane(count)) count++
  count -= 1
  return count >= 100 ? { ...found, count } : null
}

export function readMoveWord(bytes: Uint8Array, off: number): number {
  return bytes[off] | (bytes[off + 1] << 8)
}

/* ------------------------------------------------------------------ */
/* types / abilities / items                                           */
/* ------------------------------------------------------------------ */

/** `struct TypeInfo` opens with `u8 name[TYPE_NAME_LENGTH + 1]`. */
const TYPE_ANCHORS = [
  { index: 1, name: 'Normal' },
  { index: 2, name: 'Fighting' },
  { index: 4, name: 'Poison' },
  { index: 11, name: 'Fire' },
  { index: 13, name: 'Grass' },
  { index: 15, name: 'Psychic' },
]

/** `struct AbilityInfo` opens with `u8 name[ABILITY_NAME_LENGTH + 1]`. */
const ABILITY_ANCHORS = [
  { index: 1, name: 'Stench' },
  { index: 2, name: 'Drizzle' },
  { index: 26, name: 'Levitate' },
  { index: 34, name: 'Chlorophyll' },
  { index: 65, name: 'Overgrow' },
]

/** `struct ItemInfo` stores `const u8 *name` at offset 20. */
const ITEM_NAME_FIELD = 20
const ITEM_ANCHORS = [
  { index: 3, name: 'Ultra Ball' },
  { index: 4, name: 'Master Ball' },
  { index: 28, name: 'Potion' },
]

/**
 * Every anchor group, matched in one sweep. Callers that need more than
 * one table should call this once and pass the result to each finder;
 * the finders default to scanning on their own so they stay usable in
 * isolation (and in tests).
 */
export const EXPANSION_ANCHOR_GROUPS: AnchorGroup[] = [
  { name: 'species', anchors: SPECIES_ANCHORS },
  { name: 'move', anchors: MOVE_ANCHORS, byPointer: true },
  { name: 'type', anchors: TYPE_ANCHORS },
  { name: 'ability', anchors: ABILITY_ANCHORS },
  { name: 'item', anchors: ITEM_ANCHORS, byPointer: true },
]

export function scanExpansion(bytes: Uint8Array): AnchorScan {
  return scanAnchors(bytes, EXPANSION_ANCHOR_GROUPS)
}

/** Read `count` inline names from a discovered table, or null. */
export function readInlineNames(
  bytes: Uint8Array,
  table: TableLocation,
  nameLen: number,
  count: number,
): string[] {
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const o = table.base + i * table.stride
    out.push(gen3Codec.decode(bytes.subarray(o, o + nameLen)))
  }
  return out
}

export function findTypeNames(
  bytes: Uint8Array,
  scan = scanExpansion(bytes),
): { table: TableLocation; names: string[] } | null {
  const table = findInlineNameTable(scan, 'type', TYPE_ANCHORS, 0, { minStride: 0x10, maxStride: 0x80 })
  if (!table) return null
  let count = 0
  while (count < 64) {
    const o = table.base + count * table.stride
    if (o + 9 > bytes.length) break
    const slice = bytes.subarray(o, o + 9)
    if (slice.indexOf(0xff) < 0) break
    count++
  }
  if (count < 18) return null
  return { table, names: readInlineNames(bytes, table, 9, count) }
}

export function findAbilityNames(
  bytes: Uint8Array,
  scan = scanExpansion(bytes),
): { table: TableLocation; names: string[] } | null {
  const table = findInlineNameTable(scan, 'ability', ABILITY_ANCHORS, 0, { minStride: 0x10, maxStride: 0x80 })
  if (!table) return null
  let count = 0
  while (count < 1024) {
    const o = table.base + count * table.stride
    if (o + 17 > bytes.length) break
    if (bytes.subarray(o, o + 17).indexOf(0xff) < 0) break
    count++
  }
  if (count < 50) return null
  return { table, names: readInlineNames(bytes, table, 17, count) }
}

export function findItemNames(
  bytes: Uint8Array,
  scan = scanExpansion(bytes),
): { table: TableLocation; names: string[] } | null {
  const table = findPointerNameTable(scan, 'item', ITEM_ANCHORS, ITEM_NAME_FIELD, {
    minStride: 0x18,
    maxStride: 0x80,
  })
  if (!table) return null
  const names: string[] = []
  for (let i = 0; i < 2048; i++) {
    const o = table.base + i * table.stride
    if (o + table.stride > bytes.length) break
    const p = readGbaPointer(bytes, o + ITEM_NAME_FIELD)
    if (p === null) break
    names.push(readText(bytes, p, 32))
  }
  return names.length >= 50 ? { table, names } : null
}

/* ------------------------------------------------------------------ */
/* text stored behind a pointer                                        */
/* ------------------------------------------------------------------ */

/**
 * Rewrite a 0xFF-terminated string that an entry points at. Fits in
 * place when the encoding is no longer than the original; otherwise the
 * string is relocated to free space and only THIS entry's pointer is
 * retargeted — other entries may legitimately share the old string.
 */
export function writePointerText(
  rom: Rom,
  ptrField: number,
  text: string,
  maxLen: number,
): boolean {
  const encoded = gen3EncodeText(text)
  if (!encoded || encoded.length === 0 || encoded.length > maxLen) return false
  const target = readGbaPointer(rom.bytes, ptrField)
  if (target === null) return false
  const oldLen = rom.bytes.subarray(target, Math.min(target + maxLen + 1, rom.bytes.length)).indexOf(0xff)
  if (oldLen >= 0 && encoded.length <= oldLen) {
    rom.writeBytes(target, [...encoded, 0xff])
    return true
  }
  const blob = new Uint8Array([...encoded, 0xff])
  // relocate() retargets every pointer to the old text; here only this
  // entry should move, so the destination is claimed directly.
  const dest = findFreeSpaceAtEnd(rom.bytes, blob.length)
  if (dest === null) return false
  rom.writeBytes(dest, blob)
  writeGbaPointer(rom, ptrField, dest)
  return true
}


/* ------------------------------------------------------------------ */
/* sprites                                                             */
/* ------------------------------------------------------------------ */

/**
 * The expansion drops `gMonFrontPicTable` and friends: every species
 * points at its own front pic, back pic, palette and shiny palette from
 * inside `gSpeciesInfo`. That removes all the table-hunting vanilla
 * needs — the pointers are already located once the species table is —
 * but it also means the pointer fields are per-entry, so writes go
 * through the same `replaceCompressed` in-place-or-relocate path.
 */
/**
 * Can this ROM's sprites be decoded at all?
 *
 * Expansion builds compress graphics with either LZ77 or their own
 * `smol` codec, and both are decodable here — but a hack could carry
 * something else entirely, and rendering that as either would produce
 * noise. Sampling across the dex keeps one corrupt entry from switching
 * the whole tab off.
 */
export function spritesDecodable(bytes: Uint8Array, table: SpeciesTable): boolean {
  let checked = 0
  let known = 0
  for (let id = 1; id <= table.count && checked < 32; id += Math.max(1, Math.floor(table.count / 32))) {
    const p = readGbaPointer(bytes, table.base + id * table.stride + SP_GFX.frontPic)
    if (p === null) continue
    checked++
    if (decompressGraphics(bytes, p) !== null) known++
  }
  return checked > 0 && known >= checked * 0.9
}

/** Write a 16-colour palette back over an entry's raw palette slot. */
function writePaletteBytes(rom: Rom, ptrField: number, palBytes: Uint8Array): void {
  const target = readGbaPointer(rom.bytes, ptrField)
  if (target === null) return
  // A hack that kept LZ77 palettes gets a compressed write instead.
  if (isLz77Palette(rom.bytes, target)) replaceSmolAware(rom, ptrField, lz77Compress(palBytes))
  else rom.writeBytes(target, palBytes)
}

/**
 * A species palette, as 32 raw bytes.
 *
 * Unlike vanilla Gen 3 — whose `gMonPaletteTable` entries point at LZ77
 * streams — the expansion's `const u16 *palette` points straight at an
 * uncompressed 16-colour palette. Sniffing the codec here is not just
 * unnecessary but actively wrong: a raw palette's first colour can
 * parse as a plausible `smol` header (0x6a93 puts mode 3 in the low
 * nibble), which decoded Bulbasaur to 55 KB of noise. Only an explicit
 * LZ77 header is treated as compressed, for hacks that kept that.
 */
export function readPaletteBytes(bytes: Uint8Array, off: number): Uint8Array {
  if (isLz77Palette(bytes, off)) {
    try {
      const out = decompressGraphics(bytes, off)
      if (out !== null && out.length >= PALETTE_BYTES) return out
    } catch {
      // fall through to reading it raw
    }
  }
  return bytes.subarray(off, Math.min(off + PALETTE_BYTES, bytes.length))
}

/**
 * Only accept a palette as LZ77 if its header DECLARES exactly a
 * palette's worth of output.
 *
 * Checking the 0x10 magic byte alone is not enough, and this is not
 * hypothetical: Roselia's raw palette opens with the colour 0x7e10,
 * whose low byte is 0x10, so a magic-byte test called it LZ77 and lost
 * the sprite entirely. The declared size makes the test decisive —
 * Roselia's would be 0x2a4b7e, nothing like 32.
 */
function isLz77Palette(bytes: Uint8Array, off: number): boolean {
  if (!isLz77(bytes, off) || off + 4 > bytes.length) return false
  const declared = bytes[off + 1] | (bytes[off + 2] << 8) | (bytes[off + 3] << 16)
  return declared === PALETTE_BYTES
}

/** 16 colours, 2 bytes each. */
const PALETTE_BYTES = 32

/**
 * Write a compressed stream over its old slot, or relocate + retarget.
 *
 * `replaceCompressed` in gba/sprites.ts measures the old slot with
 * `lz77CompressedSize`, which reads garbage when the slot holds `smol`
 * data — so the size comes from the codec dispatcher here instead.
 */
function replaceSmolAware(rom: Rom, ptrField: number, compressed: Uint8Array): string | null {
  const oldPtr = readGbaPointer(rom.bytes, ptrField)
  if (oldPtr === null) return 'The sprite pointer looks corrupt.'
  if (compressed.length <= compressedSize(rom.bytes, oldPtr)) {
    rom.writeBytes(oldPtr, compressed)
    return null
  }
  const dest = findFreeSpaceAtEnd(rom.bytes, compressed.length)
  if (dest === null) return 'The new sprite is larger and the ROM has no free space for it.'
  rom.writeBytes(dest, compressed)
  writeGbaPointer(rom, ptrField, dest)
  return null
}

export function buildExpansionSprites(rom: Rom, table: SpeciesTable): SpriteViewer {
  const bytes = rom.bytes
  const cache = new Map<string, RenderedImage | null>()
  const field = (id: number, off: number) => table.base + id * table.stride + off

  const render = (picOff: number, id: number, shiny = false): RenderedImage | null => {
    if (id < 1 || id > table.count) return null
    const key = `${picOff}:${id}:${shiny}`
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    let out: RenderedImage | null = null
    try {
      const gfxPtr = readGbaPointer(bytes, field(id, picOff))
      if (gfxPtr !== null) {
        const gfx = decompressGraphics(bytes, gfxPtr)
        const tiles: Uint8Array[] = []
        if (gfx !== null)
          for (let i = 0; i + 32 <= Math.min(gfx.length, PIC_FRAME); i += 32) tiles.push(decodeTile4bpp(gfx, i))
        let palette: [number, number, number][] = Array.from(
          { length: 16 },
          (_, i) => [i * 16, i * 16, i * 16] as [number, number, number],
        )
        const palPtr = readGbaPointer(bytes, field(id, shiny ? SP_GFX.shinyPalette : SP_GFX.palette))
        if (palPtr !== null) palette = readPalette(readPaletteBytes(bytes, palPtr), 0)
        if (tiles.length === 64) out = renderTilesRgba(tiles, 8, palette, true)
      }
    } catch {
      out = null
    }
    cache.set(key, out)
    return out
  }

  const importPic = (picOff: number, id: number, image: RenderedImage): string | null => {
    if (id < 1 || id > table.count) return 'Unknown species.'
    if (image.width !== 64 || image.height !== 64)
      return `Sprites must be exactly 64×64 pixels (got ${image.width}×${image.height}).`
    const px = image.pixels
    const bg = px[3] >= 128 ? rgbToBgr555(px[0], px[1], px[2]) : null
    const paletteWords: number[] = [bg ?? 0]
    const indexOf = new Map<number, number>()
    if (bg !== null) indexOf.set(bg, 0)
    const indices = new Uint8Array(64 * 64)
    for (let p = 0; p < 64 * 64; p++) {
      if (px[p * 4 + 3] < 128) continue
      const word = rgbToBgr555(px[p * 4], px[p * 4 + 1], px[p * 4 + 2])
      let idx = indexOf.get(word)
      if (idx === undefined) {
        if (paletteWords.length >= 16)
          return 'Too many colors — sprites allow 15 colors plus the transparent background.'
        idx = paletteWords.length
        paletteWords.push(word)
        indexOf.set(word, idx)
      }
      indices[p] = idx
    }
    while (paletteWords.length < 16) paletteWords.push(0)

    const frame = new Uint8Array(PIC_FRAME)
    for (let t = 0; t < 64; t++) {
      const tx = (t % 8) * 8
      const ty = Math.floor(t / 8) * 8
      const tile = new Uint8Array(64)
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) tile[y * 8 + x] = indices[(ty + y) * 64 + tx + x]
      frame.set(encodeTile4bpp(tile), t * 32)
    }
    const gfxEntry = field(id, picOff)
    const gfxPtr = readGbaPointer(bytes, gfxEntry)
    if (gfxPtr === null) return 'The sprite pointer looks corrupt.'
    // Animated front pics decompress to several frames; keep the
    // original length so the game's animation code still has data.
    const origLen = decompressGraphics(bytes, gfxPtr)?.length ?? PIC_FRAME
    const raw = new Uint8Array(Math.max(origLen, PIC_FRAME))
    for (let o = 0; o < raw.length; o += PIC_FRAME)
      raw.set(frame.subarray(0, Math.min(PIC_FRAME, raw.length - o)), o)

    const palBytes = new Uint8Array(32)
    paletteWords.forEach((w, i) => {
      palBytes[i * 2] = w & 0xff
      palBytes[i * 2 + 1] = w >> 8
    })
    // Imports are always written as LZ77, even into a `smol` ROM: the
    // expansion's decompressor dispatches on the header, so the game
    // reads it back correctly and this editor needs no smol COMPRESSOR.
    // The catch is size — an LZ77 re-encode of smol data is bigger, so
    // it rarely fits the original slot and usually relocates.
    const gfxError = replaceSmolAware(rom, gfxEntry, lz77Compress(raw))
    if (gfxError) return gfxError
    // Palettes are stored raw and are a fixed 32 bytes, so they always
    // fit their existing slot — no compression, no relocation.
    writePaletteBytes(rom, field(id, SP_GFX.palette), palBytes)
    writePaletteBytes(rom, field(id, SP_GFX.shinyPalette), palBytes)
    cache.clear()
    return null
  }

  return {
    front: (id, shiny) => render(SP_GFX.frontPic, id, shiny),
    back: (id, shiny) => render(SP_GFX.backPic, id, shiny),
    hasShiny: true,
    importFront: (id, image) => importPic(SP_GFX.frontPic, id, image),
    importBack: (id, image) => importPic(SP_GFX.backPic, id, image),
  }
}

/** 64×64 4bpp = one animation frame. */
export const PIC_FRAME = 0x800

/* ------------------------------------------------------------------ */
/* wild encounters                                                     */
/* ------------------------------------------------------------------ */

/**
 * The expansion's `struct WildPokemonHeader` is not vanilla's.
 *
 *   struct WildPokemonHeader {
 *     u8 mapGroup; u8 mapNum;               // + 2 bytes of padding
 *     const struct WildEncounterTypes encounterTypes[TIMES_OF_DAY_COUNT];
 *   };
 *   struct WildEncounterTypes { const struct WildPokemonInfo *land,
 *     *water, *rockSmash, *fishing, *hidden; };
 *
 * so a header is `4 + 4 × timesOfDay × areas` bytes instead of vanilla's
 * flat 20 — which is exactly why `gba/wild.ts` finds nothing here. Both
 * `TIMES_OF_DAY_COUNT` (1 when the hack disabled time-of-day encounters,
 * 4 when it didn't) and the area count vary by build, so the pointer
 * count per header is discovered rather than assumed.
 */
const WILD_AREAS = [
  { key: 'land', label: 'Land', slots: 12 },
  { key: 'water', label: 'Water', slots: 5 },
  { key: 'rock', label: 'Rock Smash', slots: 5 },
  { key: 'fishing', label: 'Fishing', slots: 10 },
  { key: 'hidden', label: 'Hidden', slots: 3 },
]
const TIME_LABELS = ['Morning', 'Day', 'Evening', 'Night']
/** `struct WildPokemonInfo { u8 encounterRate; const struct WildPokemon *; }` */
const WILD_INFO_SIZE = 8
/** `struct WildPokemon { u8 minLevel; u8 maxLevel; u16 species; }` */
const WILD_SLOT_SIZE = 4

export interface ExpansionWildTable {
  offset: number
  count: number
  /** Pointer slots per header = timesOfDay × areas. */
  pointers: number
  timesOfDay: number
  areas: number
  headerSize: number
}

function wildSlotsValid(bytes: Uint8Array, off: number, slots: number, speciesCount: number): boolean {
  for (let i = 0; i < slots; i++) {
    const o = off + i * WILD_SLOT_SIZE
    if (o + WILD_SLOT_SIZE > bytes.length) return false
    const min = bytes[o]
    const max = bytes[o + 1]
    const species = bytes[o + 2] | (bytes[o + 3] << 8)
    if (min < 1 || min > 100 || max < min || max > 100) return false
    if (species === 0 || species > speciesCount) return false
  }
  return true
}

function wildInfoValid(bytes: Uint8Array, ptr: number, slots: number, speciesCount: number): boolean {
  if (ptr + WILD_INFO_SIZE > bytes.length) return false
  if (bytes[ptr] === 0 || bytes[ptr] > 100) return false // encounterRate
  const mons = readGbaPointer(bytes, ptr + 4)
  return mons !== null && wildSlotsValid(bytes, mons, slots, speciesCount)
}

/**
 * Discover the encounter table: the longest run of headers whose map
 * keys all exist in the discovered map index and whose non-null area
 * pointers all resolve to parseable slot data, ending at the
 * {0xFF, 0xFF} terminator. The map-key cross-check is what keeps this
 * from locking onto unrelated pointer soup.
 */
export function findExpansionWildTable(
  bytes: Uint8Array,
  mapKeys: Set<string>,
  speciesCount: number,
): ExpansionWildTable | null {
  for (const timesOfDay of [4, 1, 2, 3]) {
    for (const areas of [5, 4]) {
      const pointers = timesOfDay * areas
      const headerSize = 4 + pointers * 4
      const hit = scanWildRun(bytes, mapKeys, speciesCount, timesOfDay, areas, headerSize)
      if (hit) return hit
    }
  }
  return null
}

function scanWildRun(
  bytes: Uint8Array,
  mapKeys: Set<string>,
  speciesCount: number,
  timesOfDay: number,
  areas: number,
  headerSize: number,
): ExpansionWildTable | null {
  const pointers = timesOfDay * areas
  const headerValid = (o: number): boolean => {
    if (o + headerSize > bytes.length) return false
    if (bytes[o + 2] !== 0 || bytes[o + 3] !== 0) return false // padding
    if (!mapKeys.has(`${bytes[o]}.${bytes[o + 1]}`)) return false
    let filled = 0
    for (let i = 0; i < pointers; i++) {
      const raw = o + 4 + i * 4
      const v = (bytes[raw] | (bytes[raw + 1] << 8) | (bytes[raw + 2] << 16) | (bytes[raw + 3] << 24)) >>> 0
      if (v === 0) continue
      const p = readGbaPointer(bytes, raw)
      if (p === null) return false
      if (!wildInfoValid(bytes, p, WILD_AREAS[i % areas].slots, speciesCount)) return false
      filled++
    }
    return filled >= 1
  }
  for (let o = 0; o + headerSize <= bytes.length; o += 4) {
    if (!headerValid(o)) continue
    let count = 0
    let p = o
    while (count < 2048 && headerValid(p)) {
      count++
      p += headerSize
    }
    if (bytes[p] === 0xff && bytes[p + 1] === 0xff && count >= 8) {
      return { offset: o, count, pointers, timesOfDay, areas, headerSize }
    }
  }
  return null
}

export function buildExpansionWildModule(
  rom: Rom,
  mapKeys: Set<string>,
  speciesCount: number,
  /** Area name for a map key, so entries read as more than "Map 0.16". */
  mapName?: (key: string) => string | undefined,
): { module: WildModule; table: ExpansionWildTable } | null {
  const bytes = rom.bytes
  const table = findExpansionWildTable(bytes, mapKeys, speciesCount)
  if (!table) return null

  const headerByKey = new Map<string, number>()
  const entries: { key: string; label: string }[] = []
  for (let i = 0; i < table.count; i++) {
    const o = table.offset + i * table.headerSize
    const key = `${bytes[o]}.${bytes[o + 1]}`
    if (headerByKey.has(key)) continue
    headerByKey.set(key, o)
    const area = mapName?.(key)
    entries.push({ key, label: area ? `${key} — ${toTitleCase(area)}` : `Map ${key}` })
  }

  /** Group index → the WildPokemonInfo it points at, or null. */
  const infoPtr = (key: string, group: number): number | null => {
    const o = headerByKey.get(key)
    if (o === undefined || group >= table.pointers) return null
    return readGbaPointer(bytes, o + 4 + group * 4)
  }
  const groupLabel = (group: number): string => {
    const area = WILD_AREAS[group % table.areas]
    if (table.timesOfDay === 1) return area.label
    return `${TIME_LABELS[Math.floor(group / table.areas)] ?? `Time ${Math.floor(group / table.areas)}`} — ${area.label}`
  }

  /**
   * `groups()` skips null area pointers, so the indices the UI hands
   * back are positions in that filtered list — resolve them the same
   * way rather than treating them as raw pointer slots.
   */
  const liveGroups = (key: string): { info: number; slots: number }[] => {
    const out: { info: number; slots: number }[] = []
    for (let g = 0; g < table.pointers; g++) {
      const info = infoPtr(key, g)
      if (info === null) continue
      if (readGbaPointer(bytes, info + 4) === null) continue
      out.push({ info, slots: WILD_AREAS[g % table.areas].slots })
    }
    return out
  }

  const module: WildModule = {
    entries,
    groups(key) {
      const out: WildGroup[] = []
      for (let g = 0; g < table.pointers; g++) {
        const info = infoPtr(key, g)
        if (info === null) continue
        const mons = readGbaPointer(bytes, info + 4)
        if (mons === null) continue
        const slots: WildSlot[] = []
        for (let i = 0; i < WILD_AREAS[g % table.areas].slots; i++) {
          const o = mons + i * WILD_SLOT_SIZE
          slots.push({
            minLevel: bytes[o],
            maxLevel: bytes[o + 1],
            species: bytes[o + 2] | (bytes[o + 3] << 8),
          })
        }
        out.push({ name: groupLabel(g), rate: bytes[info], slots })
      }
      return out
    },
    setRate(key, group, rate) {
      const g = liveGroups(key)[group]
      if (g !== undefined) rom.writeU8(g.info, rate)
    },
    setSlot(key, group, slot, field, value) {
      const g = liveGroups(key)[group]
      if (g === undefined) return
      const mons = readGbaPointer(bytes, g.info + 4)
      if (mons === null || slot >= g.slots) return
      const o = mons + slot * WILD_SLOT_SIZE
      if (field === 'species') return rom.writeU16LE(o + 2, value)
      if (field === 'minLevel') return rom.writeU8(o, value)
      if (field === 'maxLevel') return rom.writeU8(o + 1, value)
    },
    revert(key) {
      for (const g of liveGroups(key)) {
        rom.revertRange(g.info, WILD_INFO_SIZE)
        const mons = readGbaPointer(bytes, g.info + 4)
        if (mons !== null) rom.revertRange(mons, g.slots * WILD_SLOT_SIZE)
      }
    },
  }

  return { module, table }
}
