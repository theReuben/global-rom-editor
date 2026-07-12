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
 */
import type { Rom } from '../rom'
import type { MapModule, RenderedImage } from '../games/schema'
import { decodeTile2bpp } from '../tiles'
import { lz3Decompress } from './lz3'

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

interface Gen2MapRec {
  group: number // 1-based
  map: number // 1-based
  tileset: number
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
): { module: MapModule; groups: number; tilesets: number; count: number } | null {
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

  const byKey = new Map(maps.map((m) => [`${m.group}.${m.map}`, m]))

  const gfxCache = new Map<number, Uint8Array>()
  const tilesetInfo = (ts: number) => {
    const e = tilesets + ts * TILESET_ENTRY
    const gfxOff = toFile(bytes[e], rom.readU16LE(e + 1))
    const meta = toFile(bytes[e + 3], rom.readU16LE(e + 4))
    let gfx = gfxCache.get(gfxOff)
    if (!gfx) {
      try {
        gfx = lz3Decompress(bytes, gfxOff)
      } catch {
        gfx = new Uint8Array(0)
      }
      gfxCache.set(gfxOff, gfx)
    }
    return { gfx, meta }
  }

  const renderBlockGrid = (ts: number, blockIds: ArrayLike<number>, perRow: number): RenderedImage => {
    const { gfx, meta } = tilesetInfo(ts)
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
          for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
              const o = ((by + tyy * 8 + y) * width + bx + txx * 8 + x) * 4
              const [r, g, b] = GB_SHADES[t[y * 8 + x]]
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
      return renderBlockGrid(m.tileset, ids, m.width)
    },
    renderBlocks(key, perRow) {
      const m = byKey.get(key)!
      const count = 128
      const ids = Array.from({ length: count }, (_, i) => i)
      return { ...renderBlockGrid(m.tileset, ids, perRow), perRow, count }
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
    events: () => ({ npcs: [], warps: [], signs: [] }),
    updateEvent() {},
    resize: () => false,
    duplicateMap: () => null,
    addEvent: () => false,
    removeEvent() {},
    attachScript: () => false,
    revertBlocks(key) {
      const m = byKey.get(key)!
      rom.revertRange(m.blocksOff, m.width * m.height)
    },
  }
  return { module, groups: groupCount, tilesets, count: maps.length }
}
