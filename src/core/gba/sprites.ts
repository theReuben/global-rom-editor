/**
 * Gen 3 Pokémon sprite viewing.
 *
 * gMonFrontPicTable: per species {ptr gfx (LZ77 4bpp), u16 size, u16 tag}
 * where tag == the species id — which makes the table structurally
 * self-identifying: a long run of 8-byte entries whose pointers hit LZ77
 * magic and whose tags count 0,1,2,… gMonPaletteTable is the same shape
 * with LZ77-compressed 32-byte palettes.
 */
import type { Rom } from '../rom'
import type { RenderedImage } from '../games/schema'
import { readGbaPointer } from '../freespace'
import { lz77Decompress } from './lz77'
import { decodeTile4bpp, readPalette, renderTilesRgba } from '../tiles'

const ENTRY = 8
const FRONT_SIZE = 0x800 // 64×64 4bpp = one animation frame
const MIN_RUN = 200

export interface SpriteViewer {
  front(id: number): RenderedImage | null
}

function findTagTable(
  bytes: Uint8Array,
  tagOff: number,
  validEntry: (e: number) => boolean,
): number | null {
  for (let o = 0; o + MIN_RUN * ENTRY <= bytes.length; o += 4) {
    let ok = true
    for (let i = 0; i < MIN_RUN; i++) {
      const e = o + i * ENTRY
      const t = readGbaPointer(bytes, e)
      if (
        t === null ||
        bytes[t] !== 0x10 ||
        (bytes[e + tagOff] | (bytes[e + tagOff + 1] << 8)) !== i ||
        !validEntry(e)
      ) {
        ok = false
        break
      }
    }
    if (ok) return o
  }
  return null
}

export function buildSpriteViewer(rom: Rom, speciesCount: number): SpriteViewer | null {
  const bytes = rom.bytes
  // Front pics: size field is a frame size (0x800; some games store the
  // two-frame total, so accept multiples).
  const picTable = findTagTable(bytes, 6, (e) => {
    const size = bytes[e + 4] | (bytes[e + 5] << 8)
    return size === FRONT_SIZE || size === FRONT_SIZE * 2
  })
  if (picTable === null) return null
  // Palette entries carry their tag at +4 (the struct has no size field).
  const palTable = findTagTable(bytes, 4, () => true)

  const cache = new Map<number, RenderedImage | null>()
  return {
    front(id) {
      if (id < 0 || id > speciesCount) return null
      if (cache.has(id)) return cache.get(id)!
      let out: RenderedImage | null = null
      try {
        const gfxPtr = readGbaPointer(bytes, picTable + id * ENTRY)
        if (gfxPtr !== null) {
          const gfx = lz77Decompress(bytes, gfxPtr)
          const tiles = []
          for (let i = 0; i + 32 <= Math.min(gfx.length, FRONT_SIZE); i += 32) {
            tiles.push(decodeTile4bpp(gfx, i))
          }
          let palette: [number, number, number][] = Array.from({ length: 16 }, (_, i) => [
            i * 16,
            i * 16,
            i * 16,
          ])
          if (palTable !== null) {
            const palPtr = readGbaPointer(bytes, palTable + id * ENTRY)
            if (palPtr !== null) palette = readPalette(lz77Decompress(bytes, palPtr), 0)
          }
          out = renderTilesRgba(tiles, 8, palette, true)
        }
      } catch {
        out = null
      }
      cache.set(id, out)
      return out
    },
  }
}
