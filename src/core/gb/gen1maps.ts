/**
 * Gen 1 (R/B/Y) map viewing and block painting.
 *
 * Formats verified against pokered (macros/scripts/maps.asm and
 * data/tilesets/tileset_headers.asm), and discovery validated against
 * the .sym files of built Red and Yellow:
 *
 *  - MapHeaderPointers: run of bank-local u16s in ROM0 (bank 0)
 *  - MapHeaderBanks: one bank byte per map, elsewhere in the ROM
 *  - Map header: tileset u8, height u8, width u8 (in 32×32px blocks),
 *    blocksPtr u16, textPtr u16, scriptPtr u16, connections u8, …
 *    (blocks live in the same bank as the header)
 *  - Tilesets table: 12-byte entries {bank, blocksPtr u16, gfxPtr u16,
 *    collPtr u16, counterTiles[3], grassTile, anim} — block defs are
 *    16 tile ids (4×4), tiles are 2bpp (16 bytes each)
 *
 * Everything is discovered structurally: the pointer run in ROM0, then
 * the banks table and tileset table are found by cross-validating
 * against the headers they must produce. No per-version offsets.
 */
import type { Rom } from '../rom'
import type { MapModule, RenderedImage } from '../games/schema'
import { decodeTile2bpp } from '../tiles'

const HEADER_PTRS_MIN = 150
const TILESET_ENTRY = 12
const MAX_DIM = 64 // Kanto's biggest maps are well under 64 blocks

// GB grayscale palette (index 0 = lightest).
const GB_SHADES: [number, number, number][] = [
  [232, 240, 223],
  [160, 178, 148],
  [88, 105, 80],
  [28, 35, 26],
]

interface Gen1Map {
  id: number
  headerOff: number
  bank: number
  tileset: number
  height: number
  width: number
  blocksOff: number
}

function toFile(bank: number, local: number): number {
  return bank * 0x4000 + (local - 0x4000)
}

export function buildGen1Maps(
  rom: Rom,
  mapNames: Record<number, string> | string[],
): { module: MapModule; headerPtrs: number; banks: number; tilesets: number; count: number } | null {
  const bytes = rom.bytes
  const romBanks = Math.max(2, Math.floor(bytes.length / 0x4000))

  // A header is plausible when its fixed fields are in range.
  const plausibleHeader = (off: number): boolean => {
    if (off + 10 > bytes.length) return false
    const ts = bytes[off]
    const h = bytes[off + 1]
    const w = bytes[off + 2]
    const blocks = rom.readU16LE(off + 3)
    const text = rom.readU16LE(off + 5)
    return ts <= 40 && h >= 1 && h <= MAX_DIM && w >= 1 && w <= MAX_DIM &&
      blocks >= 0x4000 && blocks < 0x8000 && text >= 0x4000 && text < 0x8000
  }

  // 1. Candidate MapHeaderPointers runs: Red keeps the table in ROM0,
  //    Yellow in a switchable bank — so every maximal run of 150-256
  //    bank-local u16s anywhere in the ROM is a candidate, confirmed by
  //    finding a banks table that turns its pointers into real headers.
  const candidates: { off: number; count: number }[] = []
  for (let o = 0; o + HEADER_PTRS_MIN * 2 <= bytes.length; o += 1) {
    let n = 0
    while (o + n * 2 + 2 <= bytes.length && n < 256) {
      const v = rom.readU16LE(o + n * 2)
      if (v < 0x4000 || v >= 0x8000) break
      n++
    }
    if (n >= HEADER_PTRS_MIN) candidates.push({ off: o, count: n })
    if (n > 0) o += n * 2 - 1
  }

  // 2. For each candidate, hunt for the matching MapHeaderBanks table.
  const findBanks = (ptrTable: number, mapCount: number): number => {
    outer: for (let o = 0; o + mapCount <= bytes.length; o++) {
      // Quick screen on the first few banks before full validation.
      for (let m = 0; m < 8; m++) {
        const b = bytes[o + m]
        if (b < 1 || b >= romBanks) continue outer
      }
      let good = 0
      for (let m = 0; m < mapCount; m++) {
        const b = bytes[o + m]
        if (b >= 1 && b < romBanks && plausibleHeader(toFile(b, rom.readU16LE(ptrTable + m * 2)))) good++
      }
      if (good >= mapCount * 0.85) return o
    }
    return -1
  }

  let ptrTable = -1
  let mapCount = 0
  let banksTable = -1
  for (const c of candidates) {
    const banks = findBanks(c.off, c.count)
    if (banks >= 0) {
      ptrTable = c.off
      mapCount = c.count
      banksTable = banks
      break
    }
  }
  if (ptrTable < 0 || banksTable < 0) return null

  const maps: Gen1Map[] = []
  for (let m = 0; m < mapCount; m++) {
    const bank = bytes[banksTable + m]
    const off = toFile(bank, rom.readU16LE(ptrTable + m * 2))
    if (bank < 1 || bank >= romBanks || !plausibleHeader(off)) continue
    maps.push({
      id: m,
      headerOff: off,
      bank,
      tileset: bytes[off],
      height: bytes[off + 1],
      width: bytes[off + 2],
      blocksOff: toFile(bank, rom.readU16LE(off + 3)),
    })
  }
  if (maps.length < HEADER_PTRS_MIN) return null

  // 3. Tilesets table: 12-byte entries whose count covers every tileset
  //    id the map headers actually use.
  const maxTileset = Math.max(...maps.map((m) => m.tileset))
  let tilesets = -1
  let tilesetCount = 0
  outerTs: for (let o = 0; o + (maxTileset + 1) * TILESET_ENTRY <= bytes.length; o += 1) {
    let n = 0
    while (o + (n + 1) * TILESET_ENTRY <= bytes.length && n < 64) {
      const e = o + n * TILESET_ENTRY
      const bank = bytes[e]
      if (bank < 1 || bank >= romBanks) break
      const blocks = rom.readU16LE(e + 1)
      const gfx = rom.readU16LE(e + 3)
      const coll = rom.readU16LE(e + 5)
      // Blocks/gfx are bank-local; collision lists live in ROM0.
      if ([blocks, gfx].some((v) => v < 0x4000 || v >= 0x8000)) break
      if (coll >= 0x8000) break
      if (bytes[e + 11] > 8) break // animation id
      n++
    }
    if (n > maxTileset) {
      tilesets = o
      tilesetCount = n
      break outerTs
    }
    if (n > 0) o += n * TILESET_ENTRY - 1
  }
  if (tilesets < 0) return null

  const byKey = new Map(maps.map((m) => [`0.${m.id}`, m]))
  const nameFor = (id: number) =>
    (Array.isArray(mapNames) ? mapNames[id] : mapNames[id]) ?? `Map #${id}`

  const tilesetInfo = (ts: number) => {
    const e = tilesets + Math.min(ts, tilesetCount - 1) * TILESET_ENTRY
    const bank = bytes[e]
    return {
      blocks: toFile(bank, rom.readU16LE(e + 1)),
      gfx: toFile(bank, rom.readU16LE(e + 3)),
    }
  }

  // Offsets of each warp/sign/object entry inside a map's object data.
  const parseObjects = (m: Gen1Map) => {
    const conn = bytes[m.headerOff + 9]
    let nConn = 0
    for (let b = 0; b < 4; b++) if (conn & (1 << b)) nConn++
    const objOff = toFile(m.bank, rom.readU16LE(m.headerOff + 10 + nConn * 11))
    const warps: number[] = []
    const signs: number[] = []
    const npcs: number[] = []
    let p = objOff + 1 // skip the border block
    const nWarps = bytes[p++]
    for (let i = 0; i < Math.min(nWarps, 32); i++) {
      warps.push(p)
      p += 4
    }
    const nSigns = bytes[p++]
    for (let i = 0; i < Math.min(nSigns, 32); i++) {
      signs.push(p)
      p += 3
    }
    const nObjects = bytes[p++]
    for (let i = 0; i < Math.min(nObjects, 32); i++) {
      npcs.push(p)
      const textId = bytes[p + 5]
      p += 6 + (textId & 0x40 ? 2 : textId & 0x80 ? 1 : 0)
    }
    return { warps, signs, npcs }
  }

  const tileCache = new Map<string, Uint8Array>()
  const tile = (gfx: number, id: number): Uint8Array => {
    const key = `${gfx}:${id}`
    let t = tileCache.get(key)
    if (!t) {
      t = decodeTile2bpp(bytes, gfx + id * 16)
      tileCache.set(key, t)
    }
    return t
  }

  /** Render `count` 32×32px blocks laid out `perRow` per row. */
  const renderBlockGrid = (
    ts: number,
    blockIds: ArrayLike<number>,
    perRow: number,
  ): RenderedImage => {
    const { blocks, gfx } = tilesetInfo(ts)
    const rows = Math.ceil(blockIds.length / perRow)
    const width = perRow * 32
    const height = rows * 32
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < blockIds.length; i++) {
      const bx = (i % perRow) * 32
      const by = Math.floor(i / perRow) * 32
      const def = blocks + blockIds[i] * 16
      for (let tyy = 0; tyy < 4; tyy++) {
        for (let txx = 0; txx < 4; txx++) {
          const t = tile(gfx, bytes[def + tyy * 4 + txx])
          for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
              const px = bx + txx * 8 + x
              const py = by + tyy * 8 + y
              const o = (py * width + px) * 4
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
    entries: maps.map((m) => ({ key: `0.${m.id}`, bank: 0, map: m.id, label: nameFor(m.id) })),
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
      const { blocks, gfx } = tilesetInfo(m.tileset)
      // Best-effort block count: blocks usually precede the gfx region.
      const span = gfx - blocks
      const count = Math.max(1, Math.min(256, span > 0 ? Math.floor(span / 16) : 256))
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
    setPermission() {
      /* Gen 1 collision is tile-list based, not per-cell — not editable here. */
    },
    // Object data (same bank as the header): border byte, then warps
    // (4B: y, x, destWarpId, destMap), signs (3B: y, x, textId) and
    // objects (sprite, y+4, x+4, movement, range, textId[, extras]) —
    // trainer objects (textId bit 6) carry 2 extra bytes, item objects
    // (bit 7) one. Each list is preceded by its count.
    events(key) {
      const parsed = parseObjects(byKey.get(key)!)
      return {
        warps: parsed.warps.map((w) => ({
          x: bytes[w + 1],
          y: bytes[w],
          elevation: 0,
          warpId: bytes[w + 2],
          targetMap: bytes[w + 3],
          targetBank: 0,
        })),
        signs: parsed.signs.map((sg) => ({
          x: bytes[sg + 1],
          y: bytes[sg],
          elevation: 0,
          kind: bytes[sg + 2],
        })),
        npcs: parsed.npcs.map((n) => ({
          x: bytes[n + 2] - 4,
          y: bytes[n + 1] - 4,
          elevation: 0,
          graphicsId: bytes[n],
          movementType: bytes[n + 3],
        })),
      }
    },
    updateEvent(key, kind, index, field, value) {
      const parsed = parseObjects(byKey.get(key)!)
      if (kind === 'warp') {
        const w = parsed.warps[index]
        if (w === undefined) return
        if (field === 'x') rom.writeU8(w + 1, value)
        else if (field === 'y') rom.writeU8(w, value)
        else if (field === 'warpId') rom.writeU8(w + 2, value)
        else if (field === 'targetMap') rom.writeU8(w + 3, value)
      } else if (kind === 'sign') {
        const sg = parsed.signs[index]
        if (sg === undefined) return
        if (field === 'x') rom.writeU8(sg + 1, value)
        else if (field === 'y') rom.writeU8(sg, value)
        else if (field === 'kind') rom.writeU8(sg + 2, value)
      } else {
        const n = parsed.npcs[index]
        if (n === undefined) return
        if (field === 'x') rom.writeU8(n + 2, value + 4)
        else if (field === 'y') rom.writeU8(n + 1, value + 4)
        else if (field === 'graphicsId') rom.writeU8(n, value)
        else if (field === 'movementType') rom.writeU8(n + 3, value)
      }
    },
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
  return { module, headerPtrs: ptrTable, banks: banksTable, tilesets, count: maps.length }
}
