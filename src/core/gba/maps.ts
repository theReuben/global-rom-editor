/**
 * Gen 3 map engine: parses discovered map structures, renders maps and
 * block pickers to RGBA, and applies safe in-place edits (block painting,
 * movement permissions, NPC/warp/sign fields).
 */
import type { Rom } from '../rom'
import type { CellInfo, MapEntry, MapEvents, MapItemEntry, MapModule, EventKind, ShopEntry } from '../games/schema'
import { decompressGraphics } from './compress'
import { decodeTile4bpp, readPalette } from '../tiles'
import { discoverMaps, type Gen3MapIndex } from './mapscan'
import { findRegionMap } from './regionmap'
import { GBA_ROM_BASE, findFreeSpaceAtEnd, readGbaPointer, relocate, writeGbaPointer } from '../freespace'
import { compileScript, decompileScript, encodeScriptText } from './script'
import { assembleScript, disassembleScript, resolveText } from './disasm'
import { toTitleCase } from '../text'

/**
 * Only the item shop. pokemartdecoration and pokemartdecoration2 sell
 * DECORATIONS, whose ids are a separate namespace - id 25 is a Red
 * Brick, not a Poke Ball - so offering them an item dropdown would write
 * item ids into a decoration list and quietly corrupt the shop.
 */
const MART_COMMANDS = new Set(['pokemart'])

/** A bg event that hides an item underfoot rather than running a script. */
const BG_EVENT_HIDDEN_ITEM = 7
/**
 * The hidden item's packed word. Both vanilla and the expansion keep the
 * item in the low bits - the expansion narrows it to 11 to make room for
 * a wider flag id and a quantity, and vanilla never stores an id that
 * needs more, so masking to 11 reads either correctly. The quantity bits
 * read 0 on vanilla, which is why a count only shows when it is above 1.
 */
const HIDDEN_ITEM_MASK = 0x7ff
const HIDDEN_QUANTITY_SHIFT = 24
const HIDDEN_QUANTITY_MASK = 0x7f
/** callstd functions: 0 hands an item over, 1 is a found-item pickup. */
const STD_OBTAIN_ITEM = 0
const STD_FIND_ITEM = 1
/** The vars finditem/giveitem load before calling their standard script. */
const VAR_ITEM = 0x8000
const VAR_QUANTITY = 0x8001
/** A guard against a runaway read of a list that is not really a shop. */
const MAX_SHOP_PRODUCTS = 64

/** RSE and FRLG split tiles/metatiles/palettes differently. */
interface Family {
  primaryTiles: number
  primaryMetatiles: number
  totalMetatiles: number
  primaryPalettes: number
}

const RSE: Family = { primaryTiles: 512, primaryMetatiles: 512, totalMetatiles: 1024, primaryPalettes: 6 }
const FRLG: Family = { primaryTiles: 640, primaryMetatiles: 640, totalMetatiles: 1024, primaryPalettes: 7 }

/** A shop's stock: u16 item ids, terminated by 0. */
function readProductsFrom(bytes: Uint8Array, off: number): number[] {
  const out: number[] = []
  for (let p = off; p + 2 <= bytes.length && out.length < MAX_SHOP_PRODUCTS; p += 2) {
    const id = bytes[p] | (bytes[p + 1] << 8)
    if (id === 0) break
    out.push(id)
  }
  return out
}

/** Little-endian u32, unsigned. */
function readU32(bytes: Uint8Array, off: number): number {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
}

/** Where an instruction's nth argument sits, past the opcode byte. */
function argOffset(ins: { offset: number; args: { size: number }[] }, n: number): number {
  let at = ins.offset + 1
  for (let i = 0; i < n; i++) at += ins.args[i].size
  return at
}

/**
 * Whether a pointer argument points at dialogue.
 *
 * Not every 4-byte argument does, and script bytecode decodes as
 * plausible text often enough to fool a content check - a branch to
 * another script came back as mojibake, and editing that "dialogue"
 * would have written a text pointer over a jump. The macros name their
 * text parameters, so the name is the test.
 */
function holdsText(command: string, argName: string): boolean {
  return argName.includes('text') || (command === 'loadword' && argName === 'value')
}

export function familyForGameCode(code: string): Family {
  if (code.startsWith('AX') || code.startsWith('BPE')) return RSE
  return FRLG
}

function u32ptr(bytes: Uint8Array, off: number): number {
  const v = (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
  return v - 0x08000000
}

function s16(bytes: Uint8Array, off: number): number {
  const v = bytes[off] | (bytes[off + 1] << 8)
  return v >= 0x8000 ? v - 0x10000 : v
}

interface Layout {
  offset: number
  width: number
  height: number
  borderOffset: number
  blocksOffset: number
  primaryTs: number
  secondaryTs: number
}

interface LoadedGfx {
  /** Global tile atlas: primary tiles at 0, secondary at primaryTiles. */
  tiles: (Uint8Array | undefined)[]
  /** 16 palettes of 16 RGB triples. */
  palettes: [number, number, number][][]
  metatileOffset(blockId: number): number | null
}

interface LoadedMap {
  headerOffset: number
  eventsOffset: number
  layout: Layout
  gfx: LoadedGfx
  metatileCache: Map<number, Uint8ClampedArray>
}

const NPC_SIZE = 24
const WARP_SIZE = 8
const TRIGGER_SIZE = 16
const SIGN_SIZE = 12

/** `struct MapHeader.regionMapSectionId`. */
const MAP_SECTION_ID = 0x14

export function buildGen3MapModule(rom: Rom, gameCode: string): { module: MapModule; index: Gen3MapIndex } | null {
  const bytes = rom.bytes
  const index = discoverMaps(bytes)
  if (!index) return null
  const family = familyForGameCode(gameCode)

  // Map headers carry a region-map section id at +0x14; that is where
  // human names like "Viridian City" come from. Without the table the
  // list falls back to bank.map numbers, as it always used to.
  const regionMap = findRegionMap(bytes)

  const entries: MapEntry[] = []
  const headerByKey = new Map<string, number>()
  index.banks.forEach((maps, bank) => {
    maps.forEach((headerOff, map) => {
      const layoutOff = u32ptr(bytes, headerOff)
      const w = bytes[layoutOff] | (bytes[layoutOff + 1] << 8)
      const h = bytes[layoutOff + 4] | (bytes[layoutOff + 5] << 8)
      const key = `${bank}.${map}`
      headerByKey.set(key, headerOff)
      const name = regionMap?.name(bytes[headerOff + MAP_SECTION_ID]) ?? ''
      entries.push({
        key,
        bank,
        map,
        label: name ? `${bank}.${map} — ${toTitleCase(name)} (${w}×${h})` : `${bank}.${map} — ${w}×${h}`,
        areaName: name || undefined,
      })
    })
  })

  const loaded = new Map<string, LoadedMap>()

  function parseLayout(off: number): Layout {
    return {
      offset: off,
      width: bytes[off] | (bytes[off + 1] << 8),
      height: bytes[off + 4] | (bytes[off + 5] << 8),
      borderOffset: u32ptr(bytes, off + 8),
      blocksOffset: u32ptr(bytes, off + 12),
      primaryTs: u32ptr(bytes, off + 16),
      secondaryTs: u32ptr(bytes, off + 20),
    }
  }

  function loadTiles(tsOff: number, maxTiles: number): Uint8Array[] {
    const compressed = bytes[tsOff] === 1
    const gfxOff = u32ptr(bytes, tsOff + 4)
    let gfx: Uint8Array
    if (compressed) {
      // LZ77 or the expansion's `smol`; an undecodable codec yields no
      // tiles rather than a wrong-looking map.
      gfx = decompressGraphics(bytes, gfxOff) ?? new Uint8Array(0)
    } else {
      gfx = bytes.subarray(gfxOff, Math.min(gfxOff + maxTiles * 32, bytes.length))
    }
    const tiles: Uint8Array[] = []
    for (let i = 0; i + 32 <= gfx.length && i / 32 < maxTiles; i += 32) {
      tiles.push(decodeTile4bpp(gfx, i))
    }
    return tiles
  }

  function loadGfx(layout: Layout): LoadedGfx {
    const primary = layout.primaryTs
    const secondary = layout.secondaryTs
    const tiles: (Uint8Array | undefined)[] = new Array(1024)
    loadTiles(primary, family.primaryTiles).forEach((t, i) => (tiles[i] = t))
    loadTiles(secondary, 1024 - family.primaryTiles).forEach(
      (t, i) => (tiles[family.primaryTiles + i] = t),
    )

    const palettes: [number, number, number][][] = []
    const pPal = u32ptr(bytes, primary + 8)
    const sPal = u32ptr(bytes, secondary + 8)
    for (let i = 0; i < 16; i++) {
      const base = i < family.primaryPalettes ? pPal : sPal
      palettes.push(readPalette(bytes, base + i * 32))
    }

    const pMeta = u32ptr(bytes, primary + 12)
    const sMeta = u32ptr(bytes, secondary + 12)
    const metatileOffset = (blockId: number): number | null => {
      let off: number
      if (blockId < family.primaryMetatiles) off = pMeta + blockId * 16
      else if (blockId < family.totalMetatiles) off = sMeta + (blockId - family.primaryMetatiles) * 16
      else return null
      return off + 16 <= bytes.length ? off : null
    }
    return { tiles, palettes, metatileOffset }
  }

  function load(key: string): LoadedMap {
    const cached = loaded.get(key)
    if (cached) return cached
    const headerOffset = headerByKey.get(key)
    if (headerOffset === undefined) throw new Error(`Unknown map ${key}`)
    const layout = parseLayout(u32ptr(bytes, headerOffset))
    const m: LoadedMap = {
      headerOffset,
      eventsOffset: u32ptr(bytes, headerOffset + 4),
      layout,
      gfx: loadGfx(layout),
      metatileCache: new Map(),
    }
    loaded.set(key, m)
    return m
  }

  /** Render one 16×16 metatile (two layers, 4 quadrants each) to RGBA. */
  function renderMetatile(m: LoadedMap, blockId: number): Uint8ClampedArray {
    const hit = m.metatileCache.get(blockId)
    if (hit) return hit
    const out = new Uint8ClampedArray(16 * 16 * 4)
    const mtOff = m.gfx.metatileOffset(blockId)
    if (mtOff === null) {
      // Unknown block: magenta checker so problems are visible, not silent.
      for (let i = 0; i < 256; i++) {
        out[i * 4] = 255
        out[i * 4 + 2] = 255
        out[i * 4 + 3] = 255
      }
      m.metatileCache.set(blockId, out)
      return out
    }
    for (let layer = 0; layer < 2; layer++) {
      for (let q = 0; q < 4; q++) {
        const v = bytes[mtOff + layer * 8 + q * 2] | (bytes[mtOff + layer * 8 + q * 2 + 1] << 8)
        const tile = m.gfx.tiles[v & 0x3ff]
        if (!tile) continue
        const hFlip = (v >> 10) & 1
        const vFlip = (v >> 11) & 1
        const pal = m.gfx.palettes[v >> 12] ?? m.gfx.palettes[0]
        const qx = (q % 2) * 8
        const qy = q < 2 ? 0 : 8
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const p = tile[(vFlip ? 7 - y : y) * 8 + (hFlip ? 7 - x : x)]
            if (layer === 1 && p === 0) continue // top layer: 0 is transparent
            const o = ((qy + y) * 16 + qx + x) * 4
            const [r, g, b] = pal[p] ?? [255, 0, 255]
            out[o] = r
            out[o + 1] = g
            out[o + 2] = b
            out[o + 3] = 255
          }
        }
      }
    }
    m.metatileCache.set(blockId, out)
    return out
  }

  function blockAt(m: LoadedMap, x: number, y: number): number {
    return rom.readU16LE(m.layout.blocksOffset + (y * m.layout.width + x) * 2)
  }

  function blit(dst: Uint8ClampedArray, dstW: number, src: Uint8ClampedArray, px: number, py: number) {
    for (let y = 0; y < 16; y++) {
      const srcRow = y * 16 * 4
      const dstRow = ((py + y) * dstW + px) * 4
      dst.set(src.subarray(srcRow, srcRow + 64), dstRow)
    }
  }

  function eventPtr(m: LoadedMap, kind: EventKind): { off: number; count: number; size: number } {
    const e = m.eventsOffset
    const slot = kind === 'npc' ? 0 : kind === 'warp' ? 1 : 3
    const size = kind === 'npc' ? NPC_SIZE : kind === 'warp' ? WARP_SIZE : SIGN_SIZE
    return { off: u32ptr(bytes, e + 4 + slot * 4), count: bytes[e + slot], size }
  }

  const module: MapModule = {
    entries,

    describe(key) {
      const m = load(key)
      return {
        widthBlocks: m.layout.width,
        heightBlocks: m.layout.height,
        blockCount: family.totalMetatiles,
      }
    },

    render(key) {
      const m = load(key)
      const { width, height } = m.layout
      const pixels = new Uint8ClampedArray(width * 16 * height * 16 * 4)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          blit(pixels, width * 16, renderMetatile(m, blockAt(m, x, y) & 0x3ff), x * 16, y * 16)
        }
      }
      return { pixels, width: width * 16, height: height * 16 }
    },

    renderBlocks(key, perRow) {
      const m = load(key)
      const count = family.totalMetatiles
      const rows = Math.ceil(count / perRow)
      const width = perRow * 16
      const pixels = new Uint8ClampedArray(width * rows * 16 * 4)
      for (let i = 0; i < count; i++) {
        blit(pixels, width, renderMetatile(m, i), (i % perRow) * 16, Math.floor(i / perRow) * 16)
      }
      return { pixels, width, height: rows * 16, perRow, count }
    },

    cell(key, x, y): CellInfo {
      const v = blockAt(load(key), x, y)
      return { blockId: v & 0x3ff, permission: v >> 10 }
    },

    paint(key, x, y, blockId) {
      const m = load(key)
      const off = m.layout.blocksOffset + (y * m.layout.width + x) * 2
      rom.writeU16LE(off, (rom.readU16LE(off) & 0xfc00) | (blockId & 0x3ff))
    },

    setPermission(key, x, y, permission) {
      const m = load(key)
      const off = m.layout.blocksOffset + (y * m.layout.width + x) * 2
      rom.writeU16LE(off, (rom.readU16LE(off) & 0x03ff) | ((permission & 0x3f) << 10))
    },

    events(key): MapEvents {
      const m = load(key)
      const npcs = []
      const warps = []
      const signs = []
      const n = eventPtr(m, 'npc')
      for (let i = 0; i < n.count; i++) {
        const o = n.off + i * NPC_SIZE
        npcs.push({
          x: s16(bytes, o + 4),
          y: s16(bytes, o + 6),
          elevation: bytes[o + 8],
          graphicsId: bytes[o + 1],
          movementType: bytes[o + 9],
        })
      }
      const w = eventPtr(m, 'warp')
      for (let i = 0; i < w.count; i++) {
        const o = w.off + i * WARP_SIZE
        warps.push({
          x: s16(bytes, o),
          y: s16(bytes, o + 2),
          elevation: bytes[o + 4],
          warpId: bytes[o + 5],
          targetMap: bytes[o + 6],
          targetBank: bytes[o + 7],
        })
      }
      const s = eventPtr(m, 'sign')
      for (let i = 0; i < s.count; i++) {
        const o = s.off + i * SIGN_SIZE
        signs.push({ x: s16(bytes, o), y: s16(bytes, o + 2), elevation: bytes[o + 4], kind: bytes[o + 5] })
      }
      return { npcs, warps, signs }
    },

    updateEvent(key, kind, i, field, value) {
      const m = load(key)
      const { off, count, size } = eventPtr(m, kind)
      if (i < 0 || i >= count) return
      const o = off + i * size
      const writeS16 = (at: number) => rom.writeU16LE(at, value < 0 ? value + 0x10000 : value)
      if (kind === 'npc') {
        if (field === 'x') writeS16(o + 4)
        else if (field === 'y') writeS16(o + 6)
        else if (field === 'elevation') rom.writeU8(o + 8, value)
        else if (field === 'graphicsId') rom.writeU8(o + 1, value)
        else if (field === 'movementType') rom.writeU8(o + 9, value)
      } else if (kind === 'warp') {
        if (field === 'x') writeS16(o)
        else if (field === 'y') writeS16(o + 2)
        else if (field === 'elevation') rom.writeU8(o + 4, value)
        else if (field === 'warpId') rom.writeU8(o + 5, value)
        else if (field === 'targetMap') rom.writeU8(o + 6, value)
        else if (field === 'targetBank') rom.writeU8(o + 7, value)
      } else {
        if (field === 'x') writeS16(o)
        else if (field === 'y') writeS16(o + 2)
        else if (field === 'elevation') rom.writeU8(o + 4, value)
        else if (field === 'kind') rom.writeU8(o + 5, value)
      }
    },

    resize(key, width, height) {
      const m = load(key)
      const old = m.layout
      if (width < 1 || height < 1 || width > 255 || height > 255) return false
      if (width === old.width && height === old.height) return true
      // Build the new grid: keep the overlap, fill new cells with block 0.
      const grid = new Uint8Array(width * height * 2)
      for (let y = 0; y < Math.min(height, old.height); y++) {
        for (let x = 0; x < Math.min(width, old.width); x++) {
          const v = blockAt(m, x, y)
          const o = (y * width + x) * 2
          grid[o] = v & 0xff
          grid[o + 1] = v >> 8
        }
      }
      const dest = relocate(rom, old.blocksOffset, old.width * old.height * 2, grid)
      if (dest === null) return false
      // Dimensions are s32 in the layout struct.
      rom.writeU16LE(old.offset, width)
      rom.writeU16LE(old.offset + 2, 0)
      rom.writeU16LE(old.offset + 4, height)
      rom.writeU16LE(old.offset + 6, 0)
      loaded.delete(key) // re-parse on next access
      const entry = entries.find((e) => e.key === key)
      if (entry) entry.label = `${key} — ${width}×${height}`
      return true
    },

    duplicateMap(key) {
      const m = load(key)
      const bank = Number(key.split('.')[0])
      const old = m.layout
      const align4 = (n: number) => Math.ceil(n / 4) * 4

      const gridLen = old.width * old.height * 2
      // FRLG layouts carry border dimensions at +0x18/+0x19; RSE is 2×2.
      const bw = family.primaryPalettes === 7 ? bytes[old.offset + 0x18] || 2 : 2
      const bh = family.primaryPalettes === 7 ? bytes[old.offset + 0x19] || 2 : 2
      const borderLen = bw * bh * 2
      const LAYOUT_LEN = 28
      const EVENTS_LEN = 20
      const HEADER_LEN = 28

      // One end-of-ROM blob: grid, border, layout, events, header.
      const gridOff = findFreeSpaceAtEnd(
        rom.bytes,
        align4(gridLen) + align4(borderLen) + LAYOUT_LEN + EVENTS_LEN + HEADER_LEN + 16,
      )
      if (gridOff === null) return null
      const borderOff = align4(gridOff + gridLen)
      const layoutOff = align4(borderOff + borderLen)
      const eventsOff = layoutOff + LAYOUT_LEN
      const headerOff = eventsOff + EVENTS_LEN

      rom.writeBytes(gridOff, bytes.subarray(old.blocksOffset, old.blocksOffset + gridLen))
      rom.writeBytes(borderOff, bytes.subarray(old.borderOffset, old.borderOffset + borderLen))
      rom.writeBytes(layoutOff, bytes.subarray(old.offset, old.offset + LAYOUT_LEN))
      writeGbaPointer(rom, layoutOff + 8, borderOff)
      writeGbaPointer(rom, layoutOff + 12, gridOff)
      rom.writeBytes(eventsOff, new Uint8Array(EVENTS_LEN)) // no events yet
      rom.writeBytes(headerOff, bytes.subarray(m.headerOffset, m.headerOffset + HEADER_LEN))
      writeGbaPointer(rom, headerOff, layoutOff)
      writeGbaPointer(rom, headerOff + 4, eventsOff)
      rom.writeBytes(headerOff + 8, new Uint8Array(8)) // no map scripts/connections

      // Grow this bank's group array (relocated; the bank table entry is
      // retargeted automatically).
      const bankEntryOff = index.bankTableOffset + bank * 4
      const groupOff = u32ptr(bytes, bankEntryOff)
      const count = index.banks[bank].length
      const grown = new Uint8Array((count + 1) * 4)
      grown.set(bytes.subarray(groupOff, groupOff + count * 4))
      const headerAddr = (headerOff + 0x08000000) >>> 0
      grown.set(
        [headerAddr & 0xff, (headerAddr >> 8) & 0xff, (headerAddr >> 16) & 0xff, headerAddr >>> 24],
        count * 4,
      )
      if (relocate(rom, groupOff, count * 4, grown) === null) return null

      // Register the new map in the live module state.
      index.banks[bank].push(headerOff)
      const newKey = `${bank}.${count}`
      headerByKey.set(newKey, headerOff)
      const label = `${newKey} — ${old.width}×${old.height}`
      const lastOfBank = entries.reduce(
        (best, e, i) => (e.bank === bank ? i : best),
        entries.length - 1,
      )
      entries.splice(lastOfBank + 1, 0, { key: newKey, bank, map: count, label })
      return newKey
    },

    addEvent(key, kind) {
      const m = load(key)
      const { off, count, size } = eventPtr(m, kind)
      if (count >= 200) return false
      const blank = new Uint8Array(size)
      if (kind === 'npc') {
        blank[0] = count + 1 // local id
        blank[8] = 3 // elevation
        blank[9] = 0x08 // face down
      }
      const slot = kind === 'npc' ? 0 : kind === 'warp' ? 1 : 3
      const rawPtr =
        rom.readU16LE(m.eventsOffset + 4 + slot * 4) |
        (rom.readU16LE(m.eventsOffset + 6 + slot * 4) << 16)
      if (count === 0 || rawPtr === 0) {
        // No array yet: allocate a fresh one.
        const dest = findFreeSpaceAtEnd(rom.bytes, size)
        if (dest === null) return false
        rom.writeBytes(dest, blank)
        writeGbaPointer(rom, m.eventsOffset + 4 + slot * 4, dest)
      } else {
        const grown = new Uint8Array((count + 1) * size)
        grown.set(bytes.subarray(off, off + count * size))
        grown.set(blank, count * size)
        if (relocate(rom, off, count * size, grown) === null) return false
      }
      rom.writeU8(m.eventsOffset + slot, count + 1)
      return true
    },

    removeEvent(key, kind, index) {
      const m = load(key)
      const { off, count, size } = eventPtr(m, kind)
      if (index < 0 || index >= count) return
      for (let i = index; i < count - 1; i++) {
        rom.writeBytes(off + i * size, bytes.subarray(off + (i + 1) * size, off + (i + 2) * size))
      }
      for (let b = 0; b < size; b++) rom.writeU8(off + (count - 1) * size + b, 0)
      const slot = kind === 'npc' ? 0 : kind === 'warp' ? 1 : 3
      rom.writeU8(m.eventsOffset + slot, count - 1)
    },

    attachScript(key, kind, index, steps) {
      const m = load(key)
      const { off, count, size } = eventPtr(m, kind)
      if (index < 0 || index >= count || steps.length === 0) return false
      // Two-phase: measure with a dummy base, then compile at the real one.
      const probe = compileScript(steps, 0)
      if (!probe) return false
      const base = findFreeSpaceAtEnd(rom.bytes, probe.bytes.length)
      if (base === null) return false
      const compiled = compileScript(steps, base)!
      rom.writeBytes(base, compiled.bytes)
      // NPC talk script pointer at +16; sign script/arg pointer at +8.
      const ptrOff = off + index * size + (kind === 'npc' ? 16 : 8)
      writeGbaPointer(rom, ptrOff, base)
      return true
    },

    readScript(key, kind, index) {
      const m = load(key)
      const { off, count, size } = eventPtr(m, kind)
      if (index < 0 || index >= count) return { kind: 'none' }
      const ptrOff = off + index * size + (kind === 'npc' ? 16 : 8)
      const script = readGbaPointer(bytes, ptrOff)
      if (script === null) return { kind: 'none' }
      const steps = decompileScript(bytes, script)
      return steps ? { kind: 'steps', steps } : { kind: 'foreign' }
    },

    readScriptCommands(key, kind, index) {
      const m = load(key)
      const { off, count, size } = eventPtr(m, kind)
      if (index < 0 || index >= count) return null
      const script = readGbaPointer(bytes, off + index * size + (kind === 'npc' ? 16 : 8))
      if (script === null) return null
      const d = disassembleScript(bytes, script)
      if (!d) return null
      for (const ins of d.instructions)
        for (const arg of ins.args)
          if (arg.size === 4 && arg.target === null && holdsText(ins.name, arg.name))
            arg.text = resolveText(bytes, arg.value)
      return d
    },

    writeScriptCommands(key, kind, index, instructions) {
      const m = load(key)
      const { off, count, size } = eventPtr(m, kind)
      if (index < 0 || index >= count) return false
      const ptrOff = off + index * size + (kind === 'npc' ? 16 : 8)
      const original = readGbaPointer(bytes, ptrOff)
      if (original === null) return false
      const before = disassembleScript(bytes, original)
      if (!before) return false

      // Any dialogue that changed needs somewhere to live. Text is
      // written first so the command stream can point at it.
      for (const ins of instructions) {
        for (const arg of ins.args) {
          if (arg.text === undefined || arg.text === null) continue
          const encoded = encodeScriptText(arg.text)
          if (!encoded) return false
          const existing = resolveText(bytes, arg.value)
          if (existing === arg.text) continue
          const at = findFreeSpaceAtEnd(rom.bytes, encoded.length + 1)
          if (at === null) return false
          rom.writeBytes(at, [...encoded, 0xff])
          arg.value = (at + GBA_ROM_BASE) >>> 0
        }
      }

      // Assembling at the old address keeps the script in place when it
      // still fits; otherwise it moves and the event is repointed.
      const sameSize = assembleScript(instructions, original).length === before.length
      if (sameSize) {
        rom.writeBytes(original, assembleScript(instructions, original))
        return true
      }
      const probe = assembleScript(instructions, 0)
      const dest = findFreeSpaceAtEnd(rom.bytes, probe.length)
      if (dest === null) return false
      rom.writeBytes(dest, assembleScript(instructions, dest))
      writeGbaPointer(rom, ptrOff, dest)
      return true
    },

    readShops(key) {
      const m = load(key)
      const out: ShopEntry[] = []
      // A shop is a pokemart command inside an event's script, so the
      // scripts have to be walked to find them - there is no shop table.
      for (const kind of ['npc', 'sign'] as const) {
        const { off, count, size } = eventPtr(m, kind)
        for (let i = 0; i < count; i++) {
          const script = readGbaPointer(bytes, off + i * size + (kind === 'npc' ? 16 : 8))
          if (script === null) continue
          const d = disassembleScript(bytes, script)
          if (!d) continue
          for (const ins of d.instructions) {
            if (!MART_COMMANDS.has(ins.name)) continue
            // The pointer argument follows the opcode byte.
            const argAt = ins.offset + 1
            const list = readGbaPointer(bytes, argAt)
            if (list === null) continue
            out.push({
              id: argAt,
              label: `${kind === 'npc' ? 'NPC' : 'Sign'} ${i + 1}${ins.name === 'pokemart' ? '' : ` (${ins.name})`}`,
              products: readProductsFrom(bytes, list),
            })
          }
        }
      }
      return out
    },

    setShopProduct(_key, shopId, slot, item) {
      const list = readGbaPointer(bytes, shopId)
      if (list === null) return
      const products = readProductsFrom(bytes, list)
      if (slot < 0 || slot >= products.length) return
      rom.writeU16LE(list + slot * 2, item)
    },

    addShopProduct(_key, shopId, item) {
      const list = readGbaPointer(bytes, shopId)
      if (list === null) return false
      const products = [...readProductsFrom(bytes, list), item]
      if (products.length > MAX_SHOP_PRODUCTS) return false
      // The list is sized exactly and packed against its neighbours, so
      // growing it has to move rather than overwrite what follows.
      const dest = findFreeSpaceAtEnd(rom.bytes, (products.length + 1) * 2)
      if (dest === null) return false
      products.forEach((p, i) => rom.writeU16LE(dest + i * 2, p))
      rom.writeU16LE(dest + products.length * 2, 0)
      writeGbaPointer(rom, shopId, dest)
      return true
    },

    removeShopProduct(_key, shopId, slot) {
      const list = readGbaPointer(bytes, shopId)
      if (list === null) return false
      const products = readProductsFrom(bytes, list)
      if (slot < 0 || slot >= products.length) return false
      const next = products.filter((_, i) => i !== slot)
      // Shrinking fits where it is, so the list stays put.
      next.forEach((p, i) => rom.writeU16LE(list + i * 2, p))
      rom.writeU16LE(list + next.length * 2, 0)
      return true
    },

    readItems(key) {
      const m = load(key)
      const out: MapItemEntry[] = []

      // Hidden items live in the bg event itself - no script to walk.
      const sg = eventPtr(m, 'sign')
      for (let i = 0; i < sg.count; i++) {
        const o = sg.off + i * SIGN_SIZE
        if (bytes[o + 5] !== BG_EVENT_HIDDEN_ITEM) continue
        const packed = readU32(bytes, o + 8)
        out.push({
          id: o + 8,
          source: 'hidden',
          label: `Hidden ${out.length + 1}`,
          x: s16(bytes, o),
          y: s16(bytes, o + 2),
          item: packed & HIDDEN_ITEM_MASK,
          quantity: (packed >>> HIDDEN_QUANTITY_SHIFT) & HIDDEN_QUANTITY_MASK,
        })
      }

      // Everything else is a script: finditem for a Ball on the ground,
      // giveitem for an NPC handing something over. Both load the item
      // into VAR_0x8000 before calling their standard script, so the
      // callstd is what marks the spot and the loads before it carry the
      // values.
      for (const kind of ['npc', 'sign'] as const) {
        const { off, count, size } = eventPtr(m, kind)
        for (let i = 0; i < count; i++) {
          const script = readGbaPointer(bytes, off + i * size + (kind === 'npc' ? 16 : 8))
          if (script === null) continue
          const d = disassembleScript(bytes, script)
          if (!d) continue
          const o = off + i * size
          let itemAt: number | null = null
          let item = 0
          let quantity = 1
          let fromVar = false
          for (const ins of d.instructions) {
            if (ins.name === 'setorcopyvar') {
              const dest = ins.args[0]?.value
              const src = ins.args[1]
              if (src === undefined) continue
              // A var as the source means the value is computed at run
              // time - there is no constant in the script to edit.
              if (src.value >= 0x4000) {
                if (dest === VAR_ITEM) fromVar = true
                continue
              }
              if (dest === VAR_ITEM) {
                item = src.value
                itemAt = argOffset(ins, 1)
              } else if (dest === VAR_QUANTITY) quantity = src.value
              continue
            }
            if (ins.name !== 'callstd') continue
            const fn = ins.args[0]?.value
            if (fn !== STD_FIND_ITEM && fn !== STD_OBTAIN_ITEM) continue
            const source = fn === STD_FIND_ITEM ? 'ball' : 'gift'
            if (itemAt === null) {
              // A Ball whose script is the shared Common_EventScript_FindItem:
              // the script reads the item out of the object's own template
              // (trainerRange doubles as the item, movementRangeX as the
              // count), so that is what an edit has to change.
              if (!fromVar || kind !== 'npc') continue
              itemAt = o + 0x0e
              item = bytes[itemAt] | (bytes[itemAt + 1] << 8)
              quantity = (bytes[o + 0x0a] & 0x0f) || 1
            }
            out.push({
              id: itemAt,
              source,
              label: `${source === 'ball' ? 'Ball' : 'Gift'} - ${kind === 'npc' ? 'NPC' : 'Sign'} ${i + 1}`,
              x: s16(bytes, o + (kind === 'npc' ? 4 : 0)),
              y: s16(bytes, o + (kind === 'npc' ? 6 : 2)),
              item,
              quantity,
            })
            itemAt = null
            quantity = 1
            fromVar = false
          }
        }
      }
      return out
    },

    setItem(_key, id, source, item) {
      if (source === 'hidden') {
        // The item shares its halfword with the low bits of the flag id,
        // so only its own bits may change.
        const low = bytes[id] | (bytes[id + 1] << 8)
        rom.writeU16LE(id, (low & ~HIDDEN_ITEM_MASK) | (item & HIDDEN_ITEM_MASK))
      } else {
        rom.writeU16LE(id, item)
      }
    },

    revertBlocks(key) {
      const m = load(key)
      rom.revertRange(m.layout.blocksOffset, m.layout.width * m.layout.height * 2)
    },
  }

  // TRIGGER_SIZE reserved for coord-event editing (roadmap).
  void TRIGGER_SIZE
  return { module, index }
}
