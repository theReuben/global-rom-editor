/**
 * Gen 3 Pokémon sprite viewing and importing.
 *
 * gMonFrontPicTable: per species {ptr gfx (LZ77 4bpp), u16 size, u16 tag}
 * where tag == the species id — which makes the table structurally
 * self-identifying: a long run of 8-byte entries whose pointers hit LZ77
 * magic and whose tags count 0,1,2,… gMonPaletteTable is the same shape
 * with LZ77-compressed 32-byte palettes.
 */
import type { Rom } from '../rom'
import type { RenderedImage } from '../games/schema'
import { findFreeSpaceAtEnd, readGbaPointer, writeGbaPointer } from '../freespace'
import { lz77Compress, lz77CompressedSize, lz77Decompress } from './lz77'
import { decodeTile4bpp, encodeTile4bpp, readPalette, renderTilesRgba, rgbToBgr555 } from '../tiles'

const ENTRY = 8
const FRONT_SIZE = 0x800 // 64×64 4bpp = one animation frame
const MIN_RUN = 200

export interface SpriteViewer {
  front(id: number): RenderedImage | null
  /**
   * Replace a species' front sprite with a 64×64 image of at most 16
   * colors (transparent pixels + the top-left color become the
   * background). Compressed data that no longer fits is relocated to
   * free space with the table pointer retargeted. Returns an error
   * message, or null on success.
   */
  importFront(id: number, image: RenderedImage): string | null
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

/** Write compressed data over its old slot, or relocate + retarget. */
function replaceCompressed(rom: Rom, tableEntry: number, compressed: Uint8Array): string | null {
  const oldPtr = readGbaPointer(rom.bytes, tableEntry)
  if (oldPtr === null) return 'The sprite pointer looks corrupt.'
  const oldSize = lz77CompressedSize(rom.bytes, oldPtr)
  if (compressed.length <= oldSize) {
    rom.writeBytes(oldPtr, compressed)
    return null
  }
  const dest = findFreeSpaceAtEnd(rom.bytes, compressed.length)
  if (dest === null) return 'The new sprite is larger and the ROM has no free space for it.'
  rom.writeBytes(dest, compressed)
  writeGbaPointer(rom, tableEntry, dest)
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

    importFront(id, image) {
      if (id < 0 || id > speciesCount) return 'Unknown species.'
      if (palTable === null) return 'The palette table was not found in this ROM.'
      if (image.width !== 64 || image.height !== 64)
        return `Sprites must be exactly 64×64 pixels (got ${image.width}×${image.height}).`

      const gfxEntry = picTable + id * ENTRY
      const gfxPtr = readGbaPointer(bytes, gfxEntry)
      if (gfxPtr === null) return 'The sprite pointer looks corrupt.'

      // Background = transparent pixels and the top-left color (the GBA
      // treats palette slot 0 as transparent for sprites).
      const px = image.pixels
      const bg = px[3] >= 128 ? rgbToBgr555(px[0], px[1], px[2]) : null
      const paletteWords: number[] = [bg ?? 0]
      const indexOf = new Map<number, number>()
      if (bg !== null) indexOf.set(bg, 0)

      const indices = new Uint8Array(64 * 64)
      for (let p = 0; p < 64 * 64; p++) {
        if (px[p * 4 + 3] < 128) continue // transparent → slot 0
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

      // 64×64 → 8×8 grid of 4bpp tiles, then repeat the frame to keep
      // the original decompressed size (animated sprites store 2 frames).
      const frame = new Uint8Array(FRONT_SIZE)
      for (let t = 0; t < 64; t++) {
        const tx = (t % 8) * 8
        const ty = Math.floor(t / 8) * 8
        const tile = new Uint8Array(64)
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++) tile[y * 8 + x] = indices[(ty + y) * 64 + tx + x]
        frame.set(encodeTile4bpp(tile), t * 32)
      }
      const rawLen = lz77Decompress(bytes, gfxPtr).length
      const raw = new Uint8Array(Math.max(rawLen, FRONT_SIZE))
      for (let o = 0; o < raw.length; o += FRONT_SIZE) raw.set(frame.subarray(0, Math.min(FRONT_SIZE, raw.length - o)), o)

      const palBytes = new Uint8Array(32)
      paletteWords.forEach((w, i) => {
        palBytes[i * 2] = w & 0xff
        palBytes[i * 2 + 1] = w >> 8
      })

      const gfxError = replaceCompressed(rom, gfxEntry, lz77Compress(raw))
      if (gfxError) return gfxError
      const palError = replaceCompressed(rom, palTable + id * ENTRY, lz77Compress(palBytes))
      if (palError) return palError
      cache.delete(id)
      return null
    },
  }
}
