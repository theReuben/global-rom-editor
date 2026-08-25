/**
 * Gen 3 Pokémon sprite viewing and importing (front and back).
 *
 * gMonFrontPicTable / gMonBackPicTable: per species {ptr gfx (LZ77
 * 4bpp), u16 size, u16 tag} where tag == the species id — which makes
 * the tables structurally self-identifying: long runs of 8-byte entries
 * whose pointers hit LZ77 magic and whose tags count 0,1,2,…
 * gMonPaletteTable is the same shape with LZ77-compressed 32-byte
 * palettes (the shiny table follows it in every game).
 *
 * Telling front from back (verified against built ROMs + decomp link
 * order): Emerald front pics decompress to 0x1000 (two animation
 * frames) while backs are 0x800; in R/S and FR/LG both are 0x800 and
 * the front table comes first in the ROM (pokeruby mon_attrs.s,
 * pokefirered .map). Emerald is the odd one out with back first.
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
  front(id: number, shiny?: boolean): RenderedImage | null
  /** null when the back-pic table could not be told apart / found. */
  back: ((id: number, shiny?: boolean) => RenderedImage | null) | null
  /** Whether a shiny palette table was found (front/back accept shiny). */
  hasShiny: boolean
  /**
   * Replace a species' sprite with a 64×64 image of at most 16 colors
   * (transparent pixels + the top-left color become the background).
   * Compressed data that no longer fits is relocated to free space
   * with the table pointer retargeted. Returns an error message, or
   * null on success.
   */
  importFront(id: number, image: RenderedImage): string | null
  importBack: ((id: number, image: RenderedImage) => string | null) | null
}

function findTagTables(
  bytes: Uint8Array,
  tagOff: number,
  validEntry: (e: number) => boolean,
  max: number,
  anyBase = false,
): { offset: number; tagBase: number }[] {
  const found: { offset: number; tagBase: number }[] = []
  for (let o = 0; o + MIN_RUN * ENTRY <= bytes.length && found.length < max; o += 4) {
    // Tags count up from a base: 0 for pic tables, but e.g. Emerald's
    // shiny palettes start at SPECIES_SHINY_TAG (500).
    const tagBase = bytes[o + tagOff] | (bytes[o + tagOff + 1] << 8)
    if (!anyBase && tagBase !== 0) continue
    let ok = true
    for (let i = 0; i < MIN_RUN; i++) {
      const e = o + i * ENTRY
      const t = readGbaPointer(bytes, e)
      if (
        t === null ||
        bytes[t] !== 0x10 ||
        (bytes[e + tagOff] | (bytes[e + tagOff + 1] << 8)) !== ((tagBase + i) & 0xffff) ||
        !validEntry(e)
      ) {
        ok = false
        break
      }
    }
    if (ok) {
      found.push({ offset: o, tagBase })
      o += MIN_RUN * ENTRY // resume past this table
    }
  }
  return found
}

/** Write compressed data over its old slot, or relocate + retarget. */
export function replaceCompressed(rom: Rom, tableEntry: number, compressed: Uint8Array): string | null {
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
  // Pic tables: size field is a frame size (0x800; Emerald stores two
  // frames in the gfx but keeps 0x800 in the field).
  const picTables = findTagTables(
    bytes,
    6,
    (e) => {
      const size = bytes[e + 4] | (bytes[e + 5] << 8)
      return size === FRONT_SIZE || size === FRONT_SIZE * 2
    },
    2,
  ).map((t) => t.offset)
  if (picTables.length === 0) return null
  // Palette entries carry their tag at +4 (the struct has no size
  // field). The normal table's tags start at 0; the shiny table's
  // start higher (SPECIES_SHINY_TAG = 500 in the decomps), which is
  // how the two are told apart.
  const palTables = findTagTables(bytes, 4, () => true, 2, true)
  const palTable = palTables.find((t) => t.tagBase === 0)?.offset ?? null
  const shinyTable = palTables.find((t) => t.tagBase !== 0)?.offset ?? null

  // Classify front vs back (see header comment).
  const rawLen = (table: number, id: number): number => {
    try {
      const p = readGbaPointer(bytes, table + id * ENTRY)
      return p === null ? 0 : lz77Decompress(bytes, p).length
    } catch {
      return 0
    }
  }
  let frontTable = picTables[0]
  let backTable: number | null = picTables[1] ?? null
  if (backTable !== null && rawLen(backTable, 1) >= FRONT_SIZE * 2 && rawLen(frontTable, 1) < FRONT_SIZE * 2) {
    frontTable = picTables[1]
    backTable = picTables[0]
  }

  const cache = new Map<string, RenderedImage | null>()
  const render = (table: number, id: number, shiny = false): RenderedImage | null => {
    if (id < 0 || id > speciesCount) return null
    const palettes = shiny && shinyTable !== null ? shinyTable : palTable
    const key = `${table}:${id}:${shiny}`
    if (cache.has(key)) return cache.get(key)!
    let out: RenderedImage | null = null
    try {
      const gfxPtr = readGbaPointer(bytes, table + id * ENTRY)
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
        if (palettes !== null) {
          const palPtr = readGbaPointer(bytes, palettes + id * ENTRY)
          if (palPtr !== null) palette = readPalette(lz77Decompress(bytes, palPtr), 0)
        }
        out = renderTilesRgba(tiles, 8, palette, true)
      }
    } catch {
      out = null
    }
    cache.set(key, out)
    return out
  }

  const importPic = (table: number, id: number, image: RenderedImage): string | null => {
    if (id < 0 || id > speciesCount) return 'Unknown species.'
    if (palTable === null) return 'The palette table was not found in this ROM.'
    if (image.width !== 64 || image.height !== 64)
      return `Sprites must be exactly 64×64 pixels (got ${image.width}×${image.height}).`

    const gfxEntry = table + id * ENTRY
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
    const origLen = lz77Decompress(bytes, gfxPtr).length
    const raw = new Uint8Array(Math.max(origLen, FRONT_SIZE))
    for (let o = 0; o < raw.length; o += FRONT_SIZE)
      raw.set(frame.subarray(0, Math.min(FRONT_SIZE, raw.length - o)), o)

    const palBytes = new Uint8Array(32)
    paletteWords.forEach((w, i) => {
      palBytes[i * 2] = w & 0xff
      palBytes[i * 2 + 1] = w >> 8
    })

    const gfxError = replaceCompressed(rom, gfxEntry, lz77Compress(raw))
    if (gfxError) return gfxError
    const palError = replaceCompressed(rom, palTable + id * ENTRY, lz77Compress(palBytes))
    if (palError) return palError
    // The shiny palette gets the same colors so imported sprites don't
    // show vanilla-shiny colors on someone else's artwork.
    if (shinyTable !== null) replaceCompressed(rom, shinyTable + id * ENTRY, lz77Compress(palBytes))
    for (const sh of ['true', 'false']) {
      cache.delete(`${frontTable}:${id}:${sh}`)
      cache.delete(`${backTable}:${id}:${sh}`)
    }
    return null
  }

  return {
    front: (id, shiny) => render(frontTable, id, shiny),
    back: backTable !== null ? (id, shiny) => render(backTable!, id, shiny) : null,
    hasShiny: shinyTable !== null,
    importFront: (id, image) => importPic(frontTable, id, image),
    importBack: backTable !== null ? (id, image) => importPic(backTable!, id, image) : null,
  }
}
