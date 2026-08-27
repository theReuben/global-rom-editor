/**
 * Gen 2 (G/S/C) map viewing and block painting.
 *
 * Formats verified against pokecrystal (data/maps/maps.asm,
 * data/maps/attributes.asm, data/tilesets.asm):
 *
 *  - MapGroupPointers: one bank-local u16 per map group; each group is
 *    an array of 9-byte map entries {attrBank, tileset, environment,
 *    attrPtr u16, location, music, phone/timeofday, fishgroup} in the
 *    same bank as the table
 *  - MapAttributes: {borderBlock, height, width, blocksBank,
 *    blocksPtr u16, scriptsBank, scriptsPtr u16, eventsPtr u16,
 *    connections, …}
 *  - Tilesets: 15-byte entries {gfx bank+ptr, metatiles bank+ptr,
 *    collision bank+ptr, anim u16, NULL u16, palmap u16} — the NULL
 *    word is a handy structural invariant. Tileset gfx are lz3
 *    compressed; metatiles are raw 16-byte 4×4 tile grids.
 *  - Palette maps (gfx/tileset_palette_maps.asm): one nibble per tile
 *    (byte = tile>>1, odd tile = high nibble), bit 3 = VRAM bank,
 *    low 3 bits = BG palette 0-7. The palmap pointer has no bank
 *    byte — all maps live in the bank of _LoadOverworldAttrmapPals,
 *    which we discover by voting across every tileset's pointer.
 *    Colors are the public day/indoor/dungeon sets from
 *    gfx/tilesets/bg_tiles.pal + data/maps/environment_colors.asm.
 */
import type { Rom } from '../rom'
import type { EventKind, MapModule, RenderedImage } from '../games/schema'
import { decodeTile2bpp } from '../tiles'
import { lz3Decompress } from './lz3'
import { findGbBankFreeSpace } from '../freespace'

const MAP_ENTRY = 9
const TILESET_ENTRY = 15
const MAX_DIM = 64
const MIN_GROUPS = 15
const MAX_GROUPS = 40

const GB_SHADES: [number, number, number][] = [
  [232, 240, 223],
  [160, 178, 148],
  [88, 105, 80],
  [28, 35, 26],
]

// 5-bit RGB rows from pokecrystal gfx/tilesets/bg_tiles.pal: the "day"
// set (outdoor water swapped in per environment_colors.asm $28), the
// plain day set for caves/dungeons, and the indoor set. Order:
// GRAY, RED, GREEN, WATER, YELLOW, BROWN, ROOF, TEXT.
type PalSet = number[][][]
const five = (v: number) => (v << 3) | (v >> 2)
const P = (...vals: number[]): number[][] => {
  const colors: number[][] = []
  for (let i = 0; i < 4; i++) colors.push([five(vals[i * 3]), five(vals[i * 3 + 1]), five(vals[i * 3 + 2])])
  return colors
}
const DAY_COMMON = [
  P(27, 31, 27, 21, 21, 21, 13, 13, 13, 7, 7, 7), // gray
  P(27, 31, 27, 31, 19, 24, 30, 10, 6, 7, 7, 7), // red
  P(22, 31, 10, 12, 25, 1, 5, 14, 0, 7, 7, 7), // green
]
const DAY_TAIL = [
  P(27, 31, 27, 31, 31, 7, 31, 16, 1, 7, 7, 7), // yellow
  P(27, 31, 27, 24, 18, 7, 20, 15, 3, 7, 7, 7), // brown
  P(27, 31, 27, 15, 31, 31, 5, 17, 31, 7, 7, 7), // roof
  P(31, 31, 16, 31, 31, 16, 14, 9, 0, 0, 0, 0), // text
]
const OUTDOOR: PalSet = [...DAY_COMMON, P(23, 23, 31, 18, 19, 31, 13, 12, 31, 7, 7, 7), ...DAY_TAIL]
const DUNGEON: PalSet = [...DAY_COMMON, P(31, 31, 31, 8, 12, 31, 1, 4, 31, 7, 7, 7), ...DAY_TAIL]
const INDOOR: PalSet = [
  P(30, 28, 26, 19, 19, 19, 13, 13, 13, 7, 7, 7),
  P(30, 28, 26, 31, 19, 24, 30, 10, 6, 7, 7, 7),
  P(18, 24, 9, 15, 20, 1, 9, 13, 0, 7, 7, 7),
  P(30, 28, 26, 15, 16, 31, 9, 9, 31, 7, 7, 7),
  P(30, 28, 26, 31, 31, 7, 31, 16, 1, 7, 7, 7),
  P(26, 24, 17, 21, 17, 7, 16, 13, 3, 7, 7, 7),
  P(30, 28, 26, 17, 19, 31, 14, 16, 31, 7, 7, 7),
  P(31, 31, 16, 31, 31, 16, 14, 9, 0, 0, 0, 0),
]
// Environments (constants/map_data_constants.asm): INDOOR=3, GATE=6
// use the indoor colors; CAVE=4, DUNGEON=7 the plain day colors.
const palSetFor = (env: number): PalSet =>
  env === 3 || env === 6 ? INDOOR : env === 4 || env === 7 ? DUNGEON : OUTDOOR

interface Gen2MapRec {
  group: number // 1-based
  map: number // 1-based
  tileset: number
  environment: number
  height: number
  width: number
  blocksOff: number
  attrOff: number
}

function toFile(bank: number, local: number): number {
  return bank * 0x4000 + (local < 0x4000 ? local : local - 0x4000)
}

export function buildGen2Maps(
  rom: Rom,
  mapNames: Record<string, string>,
): { module: MapModule; groups: number; tilesets: number; count: number; palBank: number } | null {
  const bytes = rom.bytes
  const romBanks = Math.max(2, Math.floor(bytes.length / 0x4000))
  const ptrOk = (v: number) => v >= 0x4000 && v < 0x8000

  const attrPlausible = (off: number): boolean => {
    if (off + 12 > bytes.length) return false
    const h = bytes[off + 1]
    const w = bytes[off + 2]
    const blocksBank = bytes[off + 3]
    return h >= 1 && h <= MAX_DIM && w >= 1 && w <= MAX_DIM &&
      blocksBank >= 1 && blocksBank < romBanks && ptrOk(rom.readU16LE(off + 4))
  }
  const entryPlausible = (off: number): boolean => {
    const attrBank = bytes[off]
    const env = bytes[off + 2]
    const attrPtr = rom.readU16LE(off + 3)
    return attrBank >= 1 && attrBank < romBanks && env <= 7 && ptrOk(attrPtr) &&
      attrPlausible(toFile(attrBank, attrPtr))
  }

  // 1. MapGroupPointers: a run of same-bank pointers where consecutive
  //    groups are 9-byte aligned and every group opens with a real map.
  let groupTable = -1
  let groupCount = 0
  scan: for (let o = 0; o + MIN_GROUPS * 2 <= bytes.length; o += 1) {
    const bank = Math.floor(o / 0x4000)
    let n = 0
    while (n < MAX_GROUPS && o + n * 2 + 2 <= bytes.length) {
      const v = rom.readU16LE(o + n * 2)
      if (!ptrOk(v)) break
      n++
    }
    if (n < MIN_GROUPS) {
      if (n > 0) o += n * 2 - 1
      continue
    }
    // Trim to the aligned, valid prefix.
    let k = 0
    while (k < n) {
      const start = toFile(bank, rom.readU16LE(o + k * 2))
      if (!entryPlausible(start)) break
      if (k + 1 < n) {
        const next = toFile(bank, rom.readU16LE(o + (k + 1) * 2))
        if (next > start && (next - start) % MAP_ENTRY !== 0) break
      }
      k++
    }
    if (k >= MIN_GROUPS) {
      groupTable = o
      groupCount = k
      break scan
    }
    o += n * 2 - 1
  }
  if (groupTable < 0) return null
  const groupBank = Math.floor(groupTable / 0x4000)

  // 2. Collect maps per group (group g runs to the next group's start).
  const maps: Gen2MapRec[] = []
  const starts = Array.from({ length: groupCount }, (_, g) =>
    toFile(groupBank, rom.readU16LE(groupTable + g * 2)),
  )
  for (let g = 0; g < groupCount; g++) {
    let end = bytes.length
    for (const s of starts) if (s > starts[g] && s < end) end = s
    let off = starts[g]
    let m = 1
    while (off + MAP_ENTRY <= end && m <= 60) {
      if (!entryPlausible(off)) break
      const attrOff = toFile(bytes[off], rom.readU16LE(off + 3))
      maps.push({
        group: g + 1,
        map: m,
        tileset: bytes[off + 1],
        environment: bytes[off + 2],
        height: bytes[attrOff + 1],
        width: bytes[attrOff + 2],
        blocksOff: toFile(bytes[attrOff + 3], rom.readU16LE(attrOff + 4)),
        attrOff,
      })
      off += MAP_ENTRY
      m++
    }
  }
  if (maps.length < 100) return null

  // 3. Tilesets table: 15-byte entries with three bank+ptr triples and
  //    the NULL word at +11.
  const maxTileset = Math.max(...maps.map((m) => m.tileset))
  let tilesets = -1
  for (let o = 0; o + (maxTileset + 1) * TILESET_ENTRY <= bytes.length; o += 1) {
    let n = 0
    while (n < 64 && o + (n + 1) * TILESET_ENTRY <= bytes.length) {
      const e = o + n * TILESET_ENTRY
      let ok = true
      for (const base of [0, 3, 6]) {
        const bank = bytes[e + base]
        const ptr = rom.readU16LE(e + base + 1)
        if (bank < 1 || bank >= romBanks || !ptrOk(ptr)) ok = false
      }
      if (rom.readU16LE(e + 11) !== 0) ok = false
      if (!ok) break
      n++
    }
    if (n > maxTileset) {
      tilesets = o
      break
    }
    if (n > 0) o += n * TILESET_ENTRY - 1
  }
  if (tilesets < 0) return null

  // 3b. Palette-map bank: the palmap word (entry +13) carries no bank.
  //     Vote across tilesets — the right bank shows nibble-pair data
  //     (bit 3 of every nibble clear in the first 48 bytes = the VRAM
  //     bank-0 tiles) with real variety, in every tileset at once.
  const tilesetCount = maxTileset + 1
  let palBank = -1
  {
    const palPtrs: number[] = []
    for (let t = 0; t < tilesetCount; t++) {
      const ptr = rom.readU16LE(tilesets + t * TILESET_ENTRY + 13)
      if (ptrOk(ptr)) palPtrs.push(ptr)
    }
    let bestScore = 0
    for (let b = 1; b < romBanks; b++) {
      let score = 0
      for (const ptr of palPtrs) {
        const off = toFile(b, ptr)
        if (off + 0x30 > bytes.length) continue
        let ok = true
        const seen = new Set<number>()
        for (let i = 0; i < 0x30; i++) {
          const v = bytes[off + i]
          if ((v & 0x88) !== 0) ok = false
          seen.add(v)
        }
        if (ok && seen.size >= 4) score++
      }
      if (score > bestScore) {
        bestScore = score
        palBank = b
      }
    }
    if (bestScore < Math.max(3, Math.floor(palPtrs.length * 0.7))) palBank = -1
  }

  const byKey = new Map(maps.map((m) => [`${m.group}.${m.map}`, m]))

  const parseEvents = (m: Gen2MapRec) => {
    const bank = bytes[m.attrOff + 6] // scripts/events share a bank
    const evOff = toFile(bank, rom.readU16LE(m.attrOff + 9))
    const warps: number[] = []
    const signs: number[] = []
    const npcs: number[] = []
    let p = evOff + 2 // skip the filler word
    const nWarps = bytes[p++]
    for (let i = 0; i < Math.min(nWarps, 48); i++) {
      warps.push(p)
      p += 5
    }
    const coordsOff = p
    p += 1 + Math.min(bytes[p], 32) * 8 // coord events: not exposed
    const coordsEnd = p
    const nBg = bytes[p++]
    for (let i = 0; i < Math.min(nBg, 48); i++) {
      signs.push(p)
      p += 5
    }
    const nObj = bytes[p++]
    for (let i = 0; i < Math.min(nObj, 48); i++) {
      npcs.push(p)
      p += 13
    }
    return { evOff, bank, warps, coordsOff, coordsEnd, signs, npcs, end: p }
  }

  /**
   * Rebuild a map's MapEvents blob with one event added (copying the
   * last entry of its kind, whose script pointers and ids are all valid
   * for this map) or removed. Growth relocates the blob into trailing
   * free space of the scripts bank (the pointer's bank) and retargets
   * the attributes' events pointer; the old blob stays untouched.
   */
  const editEvents = (m: Gen2MapRec, kind: EventKind, removeIndex: number | null): boolean => {
    const parsed = parseEvents(m)
    const raw = (off: number, len: number) => [...bytes.subarray(off, off + len)]
    const warps = parsed.warps.map((w) => raw(w, 5))
    const signs = parsed.signs.map((s) => raw(s, 5))
    const npcs = parsed.npcs.map((n) => raw(n, 13))
    const lists = { warp: warps, sign: signs, npc: npcs } as const
    const list = lists[kind]
    if (removeIndex !== null) {
      if (removeIndex < 0 || removeIndex >= list.length) return false
      list.splice(removeIndex, 1)
    } else {
      const last = list[list.length - 1]
      if (!last || list.length >= 48) return false
      list.push([...last])
    }
    const blob = [
      bytes[parsed.evOff],
      bytes[parsed.evOff + 1], // filler word
      warps.length,
      ...warps.flat(),
      ...raw(parsed.coordsOff, parsed.coordsEnd - parsed.coordsOff),
      signs.length,
      ...signs.flat(),
      npcs.length,
      ...npcs.flat(),
    ]
    if (blob.length <= parsed.end - parsed.evOff) {
      rom.writeBytes(parsed.evOff, blob)
      return true
    }
    const dest = findGbBankFreeSpace(bytes, parsed.bank, blob.length)
    if (dest === null) return false
    rom.writeBytes(dest, blob)
    rom.writeU16LE(m.attrOff + 9, (dest % 0x4000) + 0x4000)
    return true
  }

  const gfxCache = new Map<number, Uint8Array>()
  const tilesetInfo = (ts: number) => {
    const e = tilesets + ts * TILESET_ENTRY
    const gfxOff = toFile(bytes[e], rom.readU16LE(e + 1))
    const meta = toFile(bytes[e + 3], rom.readU16LE(e + 4))
    const palMap = palBank >= 0 ? toFile(palBank, rom.readU16LE(e + 13)) : -1
    let gfx = gfxCache.get(gfxOff)
    if (!gfx) {
      try {
        gfx = lz3Decompress(bytes, gfxOff)
      } catch {
        gfx = new Uint8Array(0)
      }
      gfxCache.set(gfxOff, gfx)
    }
    return { gfx, meta, palMap }
  }

  const renderBlockGrid = (ts: number, env: number, blockIds: ArrayLike<number>, perRow: number): RenderedImage => {
    const { gfx, meta, palMap } = tilesetInfo(ts)
    const palSet = palSetFor(env)
    const tileCount = Math.floor(gfx.length / 16)
    const rows = Math.ceil(blockIds.length / perRow)
    const width = perRow * 32
    const height = rows * 32
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < blockIds.length; i++) {
      const bx = (i % perRow) * 32
      const by = Math.floor(i / perRow) * 32
      const def = meta + blockIds[i] * 16
      for (let tyy = 0; tyy < 4; tyy++) {
        for (let txx = 0; txx < 4; txx++) {
          const rawId = bytes[def + tyy * 4 + txx]
          const id = rawId < tileCount ? rawId : rawId & 0x7f
          const t = decodeTile2bpp(gfx, Math.min(id, Math.max(0, tileCount - 1)) * 16)
          let colors = GB_SHADES
          if (palMap >= 0) {
            const nib = (bytes[palMap + (rawId >> 1)] >> ((rawId & 1) * 4)) & 7
            colors = palSet[nib] as [number, number, number][]
          }
          for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
              const o = ((by + tyy * 8 + y) * width + bx + txx * 8 + x) * 4
              const [r, g, b] = colors[t[y * 8 + x]]
              pixels[o] = r
              pixels[o + 1] = g
              pixels[o + 2] = b
              pixels[o + 3] = 255
            }
          }
        }
      }
    }
    return { pixels, width, height }
  }

  const module: MapModule = {
    entries: maps.map((m) => ({
      key: `${m.group}.${m.map}`,
      bank: m.group,
      map: m.map,
      label: mapNames[`${m.group}.${m.map}`] ?? `Map ${m.group}.${m.map}`,
    })),
    describe(key) {
      const m = byKey.get(key)!
      return { widthBlocks: m.width, heightBlocks: m.height, blockCount: 256 }
    },
    render(key) {
      const m = byKey.get(key)!
      const ids = bytes.subarray(m.blocksOff, m.blocksOff + m.width * m.height)
      return renderBlockGrid(m.tileset, m.environment, ids, m.width)
    },
    renderBlocks(key, perRow) {
      const m = byKey.get(key)!
      const count = 128
      const ids = Array.from({ length: count }, (_, i) => i)
      return { ...renderBlockGrid(m.tileset, m.environment, ids, perRow), perRow, count }
    },
    cell(key, x, y) {
      const m = byKey.get(key)!
      return { blockId: bytes[m.blocksOff + y * m.width + x], permission: 0 }
    },
    paint(key, x, y, blockId) {
      const m = byKey.get(key)!
      if (x < 0 || y < 0 || x >= m.width || y >= m.height) return
      rom.writeU8(m.blocksOff + y * m.width + x, blockId & 0xff)
    },
    setPermission() {},
    // MapEvents (bank = scriptsBank in the attributes): 2 filler bytes,
    // then counted lists — warps 5B {y,x,destWarp,group,map}, coord
    // events 8B (skipped), bg events 5B {y,x,fn,script}, objects 13B
    // {sprite, y+4, x+4, movefn, radii, hours, pal/type, sight,
    // script, eventFlag}. Verified against pokecrystal maps.asm macros.
    events(key) {
      const ev = parseEvents(byKey.get(key)!)
      return {
        warps: ev.warps.map((w) => ({
          x: bytes[w + 1],
          y: bytes[w],
          elevation: 0,
          warpId: bytes[w + 2],
          targetBank: bytes[w + 3],
          targetMap: bytes[w + 4],
        })),
        signs: ev.signs.map((b) => ({ x: bytes[b + 1], y: bytes[b], elevation: 0, kind: bytes[b + 2] })),
        npcs: ev.npcs.map((n) => ({
          x: bytes[n + 2] - 4,
          y: bytes[n + 1] - 4,
          elevation: 0,
          graphicsId: bytes[n],
          movementType: bytes[n + 3],
        })),
      }
    },
    updateEvent(key, kind, index, field, value) {
      const ev = parseEvents(byKey.get(key)!)
      if (kind === 'warp') {
        const w = ev.warps[index]
        if (w === undefined) return
        if (field === 'x') rom.writeU8(w + 1, value)
        else if (field === 'y') rom.writeU8(w, value)
        else if (field === 'warpId') rom.writeU8(w + 2, value)
        else if (field === 'targetBank') rom.writeU8(w + 3, value)
        else if (field === 'targetMap') rom.writeU8(w + 4, value)
      } else if (kind === 'sign') {
        const b = ev.signs[index]
        if (b === undefined) return
        if (field === 'x') rom.writeU8(b + 1, value)
        else if (field === 'y') rom.writeU8(b, value)
        else if (field === 'kind') rom.writeU8(b + 2, value)
      } else {
        const n = ev.npcs[index]
        if (n === undefined) return
        if (field === 'x') rom.writeU8(n + 2, value + 4)
        else if (field === 'y') rom.writeU8(n + 1, value + 4)
        else if (field === 'graphicsId') rom.writeU8(n, value)
        else if (field === 'movementType') rom.writeU8(n + 3, value)
      }
    },
    resize: () => false,
    duplicateMap: () => null,
    addEvent(key, kind) {
      return editEvents(byKey.get(key)!, kind, null)
    },
    removeEvent(key, kind, index) {
      editEvents(byKey.get(key)!, kind, index)
    },
    attachScript: () => false,
    // Gen 1/2 events are not scripted through this editor.
    readScript: () => ({ kind: 'none' as const }),
    readScriptCommands: () => null,
    writeScriptCommands: () => false,
    // Gen 1/2 shops are not script-driven the way Gen 3's are.
    readShops: () => [],
    readItems: () => [],
    setItem: () => {},
    setShopProduct: () => {},
    addShopProduct: () => false,
    removeShopProduct: () => false,

    revertBlocks(key) {
      const m = byKey.get(key)!
      rom.revertRange(m.blocksOff, m.width * m.height)
    },
  }
  return { module, groups: groupCount, tilesets, count: maps.length, palBank }
}
