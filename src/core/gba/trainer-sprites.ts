/**
 * Trainer front sprites (`gTrainerSprites`).
 *
 *   struct TrainerSprite {              // 32 bytes
 *     0x00 u8 y_offset;                 // padded to the next pointer
 *     0x04 struct CompressedSpriteSheet frontPic;  // ptr, u16 size, u16 tag
 *     0x0C struct SpritePalette palette;           // ptr, u16 tag, pad
 *     0x14 const union AnimCmd *const *animation;
 *     0x18 struct Coords16 mugshotCoords;
 *     0x1C s16 mugshotRotation;
 *   }                                   // include/data.h
 *
 * Discovered the same way as every other table here: by structure, never
 * by a hardcoded address. An entry is credible when both the graphics and
 * palette pointers land inside the ROM and the declared sheet size is a
 * whole number of 4bpp tiles no larger than a 64x64 pic. The longest run
 * of credible entries wins.
 */
import type { Rom } from '../rom'
import type { RenderedImage } from '../games/schema'
import { readGbaPointer } from '../freespace'
import { decompressGraphics } from './compress'
import { decodeTile4bpp, readPalette, renderTilesRgba } from '../tiles'
import { readPaletteBytes, PIC_FRAME } from './expansion'

const ENTRY = 32
const TS = { frontPic: 0x04, picSize: 0x08, picTag: 0x0a, palette: 0x0c } as const

const TILE_BYTES = 32
/** A 64x64 4bpp pic; smaller sheets exist, larger ones are not trainers. */
const MAX_PIC_BYTES = PIC_FRAME
const MIN_RUN = 20
const MAX_RUN = 2048

function u16(bytes: Uint8Array, off: number): number {
  return bytes[off] | (bytes[off + 1] << 8)
}

/**
 * Structural shape alone is not selective enough: a 32-byte record with
 * two in-range pointers and a tile-sized u16 occurs elsewhere in the ROM,
 * and an earlier version of this scan latched onto a 350-entry run of
 * exactly that, whose graphics did not decode to any trainer pic.
 *
 * The discriminator is the sprite tag. Each entry's frontPic carries a
 * tag equal to its own index, so a genuine table counts 0, 1, 2, … in
 * step with its entries — a pattern noise does not reproduce.
 */
function entryShapeValid(bytes: Uint8Array, off: number): boolean {
  if (off < 0 || off + ENTRY > bytes.length) return false
  const size = u16(bytes, off + TS.picSize)
  if (size === 0 || size > MAX_PIC_BYTES || size % TILE_BYTES !== 0) return false
  return (
    readGbaPointer(bytes, off + TS.frontPic) !== null && readGbaPointer(bytes, off + TS.palette) !== null
  )
}

function entryValid(bytes: Uint8Array, off: number, index: number): boolean {
  return entryShapeValid(bytes, off) && u16(bytes, off + TS.picTag) === index
}

export function findTrainerSprites(bytes: Uint8Array): { offset: number; count: number } | null {
  let best: { offset: number; count: number } | null = null
  for (let o = 0; o + ENTRY * MIN_RUN <= bytes.length; o += 4) {
    // Maximal runs only, so the skip below cannot step over a longer one.
    if (!entryValid(bytes, o, 0)) continue
    let count = 0
    while (count < MAX_RUN && entryValid(bytes, o + count * ENTRY, count)) count++
    if (count >= MIN_RUN && (best === null || count > best.count)) best = { offset: o, count }
    if (count > 1) o += (count - 1) * ENTRY
  }
  return best
}

export interface TrainerSprites {
  offset: number
  count: number
  render: (picId: number) => RenderedImage | null
}

export function buildTrainerSprites(rom: Rom): TrainerSprites | null {
  const bytes = rom.bytes
  const table = findTrainerSprites(bytes)
  if (table === null) return null
  const cache = new Map<number, RenderedImage | null>()

  const render = (picId: number): RenderedImage | null => {
    if (picId < 0 || picId >= table.count) return null
    const hit = cache.get(picId)
    if (hit !== undefined) return hit

    let out: RenderedImage | null = null
    try {
      const o = table.offset + picId * ENTRY
      const gfxPtr = readGbaPointer(bytes, o + TS.frontPic)
      const palPtr = readGbaPointer(bytes, o + TS.palette)
      if (gfxPtr !== null && palPtr !== null) {
        const gfx = decompressGraphics(bytes, gfxPtr)
        if (gfx !== null && gfx.length >= PIC_FRAME) {
          const tiles: Uint8Array[] = []
          for (let i = 0; i + TILE_BYTES <= PIC_FRAME; i += TILE_BYTES) tiles.push(decodeTile4bpp(gfx, i))
          const palette = readPalette(readPaletteBytes(bytes, palPtr), 0)
          if (tiles.length === 64) out = renderTilesRgba(tiles, 8, palette, true)
        }
      }
    } catch {
      out = null
    }
    cache.set(picId, out)
    return out
  }

  return { offset: table.offset, count: table.count, render }
}
