/**
 * Synthetic ROM fixtures.
 *
 * These are NOT real game data — they contain just enough correctly-shaped
 * bytes (headers + the public-knowledge signature entries the scanner keys
 * on) to exercise every code path: detection, scanning, reading, writing.
 */
import { gen12Bytes, gen3Bytes } from '../src/core/text'
import { lz77Compress } from '../src/core/gba/lz77'

function put(buf: Uint8Array, off: number, bytes: ArrayLike<number>): void {
  buf.set(Uint8Array.from(bytes as number[]), off)
}

function gbName(text: string, len: number): number[] {
  const out = gen12Bytes(text)
  while (out.length < len) out.push(0x50)
  return out
}

function gen3Name(text: string, len: number): number[] {
  const out = gen3Bytes(text)
  out.push(0xff)
  while (out.length < len) out.push(0xff)
  return out
}

/* --------------------------------------------------------------- Gen 1 */

export function makeGen1Rom(): Uint8Array {
  const rom = new Uint8Array(1024 * 1024)
  // GB header: Nintendo logo start + title.
  put(rom, 0x104, [0xce, 0xed, 0x66, 0x66])
  put(rom, 0x134, Array.from('POKEMON RED').map((c) => c.charCodeAt(0)))

  // Base stats (dex order): Bulbasaur, Ivysaur, rest zeroed.
  const stats = 0x383de
  put(rom, stats, [0x01, 45, 49, 49, 45, 65, 0x16, 0x03, 45, 64])
  put(rom, stats + 15, [33, 45, 0, 0]) // starting moves: Tackle, Growl
  put(rom, stats + 19, [3]) // medium slow
  put(rom, stats + 20, [0b10100100, 0, 0, 0, 0, 0, 0x40]) // some TM/HM flags
  put(rom, stats + 28, [0x02, 60, 62, 63, 60, 80, 0x16, 0x03, 45, 141])
  // Mew, stored separately like real Red/Blue.
  const mew = 0x425b
  put(rom, mew, [0x97, 100, 100, 100, 100, 100, 0x18, 0x18, 45, 64])

  // Internal → dex mapping. Signature entries then Bulbasaur at internal 10.
  const map = 0x41024
  put(rom, map, [0x70, 0x73, 0x20, 0x23, 0x15, 0x64, 0x22, 0x50, 0x02, 0x01])
  put(rom, map + 10, [0x97]) // internal 11 = Mew

  // Names (internal order, 10 bytes each).
  const names = 0x1c21e
  put(rom, names, gbName('RHYDON', 10))
  put(rom, names + 10, gbName('KANGASKHAN', 10))
  put(rom, names + 9 * 10, gbName('BULBASAUR', 10)) // internal 10
  put(rom, names + 10 * 10, gbName('MEW', 10)) // internal 11

  // Move data: Pound, Karate Chop, Doubleslap.
  const moves = 0x38000
  put(rom, moves, [0x01, 0x00, 40, 0x00, 0xff, 35])
  put(rom, moves + 6, [0x02, 0x00, 50, 0x00, 0xff, 25])
  put(rom, moves + 12, [0x03, 0x1d, 15, 0x00, 0xd8, 10])

  // Move names (variable length, 0x50-terminated), through move 34 so
  // the TACKLE/BODY SLAM anchor pair exists for voting discovery.
  const moveNames = 0xb0000
  const nameList = ['POUND', 'KARATE CHOP', 'DOUBLESLAP']
  for (let mv = 4; mv <= 32; mv++) nameList.push('MOVE' + String(mv))
  nameList.push('TACKLE', 'BODY SLAM')
  for (let mv = 35; mv <= 84; mv++) nameList.push('MOVE' + String(mv))
  nameList.push('THUNDERBOLT', 'THUNDER WAVE')
  put(rom, moveNames, nameList.flatMap((n) => [...gen12Bytes(n), 0x50]))

  // TM/HM move list.
  put(rom, 0x13773, [5, 13, 14, 18, 25, 92, 32, 34])

  // Evos + moves: 190 internal-order pointers (bank 0x0E local 0x7000).
  // Blob A = no evos/no moves; blob B (internal 10 = Bulbasaur) evolves
  // at 16 into internal 9 (dex 2) and learns Tackle@1, Growl@4.
  const evoTable = 0x3b000
  const evoLocal = (off: number) => 0x4000 + (off - 0x38000)
  {
    let blob = 0x3b200
    for (let i = 0; i < 190; i++) {
      put(rom, evoTable + i * 2, [evoLocal(blob) & 0xff, evoLocal(blob) >> 8])
      const data = i === 9 ? [1, 16, 9, 0, 1, 33, 4, 45, 0] : [0, 0]
      put(rom, blob, data)
      blob += data.length
    }
  }

  // Sprites: a minimal hand-built pic (1×1 tile, order 0, xor-mode 0,
  // both planes one zero-run of 32 groups; bit stream
  // 0 | 0 11110 00001 | 0 | 0 11110 00001) in bank 5, referenced from
  // every stats entry (dims 0x11).
  const pic = 5 * 0x4000 + 0x1000 // local 0x5000
  put(rom, pic, [0x11, 0x3c, 0x13, 0xc1])
  for (let dex = 1; dex <= 150; dex++) {
    put(rom, stats + (dex - 1) * 28 + 10, [0x11, 0x00, 0x50, 0x00, 0x50])
  }
  put(rom, mew + 10, [0x11, 0x00, 0x50, 0x00, 0x50])

  // Item names with vote anchor pairs at ids 1-2, 20-21 and 76-77.
  {
    const items = ['MASTER BALL', 'ULTRA BALL']
    for (let it = 3; it <= 19; it++) items.push('ITEM' + String(it))
    items.push('POTION', 'BOULDERBADGE')
    for (let it = 22; it <= 75; it++) items.push('ITEM' + String(it))
    items.push('OLD ROD', 'GOOD ROD')
    for (let it = 78; it <= 97; it++) items.push('ITEM' + String(it))
    put(rom, 0xb1000, items.flatMap((n) => [...gen12Bytes(n), 0x50]))
  }

  // SGB palettes: MonsterPalettes (152 ids) + SuperPalettes rows, each
  // near-white first (0x7FBF) with distinct second colors.
  const palT = 0x72000
  for (let i = 0; i < 152; i++) rom[palT + i] = i % 10
  for (let r = 0; r < 10; r++) {
    put(rom, palT + 152 + r * 8, [0xbf, 0x7f, r + 1, 0x7c, 0x00, 0x40, 0, 0])
  }

  // Type chart: 62 triplets {atk, def, eff} + 0xFF end (bank 0x0F).
  {
    const chart: number[] = []
    for (let i = 0; i < 62; i++) {
      chart.push(i % 9, (i * 2 + 1) % 9, i < 20 ? 20 : i < 40 ? 5 : 0)
    }
    chart[0 * 3 + 0] = 0x15 // water vs fire, super effective
    chart[0 * 3 + 1] = 0x14
    // 0x99 = unrelated data right after the chart, like the real games.
    put(rom, 0x3e400, [...chart, 0xff, 0x99])
  }

  // Wild encounters (bank 3): pointer table + blocks.
  put(rom, 0xd500, [0, 0]) // "nothing" block: grass 0, water 0
  put(rom, 0xd510, [25, 3, 0x24, 3, 0xa5, 3, 0xa5, 2, 0xa5, 2, 0x24, 3, 0x24, 3, 0x24, 4, 0xa5, 4, 0x24, 5, 0x24, 0])
  // Map 13: grass (internal 10 = dex 1) and water (internal 9 = dex 2).
  const grassPairs = Array.from({ length: 10 }, () => [5, 10]).flat()
  const waterPairs = Array.from({ length: 10 }, () => [10, 9]).flat()
  put(rom, 0xd530, [10, ...grassPairs, 20, ...waterPairs])
  const wildTable = 0xd000
  for (let m = 0; m < 12; m++) put(rom, wildTable + m * 2, [0x00, 0x55])
  put(rom, wildTable + 24, [0x10, 0x55]) // Route 1
  put(rom, wildTable + 26, [0x30, 0x55]) // map 13
  // next u16 is 0x0000 → out of pointer range → table ends (count 14)

  // Trainer parties: 47-entry pointer table immediately before the lists,
  // like the real games.
  const trTable = 0xe5000
  const trLocal = (off: number) => 0x4000 + (off % 0x4000)
  const trPtr = (off: number) => [trLocal(off) & 0xff, trLocal(off) >> 8]
  const youngster = trTable + 47 * 2
  // Class 0 (Youngster): the three anchor lists (fixed-level format).
  put(rom, youngster, [11, 0xa5, 0x6c, 0, 14, 0x05, 0, 10, 0xa5, 0xa5, 0x6b, 0])
  // Class 1: special format — Bulbasaur (internal 10) lv 5, Ivysaur (internal 9) lv 7.
  const cls1 = youngster + 12
  put(rom, cls1, [0xff, 5, 10, 7, 9, 0])
  // Class 2: fixed format — two Bulbasaur at a shared level 20.
  const cls2 = cls1 + 6
  put(rom, cls2, [20, 10, 10, 0])
  const trEnd = cls2 + 4 // 0x00 here ⇒ classes 3+ have no trainers
  put(rom, trTable, [...trPtr(youngster), ...trPtr(cls1), ...trPtr(cls2)])
  for (let c = 3; c < 47; c++) put(rom, trTable + c * 2, trPtr(trEnd))

  // Maps: pointer run + banks table + one shared header in bank 6.
  const mapPtrs = 0x200
  for (let m = 0; m < 160; m++) put(rom, mapPtrs + m * 2, [0x00, 0x43]) // local 0x4300
  const mapBanks = 0xc100
  for (let m = 0; m < 160; m++) rom[mapBanks + m] = 6
  const header = 6 * 0x4000 + 0x300 // bank 6, local 0x4300
  // ts 1, 4x5 blocks, no connections, objects at local 0x4500. (Using
  // tileset 1 forces the tileset-table scan to find a 2-entry run —
  // a single-entry "run" can appear by chance in unrelated data.)
  put(rom, header, [1, 4, 5, 0x00, 0x44, 0x00, 0x45, 0x00, 0x45, 0, 0x00, 0x45])
  // Object data: border, 1 warp (y5 x5 -> map 40 warp 1), 1 sign
  // (y13 x13 text 4), 2 NPCs (plain + trainer with 2 extra bytes),
  // then one warp_to entry {viewPtr, y, x} with base 0xC6E8:
  // 0xC6E8 + 7 + 5 + (5+6)*(5>>1) + (5>>1) = 0xC70C.
  const objData = 6 * 0x4000 + 0x500
  put(rom, objData, [
    0x0b,
    1, 5, 5, 1, 40,
    1, 13, 13, 4,
    2,
    7, 5 + 4, 8 + 4, 1, 2, 5,
    9, 6 + 4, 3 + 4, 0, 0, 0x40 | 2, 24, 1,
    0x0c, 0xc7, 5, 5,
  ])
  const mapBlocks = 6 * 0x4000 + 0x400
  rom[mapBlocks + 1] = 1 // block (1,0) uses block id 1
  // Tilesets 0 + 1 (the map uses 1): bank 6, blocks @0x6000,
  // gfx @0x6800, coll in ROM0.
  const tsTable = 0xc700
  put(rom, tsTable, [6, 0x00, 0x60, 0x00, 0x68, 0x00, 0x10, 0xff, 0xff, 0xff, 0x52, 0])
  put(rom, tsTable + 12, [6, 0x00, 0x60, 0x00, 0x68, 0x00, 0x10, 0xff, 0xff, 0xff, 0x52, 0])
  const tsBlocks = 6 * 0x4000 + 0x2000
  for (let i = 0; i < 16; i++) rom[tsBlocks + 16 + i] = 1 // block 1 = tile 1 everywhere
  const tsGfx = 6 * 0x4000 + 0x2800
  for (let i = 0; i < 16; i++) rom[tsGfx + 16 + i] = 0xff // tile 1 = darkest shade
  return rom
}

/* --------------------------------------------------------------- Gen 2 */

export function makeGen2Rom(): Uint8Array {
  const rom = new Uint8Array(2 * 1024 * 1024)
  put(rom, 0x104, [0xce, 0xed, 0x66, 0x66])
  put(rom, 0x134, Array.from('PM_CRYSTAL').map((c) => c.charCodeAt(0)))
  rom[0x143] = 0x80 // GBC flag

  const stats = 0x51424
  // Bulbasaur: dex, stats ×6, types, catch, exp, items, gender, ?, hatch...
  put(rom, stats, [0x01, 45, 49, 49, 45, 65, 65, 0x16, 0x03, 45, 64, 0, 0, 31, 100, 20])
  put(rom, stats + 22, [3]) // growth: medium slow
  put(rom, stats + 23, [(1 << 4) | 7]) // egg groups: Monster / Grass
  put(rom, stats + 24, [0b00000101, 0, 0, 0, 0, 0, 0b00000011, 0])
  put(rom, stats + 32, [0x02, 60, 62, 63, 60, 80, 80, 0x16, 0x03, 45, 141])

  const names = 0x53384
  put(rom, names, gbName('BULBASAUR', 10))
  put(rom, names + 10, gbName('IVYSAUR', 10))

  // Trainer parties (bank 0x25): class pointer table + groups, table
  // immediately before the first group like the real games.
  const trTable = 0x94000
  const nClasses = 66
  const trLocal = (off: number) => 0x4000 + (off % 0x4000)
  const trPtr = (off: number) => [trLocal(off) & 0xff, trLocal(off) >> 8]
  const groups: number[] = []
  let cursor = trTable + nClasses * 2
  const emit = (bytes: number[]) => {
    groups.push(cursor)
    put(rom, cursor, bytes)
    cursor += bytes.length
  }
  // Class 1 (Falkner) — the discovery anchor: TRAINERTYPE_MOVES.
  emit([...gen12Bytes('FALKNER'), 0x50, 1,
    7, 16, 33, 189, 0, 0,
    9, 17, 33, 189, 16, 0,
    0xff])
  // Class 2 (Whitney) — the anchor's verifier.
  emit([...gen12Bytes('WHITNEY'), 0x50, 1,
    18, 35, 3, 102, 227, 118,
    20, 241, 205, 213, 23, 208,
    0xff])
  // Class 3: two NORMAL trainers in one group.
  emit([
    ...gen12Bytes('JOEY'), 0x50, 0, 4, 19, 0xff,
    ...gen12Bytes('MIKEY'), 0x50, 0, 2, 16, 4, 19, 0xff,
  ])
  // Class 4: ITEM_MOVES — level 30 Pikachu holding item 3 with 4 moves.
  emit([...gen12Bytes('RED'), 0x50, 3, 30, 25, 3, 33, 45, 85, 87, 0xff])
  // Classes 5..66: one tiny NORMAL trainer each so every pointer is valid.
  for (let c = 4; c < nClasses; c++) emit([...gen12Bytes('AL'), 0x50, 0, 5, 1, 0xff])
  for (let c = 0; c < nClasses; c++) put(rom, trTable + c * 2, trPtr(groups[c]))

  // Trainer class names: eight LEADERs then themed names.
  const classNamesOff = 0x9a000
  const classNameList = ['LEADER', 'LEADER', 'LEADER', 'LEADER', 'LEADER', 'LEADER', 'LEADER', 'LEADER', 'RIVAL', 'YOUNGSTER']
  let cnCursor = classNamesOff
  for (const n of classNameList) {
    put(rom, cnCursor, [...gen12Bytes(n), 0x50])
    cnCursor += n.length + 1
  }
  for (let c = classNameList.length; c < nClasses; c++) {
    put(rom, cnCursor, [...gen12Bytes('SAGE'), 0x50])
    cnCursor += 5
  }

  const moves = 0x41afb
  put(rom, moves, [0x01, 0x00, 40, 0x00, 0xff, 35, 0x00])
  put(rom, moves + 7, [0x02, 0x00, 50, 0x01, 0xff, 25, 0x00])

  // Maps: 26 group pointers (bank 0x40) sharing one 4-map array.
  const grpTable = 0x100000 // bank 0x40, local 0x4000
  const grpLocal = (off: number) => 0x4000 + (off - 0x100000)
  const grpArray = 0x100100
  for (let g = 0; g < 26; g++) put(rom, grpTable + g * 2, [grpLocal(grpArray) & 0xff, grpLocal(grpArray) >> 8])
  // 4 map entries: attrBank 0x40, tileset 3, env 1, attrPtr, misc.
  for (let m = 0; m < 4; m++) {
    put(rom, grpArray + m * 9, [0x40, 3, 1, 0x00, 0x42, 0, 0, 0, 0])
  }
  // Attributes: border, h 3, w 4, blocks bank 0x40 @ local 0x4300,
  // scripts bank 0x40 @ 0x4000, events @ local 0x4800.
  put(rom, 0x100200, [0, 3, 4, 0x40, 0x00, 0x43, 0x40, 0x00, 0x40, 0x00, 0x48, 0])
  rom[0x100300 + 1] = 1 // block (1,0) = metatile 1
  // Tilesets: 4 × 15-byte entries {gfx 0x40:4700, meta 0x40:4600,
  // coll 0x40:4000, anim, NULL, palmap 0x4900} — NULL word at +11.
  for (let t = 0; t < 4; t++) {
    put(rom, 0x100400 + t * 15, [0x40, 0x00, 0x47, 0x40, 0x00, 0x46, 0x40, 0x00, 0x40, 0x00, 0x40, 0, 0, 0x00, 0x49])
  }
  // Palette map (bank 0x40 local 0x4900): nibble per tile, bit 3 clear.
  // Tile 0 = GRAY (0), tile 1 = BROWN (5), then variety for the vote.
  put(rom, 0x100900, [0x50, 0x15, 0x65, 0x66])
  for (let i = 4; i < 48; i++) rom[0x100900 + i] = (i % 2 === 0 ? 0x05 : 0x21)
  // Metatiles: metatile 0 = 16×tile0, metatile 1 = 16×tile1.
  for (let i = 0; i < 16; i++) rom[0x100600 + 16 + i] = 1
  // Tileset gfx, lz3-compressed: 16 zero bytes then 16×0xFF
  // (zero-fill 16, iterate 0xFF ×16, terminator).
  put(rom, 0x100700, [0x6f, 0x3f, 0xff, 0xff])
  // MapEvents blob (bank 0x40 local 0x4800): filler word, 2 warps
  // {y,x,destWarp,group,map}, 0 coord events, 1 bg event {y,x,fn,script},
  // 2 objects {sprite, y+4, x+4, movefn, radii, h1, h2, pal/type, sight,
  // script u16, eventFlag u16}.
  put(rom, 0x100800, [
    0, 0,
    2, /* warps */ 5, 5, 1, 13, 2, /**/ 11, 12, 1, 1, 3,
    0, /* coord events */
    1, /* bg events */ 9, 7, 0, 0x34, 0x40,
    2, /* objects */
    2, 8 + 4, 3 + 4, 0, 0x22, 0xff, 0xff, 0x00, 0, 0x50, 0x40, 0xff, 0xff,
    5, 14 + 4, 12 + 4, 6, 0x20, 0xff, 0xff, 0x30, 0, 0x60, 0x40, 0xff, 0xff,
  ])
  // Item names with two voting anchor pairs (ids 1/2 and 77/78).
  const itemNames = 0x1b0000
  const itemList = ['MASTER BALL', 'ULTRA BALL']
  for (let it = 3; it <= 76; it++) itemList.push('ITEM' + String(it))
  itemList.push('SHARP BEAK', 'PRZCUREBERRY')
  put(rom, itemNames, itemList.flatMap((n) => [...gen12Bytes(n), 0x50]))

  const moveNames = 0x1c9f29
  const g2names = ['POUND', 'KARATE CHOP']
  for (let mv = 3; mv <= 32; mv++) g2names.push('MOVE' + String(mv))
  g2names.push('TACKLE', 'BODY SLAM')
  for (let mv = 35; mv <= 84; mv++) g2names.push('MOVE' + String(mv))
  g2names.push('THUNDERBOLT', 'THUNDER WAVE')
  put(rom, moveNames, g2names.flatMap((n) => [...gen12Bytes(n), 0x50]))

  // Evos + attacks: 251 dex-order pointers (bank 0x11 local 0x4000).
  // Blob A = empty; blob B (dex 1) evolves at 16 into dex 2 and learns
  // Tackle@1, Growl@4.
  const evoTable = 0x44000
  const evoLocal = (off: number) => 0x4000 + (off - 0x44000)
  {
    let blob = 0x44300
    for (let i = 0; i < 251; i++) {
      put(rom, evoTable + i * 2, [evoLocal(blob) & 0xff, evoLocal(blob) >> 8])
      const data = i === 0 ? [1, 16, 2, 0, 1, 33, 4, 45, 0] : [0, 2, 33, 0]
      put(rom, blob, data)
      blob += data.length
    }
  }

  // Sprites: pic pointer table (bank 0x12), lz3 pics, palettes.
  // dims 2x2 for the first species so fronts are 4 tiles (64 bytes).
  for (let id = 1; id <= 24; id++) rom[stats + (id - 1) * 32 + 17] = 0x22
  const picTable = 0x48000
  // Front: 2×(alternate FF,00 ×32) = 64 bytes of color-1 pixels.
  put(rom, 0x48800, [0x5f, 0xff, 0x00, 0x5f, 0xff, 0x00, 0xff])
  // Back: 18×(zero-fill 32) = 576 bytes (6×6 tiles).
  put(rom, 0x48900, [...Array.from({ length: 18 }, () => 0x7f), 0xff])
  for (let i = 0; i < 251; i++) {
    if (i === 200) {
      put(rom, picTable + i * 6, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) // Unown slot
      continue
    }
    put(rom, picTable + i * 6, [0x12, 0x00, 0x48, 0x12, 0x00, 0x49])
  }
  // Palettes: anchor rows for dex 1 / 25 / 131.
  const pals = 0xa8c0
  put(rom, pals + 1 * 8, [236, 47, 95, 25, 148, 47, 95, 25])
  put(rom, pals + 25 * 8, [93, 23, 218, 0, 63, 2, 84, 44])
  put(rom, pals + 131 * 8, [188, 54, 8, 114, 191, 125, 112, 125])

  // Type chart with the Gen 2 Foresight separator (bank 0x0D).
  {
    const chart: number[] = []
    for (let i = 0; i < 62; i++) {
      chart.push(i % 9, (i * 2 + 1) % 9, i < 20 ? 20 : i < 40 ? 5 : 0)
    }
    chart[0] = 0x15 // water vs fire, super effective
    chart[1] = 0x14
    put(rom, 0x34d00, [...chart, 0xfe, 0, 8, 0, 1, 8, 0, 0xff])
  }

  put(rom, 0x1167a, [223, 29, 174, 205, 46, 92, 192, 249])

  // Wild data (Crystal layout): 4 Johto grass blocks, 1 water block.
  const morn = [3, 19, 4, 19, 5, 19, 3, 19, 6, 19, 5, 19, 5, 19]
  const nite = [3, 92, 4, 92, 5, 92, 3, 19, 6, 92, 5, 19, 5, 19]
  const filler = (g: number, m: number) => [g, m, 4, 4, 4, ...Array.from({ length: 21 }, () => [5, 16]).flat()]
  let w = 0x2ab00
  const putw = (b: number[]) => { put(rom, w, b); w += b.length }
  // Johto grass blocks: the five voting anchors (indices 0, 2, 5, 8
  // and 14 — see JOHTO_GRASS_ANCHORS) plus filler. Only the anchor
  // blocks carry real signature bytes.
  // head4 must reproduce bytes 5-8 of the real anchor patterns exactly,
  // or that anchor simply won't vote.
  const anchorBlock = (g: number, m: number, rate: number, head4: number[]) => {
    const rest = Array.from({ length: 5 }, () => [5, 16]).flat() // 5 more pairs
    const row = [...head4, ...rest]
    return [g, m, rate, rate, rate, ...row, ...row, ...nite]
  }
  const johto: number[][] = []
  johto[0] = [3, 2, 5, 5, 5, ...morn, ...morn, ...nite] // Sprout Tower 2F
  johto[2] = anchorBlock(3, 5, 5, [20, 19, 21, 19])
  johto[5] = anchorBlock(3, 8, 5, [20, 19, 21, 19])
  johto[8] = anchorBlock(3, 11, 5, [20, 19, 21, 19])
  johto[14] = anchorBlock(3, 27, 15, [5, 201, 5, 201])
  // 45 blocks: enough for the five anchors AND for the structural
  // fallback (which needs a run of at least 40) to be exercised.
  let spareAt = 0
  for (let i = 0; i < 45; i++) {
    if (!johto[i]) johto[i] = filler(10, ++spareAt)
    putw(johto[i])
  }
  putw([0xff]) // end Johto grass
  putw([11, 1, 10, 15, 194, 20, 195, 15, 194]) // Johto water
  putw([0xff])
  putw([0xff]) // empty Kanto grass
  putw([0xff]) // empty Kanto water

  addEggMoves(rom)
  return rom
}

/**
 * Egg moves in bank 8, mirroring pokecrystal: 251 dex-order bank-local
 * pointers followed by the lists, with every species that has no egg
 * moves sharing one pointer to a lone 0xFF terminator.
 */
function addEggMoves(rom: Uint8Array): void {
  const table = 0x20000 // bank 8, address 0x4000
  const sample: [number, number[]][] = [
    [1, [113, 130, 219, 13, 80]],
    [4, [187, 246, 157, 44, 200, 251]],
    [7, [50, 174, 95]],
    [10, [1, 2]],
    [13, [3]],
    [16, [4, 5, 6]],
    [19, [7]],
    [22, [8, 9]],
    [25, [10, 11, 12]],
    [28, [13]],
    [31, [14, 15]],
    [34, [16]],
  ]
  const listAt = new Map<number, number>()
  let cursor = table + 251 * 2
  for (const [dex, moves] of sample) {
    listAt.set(dex, cursor)
    put(rom, cursor, [...moves, 0xff])
    cursor += moves.length + 1
  }
  const empty = cursor // the shared "no egg moves" terminator
  rom[cursor] = 0xff
  for (let dex = 1; dex <= 251; dex++) {
    const off = listAt.get(dex) ?? empty
    put(rom, table + (dex - 1) * 2, u16s((off % 0x4000) + 0x4000))
  }
}

/* --------------------------------------------------------------- Gen 3 */

export function makeGen3Rom(): Uint8Array {
  const rom = new Uint8Array(4 * 1024 * 1024)
  rom.fill(0xff, 0x3e0000) // trailing padding, like a real GBA ROM
  rom[0xb2] = 0x96 // GBA fixed header byte
  put(rom, 0xa0, Array.from('POKEMON FIRE').map((c) => c.charCodeAt(0)))
  put(rom, 0xac, Array.from('BPRE').map((c) => c.charCodeAt(0)))

  // Base stats: entry 0 dummy, then Bulbasaur, Ivysaur.
  const stats = 0x2547a0
  const bulba = stats + 28
  put(rom, bulba, [45, 49, 49, 45, 65, 65, 12, 3, 45, 64])
  put(rom, bulba + 10, [0, 1]) // EV yield u16 LE = 0x0100 → Sp. Atk = 1
  put(rom, bulba + 12, [0, 0, 0, 0]) // held items
  put(rom, bulba + 16, [31, 20, 70, 3, 1, 7, 65, 0]) // gender..abilities (65 = Overgrow)
  put(rom, stats + 56, [60, 62, 63, 60, 80, 80, 12, 3, 45, 141])
  // Extra anchor species so discovery survives anchor self-edits.
  put(rom, stats + 25 * 28, [35, 55, 30, 90, 50, 40, 13, 13, 190, 82]) // Pikachu
  put(rom, stats + 113 * 28, [250, 5, 5, 50, 35, 105, 0, 0, 30, 255]) // Chansey

  const names = 0x245ee0
  put(rom, names, gen3Name('??????????', 11)) // entry 0 dummy
  put(rom, names + 11, gen3Name('BULBASAUR', 11))
  put(rom, names + 22, gen3Name('IVYSAUR', 11))

  const moves = 0x250c04
  put(rom, moves + 12, [0, 40, 0, 100, 35, 0, 0, 0, 0x33, 0, 0, 0]) // Pound
  put(rom, moves + 24, [44, 50, 1, 100, 25, 0, 0, 0, 0x33, 0, 0, 0]) // Karate Chop

  const moveNames = 0x247111
  put(rom, moveNames, gen3Name('-', 13)) // entry 0 dummy
  put(rom, moveNames + 13, gen3Name('POUND', 13))
  put(rom, moveNames + 26, gen3Name('KARATE CHOP', 13))

  const abilities = 0x24fc40
  put(rom, abilities, gen3Name('-', 13)) // entry 0: no ability
  put(rom, abilities + 13, gen3Name('STENCH', 13))
  put(rom, abilities + 26, gen3Name('DRIZZLE', 13))

  addMapData(rom)
  addItemData(rom)
  addTrainerData(rom)
  addWildData(rom)
  addClassNames(rom)
  addSpeciesExtras(rom)
  return rom
}

/** Evolutions, learnsets and type chart. */
function addSpeciesExtras(rom: Uint8Array): void {
  // Evolutions: 40 bytes/species (5 × 8). Entry 0 dummy.
  const evos = 0x3d1000
  put(rom, evos + 40, u16s(4, 16, 2)) // Bulbasaur → #2 at 16
  put(rom, evos + 80, u16s(4, 32, 3)) // Ivysaur → #3 at 32
  put(rom, evos + 160, u16s(4, 16, 5)) // Charmander (species 4) → #5 at 16

  // Learnsets: pointer table + packed u16 lists.
  const lsDummy = 0x3d20f0
  put(rom, lsDummy, [0xff, 0xff])
  const lsBulba = 0x3d2100
  put(rom, lsBulba, u16s((1 << 9) | 33, (4 << 9) | 45, 0xffff))
  const lsIvy = 0x3d2110
  put(rom, lsIvy, u16s((1 << 9) | 33, (4 << 9) | 45, 0xffff))
  const lsVenu = 0x3d2120
  put(rom, lsVenu, u16s((1 << 9) | 33, (4 << 9) | 45, 0xffff))
  const lsChar = 0x3d2130
  put(rom, lsChar, u16s((1 << 9) | 10, (1 << 9) | 45, 0xffff))
  // Extra voting anchors: Pikachu (Thundershock@1), Magikarp (Splash@1).
  const lsPika = 0x3d2140
  put(rom, lsPika, u16s((1 << 9) | 84, 0xffff))
  const lsKarp = 0x3d2150
  put(rom, lsKarp, u16s((1 << 9) | 150, 0xffff))
  const lsTable = 0x3d2200
  put(rom, lsTable, [...ptr(lsDummy), ...ptr(lsBulba), ...ptr(lsIvy), ...ptr(lsVenu), ...ptr(lsChar)])
  put(rom, lsTable + 25 * 4, ptr(lsPika))
  put(rom, lsTable + 129 * 4, ptr(lsKarp))

  // Type chart: two normal rows + separator + one Foresight row + end.
  const chart = 0x3d3000
  put(rom, chart, [0, 5, 5, 0, 8, 5, 10, 10, 5, 10, 12, 20, 0xfe, 0xfe, 0, 0, 7, 0, 0xff, 0xff, 0])

  // TM/HM learnsets: entry 0 dummy, then the four anchor species.
  const tmhm = 0x3d5000
  put(rom, tmhm + 8, [32, 7, 53, 132, 8, 30, 228, 0]) // Bulbasaur
  put(rom, tmhm + 16, [32, 7, 53, 132, 8, 30, 228, 0]) // Ivysaur (same)
  put(rom, tmhm + 24, [48, 71, 53, 134, 8, 30, 228, 0]) // Venusaur
  put(rom, tmhm + 32, [35, 6, 81, 204, 164, 30, 166, 0]) // Charmander
  // TM move list: Focus Punch, Dragon Claw, Water Pulse, Calm Mind…
  put(rom, 0x3d5300, u16s(264, 337, 352, 347, 46))

  // Sprite tables: 210 self-tagged entries sharing one LZ77 gfx/palette.
  // Front table first, back second (the FRLG/R-S ordering); back gfx
  // uses palette color 2 so tests can tell the two apart.
  const gfx = 0x3d6000
  const tiles = new Uint8Array(0x800).fill(0x11) // all pixels = color 1
  put(rom, gfx, lz77Compress(tiles))
  const backGfx = 0x3d6800
  put(rom, backGfx, lz77Compress(new Uint8Array(0x800).fill(0x22))) // color 2
  const pal = 0x3d7000
  const palData = new Uint8Array(32)
  palData[2] = 0x1f // color 1 = red
  palData[4] = 0xe0 // color 2 = pure green (0x03E0 in BGR555)
  palData[5] = 0x03
  put(rom, pal, lz77Compress(palData))
  const shinyPal = 0x3d7100
  const shinyData = new Uint8Array(32)
  shinyData[2] = 0x00 // color 1 = pure blue (0x7C00 in BGR555)
  shinyData[3] = 0x7c
  put(rom, shinyPal, lz77Compress(shinyData))
  const picTable = 0x3d8000
  const backTable = 0x3d9000
  const palTable = 0x3da000
  const shinyTable = 0x3db000
  for (let i = 0; i < 210; i++) {
    put(rom, picTable + i * 8, [...ptr(gfx), ...u16s(0x800, i)])
    put(rom, backTable + i * 8, [...ptr(backGfx), ...u16s(0x800, i)])
    put(rom, palTable + i * 8, [...ptr(pal), ...u16s(i, 0)])
    put(rom, shinyTable + i * 8, [...ptr(shinyPal), ...u16s(500 + i, 0)]) // SPECIES_SHINY_TAG base
  }
}

/** Trainer class names: 13-byte entries; run must include the anchors. */
function addClassNames(rom: Uint8Array): void {
  const table = 0x3d0000
  const names = ['PKMN TRAINER', 'YOUNGSTER', 'BUG CATCHER', 'LASS', 'HIKER']
  const filler = ['SAILOR', 'FISHERMAN', 'CAMPER', 'PICNICKER', 'BEAUTY', 'PSYCHIC', 'BLACK BELT',
    'BIRD KEEPER', 'JUGGLER', 'ENGINEER', 'GAMBLER', 'SWIMMER', 'CUE BALL', 'GENTLEMAN', 'ROCKER']
  const all = [...names, ...filler]
  all.forEach((n, i) => put(rom, table + i * 13, gen3Name(n, 13)))
  rom[table - 13] = 0x01 // undecodable byte stops the backward walk
}

/**
 * Item table: 44-byte entries starting with a 14-byte name. Each entry
 * stores its own index at +14 and a description pointer at +20 — that
 * self-referencing shape is what discovery keys on (names are editable,
 * so they can't be the anchor). Entry 20 is a placeholder slot
 * (itemId 0) like the unused ids in the real games.
 */
function addItemData(rom: Uint8Array): void {
  const items = 0x3a0000
  // One shared placeholder string (like the real unused ids) plus a
  // private string for items 1-3, so both the in-place and the
  // relocate-because-shared paths are reachable.
  const desc = 0x3a4000
  put(rom, desc, [...gen3Bytes('A TEST ITEM.'), 0xff])
  const ownDesc = (i: number) => 0x3a4100 + i * 0x40
  for (let i = 1; i <= 3; i++) {
    put(rom, ownDesc(i), [...gen3Bytes('Catches a POKéMON.'), 0xfe, ...gen3Bytes('Second line.'), 0xff])
  }
  const names = ['??????????', 'MASTER BALL', 'ULTRA BALL', 'POTION']
  for (let i = 0; i < 120; i++) {
    const o = items + i * 44
    put(rom, o, gen3Name(names[i] ?? `ITEM${i}`, 14))
    put(rom, o + 14, u16s(i === 20 ? 0 : i)) // itemId (20 = unused slot)
    put(rom, o + 16, u16s(i * 10)) // price
    rom[o + 18] = i % 7 // holdEffect
    rom[o + 19] = i % 5 // holdEffectParam
    put(rom, o + 20, ptr(i >= 1 && i <= 3 ? ownDesc(i) : desc))
    rom[o + 24] = 0 // importance
    rom[o + 26] = (i % 5) + 1 // pocket
    rom[o + 27] = i % 3 // type
    put(rom, o + 28, ptr(desc)) // fieldUseFunc (any valid pointer)
    rom[o + 32] = i % 3 // battleUsage
    put(rom, o + 36, ptr(desc)) // battleUseFunc
    rom[o + 40] = i % 4 // secondaryId
  }
}

/**
 * Trainer table: 61 entries of 40 bytes. Most are simple one-mon
 * trainers (enough "strong" entries for alignment detection); trainer 1
 * uses held items + custom moves (partyFlags = 3).
 */
function addTrainerData(rom: Uint8Array): void {
  const table = 0x3b0000
  const simpleParty = 0x3b8000
  const richParty = 0x3b8100

  // Non-trainer data immediately before the table, like a real ROM.
  rom[table - 40] = 0xff

  // Shared simple party: 1 mon — iv, level, species, padding (8 bytes).
  put(rom, simpleParty, u16s(50, 10, 1, 0))
  // Rich party: 2 mons with items + custom moves (16 bytes each).
  put(rom, richParty, u16s(100, 20, 1, 3, 1, 2, 0, 0))
  put(rom, richParty + 16, u16s(0, 22, 2, 0, 2, 0, 0, 0))

  for (let i = 0; i < 61; i++) {
    const o = table + i * 40
    if (i === 1) {
      put(rom, o, [3, 2, 1, 4]) // flags=items+moves, class 2, music 1, pic 4
      put(rom, o + 4, gen3Name('BRENDAN', 12))
      put(rom, o + 16, u16s(3, 0, 0, 0)) // battle items: POTION
      put(rom, o + 24, [0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0]) // single, ai=1, size=2
      put(rom, o + 36, ptr(richParty))
    } else {
      put(rom, o, [0, 1, 0, 2])
      put(rom, o + 4, gen3Name('YOUNGSTER', 12))
      put(rom, o + 24, [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]) // ai=0, size=1
      put(rom, o + 36, ptr(simpleParty))
    }
  }
}

/**
 * Wild encounters for the two fixture maps: map 0.0 has grass + fishing,
 * map 1.0 has grass only; table ends with the FF FF terminator.
 */
function addWildData(rom: Uint8Array): void {
  const grass = 0x3c0000
  for (let i = 0; i < 12; i++) put(rom, grass + i * 4, [3, 5, ...u16s(i % 2 === 0 ? 1 : 2).slice(0, 2)])
  const fishing = 0x3c0100
  for (let i = 0; i < 10; i++) put(rom, fishing + i * 4, [10, 15, ...u16s(2).slice(0, 2)])

  const grassInfo = 0x3c0200
  put(rom, grassInfo, [20, 0, 0, 0, ...ptr(grass)])
  const fishingInfo = 0x3c0210
  put(rom, fishingInfo, [30, 0, 0, 0, ...ptr(fishing)])

  const table = 0x3c1000
  put(rom, table, [0, 0, 0, 0, ...ptr(grassInfo), 0, 0, 0, 0, 0, 0, 0, 0, ...ptr(fishingInfo)])
  put(rom, table + 20, [1, 0, 0, 0, ...ptr(grassInfo), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  put(rom, table + 40, [0xff, 0xff])
}

/* --------------------------------------------------- Gen 3 map fixtures */

function ptr(off: number): number[] {
  const v = (off + 0x08000000) >>> 0
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]
}

function u16s(...values: number[]): number[] {
  return values.flatMap((v) => [v & 0xff, (v >> 8) & 0xff])
}

/**
 * A complete synthetic map-data chain (FRLG family, so primary metatiles
 * run 0..639 and block 640 is the secondary tileset's entry 0):
 * two tilesets → layout (4×3) → map header (+1 NPC, +1 warp) →
 * two single-map groups → bank table.
 */
function addMapData(rom: Uint8Array): void {
  const gfxP = 0x310100
  const palP = 0x310200
  const mtP = 0x310500
  const tsP = 0x310000
  const gfxS = 0x311100
  const palS = 0x311300
  const mtS = 0x311600
  const tsS = 0x311000
  const border = 0x312000
  const blocks = 0x312100
  const layout = 0x312200
  const events = 0x312300
  const npcs = 0x312400
  const warps = 0x312500
  const header = 0x312700
  const group0 = 0x313000
  const group1 = 0x313010
  const bankTable = 0x313100

  // Primary tileset: compressed gfx, 3 tiles (solid color 1, 2, 0).
  const tiles = new Uint8Array(96)
  tiles.fill(0x11, 0, 32)
  tiles.fill(0x22, 32, 64)
  put(rom, tsP, [1, 0, 0, 0, ...ptr(gfxP), ...ptr(palP), ...ptr(mtP), 0, 0, 0, 0, 0, 0, 0, 0])
  put(rom, gfxP, lz77Compress(tiles))
  put(rom, palP + 0 * 32 + 1 * 2, u16s(0x001f)) // palette 0, color 1: red
  put(rom, palP + 1 * 32 + 2 * 2, u16s(0x03e0)) // palette 1, color 2: green
  // Metatile 0: bottom layer tile 0 pal 0, top layer tile 2 (transparent).
  put(rom, mtP, u16s(0, 0, 0, 0, 2, 2, 2, 2))
  // Metatile 1: bottom layer tile 1 pal 1.
  put(rom, mtP + 16, u16s(0x1001, 0x1001, 0x1001, 0x1001, 2, 2, 2, 2))

  // Secondary tileset: raw gfx, 1 tile (solid color 3).
  put(rom, tsS, [0, 1, 0, 0, ...ptr(gfxS), ...ptr(palS), ...ptr(mtS), 0, 0, 0, 0, 0, 0, 0, 0])
  put(rom, gfxS, new Uint8Array(32).fill(0x33))
  put(rom, palS + 7 * 32 + 3 * 2, u16s(0x7c00)) // palette 7, color 3: blue
  // Secondary metatile 0 (= block 640): tile 640 pal 7.
  put(rom, mtS, u16s(0x7280, 0x7280, 0x7280, 0x7280, 2, 2, 2, 2))

  // 4×3 block grid; cell (0,1) has movement permission 1.
  put(rom, blocks, u16s(0, 1, 0, 640, 0x0400, 1, 0, 0, 1, 0, 1, 0))
  put(rom, layout, [4, 0, 0, 0, 3, 0, 0, 0, ...ptr(border), ...ptr(blocks), ...ptr(tsP), ...ptr(tsS), 2, 2, 0, 0])

  // Events: 1 NPC at (2,1), 1 warp at (3,2).
  put(rom, events, [1, 1, 0, 0, ...ptr(npcs), ...ptr(warps), 0, 0, 0, 0, 0, 0, 0, 0])
  put(rom, npcs, [1, 5, 0, 0, ...u16s(2, 1), 3, 1, 0x11, 0, ...u16s(0, 0), 0, 0, 0, 0, ...u16s(0, 0)])
  put(rom, warps, [...u16s(3, 2), 0, 1, 0, 1])

  put(rom, header, [...ptr(layout), ...ptr(events), 0, 0, 0, 0, 0, 0, 0, 0, ...u16s(0x012c, 1), 1, 0, 2, 1, 0, 0, 1, 0])
  put(rom, group0, ptr(header))
  put(rom, group1, ptr(header))
  put(rom, bankTable, [...ptr(group0), ...ptr(group1)])
}

/* ------------------------------------------------------------ Gen 4/5 */

export function buildNarc(subfiles: Uint8Array[]): Uint8Array {
  const total = subfiles.reduce((s, f) => s + f.length, 0)
  const btafSize = 12 + subfiles.length * 8
  const narc = new Uint8Array(16 + btafSize + 16 + 8 + total)
  const w16 = (o: number, v: number) => put(narc, o, u16s(v))
  const w32 = (o: number, v: number) =>
    put(narc, o, [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff])
  put(narc, 0, Array.from('NARC').map((c) => c.charCodeAt(0)))
  narc[4] = 0xfe
  narc[5] = 0xff
  w32(8, narc.length)
  w16(12, 16)
  w16(14, 3)
  let p = 16
  put(narc, p, Array.from('BTAF').map((c) => c.charCodeAt(0)))
  w32(p + 4, btafSize)
  w16(p + 8, subfiles.length)
  let rel = 0
  subfiles.forEach((f, i) => {
    w32(p + 12 + i * 8, rel)
    w32(p + 16 + i * 8, rel + f.length)
    rel += f.length
  })
  p += btafSize
  put(narc, p, Array.from('BTNF').map((c) => c.charCodeAt(0)))
  w32(p + 4, 16)
  w32(p + 8, 4)
  w16(p + 12, 0)
  w16(p + 14, 1)
  p += 16
  put(narc, p, Array.from('GMIF').map((c) => c.charCodeAt(0)))
  w32(p + 4, 8 + total)
  p += 8
  for (const f of subfiles) {
    put(narc, p, f)
    p += f.length
  }
  return narc
}

/** NDS ROM with one file at /dir0/dir1/.../fileName. */
/** Build an NDS ROM with an arbitrary file tree (FNT + FAT). */
export function makeNdsRom(
  gameCode: string,
  entries: { path: string; content: Uint8Array }[],
): Uint8Array {
  const rom = new Uint8Array(0x200000)
  put(rom, 0x00, Array.from('POKEMON').map((c) => c.charCodeAt(0)))
  put(rom, 0x0c, Array.from(gameCode).map((c) => c.charCodeAt(0)))

  // Directory tree from the paths.
  interface Dir { id: number; name: string; parent: number; dirs: Dir[]; files: { name: string; index: number }[] }
  const root: Dir = { id: 0xf000, name: '', parent: 0xf000, dirs: [], files: [] }
  const allDirs: Dir[] = [root]
  const dirFor = (parts: string[]): Dir => {
    let d = root
    for (const part of parts) {
      let next = d.dirs.find((x) => x.name === part)
      if (!next) {
        next = { id: 0xf000 + allDirs.length, name: part, parent: d.id, dirs: [], files: [] }
        d.dirs.push(next)
        allDirs.push(next)
      }
      d = next
    }
    return d
  }
  entries.forEach((e, index) => {
    const parts = e.path.replace(/^\//, '').split('/')
    dirFor(parts.slice(0, -1)).files.push({ name: parts[parts.length - 1], index })
  })

  // File ids in subtable emission order (= allDirs order).
  const fileIds = new Map<number, number>() // entry index -> file id
  let nextFile = 0
  const firstFileId = new Map<number, number>()
  for (const d of allDirs) {
    firstFileId.set(d.id, nextFile)
    for (const f of d.files) fileIds.set(f.index, nextFile++)
  }

  const fnt = 0x1000
  const fat = 0x3000
  put(rom, 0x40, [fnt & 0xff, fnt >> 8, 0, 0])
  put(rom, 0x44, [0, 0x10, 0, 0])
  put(rom, 0x48, [fat & 0xff, fat >> 8, 0, 0])
  put(rom, 0x4c, [entries.length * 8, 0, 0, 0])

  // Main table (8 bytes per dir) then subtables.
  let subOff = allDirs.length * 8
  for (const d of allDirs) {
    const parentOrCount = d === root ? allDirs.length : d.parent
    const first = firstFileId.get(d.id)!
    put(rom, fnt + (d.id - 0xf000) * 8, [
      subOff & 0xff, (subOff >> 8) & 0xff, 0, 0,
      first & 0xff, first >> 8,
      parentOrCount & 0xff, parentOrCount >> 8,
    ])
    let p = fnt + subOff
    for (const f of d.files) {
      rom[p++] = f.name.length
      for (const ch of f.name) rom[p++] = ch.charCodeAt(0)
    }
    for (const sub of d.dirs) {
      rom[p++] = 0x80 | sub.name.length
      for (const ch of sub.name) rom[p++] = ch.charCodeAt(0)
      rom[p++] = sub.id & 0xff
      rom[p++] = sub.id >> 8
    }
    rom[p++] = 0
    subOff = p - fnt
  }

  // FAT + contents.
  let dataOff = 0x8000
  entries.forEach((e, index) => {
    const id = fileIds.get(index)!
    put(rom, fat + id * 8, [dataOff & 0xff, (dataOff >> 8) & 0xff, (dataOff >> 16) & 0xff, 0])
    const end = dataOff + e.content.length
    put(rom, fat + id * 8 + 4, [end & 0xff, (end >> 8) & 0xff, (end >> 16) & 0xff, 0])
    put(rom, dataOff, e.content)
    dataOff = (end + 0xff) & ~0xff
  })
  return rom
}

export function makeNdsRomWithFile(
  gameCode: string,
  dirs: string[],
  fileName: string,
  content: Uint8Array,
): Uint8Array {
  const rom = new Uint8Array(0x100000)
  put(rom, 0x00, Array.from('POKEMON').map((c) => c.charCodeAt(0)))
  put(rom, 0x0c, Array.from(gameCode).map((c) => c.charCodeAt(0)))
  const fnt = 0x1000
  const fat = 0x3000
  const fileOff = 0x8000
  put(rom, 0x40, [0, 16, 0, 0]) // fnt offset 0x1000
  put(rom, 0x44, [0, 8, 0, 0]) // fnt size
  put(rom, 0x48, [0, 48, 0, 0]) // fat offset 0x3000
  put(rom, 0x4c, [8, 0, 0, 0]) // fat size: 1 file
  const dirCount = dirs.length + 1
  // Main table entries: root + one per dir; subtables every 0x40 from +0x100.
  const sub = (i: number) => 0x100 + i * 0x40
  put(rom, fnt, [sub(0) & 0xff, sub(0) >> 8, 0, 0, 0, 0, dirCount & 0xff, dirCount >> 8])
  dirs.forEach((_, i) => {
    const parent = i === 0 ? 0xf000 : 0xf000 + i
    put(rom, fnt + 8 * (i + 1), [sub(i + 1) & 0xff, sub(i + 1) >> 8, 0, 0, 0, 0, parent & 0xff, parent >> 8])
  })
  // Subtables: each dir level points into the next; the last holds the file.
  dirs.forEach((name, i) => {
    const id = 0xf001 + i
    put(rom, fnt + sub(i), [0x80 | name.length, ...Array.from(name).map((c) => c.charCodeAt(0)), id & 0xff, id >> 8, 0])
  })
  put(rom, fnt + sub(dirs.length), [fileName.length, ...Array.from(fileName).map((c) => c.charCodeAt(0)), 0])
  put(rom, fat, [fileOff & 0xff, (fileOff >> 8) & 0xff, (fileOff >> 16) & 0xff, 0])
  const end = fileOff + content.length
  put(rom, fat + 4, [end & 0xff, (end >> 8) & 0xff, (end >> 16) & 0xff, 0])
  put(rom, fileOff, content)
  return rom
}

/**
 * Encode a Gen 4 msg bank (XOR-symmetric scrambling). Only A-Z / a-z
 * text: A=0x12B…, a=0x145… per the generated charmap.
 */
export function encodeMsgBank(texts: string[], key: number): Uint8Array {
  const chars = (text: string) =>
    [...text].map((ch) =>
      ch >= 'A' && ch <= 'Z' ? 0x12b + ch.charCodeAt(0) - 65 : 0x145 + ch.charCodeAt(0) - 97,
    )
  const messages = texts.map((t) => [...chars(t), 0xffff])
  const total = 4 + messages.length * 8 + messages.reduce((s, m) => s + m.length * 2, 0)
  const out = new Uint8Array(total)
  const w16 = (o: number, v: number) => {
    out[o] = v & 0xff
    out[o + 1] = (v >> 8) & 0xff
  }
  w16(0, messages.length)
  w16(2, key)
  let off = 4 + messages.length * 8
  messages.forEach((msg, n) => {
    let seed = (key * 765 * (n + 1)) & 0xffff
    seed = ((seed | (seed << 16)) & 0xffffffff) >>> 0
    w16(4 + n * 8, (off ^ seed) & 0xffff)
    w16(6 + n * 8, ((off ^ seed) >>> 16) & 0xffff)
    w16(8 + n * 8, (msg.length ^ seed) & 0xffff)
    w16(10 + n * 8, ((msg.length ^ seed) >>> 16) & 0xffff)
    let charSeed = ((n + 1) * 596947) & 0xffff
    for (const c of msg) {
      w16(off, (c ^ charSeed) & 0xffff)
      charSeed = (charSeed + 18749) & 0xffff
      off += 2
    }
  })
  return out
}

/** Scrambled Pt/HGSS-style NCGR: 160×80 4bpp, all color-1 pixels. */
function buildNcgr(key: number): Uint8Array {
  const plain = new Uint8Array(6400).fill(0x11)
  plain[0] = 0
  plain[1] = 0
  const data = new Uint8Array(6400)
  let seed = key >>> 0
  for (let i = 0; i < 3200; i++) {
    const v = (plain[i * 2] | (plain[i * 2 + 1] << 8)) ^ (seed & 0xffff)
    data[i * 2] = v & 0xff
    data[i * 2 + 1] = (v >> 8) & 0xff
    seed = (Math.imul(seed, 1103515245) + 24691) >>> 0
  }
  const out = new Uint8Array(0x30 + 6400)
  put(out, 0, [...'RGCN'].map((c) => c.charCodeAt(0)))
  put(out, 4, [0xff, 0xfe, 0x00, 0x01])
  put(out, 8, [(out.length & 0xff), (out.length >> 8) & 0xff, 0, 0])
  put(out, 12, [0x10, 0, 1, 0])
  put(out, 0x10, [...'RAHC'].map((c) => c.charCodeAt(0)))
  put(out, 0x14, [0x20, 0x19, 0, 0]) // block size
  put(out, 0x18, [10, 0, 20, 0]) // tilesY, tilesX
  put(out, 0x1c, [3, 0, 0, 0]) // 4bpp
  put(out, 0x24, [1, 0, 0, 0]) // scanned (linear) flag
  put(out, 0x28, [0x00, 0x19, 0, 0]) // data size 6400
  put(out, 0x2c, [0x18, 0, 0, 0])
  put(out, 0x30, data)
  return out
}

/** 16-color NCLR with color 1 set to `c1` (BGR555). */
function buildNclr(c1: number): Uint8Array {
  const out = new Uint8Array(0x28 + 32)
  put(out, 0, [...'RLCN'].map((c) => c.charCodeAt(0)))
  put(out, 4, [0xff, 0xfe, 0x00, 0x01])
  put(out, 8, [out.length & 0xff, (out.length >> 8) & 0xff, 0, 0])
  put(out, 12, [0x10, 0, 1, 0])
  put(out, 0x10, [...'TTLP'].map((c) => c.charCodeAt(0)))
  put(out, 0x14, [0x38, 0, 0, 0])
  put(out, 0x18, [4, 0, 0, 0])
  put(out, 0x20, [0x20, 0, 0, 0])
  put(out, 0x24, [0x10, 0, 0, 0])
  put(out, 0x28 + 2, [c1 & 0xff, c1 >> 8]) // color 1
  return out
}

/** Platinum-style ROM: 150-species personal NARC, Gen 4 layout. */
export function makeGen4Rom(): Uint8Array {
  const entries: Uint8Array[] = []
  for (let i = 0; i < 150; i++) entries.push(new Uint8Array(44))
  // Bulbasaur-ish entry 1 (offsets verified against pokeplatinum).
  const b = entries[1]
  put(b, 0, [45, 49, 49, 45, 65, 65, 12, 3, 45, 64])
  put(b, 10, u16s(0x0100)) // 1 Sp. Atk EV
  put(b, 12, u16s(0, 0))
  put(b, 16, [31, 20, 70, 3, 1, 7, 65, 0])
  b[28] = 0b0000_0101 // TMs 1 and 3
  put(entries[2], 0, [60, 62, 63, 60, 80, 80, 12, 3, 45, 141])
  const moves: Uint8Array[] = []
  for (let i = 0; i < 470; i++) moves.push(new Uint8Array(16))
  // Pound: effect 0, physical, power 40, Normal, 100%, 35 PP.
  put(moves[1], 0, [0, 0, 0, 40, 0, 100, 35, 0, 0, 0, 0, 0])
  // Quick Attack-ish: priority +1 at offset 10.
  put(moves[98], 0, [0, 0, 0, 40, 0, 100, 30, 0, 0, 0, 1, 0])
  // Msg NARC with the species (412) and move (647) name banks at
  // Platinum's indices.
  const msgSubs: Uint8Array[] = []
  for (let i = 0; i < 412; i++) msgSubs.push(new Uint8Array(0))
  msgSubs.push(encodeMsgBank(['Egg', 'Bulbasaur', 'Ivysaur'], 0x1e39))
  while (msgSubs.length < 647) msgSubs.push(new Uint8Array(0))
  msgSubs.push(encodeMsgBank(['x', 'Pound', 'KarateChop'], 0x2b21))
  // pl_pokegra: 6 subfiles/species; species 1/4/7/25 get real scrambled
  // NCGRs + palettes (red normal, green shiny), everything else empty.
  const graSubs: Uint8Array[] = []
  for (let sp = 0; sp <= 110; sp++) {
    const real = sp === 1 || sp === 4 || sp === 7 || sp === 25
    graSubs.push(new Uint8Array(0)) // back female
    graSubs.push(real ? buildNcgr(0x1234 + sp) : new Uint8Array(0)) // back male
    graSubs.push(new Uint8Array(0)) // front female
    graSubs.push(real ? buildNcgr(0x4321 + sp) : new Uint8Array(0)) // front male
    graSubs.push(real ? buildNclr(0x001f) : new Uint8Array(0)) // normal: red
    graSubs.push(real ? buildNclr(0x03e0) : new Uint8Array(0)) // shiny: green
  }
  // evo.narc: 44-byte subfiles (7 × {method, param, target} u16s + pad);
  // Bulbasaur evolves at 16 (EVO_LEVEL = 4) into dex 2.
  const evoSubs: Uint8Array[] = []
  for (let i = 0; i < 150; i++) evoSubs.push(new Uint8Array(44))
  put(evoSubs[1], 0, u16s(4, 16, 2))
  // wotbl.narc: (level<<9)|move u16s, 0xFFFF end.
  const wotblSubs: Uint8Array[] = []
  for (let i = 0; i < 150; i++) wotblSubs.push(Uint8Array.from(u16s(0xffff)))
  wotblSubs[1] = Uint8Array.from(u16s((1 << 9) | 33, (4 << 9) | 45, 0xffff))
  return makeNdsRom('CPUE', [
    { path: 'poketool/personal/pl_personal.narc', content: buildNarc(entries) },
    { path: 'poketool/waza/pl_waza_tbl.narc', content: buildNarc(moves) },
    { path: 'msgdata/pl_msg.narc', content: buildNarc(msgSubs) },
    { path: 'poketool/pokegra/pl_pokegra.narc', content: buildNarc(graSubs) },
    { path: 'poketool/personal/evo.narc', content: buildNarc(evoSubs) },
    { path: 'poketool/personal/wotbl.narc', content: buildNarc(wotblSubs) },
  ])
}

/** Black-style ROM: 60-byte entries (layout per PKHeX PersonalInfo5BW). */
export function makeGen5Rom(): Uint8Array {
  const entries: Uint8Array[] = []
  for (let i = 0; i < 160; i++) entries.push(new Uint8Array(60))
  const b = entries[1]
  put(b, 0, [45, 49, 49, 45, 65, 65, 11, 3, 45]) // grass = 11 in Gen 5
  put(b, 0x0a, u16s(0x0100)) // 1 Sp. Atk EV
  put(b, 0x0c, u16s(17, 0, 44)) // items 1-3
  put(b, 0x12, [31, 20, 70, 3, 1, 7, 65, 0, 34]) // gender…abilities+hidden
  put(b, 0x22, u16s(300)) // base EXP is u16 in Gen 5
  b[0x28] = 0b0000_0101 // TM01 + TM03
  b[0x28 + 11] = 0x80 // flag index 95 = HM01
  return makeNdsRomWithFile('IRBO', ['a', '0', '1'], '6', buildNarc(entries))
}
