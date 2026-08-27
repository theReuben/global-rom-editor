/**
 * Overworld (object event) sprites.
 *
 * An NPC's `graphicsId` indexes `gObjectEventGraphicsInfoPointers`, an
 * array of pointers to `struct ObjectEventGraphicsInfo`. That struct
 * does not name its own index, so the table is found the way everything
 * else here is: by finding the structs first, then the longest run of
 * pointers into them.
 *
 * What makes a struct recognisable (verified against a built ROM - all
 * 409 of this ROM's infos match, and no other run does):
 *   +0x00 u16 tileTag        always TAG_NONE for object events
 *   +0x02 u16 paletteTag     an OBJ_EVENT_PAL_TAG_*, 0x1100..0x11FF
 *   +0x06 u16 size           bytes of one frame
 *   +0x08 s16 width, height  GBA sprite dimensions
 *   +0x0C paletteSlot:4 shadowSize:2 inanimate:1 compressed:1
 *   +0x10 oam, +0x14 subspriteTables, +0x18 anims, +0x1C images
 *
 * and the clincher: images[0].size == width * height / 2, the exact
 * size of one 4bpp frame.
 *
 * Colours come from a second table of {palette, tag} pairs, matched to
 * the struct's paletteTag.
 */
import { readGbaPointer } from '../freespace'
import { decompressGraphics } from './compress'
import { decodeTile4bpp, readPalette } from '../tiles'
import type { RenderedImage } from '../games/schema'

const INFO_SIZE = 0x24
const TAG_NONE = 0xffff
const PAL_TAG_MIN = 0x1100
const PAL_TAG_MAX = 0x11ff
/**
 * Sprite dimensions. Not just the GBA's object sizes: a big object
 * event (the Cable Car, the Truck) is drawn from subsprites and its
 * info records the whole thing, 48x48 or 96x40.
 */
const MIN_DIM = 8
const MAX_DIM = 128
const MIN_TABLE = 32
const MAX_TABLE = 1024
/** Entries the game leaves empty; see the comment on the grouping. */
const MAX_GAP = 200

const INFO = {
  tileTag: 0x00,
  paletteTag: 0x02,
  size: 0x06,
  width: 0x08,
  height: 0x0a,
  flags: 0x0c,
  images: 0x1c,
} as const

export interface OverworldSprites {
  /** Number of graphics ids the pointer table holds. */
  count: number
  tableOffset: number
  /** Where a palette tag's colours live; exposed for verification. */
  paletteFor(tag: number): number | undefined
  render(graphicsId: number): RenderedImage | null
}

function u16(bytes: Uint8Array, off: number): number {
  return bytes[off] | (bytes[off + 1] << 8)
}

function validDim(n: number): boolean {
  return n >= MIN_DIM && n <= MAX_DIM && n % 8 === 0
}

function validInfo(bytes: Uint8Array, off: number): boolean {
  if (off + INFO_SIZE > bytes.length) return false
  if (u16(bytes, off + INFO.tileTag) !== TAG_NONE) return false
  const width = u16(bytes, off + INFO.width)
  const height = u16(bytes, off + INFO.height)
  if (!validDim(width) || !validDim(height)) return false
  const images = readGbaPointer(bytes, off + INFO.images)
  if (images === null || images + 8 > bytes.length) return false
  const frame = readGbaPointer(bytes, images)
  if (frame === null) return false
  return u16(bytes, images + 4) === (width * height) / 2
}

/** Palette tables are {const u16 *data, u16 tag} pairs, 8 bytes each. */
function findPalettes(bytes: Uint8Array): Map<number, number> {
  let best: Map<number, number> = new Map()
  let run: Map<number, number> = new Map()
  let runStart = -1
  for (let o = 0; o + 8 <= bytes.length; o += 4) {
    const data = readGbaPointer(bytes, o)
    const tag = u16(bytes, o + 4)
    const ok =
      data !== null &&
      data + 32 <= bytes.length &&
      tag >= PAL_TAG_MIN &&
      tag <= PAL_TAG_MAX &&
      u16(bytes, o + 6) === 0
    if (ok && (runStart === -1 || o === runStart + run.size * 8)) {
      if (runStart === -1) runStart = o
      run.set(tag, data)
      o += 4 // the pair is 8 bytes; the loop adds the other 4
      continue
    }
    if (run.size > best.size) best = run
    run = new Map()
    runStart = -1
  }
  return run.size > best.size ? run : best
}

export function findOverworldSprites(bytes: Uint8Array): OverworldSprites | null {
  const infos = new Set<number>()
  for (let o = 0; o + INFO_SIZE <= bytes.length; o += 4) if (validInfo(bytes, o)) infos.add(o)
  if (infos.size < MIN_TABLE) return null

  // The pointer table: the positions pointing at those structs, grouped
  // into one table. Two things stop this being a contiguous run - the
  // same info is shared by several ids, and ids the game defines but
  // never uses are null. In this ROM the FRLG object events are
  // compiled out, leaving a hole 145 entries wide in the middle of the
  // table, so the gap tolerance has to be wide enough to step over it.
  // Only pointers to a validated object-event info count as hits, which
  // is what keeps a gap that wide from swallowing an unrelated table.
  const hits: number[] = []
  for (let o = 0; o + 4 <= bytes.length; o += 4) {
    const target = readGbaPointer(bytes, o)
    if (target !== null && infos.has(target)) hits.push(o)
  }
  let bestStart = -1
  let bestEnd = -1
  let bestCount = 0
  let groupStart = hits[0] ?? -1
  let groupCount = 0
  for (let i = 0; i < hits.length; i++) {
    groupCount++
    const isLast = i === hits.length - 1 || hits[i + 1] - hits[i] > MAX_GAP * 4
    if (!isLast) continue
    if (groupCount > bestCount) {
      bestCount = groupCount
      bestStart = groupStart
      bestEnd = hits[i]
    }
    groupStart = hits[i + 1] ?? -1
    groupCount = 0
  }
  if (bestCount < MIN_TABLE) return null
  const length = (bestEnd - bestStart) / 4 + 1
  if (length > MAX_TABLE) return null

  const palettes = findPalettes(bytes)

  return {
    count: length,
    tableOffset: bestStart,
    paletteFor: (tag) => palettes.get(tag),
    render(graphicsId) {
      if (graphicsId < 0 || graphicsId >= length) return null
      const info = readGbaPointer(bytes, bestStart + graphicsId * 4)
      if (info === null) return null
      const width = u16(bytes, info + INFO.width)
      const height = u16(bytes, info + INFO.height)
      const images = readGbaPointer(bytes, info + INFO.images)
      if (images === null) return null
      const frame = readGbaPointer(bytes, images)
      if (frame === null) return null
      const compressed = (bytes[info + INFO.flags] & 0x80) !== 0
      const need = (width * height) / 2
      let tiles: Uint8Array
      try {
        tiles = compressed ? (decompressGraphics(bytes, frame) ?? new Uint8Array()) : bytes.subarray(frame, frame + need)
      } catch {
        return null
      }
      if (tiles.length < need) return null

      const palette = palettes.get(u16(bytes, info + INFO.paletteTag))
      if (palette === undefined) return null
      const colors = readPalette(bytes, palette)

      const pixels = new Uint8ClampedArray(width * height * 4)
      const tilesPerRow = width / 8
      for (let t = 0; t < (width * height) / 64; t++) {
        const tile = decodeTile4bpp(tiles, t * 32)
        const ox = (t % tilesPerRow) * 8
        const oy = Math.floor(t / tilesPerRow) * 8
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const c = tile[y * 8 + x]
            if (c === 0) continue // colour 0 is the transparent one
            const [r, g, b] = colors[c]
            const o = ((oy + y) * width + ox + x) * 4
            pixels[o] = r
            pixels[o + 1] = g
            pixels[o + 2] = b
            pixels[o + 3] = 255
          }
        }
      }
      return { pixels, width, height }
    },
  }
}
